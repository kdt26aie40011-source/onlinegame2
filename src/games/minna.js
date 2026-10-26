// みんなでうろドロ：全員がお題を出し、全員が他の人のお題をすべて描き、全員で評価する
const {
  COLLECT_GRACE_MS, FALLBACK_TOPICS, RATE_LIKE_MS, RATE_UNIQUE_MS, LIKE_LIMIT, UNIQUE_LIMIT,
} = require('../constants');
const { randomItem, shuffle, randomId, isValidImage, parseTopic, rankBy, fail, OK } = require('../util');

const RATE_KINDS = {
  like: { phase: 'mlike', limit: LIKE_LIMIT, key: 'likes', label: 'いいね' },
  unique: { phase: 'munique', limit: UNIQUE_LIMIT, key: 'uniques', label: 'ユニーク' },
};

class MinnaGame {
  constructor(room, participantIds, settings) {
    this.mode = 'minna';
    this.room = room;
    this.participants = new Set(participantIds);
    this.topicTimeMs = settings.topicTimeSec * 1000;
    this.drawTimeMs = settings.drawTimeSec * 1000;
    this.topics = new Map(); // ownerId -> { id, ownerId, ownerName, text, auto, drawings: [] }
    this.order = []; // お題を出した人の並び（配り分けに使う）
    this.offsets = [];
    this.round = 0;
    this.totalRounds = 0;
    this.assignments = new Map(); // 描く人 -> お題を出した人（今のラウンド）
    this.submittedThisRound = new Set();
    this.evalTopics = [];
    this.evalIndex = 0;
  }

  start() {
    this.room.setPhase('mtopic', this.topicTimeMs, () => this.finishTopics());
  }

  // ---- 参加者 ----

  seated() {
    return this.room.sortedPlayers().map((p) => p.id).filter((id) => this.participants.has(id));
  }

  onDisconnect() {
    // 2分以内に戻れば、そのまま続きから参加できる
  }

  // 戻れなかった人は空席として扱う。出したお題と描いた絵は残す
  onRelease() {
    const { phase } = this.room;
    const playing = phase === 'mtopic' || phase === 'mdraw' || phase === 'mcollect';
    if (playing && this.seated().length < 2) {
      this.room.endGame('人数が足りなくなったため、ゲームを終了しました');
      return;
    }
    if (phase === 'mtopic' && this.allTopicsSubmitted()) this.finishTopics();
    if ((phase === 'mdraw' || phase === 'mcollect') && this.allDrawingsSubmitted()) this.startDrawRound();
  }

  // ---- お題入力 ----

  submitTopic(playerId, rawTopic) {
    if (this.room.phase !== 'mtopic' || !this.participants.has(playerId)) return fail('今はお題を入力できません');
    if (this.topics.has(playerId)) return fail('お題はもう決めています');
    const { topic, error } = parseTopic(rawTopic);
    if (error) return fail(error);

    this.addTopic(playerId, topic, false);
    if (this.allTopicsSubmitted()) this.finishTopics();
    else this.room.broadcast();
    return OK;
  }

  addTopic(ownerId, text, auto) {
    this.topics.set(ownerId, {
      id: randomId(),
      ownerId,
      ownerName: this.room.players.get(ownerId)?.name ?? '',
      text,
      auto,
      drawings: [], // { id, authorId, authorName, likes: Set, uniques: Set }
    });
  }

  allTopicsSubmitted() {
    return this.seated().every((id) => this.topics.has(id));
  }

  finishTopics() {
    // 時間内に決めなかった人のお題は、重ならないようにランダムで決める
    const used = new Set([...this.topics.values()].map((t) => t.text));
    for (const id of this.seated()) {
      if (this.topics.has(id)) continue;
      const choices = FALLBACK_TOPICS.filter((t) => !used.has(t));
      const text = randomItem(choices.length ? choices : FALLBACK_TOPICS);
      used.add(text);
      this.addTopic(id, text, true);
    }

    // 抜けた人が出したお題も残す（描く割り当てだけしない）
    this.order = shuffle([...this.topics.keys()]);
    this.totalRounds = this.order.length - 1;
    // ラウンド r では、並びで offset だけ先の人のお題を描く。
    // 全ラウンドで offset が 1〜N-1 を一度ずつ取るので、全員が自分以外のお題をちょうど1回ずつ描く
    this.offsets = shuffle(Array.from({ length: this.totalRounds }, (_, i) => i + 1));
    if (this.totalRounds < 1 || this.seated().length < 2) {
      this.room.endGame('人数が足りないため、ゲームを終了しました');
      return;
    }
    this.startDrawRound();
  }

  // ---- お絵描き ----

  startDrawRound() {
    const { room } = this;
    this.round++;
    if (this.round > this.totalRounds) return this.startEvaluation();
    room.applyPendingHost();

    const n = this.order.length;
    const offset = this.offsets[this.round - 1];
    this.assignments.clear();
    this.submittedThisRound.clear();
    this.order.forEach((drawerId, i) => {
      // 戻れなかった人は空席。以降のラウンドでは描く割り当てをしない
      if (!room.players.has(drawerId) || !this.participants.has(drawerId)) return;
      this.assignments.set(drawerId, this.order[(i + offset) % n]);
    });
    if (this.assignments.size === 0) return this.startEvaluation();

    room.setPhase('mdraw', this.drawTimeMs, () => {
      room.setPhase('mcollect', COLLECT_GRACE_MS, () => this.startDrawRound());
    });
  }

  submitDrawing(playerId, image) {
    const { room } = this;
    const ownerId = this.assignments.get(playerId);
    if ((room.phase !== 'mdraw' && room.phase !== 'mcollect') || !ownerId) return fail('今は絵を提出できません');
    if (this.submittedThisRound.has(playerId)) return fail('すでに提出しています');
    if (!isValidImage(image)) return fail('絵のデータが正しくありません');

    this.submittedThisRound.add(playerId);
    this.topics.get(ownerId).drawings.push({
      id: room.addImage(image),
      authorId: playerId,
      authorName: room.players.get(playerId).name,
      likes: new Set(),
      uniques: new Set(),
    });

    if (this.allDrawingsSubmitted()) this.startDrawRound();
    else room.broadcast();
    return OK;
  }

  allDrawingsSubmitted() {
    return [...this.assignments.keys()]
      .filter((id) => this.room.players.has(id))
      .every((id) => this.submittedThisRound.has(id));
  }

  // ---- 評価 ----

  startEvaluation() {
    this.assignments.clear();
    this.evalTopics = this.order.map((id) => this.topics.get(id)).filter((t) => t.drawings.length > 0);
    this.evalIndex = 0;
    if (this.evalTopics.length === 0) return this.showResults();
    this.startRatePhase();
  }

  currentEvalTopic() {
    return this.evalTopics[this.evalIndex];
  }

  startRatePhase() {
    this.room.applyPendingHost();
    this.room.setPhase('mlike', RATE_LIKE_MS, () => {
      this.settle('like');
      this.room.setPhase('munique', RATE_UNIQUE_MS, () => {
        this.settle('unique');
        this.evalIndex++;
        if (this.evalIndex < this.evalTopics.length) this.startRatePhase();
        else this.showResults();
      });
    });
  }

  // フェーズの終わりに、ついた数を成績に足して描いた人に知らせる（匿名）
  settle(kind) {
    const { key, label } = RATE_KINDS[kind];
    for (const drawing of this.currentEvalTopic().drawings) {
      const count = drawing[key].size;
      const author = this.room.players.get(drawing.authorId);
      if (!count || !author) continue;
      author.stats[key] += count;
      this.room.notifyPlayer(author.id, `あなたの絵に${label}が${count}つ付きました！`);
    }
  }

  // いいね・ユニークをつける／外す
  rate(playerId, kind, drawingId) {
    const rule = RATE_KINDS[kind];
    if (!rule || this.room.phase !== rule.phase) return fail('今は評価できません');
    if (!this.participants.has(playerId)) return fail('観戦中は評価できません');
    const topic = this.currentEvalTopic();
    const drawing = topic.drawings.find((d) => d.id === drawingId);
    if (!drawing) return fail('その絵は見つかりません');
    if (drawing.authorId === playerId) return fail('自分の絵には付けられません');

    const marks = drawing[rule.key];
    if (marks.has(playerId)) {
      marks.delete(playerId);
    } else {
      const used = topic.drawings.filter((d) => d[rule.key].has(playerId)).length;
      if (used >= rule.limit) return fail(`${rule.label}は1つのお題で${rule.limit}枚までです`);
      marks.add(playerId);
    }
    this.room.broadcast();
    return OK;
  }

  // ---- 結果発表 ----

  showResults() {
    this.room.setPhase('mresult', 0);
  }

  next() {
    if (this.room.phase !== 'mresult') return fail('今は進められません');
    this.room.endGame('ゲーム終了！おつかれさまでした');
    return OK;
  }

  // ---- 表示 ----

  view(playerId) {
    const { room } = this;
    const { phase } = room;
    const view = {
      mode: this.mode,
      isParticipant: this.participants.has(playerId),
      participantIds: [...this.participants],
      round: this.round,
      totalRounds: this.totalRounds,
    };

    if (phase === 'mtopic') {
      view.myTopic = this.topics.get(playerId)?.text ?? null;
      view.submittedCount = this.topics.size;
      view.submitTotal = this.seated().length;
    }

    if (phase === 'mdraw' || phase === 'mcollect') {
      const ownerId = this.assignments.get(playerId);
      const topic = ownerId && this.topics.get(ownerId);
      view.assignment = topic ? { topic: topic.text, auto: topic.auto } : null;
      view.submitted = this.submittedThisRound.has(playerId);
      view.submittedCount = this.submittedThisRound.size;
      view.submitTotal = [...this.assignments.keys()].filter((id) => room.players.has(id)).length;
    }

    if (phase === 'mlike' || phase === 'munique') {
      const kind = phase === 'mlike' ? 'like' : 'unique';
      const { key, limit } = RATE_KINDS[kind];
      const topic = this.currentEvalTopic();
      view.evaluation = {
        index: this.evalIndex + 1,
        total: this.evalTopics.length,
        topic: topic.text,
        isMyTopic: topic.ownerId === playerId,
        kind,
        limit,
        used: topic.drawings.filter((d) => d[key].has(playerId)).length,
        // 評価中は、誰が描いたか・誰のお題かは伏せる（自分の絵かどうかだけ分かる）
        drawings: topic.drawings.map((d) => ({
          id: d.id,
          url: room.imageUrl(d.id),
          mine: d.authorId === playerId,
          marked: d[key].has(playerId),
        })),
      };
    }

    if (phase === 'mresult') {
      view.results = this.order.map((id) => this.topics.get(id)).map((topic) => {
        const entry = (d, score) => ({
          id: d.id,
          url: room.imageUrl(d.id),
          authorId: d.authorId,
          authorName: d.authorName,
          score,
        });
        return {
          id: topic.id,
          text: topic.text,
          auto: topic.auto,
          ownerName: topic.ownerName,
          likeRanking: rankBy(topic.drawings, (d) => d.likes.size).map((r) => ({ ...entry(r.item, r.score), rank: r.rank })),
          uniqueRanking: rankBy(topic.drawings, (d) => d.uniques.size).map((r) => ({ ...entry(r.item, r.score), rank: r.rank })),
        };
      });
    }

    return view;
  }
}

module.exports = { MinnaGame };
