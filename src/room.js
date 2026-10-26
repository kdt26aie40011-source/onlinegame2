const crypto = require('crypto');
const {
  ROOM_ID_LENGTH, ROOM_ID_CHARS, NAME_MAX, TOPIC_MAX, MAX_PARTICIPANTS, MAX_SPECTATORS, MAX_PARENTS_PER_LAP,
  MIN_PLAYERS, ICONS, SETTING_RULES, MODES, SEAT_HOLD_MS, EMPTY_ROOM_TTL_MS, LIKE_LIMIT, UNIQUE_LIMIT,
} = require('./constants');
const { randomId, fail, OK } = require('./util');
const { NormalGame } = require('./games/normal');
const { MinnaGame } = require('./games/minna');

const GAMES = { normal: NormalGame, minna: MinnaGame };
const ROLES = ['player', 'spectator'];

// ホストの操作でしか進まない場面。ここではホストが抜けたら即時に引き継ぐ
const HOST_DRIVEN_PHASES = new Set(['lobby', 'result', 'mresult']);

function randomRoomId() {
  let id = '';
  for (let i = 0; i < ROOM_ID_LENGTH; i++) id += ROOM_ID_CHARS[crypto.randomInt(ROOM_ID_CHARS.length)];
  return id;
}

function sameToken(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

class Room {
  constructor(id, io, onClose) {
    this.id = id;
    this.io = io;
    this.onClose = onClose;
    // playerId -> { id, token, name, icon, role, pendingRole, socketId, connected, order, stats, releaseTimer }
    this.players = new Map();
    this.nextOrder = 0;
    this.hostId = null;
    this.pendingHostId = null; // 手動譲渡の予約（ラウンドの切り替わりで反映）
    this.settings = {
      mode: 'normal',
      topicTimeSec: SETTING_RULES.topicTimeSec.initial,
      drawTimeSec: SETTING_RULES.drawTimeSec.initial,
      parentsPerLap: null, // null は「全員」
      laps: SETTING_RULES.laps.initial,
    };
    this.phase = 'lobby';
    this.game = null;
    this.images = new Map(); // drawingId -> PNG の Buffer
    this.timer = null;
    this.deadline = null;
    this.notice = null;
    this.emptyTimer = null;
    this.closed = false;
    this.scheduleCloseIfEmpty();
  }

  // ---- 入退室 ----

  // 入室画面で使う、入室前でも見てよい情報
  publicInfo() {
    return {
      icons: ICONS,
      nameMax: NAME_MAX,
      full: { player: this.isFull('player'), spectator: this.isFull('spectator') },
      inGame: !!this.game,
    };
  }

  // 離席中で席を保持している人も1人に数える
  countRole(role) {
    return [...this.players.values()].filter((p) => p.role === role).length;
  }

  isFull(role) {
    return this.countRole(role) >= (role === 'player' ? MAX_PARTICIPANTS : MAX_SPECTATORS);
  }

  join(socket, rawName, icon, role) {
    const name = typeof rawName === 'string' ? rawName.trim() : '';
    if (!name) return fail('名前を入力してください');
    if ([...name].length > NAME_MAX) return fail(`名前は${NAME_MAX}文字までです`);
    if (!ICONS.includes(icon)) return fail('アイコンを選んでください');
    if (!ROLES.includes(role)) return fail('参加者か観戦者かを選んでください');
    if (this.isFull(role)) return fail('部屋が満員です');
    if ([...this.players.values()].some((p) => p.name === name)) {
      return fail('同じ名前の人がすでに部屋にいます。別の名前にしてください');
    }

    // ゲーム中に参加者として入った人は、参加者枠を使って次のゲームまで観戦モードで待つ
    const player = {
      id: crypto.randomUUID(),
      token: crypto.randomBytes(24).toString('base64url'),
      name,
      icon,
      role,
      pendingRole: null,
      socketId: null,
      connected: false,
      order: this.nextOrder++,
      stats: { wins: 0, likes: 0, uniques: 0 },
      releaseTimer: null,
    };
    this.players.set(player.id, player);
    this.attach(socket, player);
    if (!this.hostId) this.hostId = player.id;
    this.ensureHostIfIdle();
    return { ok: true, playerId: player.id, token: player.token };
  }

  // 2分以内に戻ってきた人を、同じ席（成績もそのまま）に戻す
  rejoin(socket, playerId, token) {
    const player = typeof playerId === 'string' ? this.players.get(playerId) : undefined;
    if (!player || !sameToken(player.token, token)) {
      return fail('席が見つかりません。2分以上たったか、部屋が終了した可能性があります');
    }
    this.attach(socket, player);
    this.ensureHostIfIdle();
    return { ok: true, playerId: player.id, token: player.token };
  }

  attach(socket, player) {
    // 別のタブ・端末で入り直したら、古い接続は切り離す
    if (player.socketId && player.socketId !== socket.id) {
      const old = this.io.sockets.sockets.get(player.socketId);
      if (old) {
        old.data.roomId = null;
        old.emit('replaced');
        old.leave(this.id);
      }
    }
    clearTimeout(player.releaseTimer);
    player.releaseTimer = null;
    player.socketId = socket.id;
    player.connected = true;
    socket.join(this.id);
    clearTimeout(this.emptyTimer);
    this.emptyTimer = null;
  }

  // 通信切断・自分での退出。どちらも2分間は席を保持する
  disconnect(playerId) {
    const player = this.players.get(playerId);
    if (!player || !player.connected) return;
    player.connected = false;
    player.socketId = null;
    player.releaseTimer = setTimeout(() => this.release(playerId), SEAT_HOLD_MS);

    this.game?.onDisconnect(playerId);
    this.ensureHostIfIdle();
    if (this.connectedPlayers().length === 0) this.scheduleCloseIfEmpty();
    this.broadcast();
  }

  // 2分たっても戻らなかった人の席を解放する
  release(playerId) {
    const player = this.players.get(playerId);
    if (!player || player.connected) return;
    this.players.delete(playerId);
    if (this.pendingHostId === playerId) this.pendingHostId = null;

    if (this.players.size === 0) {
      this.clearTimer();
      this.game = null;
      this.phase = 'lobby';
      this.hostId = null;
      this.clearImages();
      this.scheduleCloseIfEmpty();
      return;
    }

    if (this.hostId === playerId) this.changeHost(this.nextHostCandidate() ?? this.sortedPlayers()[0]);
    this.clampParentsSetting();
    this.game?.onRelease(playerId);
    this.broadcast();
  }

  scheduleCloseIfEmpty() {
    clearTimeout(this.emptyTimer);
    this.emptyTimer = setTimeout(() => {
      if (this.connectedPlayers().length === 0) this.close();
    }, EMPTY_ROOM_TTL_MS);
  }

  // ホストによる強制終了
  forceClose(playerId) {
    if (playerId !== this.hostId) return fail('ホストだけが部屋を終了できます');
    this.io.to(this.id).emit('room:closed');
    this.close();
    return OK;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.clearTimer();
    clearTimeout(this.emptyTimer);
    for (const player of this.players.values()) clearTimeout(player.releaseTimer);
    for (const socket of this.io.sockets.sockets.values()) {
      if (socket.data.roomId === this.id) socket.data.roomId = null;
    }
    this.io.in(this.id).socketsLeave(this.id);
    this.images.clear();
    this.onClose(this);
  }

  // ---- 参加者・観戦者の切り替え ----

  switchRole(playerId, role) {
    const player = this.players.get(playerId);
    if (!ROLES.includes(role)) return fail('切り替え先が正しくありません');

    if (!this.game) {
      player.role = role;
      player.pendingRole = null;
      this.clampParentsSetting();
    } else {
      // ゲーム中に切り替えた場合は次のゲームから反映
      player.pendingRole = role === player.role ? null : role;
    }
    this.broadcast();
    return OK;
  }

  applyPendingRoles() {
    for (const player of this.players.values()) {
      if (player.pendingRole) player.role = player.pendingRole;
      player.pendingRole = null;
    }
  }

  // ---- ホスト権限 ----

  transferHost(playerId, targetId) {
    if (playerId !== this.hostId) return fail('ホストだけが譲渡できます');
    const target = this.players.get(targetId);
    if (!target || targetId === playerId) return fail('その人には譲渡できません');
    if (!target.connected) return fail('離席中の人には譲渡できません');

    if (this.phase === 'lobby') {
      this.changeHost(target);
    } else {
      // ゲーム中はラウンドが切り替わるタイミングで反映する
      this.pendingHostId = targetId;
      this.notifyAll(`👑 次のラウンドから${target.name}さんがホストになります`);
    }
    this.broadcast();
    return OK;
  }

  applyPendingHost() {
    const target = this.players.get(this.pendingHostId);
    this.pendingHostId = null;
    if (target?.connected && target.id !== this.hostId) this.changeHost(target);
  }

  // ホストが離席中なら、入室順が次に早い（いる）人へ移す
  ensureHost() {
    if (this.players.get(this.hostId)?.connected) return;
    const next = this.nextHostCandidate();
    if (next) this.changeHost(next);
  }

  ensureHostIfIdle() {
    if (HOST_DRIVEN_PHASES.has(this.phase)) this.ensureHost();
  }

  nextHostCandidate() {
    return this.connectedPlayers().find((p) => p.id !== this.hostId);
  }

  changeHost(player) {
    if (!player || player.id === this.hostId) return;
    this.hostId = player.id;
    if (this.pendingHostId === player.id) this.pendingHostId = null;
    this.notifyAll(`👑 ホストが${player.name}さんに代わりました`);
  }

  // ---- ゲーム設定 ----

  updateSettings(playerId, input) {
    if (playerId !== this.hostId) return fail('ホストだけが設定を変更できます');
    if (this.game) return fail('ゲーム中は設定を変更できません');

    const next = { ...this.settings };
    if (input.mode !== undefined) {
      if (!MODES.includes(input.mode)) return fail('ゲームモードが正しくありません');
      next.mode = input.mode;
    }
    for (const [key, rule] of Object.entries(SETTING_RULES)) {
      if (input[key] === undefined) continue;
      const value = input[key];
      if (!Number.isInteger(value) || value < rule.min || value > rule.max || (value - rule.min) % rule.step !== 0) {
        return fail('設定の値が正しくありません');
      }
      next[key] = value;
    }
    if (input.parentsPerLap !== undefined) {
      const value = input.parentsPerLap;
      if (value !== null && (!Number.isInteger(value) || value < 1 || value > this.maxParentsPerLap())) {
        return fail('親の人数が正しくありません');
      }
      next.parentsPerLap = value;
    }

    this.settings = next;
    this.broadcast();
    return OK;
  }

  maxParentsPerLap() {
    return Math.max(1, Math.min(this.countRole('player'), MAX_PARENTS_PER_LAP));
  }

  // 参加者が減って親の人数が参加人数を超えたら、参加人数に合わせて下げる
  clampParentsSetting() {
    const { parentsPerLap } = this.settings;
    if (parentsPerLap !== null && parentsPerLap > this.maxParentsPerLap()) {
      this.settings.parentsPerLap = this.maxParentsPerLap();
    }
  }

  // ---- ゲーム進行 ----

  startGame(playerId) {
    if (playerId !== this.hostId) return fail('ホストだけが開始できます');
    if (this.game) return fail('ゲームはすでに始まっています');
    const { mode } = this.settings;
    const ids = this.sortedPlayers().filter((p) => p.role === 'player').map((p) => p.id);
    if (ids.length < MIN_PLAYERS[mode]) return fail(`参加者が${MIN_PLAYERS[mode]}人以上で開始できます`);

    this.notice = null;
    this.game = new GAMES[mode](this, ids, this.settings);
    this.game.start();
    return OK;
  }

  // ゲームの操作は今のゲームに任せる
  gameAction(method, ...args) {
    if (!this.game) return fail('ゲーム中ではありません');
    if (typeof this.game[method] !== 'function') return fail('今はその操作はできません');
    return this.game[method](...args);
  }

  next(playerId) {
    if (playerId !== this.hostId) return fail('ホストだけが進められます');
    return this.gameAction('next');
  }

  endGame(notice) {
    this.clearTimer();
    this.game = null;
    this.phase = 'lobby';
    this.notice = notice;
    this.clearImages();
    this.applyPendingRoles();
    this.clampParentsSetting();
    this.applyPendingHost();
    this.ensureHost();
    this.broadcast();
  }

  // ---- 絵の画像 ----

  addImage(dataUrl) {
    const id = randomId();
    this.images.set(id, Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64'));
    return id;
  }

  getImage(id) {
    return this.images.get(id);
  }

  imageUrl(id) {
    return `/api/rooms/${this.id}/drawings/${id}.png`;
  }

  clearImages() {
    this.images.clear();
  }

  // ---- 内部ヘルパー ----

  setPhase(phase, durationMs, onTimeout) {
    this.clearTimer();
    this.phase = phase;
    // 時間で進む工程では、ホストの引き継ぎは工程が切り替わるタイミングで行う
    this.ensureHost();
    if (durationMs > 0 && onTimeout) {
      this.deadline = Date.now() + durationMs;
      this.timer = setTimeout(onTimeout, durationMs);
    }
    this.broadcast();
  }

  clearTimer() {
    clearTimeout(this.timer);
    this.timer = null;
    this.deadline = null;
  }

  notifyAll(message) {
    this.io.to(this.id).emit('notify', { message });
  }

  notifyPlayer(playerId, message) {
    const socketId = this.players.get(playerId)?.socketId;
    if (socketId) this.io.to(socketId).emit('notify', { message });
  }

  isConnected(playerId) {
    return !!this.players.get(playerId)?.connected;
  }

  sortedPlayers() {
    return [...this.players.values()].sort((a, b) => a.order - b.order);
  }

  connectedPlayers() {
    return this.sortedPlayers().filter((p) => p.connected);
  }

  broadcast() {
    if (this.closed) return;
    for (const player of this.players.values()) {
      if (player.socketId) this.io.to(player.socketId).emit('state', this.viewFor(player.id));
    }
  }

  // プレイヤーごとに見せてよい情報だけを組み立てる
  viewFor(playerId) {
    return {
      roomId: this.id,
      me: playerId,
      hostId: this.hostId,
      pendingHostId: this.pendingHostId,
      phase: this.phase,
      remainingMs: this.deadline ? Math.max(0, this.deadline - Date.now()) : null,
      notice: this.notice,
      limits: {
        nameMax: NAME_MAX,
        topicMax: TOPIC_MAX,
        minPlayers: MIN_PLAYERS,
        likeLimit: LIKE_LIMIT,
        uniqueLimit: UNIQUE_LIMIT,
      },
      settings: this.settings,
      settingRules: { ...SETTING_RULES, parentsPerLap: { min: 1, max: this.maxParentsPerLap() } },
      players: this.sortedPlayers().map((p) => ({
        id: p.id,
        name: p.name,
        icon: p.icon,
        role: p.role,
        pendingRole: p.pendingRole,
        stats: p.stats,
        connected: p.connected,
      })),
      game: this.game?.view(playerId) ?? null,
    };
  }
}

class RoomManager {
  constructor(io) {
    this.io = io;
    this.rooms = new Map();
  }

  create() {
    let id;
    do id = randomRoomId(); while (this.rooms.has(id));
    const room = new Room(id, this.io, (r) => this.rooms.delete(r.id));
    this.rooms.set(id, room);
    return room;
  }

  get(id) {
    return typeof id === 'string' ? this.rooms.get(id) : undefined;
  }
}

module.exports = { RoomManager };
