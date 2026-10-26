// ステップ5：みんなでうろドロ（サーバーは RATE_PHASE_MS=1500 SEAT_HOLD_MS=3000 で起動）
const { URL, PNG, check, createRoom, joinAs, finish } = require('./lib');

(async () => {
  const room = await createRoom();
  const A = await joinAs(room, 'A');
  const B = await joinAs(room, 'B');
  const S = await joinAs(room, 'S', 'spectator');
  const players = { A, B };

  check(!(await B.emit('settings:update', { mode: 'minna' })).ok, 'non-host cannot change mode');
  check(!(await A.emit('settings:update', { mode: 'chaos' })).ok, 'invalid mode rejected');
  check((await A.emit('settings:update', { mode: 'minna', drawTimeSec: 30 })).ok, 'host sets minna mode');
  let r = await A.emit('game:start');
  check(!r.ok && r.error.includes('3人以上'), 'minna needs 3 participants');

  for (const n of ['C', 'D', 'E']) players[n] = await joinAs(room, n);
  const nameOf = (id) => Object.keys(players).find((n) => players[n].id === id);
  await A.waitFor((s) => s.players.length === 6);
  check((await A.emit('game:start')).ok, 'minna game starts with 5');

  // ---- お題入力（全員） ----
  let st = await A.waitFor((s) => s.phase === 'mtopic');
  check(st.game.mode === 'minna' && st.game.submitTotal === 5, 'mtopic: 5 people to submit');
  check(!(await S.emit('topic:submit', { topic: 'x' })).ok, 'spectator cannot submit topic');
  for (const [n, c] of Object.entries(players)) {
    check((await c.emit('topic:submit', { topic: `お題${n}` })).ok, `${n} submits topic`);
    if (n === 'A') check(!(await A.emit('topic:submit', { topic: 'again' })).ok, 'second topic rejected');
  }

  // ---- お絵描き（参加人数-1 = 4ラウンド）。Eは2ラウンド目に抜けて戻らない ----
  const E = players.E;
  let active = Object.values(players);
  const drawn = {};
  for (let round = 1; round <= 4; round++) {
    st = await A.waitFor((s) => s.phase === 'mdraw' && s.game.round === round, 15000);
    if (round === 1) check(st.game.totalRounds === 4, 'total rounds = 4');
    if (round === 3) check(!st.players.find((p) => p.id === E.id), 'E released (empty seat), game continues');
    // 各端末にそのラウンドの状態が届くまで待つ
    for (const c of active) await c.waitFor((s) => s.phase === 'mdraw' && s.game.round === round);
    const topics = active.map((c) => c.state.game.assignment?.topic);
    check(topics.every(Boolean) && new Set(topics).size === active.length, `r${round}: ${active.length} distinct topics dealt`);
    if (round === 1) check(S.state.game.assignment === null, 'spectator has no assignment');
    for (const c of active) {
      const n = nameOf(c.id);
      const t = c.state.game.assignment.topic;
      if (t === `お題${n}`) check(false, `r${round}: ${n} got own topic`);
      (drawn[n] ??= []).push(t);
    }
    if (round === 2) {
      E.s.disconnect();
      active = active.filter((c) => c !== E);
    }
    for (const c of active) {
      check((await c.emit('drawing:submit', { image: PNG })).ok, `r${round}: ${nameOf(c.id)} submits`);
      if (c === A && round === 1) check(!(await A.emit('drawing:submit', { image: PNG })).ok, 'double submit rejected');
    }
  }
  for (const n of ['A', 'B', 'C', 'D']) {
    const others = ['A', 'B', 'C', 'D', 'E'].filter((x) => x !== n).map((x) => `お題${x}`).sort();
    check(JSON.stringify([...drawn[n]].sort()) === JSON.stringify(others), `${n} drew every other topic exactly once`);
  }

  // ---- 評価（お題ごとに いいね → ユニーク） ----
  st = await A.waitFor((s) => s.phase === 'mlike');
  check(st.game.evaluation.total === 5, "evaluating 5 topics (E's topic kept)");
  check(st.game.evaluation.drawings.every((d) => !('authorId' in d) && !('authorName' in d)), 'authors hidden during evaluation');

  // Aのお題の評価になるまで進める
  st = await A.waitFor((s) => s.phase === 'mlike' && s.game.evaluation.isMyTopic, 30000);
  const ev = st.game.evaluation;
  const n = ev.drawings.length;
  check(n >= 3 && ev.drawings.every((d) => !d.mine), `own topic: A can rate all ${n} drawings`);
  for (const d of ev.drawings.slice(0, 3)) check((await A.emit('drawing:rate', { kind: 'like', drawingId: d.id })).ok, 'A likes a drawing');
  if (n > 3) {
    r = await A.emit('drawing:rate', { kind: 'like', drawingId: ev.drawings[3].id });
    check(!r.ok && r.error.includes('3枚まで'), 'like 4th rejected (max 3)');
  }
  check((await A.emit('drawing:rate', { kind: 'like', drawingId: ev.drawings[2].id })).ok, 'A un-likes one (toggle)');
  await A.waitFor((s) => s.game?.evaluation?.used === 2);
  check(true, 'like count back to 2');
  check(!(await A.emit('drawing:rate', { kind: 'unique', drawingId: ev.drawings[0].id })).ok, 'unique not allowed in like phase');
  check(!(await S.emit('drawing:rate', { kind: 'like', drawingId: ev.drawings[0].id })).ok, 'spectator cannot rate');
  const own = B.state.game.evaluation.drawings.find((d) => d.mine);
  if (own) check(!(await B.emit('drawing:rate', { kind: 'like', drawingId: own.id })).ok, 'cannot like own drawing');

  st = await A.waitFor((s) => s.phase === 'munique');
  check((await A.emit('drawing:rate', { kind: 'unique', drawingId: ev.drawings[0].id })).ok, 'unique 1');
  check((await A.emit('drawing:rate', { kind: 'unique', drawingId: ev.drawings[1].id })).ok, 'unique 2');
  r = await A.emit('drawing:rate', { kind: 'unique', drawingId: ev.drawings[2].id });
  check(!r.ok && r.error.includes('2枚まで'), 'unique 3rd rejected (max 2)');

  // ---- 結果発表 ----
  st = await A.waitFor((s) => s.phase === 'mresult', 30000);
  const results = st.game.results;
  check(results.length === 5, '5 topic results');
  const mine = results.find((t) => t.text === 'お題A');
  const ranks = mine.likeRanking.map((e) => `${e.rank}:${e.score}`).join(' ');
  const expected = [...Array(n)].map((_, i) => (i < 2 ? '1:1' : `3:0`)).join(' ');
  check(ranks === expected, `tied ranks (${ranks})`);
  check(mine.uniqueRanking.filter((e) => e.score === 1).length === 2, 'unique ranking counts');
  check(mine.likeRanking.every((e) => e.authorName), 'authors revealed in results');
  const totals = st.players.reduce((acc, p) => ({ likes: acc.likes + p.stats.likes, uniques: acc.uniques + p.stats.uniques }), { likes: 0, uniques: 0 });
  // 席が解放された人（E）の成績は消えるので、残っている人の分だけ数える
  const present = (e) => st.players.some((p) => p.id === e.authorId);
  const sum = (list) => list.filter(present).reduce((acc, e) => acc + e.score, 0);
  check(totals.likes === sum(mine.likeRanking) && totals.uniques === sum(mine.uniqueRanking),
    `stats accumulated (likes ${totals.likes}, uniques ${totals.uniques})`);
  const notes = Object.values(players).flatMap((c) => c.notes);
  check(notes.some((m) => m.includes('いいねが1つ付きました')), 'authors notified anonymously');
  const img = await fetch(`${URL}${mine.likeRanking[0].url}`);
  check(img.ok, 'result image served');

  check(!(await B.emit('game:next')).ok, 'non-host cannot finish');
  check((await A.emit('game:next')).ok, 'host returns to lobby');
  st = await A.waitFor((s) => s.phase === 'lobby');
  check(st.players.every((p) => p.stats.wins === 0), 'minna does not add 1位 count');
  check((await fetch(`${URL}${mine.likeRanking[0].url}`)).status === 404, 'images cleared after game');

  for (const c of [...Object.values(players), S]) c.s.disconnect();
  finish();
})().catch((e) => { console.error(e); process.exit(1); });
