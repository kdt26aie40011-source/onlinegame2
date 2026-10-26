// うろドロ（通常モード）：親がお題を出し、子が描き、親が1位を選ぶ
const {
  MAX_PARENTS_PER_LAP, SELECT_TIME_MS, SELECT_TIME_MANY_MS, COLLECT_GRACE_MS,
  FALLBACK_TOPICS, TEASE_MESSAGES, PARENT_ABSENT_MESSAGE,
} = require('../constants');
const { randomItem, shuffle, isValidImage, parseTopic, fail, OK } = require('../util');

class NormalGame {
  constructor(room, participantIds, settings) {
    this.mode = 'normal';
    this.room = room;
    this.participants = new Set(participantIds);
    this.topicTimeMs = settings.topicTimeSec * 1000;
    this.drawTimeMs = settings.drawTimeSec * 1000;
    const count = participantIds.length;
    this.parentsPerLap = Math.min(settings.parentsPerLap ?? count, count, MAX_PARENTS_PER_LAP);
    this.laps = settings.laps;
    this.lap = 1;
    this.roundInLap = 0;
    this.doneParents = new Set();
    this.round = null;
  }

  start() {
    this.startRound();
  }

  // ---- 参加者 ----

  // 席がある（離席中を含む）参加者
  seated() {
    return this.room.sortedPlayers().map((p) => p.id).filter((id) => this.participants.has(id));
  }

  connected() {
    return this.seated().filter((id) => this.room.isConnected(id));
  }

  onDisconnect(playerId) {
    if (this.round?.parentId === playerId && this.room.phase === 'topic') this.redrawParent(playerId);
  }

  // 2分たっても戻らず席が解放された
  onRelease(playerId) {
    if (this.seated().length < 2) {
      this.room.endGame('人数が足りなくなったため、ゲームを終了しました');
      return;
    }
    const { phase } = this.room;
    if (this.round?.parentId === playerId && phase === 'select') {
      this.showResult({ message: PARENT_ABSENT_MESSAGE });
    } else if ((phase === 'draw' || phase === 'collect') && this.allChildrenSubmitted()) {
      this.finishDrawing();
    }
  }

  // ---- 進行 ----

  next() {
    if (this.room.phase !== 'result') return fail('今は進められません');
    this.room.notice = null;
    this.startRound();
    return OK;
  }

  startRound() {
    const { room } = this;
    room.applyPendingHost();
    room.clearImages();
    const seated = this.seated();
    // 参加者が減ったら、1周あたりの親の人数も合わせて下げる
    this.parentsPerLap = Math.min(this.parentsPerLap, seated.length);

    if (this.roundInLap >= this.parentsPerLap) {
      this.lap++;
      this.roundInLap = 0;
      this.doneParents.clear();
    }
    if (this.lap > this.laps) return room.endGame('ゲーム終了！おつかれさまでした');
    if (seated.length < 2) return room.endGame('人数が足りないため、ゲームを終了しました');

    this.roundInLap++;
    this.round = {
      parentId: this.pickParent(),
      topic: null,
      topicAuto: false,
      childIds: [],
      drawings: new Map(), // authorId -> { id, authorId, authorName, likedBy }
      order: [],
      winnerDrawingId: null,
      message: null,
    };
    room.setPhase('topic', this.topicTimeMs, () => this.onTopicTimeout());
  }

  // その周でまだ親になっていない、離席していない人から選ぶ
  pickParent() {
    const connected = this.connected();
    let candidates = connected.filter((id) => !this.doneParents.has(id));
    if (candidates.length === 0) candidates = connected;
    if (candidates.length === 0) candidates = this.seated();
    const parentId = randomItem(candidates);
    this.doneParents.add(parentId);
    return parentId;
  }

  // お題入力中に親が抜けたら、親を選び直してお題入力からやり直す
  redrawParent(oldParentId) {
    if (this.connected().length === 0) return;
    // 抜けた親は、その周で「親をやっていない」扱いにする
    this.doneParents.delete(oldParentId);
    this.round.parentId = this.pickParent();
    this.room.notice = '親が抜けたため、親を選び直しました';
    this.room.setPhase('topic', this.topicTimeMs, () => this.onTopicTimeout());
  }

  submitTopic(playerId, rawTopic) {
    if (this.room.phase !== 'topic' || this.round.parentId !== playerId) return fail('今はお題を入力できません');
    const { topic, error } = parseTopic(rawTopic);
    if (error) return fail(error);
    this.round.topic = topic;
    this.startDrawing();
    return OK;
  }

  onTopicTimeout() {
    this.round.topic = randomItem(FALLBACK_TOPICS);
    this.round.topicAuto = true;
    this.startDrawing();
  }

  startDrawing() {
    const { round } = this;
    // 離席中の子も、2分以内に戻れば続きから描けるように含めておく
    round.childIds = this.seated().filter((id) => id !== round.parentId);
    this.room.setPhase('draw', this.drawTimeMs, () => {
      // 時間切れ：各端末に「今の絵を送って」と伝え、少しだけ待つ
      this.room.setPhase('collect', COLLECT_GRACE_MS, () => this.finishDrawing());
    });
  }

  submitDrawing(playerId, image) {
    const { round, room } = this;
    if ((room.phase !== 'draw' && room.phase !== 'collect') || !round.childIds.includes(playerId)) {
      return fail('今は絵を提出できません');
    }
    if (round.drawings.has(playerId)) return fail('すでに提出しています');
    if (!isValidImage(image)) return fail('絵のデータが正しくありません');

    round.drawings.set(playerId, {
      id: room.addImage(image),
      authorId: playerId,
      authorName: room.players.get(playerId).name,
      likedBy: new Set(),
    });

    if (this.allChildrenSubmitted()) this.finishDrawing();
    else room.broadcast();
    return OK;
  }

  allChildrenSubmitted() {
    const { round, room } = this;
    return round.childIds.filter((id) => room.players.has(id)).every((id) => round.drawings.has(id));
  }

  finishDrawing() {
    const { round, room } = this;
    round.order = shuffle([...round.drawings.values()]);

    if (round.order.length === 0) return this.showResult({ message: '絵が1枚も届きませんでした' });
    // 1位選定タイムまでに親が戻っていなければ、選定をスキップする
    if (!room.isConnected(round.parentId)) return this.showResult({ message: PARENT_ABSENT_MESSAGE });

    const selectTime = round.childIds.length >= 10 ? SELECT_TIME_MANY_MS : SELECT_TIME_MS;
    room.setPhase('select', selectTime, () => {
      const parent = room.players.get(round.parentId);
      const message = parent?.connected
        ? randomItem(TEASE_MESSAGES).replace('{name}', parent.name)
        : PARENT_ABSENT_MESSAGE;
      this.showResult({ message });
    });
  }

  selectWinner(playerId, drawingId) {
    const { round, room } = this;
    if (room.phase !== 'select' || round.parentId !== playerId) return fail('今は1位を選べません');
    const drawing = round.order.find((d) => d.id === drawingId);
    if (!drawing) return fail('その絵は見つかりません');

    const author = room.players.get(drawing.authorId);
    if (author) author.stats.wins++;
    this.showResult({ winnerDrawingId: drawing.id });
    return OK;
  }

  showResult({ winnerDrawingId = null, message = null }) {
    this.round.winnerDrawingId = winnerDrawingId;
    this.round.message = message;
    this.room.setPhase('result', 0);
  }

  // 結果発表中の「いいね」
  rate(playerId, kind, drawingId) {
    const { round, room } = this;
    if (kind !== 'like' || room.phase !== 'result') return fail('今はいいねできません');
    // 観戦モード（観戦者・次のゲームから参加の人）は閲覧のみ
    if (!this.participants.has(playerId)) return fail('観戦中はいいねできません');
    const drawing = round.order.find((d) => d.id === drawingId);
    if (!drawing) return fail('その絵は見つかりません');
    if (drawing.authorId === playerId) return fail('自分の絵にはいいねできません');
    if (drawing.likedBy.has(playerId)) return fail('この絵にはもういいねしています');

    drawing.likedBy.add(playerId);
    const author = room.players.get(drawing.authorId);
    if (author) {
      author.stats.likes++;
      // いいねは匿名。誰が押したかは伝えない
      room.notifyPlayer(author.id, 'あなたの絵がいいねされました！');
    }
    room.broadcast();
    return OK;
  }

  // ---- 表示 ----

  view(playerId) {
    const { round, room } = this;
    const { phase } = room;
    const showDrawings = phase === 'select' || phase === 'result';
    const reveal = phase === 'result';

    return {
      mode: this.mode,
      isParticipant: this.participants.has(playerId),
      participantIds: [...this.participants],
      lap: this.lap,
      laps: this.laps,
      round: this.roundInLap,
      roundsPerLap: this.parentsPerLap,
      parentId: round.parentId,
      topic: phase === 'topic' ? null : round.topic,
      topicAuto: round.topicAuto,
      childIds: round.childIds,
      submitted: round.drawings.has(playerId),
      submittedCount: round.drawings.size,
      drawings: showDrawings
        ? round.order.map((d) => ({
          id: d.id,
          url: room.imageUrl(d.id),
          authorId: reveal ? d.authorId : null,
          authorName: reveal ? d.authorName : null,
          likeCount: reveal ? d.likedBy.size : 0,
          likedByMe: reveal && d.likedBy.has(playerId),
        }))
        : null,
      winnerDrawingId: reveal ? round.winnerDrawingId : null,
      message: reveal ? round.message : null,
    };
  }
}

module.exports = { NormalGame };
