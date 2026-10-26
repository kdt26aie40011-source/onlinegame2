// ステップ4：観戦機能
const { URL, PNG, check, createRoom, joinAs, finish } = require('./lib');

(async () => {
  // ---- 人数上限（参加者9・観戦者10は別枠） ----
  const full = await createRoom();
  const crowd = [];
  for (let i = 0; i < 9; i++) crowd.push(await joinAs(full, `p${i}`));
  check(crowd.every((c) => c.joinResult.ok), '9 participants joined');
  let r = (await joinAs(full, 'p9')).joinResult;
  check(!r.ok && r.error === '部屋が満員です', '10th participant: 部屋が満員です');
  for (let i = 0; i < 10; i++) crowd.push(await joinAs(full, `s${i}`, 'spectator'));
  check(crowd.slice(9).every((c) => c.joinResult.ok), '10 spectators joined (separate slots)');
  r = (await joinAs(full, 's10', 'spectator')).joinResult;
  check(!r.ok && r.error === '部屋が満員です', '11th spectator: 部屋が満員です');
  let info = await (await fetch(`${URL}/api/rooms/${full}`)).json();
  check(info.full.player && info.full.spectator, 'room info: both full');
  check(!(await joinAs(full, 'x', 'judge')).joinResult.ok, 'invalid role rejected');

  // 観戦者→参加者は9人いても切り替えられる
  check((await crowd[9].emit('role:switch', { role: 'player' })).ok, 'spectator -> player while 9 participants');
  let st = await crowd[0].waitFor((s) => s.players.filter((p) => p.role === 'player').length === 10);
  check(true, 'participants can exceed 9 (now 10)');
  for (const c of crowd) c.s.disconnect();

  // ---- ゲーム中の観戦・途中参加・切り替え ----
  const room = await createRoom();
  const A = await joinAs(room, 'A');
  const B = await joinAs(room, 'B');
  const S = await joinAs(room, 'S', 'spectator');
  st = await A.waitFor((s) => s.players.length === 3);
  check(st.players.find((p) => p.id === S.id).role === 'spectator', 'S is spectator');

  check((await A.emit('game:start')).ok, 'game starts with 2 participants (spectator not counted)');
  st = await S.waitFor((s) => s.phase === 'topic');
  check(!st.game.isParticipant && !st.game.participantIds.includes(S.id), 'spectator not in game');
  check(st.game.participantIds.length === 2 && st.game.roundsPerLap === 2, 'parents = participants only');

  // ゲーム中に参加者として入室 → 次のゲームまで観戦モード
  const C = await joinAs(room, 'C');
  st = await C.waitFor((s) => s.phase === 'topic');
  check(C.joinResult.ok && !st.game.isParticipant, 'mid-game participant waits as watcher');
  // ゲーム中に観戦者として入室 → そのまま観戦
  const T = await joinAs(room, 'T', 'spectator');
  check(T.joinResult.ok, 'mid-game spectator joined');

  // ゲーム中の切り替えは次のゲームから
  check((await B.emit('role:switch', { role: 'spectator' })).ok, 'B asks to become spectator mid-game');
  check((await S.emit('role:switch', { role: 'player' })).ok, 'S asks to become player mid-game');
  st = await A.waitFor((s) => s.players.find((p) => p.id === B.id).pendingRole === 'spectator');
  check(st.players.find((p) => p.id === B.id).role === 'player', 'B still player this game');

  const everyone = { A, B, C, S, T };
  const byId = (id) => Object.values(everyone).find((c) => c.id === id);
  for (let round = 1; round <= 2; round++) {
    st = await A.waitFor((s) => s.phase === 'topic' && s.game.round === round);
    const parent = byId(st.game.parentId);
    const child = parent === A ? B : A;
    check(!(await S.emit('topic:submit', { topic: 'x' })).ok, `r${round}: spectator cannot submit topic`);
    await parent.emit('topic:submit', { topic: `お題${round}` });
    await child.waitFor((s) => s.phase === 'draw');
    check(!(await C.emit('drawing:submit', { image: PNG })).ok, `r${round}: waiting participant cannot draw`);
    check(!(await S.emit('drawing:submit', { image: PNG })).ok, `r${round}: spectator cannot draw`);
    await child.emit('drawing:submit', { image: PNG });
    st = await parent.waitFor((s) => s.phase === 'select');
    await parent.emit('winner:select', { drawingId: st.game.drawings[0].id });
    st = await S.waitFor((s) => s.phase === 'result');
    check(!(await S.emit('drawing:rate', { kind: 'like', drawingId: st.game.drawings[0].id })).ok, `r${round}: spectator cannot like`);
    const img = await fetch(`${URL}${st.game.drawings[0].url}`);
    check(img.ok && img.headers.get('content-type') === 'image/png', `r${round}: drawing image served as PNG`);
    await A.emit('game:next');
  }

  st = await A.waitFor((s) => s.phase === 'lobby');
  const role = (id) => st.players.find((p) => p.id === id);
  check(role(B.id).role === 'spectator' && role(S.id).role === 'player' && !role(B.id).pendingRole, 'pending roles applied after game');
  check((await fetch(`${URL}${'/api/rooms/' + room + '/drawings/doesnotexist.png'}`)).status === 404, 'unknown image 404');

  // ロビーでの切り替えは即時
  check((await T.emit('role:switch', { role: 'player' })).ok, 'lobby switch');
  st = await A.waitFor((s) => s.players.find((p) => p.id === T.id).role === 'player');
  check(true, 'lobby switch is immediate');

  check((await A.emit('game:start')).ok, 'next game starts');
  st = await A.waitFor((s) => s.phase === 'topic');
  const ids = new Set(st.game.participantIds);
  check(ids.has(A.id) && ids.has(C.id) && ids.has(S.id) && ids.has(T.id) && !ids.has(B.id), 'next game: A,C,S,T play; B watches');

  for (const c of Object.values(everyone)) c.s.disconnect();
  finish();
})().catch((e) => { console.error(e); process.exit(1); });
