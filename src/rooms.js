const crypto = require('crypto');

const ROOM_ID_LENGTH = 12;
const ROOM_ID_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
const NAME_MAX = 9;
const TOPIC_MAX = 20;
const MAX_PARTICIPANTS = 9;
const MAX_PARENTS_PER_LAP = 9;

// デフォルメ動物のアイコン（重複可）
const ICONS = ['🐶', '🐱', '🐰', '🐻', '🐼', '🦊', '🐸', '🐷', '🐵', '🐯', '🐨', '🐹', '🐧', '🐮', '🐔', '🦁'];

// ホストが変更できるゲーム設定の範囲
const SETTING_RULES = {
  topicTimeSec: { min: 20, max: 50, step: 5, initial: 30 },
  drawTimeSec: { min: 30, max: 200, step: 10, initial: 100 },
  laps: { min: 1, max: 3, step: 1, initial: 1 },
};

const SELECT_TIME_MS = 15_000;
const SELECT_TIME_MANY_MS = 30_000; // 子が10人以上のとき
const COLLECT_GRACE_MS = 3_000; // 時間切れ後、各端末から絵が届くのを待つ時間
const SEAT_HOLD_MS = Number(process.env.SEAT_HOLD_MS) || 120_000; // 切断・退出後に席を保持する時間
const EMPTY_ROOM_TTL_MS = Number(process.env.EMPTY_ROOM_TTL_MS) || 120_000;

// ホストの操作でしか進まない場面。ここではホストが抜けたら即時に引き継ぐ
const HOST_DRIVEN_PHASES = new Set(['lobby', 'result']);

const IMAGE_MAX_LENGTH = 2_000_000;
const IMAGE_PATTERN = /^data:image\/png;base64,[A-Za-z0-9+/]+=*$/;

const PARENT_ABSENT_MESSAGE = '親が不在のため今回は1位なしです';

// 親が時間内にお題を決めなかったときに使うお題
const FALLBACK_TOPICS = [
  'キリン', 'ペンギン', 'タコ', 'ピアノ', '自転車', '消防車', 'ひまわり',
  '雪だるま', 'ハンバーガー', 'ソフトクリーム', '新幹線', 'カブトムシ',
];

// 親が時間内に1位を選ばなかったときのメッセージ
const TEASE_MESSAGES = [
  '{name}は優柔不断です',
  '{name}は全部1位にしたかったようです',
  '{name}は見とれていて時間を忘れました',
  '{name}はまだ迷っています',
  '{name}には選べませんでした…',
  '{name}は決断力を家に忘れてきました',
  '{name}の心はまだ揺れています',
  '{name}は審査を放棄しました',
  '{name}はうろ覚えすぎて選べませんでした',
  '{name}、あとでみんなに謝りましょう',
];

const randomItem = (list) => list[crypto.randomInt(list.length)];

function shuffle(list) {
  const copy = [...list];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

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
    // playerId -> { id, token, name, icon, socketId, connected, order, stats, releaseTimer }
    this.players = new Map();
    this.nextOrder = 0;
    this.hostId = null;
    this.pendingHostId = null; // 手動譲渡の予約（ラウンドの切り替わりで反映）
    this.settings = {
      topicTimeSec: SETTING_RULES.topicTimeSec.initial,
      drawTimeSec: SETTING_RULES.drawTimeSec.initial,
      parentsPerLap: null, // null は「全員」
      laps: SETTING_RULES.laps.initial,
    };
    this.phase = 'lobby'; // lobby | topic | draw | collect | select | result
    this.game = null;
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
    return { icons: ICONS, nameMax: NAME_MAX, full: this.isFull() };
  }

  // 離席中で席を保持している人も1人に数える
  isFull() {
    return this.players.size >= MAX_PARTICIPANTS;
  }

  join(socket, rawName, icon) {
    const name = typeof rawName === 'string' ? rawName.trim() : '';
    if (!name) return { ok: false, error: '名前を入力してください' };
    if ([...name].length > NAME_MAX) return { ok: false, error: `名前は${NAME_MAX}文字までです` };
    if (!ICONS.includes(icon)) return { ok: false, error: 'アイコンを選んでください' };
    if (this.isFull()) return { ok: false, error: '部屋が満員です' };
    if ([...this.players.values()].some((p) => p.name === name)) {
      return { ok: false, error: '同じ名前の人がすでに部屋にいます。別の名前にしてください' };
    }

    const player = {
      id: crypto.randomUUID(),
      token: crypto.randomBytes(24).toString('base64url'),
      name,
      icon,
      socketId: null,
      connected: false,
      order: this.nextOrder++,
      stats: { wins: 0, likes: 0 },
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
      return { ok: false, error: '席が見つかりません。2分以上たったか、部屋が終了した可能性があります' };
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

    const round = this.game?.round;
    if (round && round.parentId === playerId && this.phase === 'topic') {
      this.redrawParent(playerId);
    }
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
      this.scheduleCloseIfEmpty();
      return;
    }

    if (this.hostId === playerId) this.changeHost(this.nextHostCandidate() ?? this.sortedPlayers()[0]);
    this.clampParentsSetting();
    if (this.game) this.handleReleaseDuringGame(playerId);
    this.broadcast();
  }

  handleReleaseDuringGame(playerId) {
    if (this.seatedParticipants().length < 2) {
      this.endGame('人数が足りなくなったため、ゲームを終了しました');
      return;
    }
    const round = this.game.round;
    if (!round) return;

    if (round.parentId === playerId && this.phase === 'select') {
      this.showResult({ message: PARENT_ABSENT_MESSAGE });
      return;
    }
    if ((this.phase === 'draw' || this.phase === 'collect') && this.allChildrenSubmitted()) {
      this.finishDrawing();
    }
  }

  scheduleCloseIfEmpty() {
    clearTimeout(this.emptyTimer);
    this.emptyTimer = setTimeout(() => {
      if (this.connectedPlayers().length === 0) this.close();
    }, EMPTY_ROOM_TTL_MS);
  }

  // ホストによる強制終了
  forceClose(playerId) {
    if (playerId !== this.hostId) return { ok: false, error: 'ホストだけが部屋を終了できます' };
    this.io.to(this.id).emit('room:closed');
    this.close();
    return { ok: true };
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
    this.onClose(this);
  }

  // ---- ホスト権限 ----

  transferHost(playerId, targetId) {
    if (playerId !== this.hostId) return { ok: false, error: 'ホストだけが譲渡できます' };
    const target = this.players.get(targetId);
    if (!target || targetId === playerId) return { ok: false, error: 'その人には譲渡できません' };
    if (!target.connected) return { ok: false, error: '離席中の人には譲渡できません' };

    if (this.phase === 'lobby') {
      this.changeHost(target);
    } else {
      // ゲーム中はラウンドが切り替わるタイミングで反映する
      this.pendingHostId = targetId;
      this.notifyAll(`👑 次のラウンドから${target.name}さんがホストになります`);
    }
    this.broadcast();
    return { ok: true };
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
    if (playerId !== this.hostId) return { ok: false, error: 'ホストだけが設定を変更できます' };
    if (this.phase !== 'lobby') return { ok: false, error: 'ゲーム中は設定を変更できません' };

    const next = { ...this.settings };
    for (const [key, rule] of Object.entries(SETTING_RULES)) {
      if (input[key] === undefined) continue;
      const value = input[key];
      if (!Number.isInteger(value) || value < rule.min || value > rule.max || (value - rule.min) % rule.step !== 0) {
        return { ok: false, error: '設定の値が正しくありません' };
      }
      next[key] = value;
    }
    if (input.parentsPerLap !== undefined) {
      const value = input.parentsPerLap;
      if (value !== null && (!Number.isInteger(value) || value < 1 || value > this.maxParentsPerLap())) {
        return { ok: false, error: '親の人数が正しくありません' };
      }
      next.parentsPerLap = value;
    }

    this.settings = next;
    this.broadcast();
    return { ok: true };
  }

  maxParentsPerLap() {
    return Math.max(1, Math.min(this.players.size, MAX_PARENTS_PER_LAP));
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
    if (playerId !== this.hostId) return { ok: false, error: 'ホストだけが開始できます' };
    if (this.phase !== 'lobby') return { ok: false, error: 'ゲームはすでに始まっています' };
    const ids = this.sortedPlayers().map((p) => p.id);
    if (ids.length < 2) return { ok: false, error: '2人以上で開始できます' };

    const { topicTimeSec, drawTimeSec, parentsPerLap, laps } = this.settings;
    this.notice = null;
    this.game = {
      participants: new Set(ids),
      topicTimeMs: topicTimeSec * 1000,
      drawTimeMs: drawTimeSec * 1000,
      parentsPerLap: Math.min(parentsPerLap ?? ids.length, ids.length, MAX_PARENTS_PER_LAP),
      laps,
      lap: 1,
      roundInLap: 0,
      doneParents: new Set(),
      round: null,
    };
    this.startRound();
    return { ok: true };
  }

  next(playerId) {
    if (playerId !== this.hostId) return { ok: false, error: 'ホストだけが進められます' };
    if (this.phase !== 'result') return { ok: false, error: '今は進められません' };
    this.notice = null;
    this.startRound();
    return { ok: true };
  }

  startRound() {
    const g = this.game;
    this.applyPendingHost();
    const seated = this.seatedParticipants();
    // 参加者が減ったら、1周あたりの親の人数も合わせて下げる
    g.parentsPerLap = Math.min(g.parentsPerLap, seated.length);

    if (g.roundInLap >= g.parentsPerLap) {
      g.lap++;
      g.roundInLap = 0;
      g.doneParents.clear();
    }
    if (g.lap > g.laps) return this.endGame('ゲーム終了！おつかれさまでした');
    if (seated.length < 2) return this.endGame('人数が足りないため、ゲームを終了しました');

    g.roundInLap++;
    g.round = {
      parentId: this.pickParent(),
      topic: null,
      topicAuto: false,
      childIds: [],
      drawings: new Map(), // authorId -> { id, authorId, authorName, image, likedBy }
      order: [],
      winnerDrawingId: null,
      message: null,
    };
    this.setPhase('topic', g.topicTimeMs, () => this.onTopicTimeout());
  }

  // その周でまだ親になっていない、離席していない人から選ぶ
  pickParent() {
    const g = this.game;
    const connected = this.connectedParticipants();
    let candidates = connected.filter((id) => !g.doneParents.has(id));
    if (candidates.length === 0) candidates = connected;
    if (candidates.length === 0) candidates = this.seatedParticipants();
    const parentId = randomItem(candidates);
    g.doneParents.add(parentId);
    return parentId;
  }

  // お題入力中に親が抜けたら、親を選び直してお題入力からやり直す
  redrawParent(oldParentId) {
    const g = this.game;
    if (this.connectedParticipants().length === 0) return;
    // 抜けた親は、その周で「親をやっていない」扱いにする
    g.doneParents.delete(oldParentId);
    g.round.parentId = this.pickParent();
    this.notice = '親が抜けたため、親を選び直しました';
    this.setPhase('topic', g.topicTimeMs, () => this.onTopicTimeout());
  }

  submitTopic(playerId, rawTopic) {
    const round = this.game?.round;
    if (this.phase !== 'topic' || round.parentId !== playerId) {
      return { ok: false, error: '今はお題を入力できません' };
    }
    const topic = typeof rawTopic === 'string' ? rawTopic.trim() : '';
    if (!topic) return { ok: false, error: 'お題を入力してください' };
    if ([...topic].length > TOPIC_MAX) return { ok: false, error: `お題は${TOPIC_MAX}文字までです` };

    round.topic = topic;
    this.startDrawing();
    return { ok: true };
  }

  onTopicTimeout() {
    const round = this.game.round;
    round.topic = randomItem(FALLBACK_TOPICS);
    round.topicAuto = true;
    this.startDrawing();
  }

  startDrawing() {
    const round = this.game.round;
    // 離席中の子も、2分以内に戻れば続きから描けるように含めておく
    round.childIds = this.seatedParticipants().filter((id) => id !== round.parentId);
    this.setPhase('draw', this.game.drawTimeMs, () => {
      // 時間切れ：各端末に「今の絵を送って」と伝え、少しだけ待つ
      this.setPhase('collect', COLLECT_GRACE_MS, () => this.finishDrawing());
    });
  }

  submitDrawing(playerId, image) {
    const round = this.game?.round;
    if ((this.phase !== 'draw' && this.phase !== 'collect') || !round.childIds.includes(playerId)) {
      return { ok: false, error: '今は絵を提出できません' };
    }
    if (round.drawings.has(playerId)) return { ok: false, error: 'すでに提出しています' };
    if (typeof image !== 'string' || image.length > IMAGE_MAX_LENGTH || !IMAGE_PATTERN.test(image)) {
      return { ok: false, error: '絵のデータが正しくありません' };
    }

    const player = this.players.get(playerId);
    round.drawings.set(playerId, {
      id: crypto.randomBytes(6).toString('hex'),
      authorId: playerId,
      authorName: player.name,
      image,
      likedBy: new Set(),
    });

    if (this.allChildrenSubmitted()) this.finishDrawing();
    else this.broadcast();
    return { ok: true };
  }

  allChildrenSubmitted() {
    const round = this.game.round;
    return round.childIds
      .filter((id) => this.players.has(id))
      .every((id) => round.drawings.has(id));
  }

  finishDrawing() {
    const round = this.game.round;
    round.order = shuffle([...round.drawings.values()]);

    if (round.order.length === 0) return this.showResult({ message: '絵が1枚も届きませんでした' });
    // 1位選定タイムまでに親が戻っていなければ、選定をスキップする
    if (!this.isConnected(round.parentId)) return this.showResult({ message: PARENT_ABSENT_MESSAGE });

    const selectTime = round.childIds.length >= 10 ? SELECT_TIME_MANY_MS : SELECT_TIME_MS;
    this.setPhase('select', selectTime, () => {
      const parent = this.players.get(round.parentId);
      const message = parent?.connected
        ? randomItem(TEASE_MESSAGES).replace('{name}', parent.name)
        : PARENT_ABSENT_MESSAGE;
      this.showResult({ message });
    });
  }

  selectWinner(playerId, drawingId) {
    const round = this.game?.round;
    if (this.phase !== 'select' || round.parentId !== playerId) {
      return { ok: false, error: '今は1位を選べません' };
    }
    const drawing = round.order.find((d) => d.id === drawingId);
    if (!drawing) return { ok: false, error: 'その絵は見つかりません' };

    const author = this.players.get(drawing.authorId);
    if (author) author.stats.wins++;
    this.showResult({ winnerDrawingId: drawing.id });
    return { ok: true };
  }

  showResult({ winnerDrawingId = null, message = null }) {
    const round = this.game.round;
    round.winnerDrawingId = winnerDrawingId;
    round.message = message;
    this.setPhase('result', 0);
  }

  like(playerId, drawingId) {
    const round = this.game?.round;
    if (this.phase !== 'result') return { ok: false, error: '今はいいねできません' };
    // 観戦モード（次のゲームから参加の人）は閲覧のみ
    if (!this.game.participants.has(playerId)) return { ok: false, error: '観戦中はいいねできません' };
    const drawing = round.order.find((d) => d.id === drawingId);
    if (!drawing) return { ok: false, error: 'その絵は見つかりません' };
    if (drawing.authorId === playerId) return { ok: false, error: '自分の絵にはいいねできません' };
    if (drawing.likedBy.has(playerId)) return { ok: false, error: 'この絵にはもういいねしています' };

    drawing.likedBy.add(playerId);
    const author = this.players.get(drawing.authorId);
    if (author) {
      author.stats.likes++;
      // いいねは匿名。誰が押したかは伝えない
      if (author.socketId) this.io.to(author.socketId).emit('notify', { message: 'あなたの絵がいいねされました！' });
    }
    this.broadcast();
    return { ok: true };
  }

  endGame(notice) {
    this.clearTimer();
    this.game = null;
    this.phase = 'lobby';
    this.notice = notice;
    this.applyPendingHost();
    this.ensureHost();
    this.broadcast();
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

  isConnected(playerId) {
    return !!this.players.get(playerId)?.connected;
  }

  sortedPlayers() {
    return [...this.players.values()].sort((a, b) => a.order - b.order);
  }

  connectedPlayers() {
    return this.sortedPlayers().filter((p) => p.connected);
  }

  // 席がある（離席中を含む）ゲーム参加者
  seatedParticipants() {
    if (!this.game) return [];
    return this.sortedPlayers().map((p) => p.id).filter((id) => this.game.participants.has(id));
  }

  connectedParticipants() {
    return this.seatedParticipants().filter((id) => this.isConnected(id));
  }

  broadcast() {
    if (this.closed) return;
    for (const player of this.players.values()) {
      if (player.socketId) this.io.to(player.socketId).emit('state', this.viewFor(player.id));
    }
  }

  // プレイヤーごとに見せてよい情報だけを組み立てる
  viewFor(playerId) {
    const g = this.game;
    const round = g?.round;
    const showDrawings = this.phase === 'select' || this.phase === 'result';
    const revealAuthors = this.phase === 'result';

    return {
      roomId: this.id,
      me: playerId,
      hostId: this.hostId,
      pendingHostId: this.pendingHostId,
      phase: this.phase,
      remainingMs: this.deadline ? Math.max(0, this.deadline - Date.now()) : null,
      notice: this.notice,
      limits: { nameMax: NAME_MAX, topicMax: TOPIC_MAX },
      settings: this.settings,
      settingRules: { ...SETTING_RULES, parentsPerLap: { min: 1, max: this.maxParentsPerLap() } },
      players: this.sortedPlayers().map((p) => ({
        id: p.id,
        name: p.name,
        icon: p.icon,
        stats: p.stats,
        connected: p.connected,
        inGame: g ? g.participants.has(p.id) : false,
      })),
      game: g && round && {
        lap: g.lap,
        laps: g.laps,
        round: g.roundInLap,
        roundsPerLap: g.parentsPerLap,
        parentId: round.parentId,
        topic: this.phase === 'topic' ? null : round.topic,
        topicAuto: round.topicAuto,
        childIds: round.childIds,
        submitted: round.drawings.has(playerId),
        submittedCount: round.drawings.size,
        drawings: showDrawings
          ? round.order.map((d) => ({
            id: d.id,
            image: d.image,
            authorId: revealAuthors ? d.authorId : null,
            authorName: revealAuthors ? d.authorName : null,
            likeCount: revealAuthors ? d.likedBy.size : 0,
            likedByMe: revealAuthors && d.likedBy.has(playerId),
          }))
          : null,
        winnerDrawingId: revealAuthors ? round.winnerDrawingId : null,
        message: revealAuthors ? round.message : null,
      },
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
