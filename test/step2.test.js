// ステップ2の機能テスト
const { io } = require('socket.io-client');
const URL = process.env.TEST_URL || 'http://localhost:3000';
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

let failures = 0;
const check = (cond, msg) => { console.log(`${cond ? 'OK  ' : 'FAIL'} ${msg}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function client(label) {
  const s = io(URL, { forceNew: true, transports: ['websocket'] });
  const c = { s, label, state: null, waiters: [], notes: [] };
  s.on('state', (st) => { c.state = st; c.waiters = c.waiters.filter((w) => !w(st)); });
  s.on('notify', (n) => c.notes.push(n.message));
  c.emit = (ev, p = {}) => new Promise((r) => s.emit(ev, p, r));
  c.waitFor = (pred, ms = 10000) => new Promise((resolve, reject) => {
    if (c.state && pred(c.state)) return resolve(c.state);
    const t = setTimeout(() => reject(new Error(`${label} timeout`)), ms);
    c.waiters.push((st) => { if (pred(st)) { clearTimeout(t); resolve(st); return true; } return false; });
  });
  return c;
}

(async () => {
  const { roomId } = await (await fetch(`${URL}/api/rooms`, { method: 'POST' })).json();
  check((await fetch(`${URL}/api/rooms/nope`)).status === 404, 'room info 404 for unknown room');
  let info = await (await fetch(`${URL}/api/rooms/${roomId}`)).json();
  check(info.icons.length >= 10 && info.full.player === false && info.full.spectator === false, `room info: ${info.icons.length} icons, not full`);

  const cs = [];
  const A = client('A'); cs.push(A);
  check(!(await A.emit('join', { roomId, name: 'えー', icon: '<b>', role: 'player' })).ok, 'invalid icon rejected');
  A.id = (await A.emit('join', { roomId, name: 'えー', icon: '🐱', role: 'player' })).playerId;
  const dup = client('dup');
  const dupRes = await dup.emit('join', { roomId, name: 'えー', icon: '🐶', role: 'player' });
  check(!dupRes.ok && dupRes.error.includes('同じ名前'), 'duplicate name rejected');

  for (let i = 1; i < 9; i++) {
    const c = client(`P${i}`);
    const r = await c.emit('join', { roomId, name: `ぷれいや${i}`, icon: '🐶', role: 'player' });
    c.id = r.playerId; cs.push(c);
  }
  check(cs.every((c) => c.id), '9 players joined');
  const tenth = await dup.emit('join', { roomId, name: 'じゅう', icon: '🐶', role: 'player' });
  check(!tenth.ok && tenth.error === '部屋が満員です', '10th player: 部屋が満員です');
  info = await (await fetch(`${URL}/api/rooms/${roomId}`)).json();
  check(info.full.player === true && info.full.spectator === false, 'room info reports full');

  // ---- 設定 ----
  await A.waitFor((s) => s.players.length === 9);
  check(A.state.players[0].icon === '🐱' && A.state.players[0].stats.wins === 0, 'player icon + stats in state');
  check(A.state.settings.topicTimeSec === 30 && A.state.settings.drawTimeSec === 100 && A.state.settings.parentsPerLap === null && A.state.settings.laps === 1, 'initial settings');
  check(!(await cs[1].emit('settings:update', { laps: 2 })).ok, 'non-host cannot change settings');
  check(!(await A.emit('settings:update', { topicTimeSec: 23 })).ok, 'topicTime 23 (off-step) rejected');
  check(!(await A.emit('settings:update', { drawTimeSec: 210 })).ok, 'drawTime 210 rejected');
  check(!(await A.emit('settings:update', { laps: 4 })).ok, 'laps 4 rejected');
  check(!(await A.emit('settings:update', { parentsPerLap: 10 })).ok, 'parents 10 rejected');
  check((await A.emit('settings:update', { topicTimeSec: 25, drawTimeSec: 30, laps: 2, parentsPerLap: 9 })).ok, 'host updates settings');
  await A.waitFor((s) => s.settings.laps === 2);

  // 7人抜けて2人に → 親の人数が2に下がる
  for (const c of cs.splice(2)) c.s.disconnect();
  dup.s.disconnect();
  let st = await A.waitFor((s) => s.players.length === 2);
  check(st.settings.parentsPerLap === 2, `parents clamped to ${st.settings.parentsPerLap}`);

  const B = cs[1];
  check((await A.emit('game:start')).ok, 'start with 2 players');
  st = await A.waitFor((s) => s.phase === 'topic');
  check(st.game.roundsPerLap === 2 && st.game.laps === 2, 'game uses settings: 2 parents x 2 laps');
  check(st.remainingMs > 20000 && st.remainingMs <= 25000, `topic timer ${st.remainingMs}ms (25s)`);
  check(!(await A.emit('settings:update', { laps: 1 })).ok, 'settings locked during game');

  // ---- 1位といいね ----
  const parent = st.game.parentId === A.id ? A : B;
  const child = parent === A ? B : A;
  await parent.emit('topic:submit', { topic: 'くじら' });
  st = await child.waitFor((s) => s.phase === 'draw');
  check(st.remainingMs > 25000 && st.remainingMs <= 30000, `draw timer ${st.remainingMs}ms (30s)`);
  await child.emit('drawing:submit', { image: PNG });
  st = await parent.waitFor((s) => s.phase === 'select');
  const drawingId = st.game.drawings[0].id;
  check(!(await parent.emit('drawing:rate', { kind: 'like', drawingId })).ok, 'cannot like before result');
  await parent.emit('winner:select', { drawingId });
  st = await child.waitFor((s) => s.phase === 'result');
  check(st.players.find((p) => p.id === child.id).stats.wins === 1, 'winner gets 1位 count');
  check(!(await child.emit('drawing:rate', { kind: 'like', drawingId })).ok, 'cannot like own drawing');
  check((await parent.emit('drawing:rate', { kind: 'like', drawingId })).ok, 'parent likes child drawing');
  check(!(await parent.emit('drawing:rate', { kind: 'like', drawingId })).ok, 'second like on same drawing rejected');
  st = await child.waitFor((s) => s.players.find((p) => p.id === child.id).stats.likes === 1);
  check(st.game.drawings[0].likeCount === 1 && st.game.drawings[0].likedByMe === false, 'like count shown, anonymous');
  await sleep(200);
  check(child.notes.includes('あなたの絵がいいねされました！'), 'author notified');
  check(parent.state.game.drawings[0].likedByMe === true, 'liker sees likedByMe');

  // 成績はゲームをまたいで累積：次へ→ロビーに戻っても残る
  await A.emit('game:next');
  st = await A.waitFor((s) => s.phase === 'topic' && s.game.round === 2);
  check(st.players.find((p) => p.id === child.id).stats.wins === 1, 'stats persist into next round');

  A.s.disconnect(); B.s.disconnect();
  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASSED');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
