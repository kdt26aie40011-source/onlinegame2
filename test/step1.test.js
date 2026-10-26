const { io } = require('socket.io-client');
const URL = process.env.TEST_URL || 'http://localhost:3000';
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

let failures = 0;
const check = (cond, msg) => { console.log(`${cond ? 'OK  ' : 'FAIL'} ${msg}`); if (!cond) failures++; };

function client(label) {
  const s = io(URL, { forceNew: true, transports: ['websocket'] });
  const c = { s, label, state: null, waiters: [] };
  s.on('state', (st) => { c.state = st; c.waiters = c.waiters.filter((w) => !w(st)); });
  c.emit = (ev, p = {}) => new Promise((r) => s.emit(ev, p, r));
  c.waitFor = (pred, ms = 25000) => new Promise((resolve, reject) => {
    if (c.state && pred(c.state)) return resolve(c.state);
    const t = setTimeout(() => reject(new Error(`${label} timeout`)), ms);
    c.waiters.push((st) => { if (pred(st)) { clearTimeout(t); resolve(st); return true; } return false; });
  });
  return c;
}

(async () => {
  const { roomId } = await (await fetch(`${URL}/api/rooms`, { method: 'POST' })).json();
  check(/^[A-Za-z0-9]{12}$/.test(roomId), `room id ${roomId}`);
  const page = await fetch(`${URL}/r/${roomId}`);
  check(page.ok, 'room page served');

  const A = client('A'), B = client('B'), C = client('C');
  const all = [A, B, C];
  check(!(await A.emit('join', { roomId: 'nope', name: 'x' })).ok, 'unknown room rejected');
  check(!(await A.emit('join', { roomId, name: '1234567890' })).ok, '10-char name rejected');
  for (const [c, n] of [[A, 'あいうえおかきくけ'], [B, 'ぼぶ'], [C, 'しー']]) {
    const r = await c.emit('join', { roomId, name: n, icon: '🐶', role: 'player' });
    check(r.ok, `${c.label} joined`);
    c.id = r.playerId;
  }
  await A.waitFor((s) => s.players.length === 3);
  check(A.state.hostId === A.id, 'A is host');
  check(!(await B.emit('game:start')).ok, 'non-host cannot start');
  check((await A.emit('game:start')).ok, 'host starts');

  const byId = (id) => all.find((c) => c.id === id);
  const parents = [];

  // ---- Round 1: normal flow ----
  let st = await A.waitFor((s) => s.phase === 'topic');
  check(st.game.round === 1 && st.game.roundsPerLap === 3, 'round 1/3');
  let parent = byId(st.game.parentId); parents.push(parent.id);
  let kids = all.filter((c) => c !== parent);
  check(!(await kids[0].emit('topic:submit', { topic: 'x' })).ok, 'child cannot submit topic');
  check(!(await parent.emit('topic:submit', { topic: 'あ'.repeat(21) })).ok, '21-char topic rejected');
  check((await parent.emit('topic:submit', { topic: 'ねこ' })).ok, 'parent submits topic');
  st = await kids[0].waitFor((s) => s.phase === 'draw');
  check(st.game.topic === 'ねこ', 'child sees topic');
  check(!(await parent.emit('drawing:submit', { image: PNG })).ok, 'parent cannot draw');
  check(!(await kids[0].emit('drawing:submit', { image: 'data:text/html,<b>' })).ok, 'bad image rejected');
  for (const k of kids) check((await k.emit('drawing:submit', { image: PNG })).ok, `${k.label} submits drawing`);
  st = await parent.waitFor((s) => s.phase === 'select');
  check(st.game.drawings.length === 2 && st.game.drawings.every((d) => d.authorName === null), 'select: 2 anonymous drawings');
  check(!(await kids[0].emit('winner:select', { drawingId: st.game.drawings[0].id })).ok, 'child cannot select');
  check((await parent.emit('winner:select', { drawingId: st.game.drawings[1].id })).ok, 'parent selects');
  st = await A.waitFor((s) => s.phase === 'result');
  check(st.game.winnerDrawingId === st.game.drawings[1].id && st.game.drawings.every((d) => d.authorName), 'result reveals authors + winner');
  check(!(await B.emit('game:next')).ok, 'non-host cannot next');
  check((await A.emit('game:next')).ok, 'host next');

  // ---- Round 2: select timeout ----
  st = await A.waitFor((s) => s.phase === 'topic' && s.game.round === 2);
  parent = byId(st.game.parentId);
  check(!parents.includes(parent.id), 'round 2 parent is new'); parents.push(parent.id);
  kids = all.filter((c) => c !== parent);
  await parent.emit('topic:submit', { topic: 'いぬ' });
  for (const k of kids) await k.emit('drawing:submit', { image: PNG });
  await A.waitFor((s) => s.phase === 'select');
  console.log('  ...waiting 15s for select timeout');
  st = await A.waitFor((s) => s.phase === 'result', 20000);
  check(!st.game.winnerDrawingId && st.game.message.includes(st.players.find((p) => p.id === parent.id).name), `tease: ${st.game.message}`);
  await A.emit('game:next');

  // ---- Round 3: last parent; parent leaves during topic ----
  st = await A.waitFor((s) => s.phase === 'topic' && s.game.round === 3);
  parent = byId(st.game.parentId);
  check(!parents.includes(parent.id), 'round 3 parent is the remaining player');
  const remaining = all.filter((c) => c !== parent);
  parent.s.disconnect();
  st = await remaining[0].waitFor((s) => s.players.length === 2 && s.phase === 'topic');
  check(st.notice && remaining.some((c) => c.id === st.game.parentId), `parent re-drawn: ${st.notice}`);
  if (parent === A) check(st.hostId !== A.id, 'host moved after host left');

  // ---- child leaves during draw -> game ends ----
  const p2 = byId(st.game.parentId), k2 = remaining.find((c) => c !== p2);
  await p2.emit('topic:submit', { topic: 'とり' });
  await k2.waitFor((s) => s.phase === 'draw');
  k2.s.disconnect();
  st = await p2.waitFor((s) => s.phase === 'lobby');
  check(st.notice && st.notice.includes('人数'), `game ended: ${st.notice}`);
  check(st.hostId === p2.id, 'last player is host');

  p2.s.disconnect();
  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASSED');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
