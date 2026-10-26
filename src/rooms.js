const crypto = require('crypto');

const ROOM_ID_LENGTH = 12;
const ROOM_ID_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
const NAME_MAX = 9;
const TOPIC_MAX = 20;
const MAX_PARENTS_PER_LAP = 9;

// ステップ1では制限時間は固定値
const TOPIC_TIME_MS = 30_000;
const DRAW_TIME_MS = 100_000;
const SELECT_TIME_MS = 15_000;
const SELECT_TIME_MANY_MS = 30_000; // 子が10人以上のとき
const COLLECT_GRACE_MS = 3_000; // 時間切れ後、各端末から絵が届くのを待つ時間
const EMPTY_ROOM_TTL_MS = 120_000;

const IMAGE_MAX_LENGTH = 2_000_000;
const IMAGE_PATTERN = /^data:image\/png;base64,[A-Za-z0-9+/]+=*$/;

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

class Room {
  constructor(id, io, onClose) {
    this.id = id;
    this.io = io;
    this.onClose = onClose;
    this.players = new Map(); // playerId -> { id, name, socketId, order }
    this.nextOrder = 0;
    this.hostId = null;
    this.phase = 'lobby'; // lobby | topic | draw | collect | select | result
    this.game = null;
    this.timer = null;
    this.deadline = null;
    this.notice = null;
    this.emptyTimer = null;
    this.scheduleCloseIfEmpty();
  }

  // ---- 入退室 ----

  join(socket, rawName) {
    const name = typeof rawName === 'string' ? rawName.trim() : '';
    if (!name) return { ok: false, error: '名前を入力してください' };
    if ([...name].length > NAME_MAX) return { ok: false, error: `名前は${NAME_MAX}文字までです` };

    const id = crypto.randomUUID();
    this.players.set(id, { id, name, socketId: socket.id, order: this.nextOrder++ });
    if (!this.hostId) this.hostId = id;
    socket.join(this.id);
    clearTimeout(this.emptyTimer);
    this.emptyTimer = null;
    return { ok: true, playerId: id };
  }

  leave(playerId) {
    if (!this.players.delete(playerId)) return;

    if (this.players.size === 0) {
      this.clearTimer();
      this.game = null;
      this.phase = 'lobby';
      this.hostId = null;
      this.scheduleCloseIfEmpty();
      return;
    }

    if (this.hostId === playerId) this.hostId = this.sortedPlayers()[0].id;

    if (this.game) this.handleLeaveDuringGame(playerId);
    this.broadcast();
  }

  handleLeaveDuringGame(playerId) {
    const g = this.game;
    if (this.presentParticipants().length < 2) {
      this.endGame('人数が足りなくなったため、ゲームを終了しました');
      return;
    }
    const round = g.round;
    if (!round) return;

    if (round.parentId === playerId) {
      if (this.phase === 'topic') {
        // 抜けた親は「この周で親をやっていない」扱いにして再抽選
        g.doneParents.delete(playerId);
        round.parentId = this.pickParent(this.presentParticipants());
        this.notice = '親が抜けたため、親を選び直しました';
        this.setPhase('topic', TOPIC_TIME_MS, () => this.onTopicTimeout());
      } else if (this.phase === 'select') {
        this.showResult({ message: '親が不在のため今回は1位なしです' });
      }
      // お絵描き中はそのまま続行し、1位選定の直前に判断する
      return;
    }

    if ((this.phase === 'draw' || this.phase === 'collect') && this.allChildrenSubmitted()) {
      this.finishDrawing();
    }
  }

  scheduleCloseIfEmpty() {
    clearTimeout(this.emptyTimer);
    this.emptyTimer = setTimeout(() => {
      if (this.players.size === 0) this.onClose(this);
    }, EMPTY_ROOM_TTL_MS);
  }

  close() {
    this.clearTimer();
    clearTimeout(this.emptyTimer);
  }

  // ---- ゲーム進行 ----

  startGame(playerId) {
    if (playerId !== this.hostId) return { ok: false, error: 'ホストだけが開始できます' };
    if (this.phase !== 'lobby') return { ok: false, error: 'ゲームはすでに始まっています' };
    const ids = this.sortedPlayers().map((p) => p.id);
    if (ids.length < 2) return { ok: false, error: '2人以上で開始できます' };

    this.notice = null;
    this.game = {
      participants: new Set(ids),
      parentsPerLap: Math.min(ids.length, MAX_PARENTS_PER_LAP),
      laps: 1,
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
    const present = this.presentParticipants();
    // 参加者が減ったら、1周あたりの親の人数も合わせて下げる
    g.parentsPerLap = Math.min(g.parentsPerLap, present.length);

    if (g.roundInLap >= g.parentsPerLap) {
      g.lap++;
      g.roundInLap = 0;
      g.doneParents.clear();
    }
    if (g.lap > g.laps) return this.endGame('ゲーム終了！おつかれさまでした');
    if (present.length < 2) return this.endGame('人数が足りないため、ゲームを終了しました');

    g.roundInLap++;
    g.round = {
      parentId: this.pickParent(present),
      topic: null,
      topicAuto: false,
      childIds: [],
      drawings: new Map(), // authorId -> { id, authorId, authorName, image }
      order: [],
      winnerDrawingId: null,
      message: null,
    };
    this.setPhase('topic', TOPIC_TIME_MS, () => this.onTopicTimeout());
  }

  pickParent(present) {
    const g = this.game;
    let candidates = present.filter((id) => !g.doneParents.has(id));
    if (candidates.length === 0) candidates = present;
    const parentId = randomItem(candidates);
    g.doneParents.add(parentId);
    return parentId;
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
    round.childIds = this.presentParticipants().filter((id) => id !== round.parentId);
    this.setPhase('draw', DRAW_TIME_MS, () => {
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
    if (!this.players.has(round.parentId)) return this.showResult({ message: '親が不在のため今回は1位なしです' });

    const selectTime = round.childIds.length >= 10 ? SELECT_TIME_MANY_MS : SELECT_TIME_MS;
    this.setPhase('select', selectTime, () => {
      const parent = this.players.get(round.parentId);
      const message = parent
        ? randomItem(TEASE_MESSAGES).replace('{name}', parent.name)
        : '親が不在のため今回は1位なしです';
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
    this.showResult({ winnerDrawingId: drawing.id });
    return { ok: true };
  }

  showResult({ winnerDrawingId = null, message = null }) {
    const round = this.game.round;
    round.winnerDrawingId = winnerDrawingId;
    round.message = message;
    this.setPhase('result', 0);
  }

  endGame(notice) {
    this.clearTimer();
    this.game = null;
    this.phase = 'lobby';
    this.notice = notice;
    this.broadcast();
  }

  // ---- 内部ヘルパー ----

  setPhase(phase, durationMs, onTimeout) {
    this.clearTimer();
    this.phase = phase;
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

  sortedPlayers() {
    return [...this.players.values()].sort((a, b) => a.order - b.order);
  }

  presentParticipants() {
    if (!this.game) return [];
    return this.sortedPlayers().map((p) => p.id).filter((id) => this.game.participants.has(id));
  }

  broadcast() {
    for (const player of this.players.values()) {
      this.io.to(player.socketId).emit('state', this.viewFor(player.id));
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
      phase: this.phase,
      remainingMs: this.deadline ? Math.max(0, this.deadline - Date.now()) : null,
      notice: this.notice,
      limits: { nameMax: NAME_MAX, topicMax: TOPIC_MAX },
      players: this.sortedPlayers().map((p) => ({
        id: p.id,
        name: p.name,
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
    const room = new Room(id, this.io, (r) => this.remove(r));
    this.rooms.set(id, room);
    return room;
  }

  get(id) {
    return typeof id === 'string' ? this.rooms.get(id) : undefined;
  }

  remove(room) {
    room.close();
    this.rooms.delete(room.id);
  }
}

module.exports = { RoomManager };
