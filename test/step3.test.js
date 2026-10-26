// ステップ3の機能テスト（サーバーは SEAT_HOLD_MS=3000 EMPTY_ROOM_TTL_MS=3000 で起動しておく）
const { io } = require('socket.io-client');
const URL = process.env.TEST_URL || 'http://localhost:3000';
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

let failures = 0;
const check = (cond, msg) => { console.log(`${cond ? 'OK  ' : 'FAIL'} ${msg}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function client(label) {
  const s = io(URL, { forceNew: true, transports: ['websocket'] });
  const c = { s, label, state: null, waiters: [], notes: [], events: [] };
  s.on('state', (st) => { c.state = st; c.waiters = c.waiters.filter((w) => !w(st)); });
  s.on('notify', (n) => c.notes.push(n.message));
  s.on('replaced', () => c.events.push('replaced'));
  s.on('room:closed', () => c.events.push('closed'));
  c.emit = (ev, p = {}) => new Promise((r) => s.emit(ev, p, r));
  c.waitFor = (pred, ms = 10000) => new Promise((resolve, reject) => {
    if (c.state && pred(c.state)) return resolve(c.state);
    const t = setTimeout(() => reject(new Error(`${label} timeout`)), ms);
    c.waiters.push((st) => { if (pred(st)) { clearTimeout(t); resolve(st); return true; } return false; });
  });
  return c;
}

const player = (st, id) => st.players.find((p) => p.id === id);

(async () => {
  const { roomId } = await (await fetch(`${URL}/api/rooms`, { method: 'POST' })).json();
  const seats = {};
  const live = {};
  for (const n of ['A', 'B', 'C']) {
    const c = client(n);
    const r = await c.emit('join', { roomId, name: n, icon: '🐶', role: 'player' });
    seats[n] = { playerId: r.playerId, token: r.token };
    live[n] = c;
  }
  check(typeof seats.A.token === 'string' && seats.A.token.length >= 20, 'join returns secret token');
  let st = await live.A.waitFor((s) => s.players.length === 3);
  check(!JSON.stringify(st).includes(seats.B.token), 'tokens are not broadcast');

  // ---- 席の保持と復帰 ----
  live.B.s.disconnect();
  st = await live.A.waitFor((s) => player(s, seats.B.playerId).connected === false);
  check(st.players.length === 3, 'disconnected player keeps seat (離席中)');
  const bad = client('B-bad');
  check(!(await bad.emit('rejoin', { roomId, playerId: seats.B.playerId, token: 'x'.repeat(32) })).ok, 'rejoin with wrong token rejected');
  check(!(await bad.emit('join', { roomId, name: 'B', icon: '🐶', role: 'player' })).ok, 'held seat name still counts as duplicate');
  bad.s.disconnect();
  live.B = client('B2');
  let r = await live.B.emit('rejoin', { roomId, ...seats.B });
  check(r.ok && r.playerId === seats.B.playerId, 'rejoin within hold time -> same seat');
  st = await live.A.waitFor((s) => player(s, seats.B.playerId).connected === true);
  check(st.players.length === 3, 'player back online');

  // 別タブで入り直したら古い接続は切り離される
  const B3 = client('B3');
  check((await B3.emit('rejoin', { roomId, ...seats.B })).ok, 'second tab rejoin ok');
  await sleep(200);
  check(live.B.events.includes('replaced'), 'old tab gets replaced');
  check(!(await live.B.emit('game:start')).ok, 'old tab can no longer act');
  live.B.s.disconnect();
  live.B = B3;

  // ---- ホスト譲渡（ロビーでは即時） ----
  check(!(await live.B.emit('host:transfer', { playerId: seats.C.playerId })).ok, 'non-host cannot transfer');
  check((await live.A.emit('host:transfer', { playerId: seats.B.playerId })).ok, 'host transfers to B');
  st = await live.C.waitFor((s) => s.hostId === seats.B.playerId);
  check(true, 'lobby transfer is immediate');
  await sleep(100);
  check(live.C.notes.some((n) => n.includes('ホストがBさんに代わりました')), 'everyone notified of host change');

  // ホストが抜けたら入室順の次の人へ（ロビーでは即時）
  live.B.s.disconnect();
  st = await live.C.waitFor((s) => s.hostId === seats.A.playerId);
  check(true, 'host left in lobby -> A (earliest present) immediately');
  live.B = client('B4');
  await live.B.emit('rejoin', { roomId, ...seats.B });
  await sleep(200);
  check(live.A.state.hostId === seats.A.playerId, 'original host returning does not regain host');

  // ---- ゲーム中のホスト引き継ぎ（工程の切り替わりで） ----
  await live.A.emit('settings:update', { laps: 2 });
  check((await live.A.emit('game:start')).ok, 'game started');
  st = await live.B.waitFor((s) => s.phase === 'topic');
  const parentName = Object.keys(seats).find((n) => seats[n].playerId === st.game.parentId);
  if (parentName !== 'A') {
    live.A.s.disconnect();
    st = await live.B.waitFor((s) => player(s, seats.A.playerId).connected === false);
    check(st.hostId === seats.A.playerId, 'host away during topic: not moved yet');
    await live[parentName].emit('topic:submit', { topic: 'うま' });
    st = await live.B.waitFor((s) => s.phase === 'draw');
    check(st.hostId !== seats.A.playerId, 'host moved at next phase (draw)');
  } else {
    live.A.s.disconnect();
    st = await live.B.waitFor((s) => s.phase === 'topic' && s.game.parentId !== seats.A.playerId);
    check(!!st.notice, 'parent(host) left during topic: parent re-drawn');
    check(st.hostId !== seats.A.playerId, 'host moved with phase restart');
    await live[Object.keys(seats).find((n) => seats[n].playerId === st.game.parentId)].emit('topic:submit', { topic: 'うま' });
    st = await live.B.waitFor((s) => s.phase === 'draw');
  }
  const host1 = st.hostId;
  // Aが描画中に戻る → 子として描ける
  live.A = client('A2');
  await live.A.emit('rejoin', { roomId, ...seats.A });
  st = await live.A.waitFor((s) => s.phase === 'draw');
  const parentId = st.game.parentId;
  const kids = Object.keys(seats).filter((n) => seats[n].playerId !== parentId);
  check(st.game.childIds.includes(seats.A.playerId) || parentId === seats.A.playerId, 'returning player still in round');
  for (const k of kids) await live[k].emit('drawing:submit', { image: PNG });
  st = await live.B.waitFor((s) => s.phase === 'select');

  // 1位選定中に親が離席 → 時間内に戻って選べば有効
  const pName = Object.keys(seats).find((n) => seats[n].playerId === parentId);
  live[pName].s.disconnect();
  await live[kids[0]].waitFor((s) => player(s, parentId).connected === false);
  check(live[kids[0]].state.phase === 'select', 'select continues while parent away');
  live[pName] = client(`${pName}-back`);
  await live[pName].emit('rejoin', { roomId, ...seats[pName] });
  st = await live[pName].waitFor((s) => s.phase === 'select');
  check((await live[pName].emit('winner:select', { drawingId: st.game.drawings[0].id })).ok, 'parent returned and selected');
  st = await live[pName].waitFor((s) => s.phase === 'result');
  check(!!st.game.winnerDrawingId, 'winner valid after return');

  // 結果発表中の手動譲渡 → 次のラウンドで反映
  const hostName = Object.keys(seats).find((n) => seats[n].playerId === st.hostId);
  const target = Object.keys(seats).find((n) => n !== hostName);
  check((await live[hostName].emit('host:transfer', { playerId: seats[target].playerId })).ok, 'transfer requested during result');
  st = await live[target].waitFor((s) => s.pendingHostId === seats[target].playerId);
  check(st.hostId === seats[hostName].playerId, 'host not changed yet (pending)');
  await live[hostName].emit('game:next');
  st = await live[target].waitFor((s) => s.phase === 'topic' && s.game.round === 2);
  check(st.hostId === seats[target].playerId && !st.pendingHostId, 'pending host applied at round switch');

  // お絵描き中に親が離席して戻らない → 1位なし
  const p2 = Object.keys(seats).find((n) => seats[n].playerId === st.game.parentId);
  await live[p2].emit('topic:submit', { topic: 'しか' });
  const kids2 = Object.keys(seats).filter((n) => n !== p2);
  await live[kids2[0]].waitFor((s) => s.phase === 'draw');
  live[p2].s.disconnect();
  await live[kids2[0]].waitFor((s) => player(s, seats[p2].playerId).connected === false);
  for (const k of kids2) await live[k].emit('drawing:submit', { image: PNG });
  st = await live[kids2[0]].waitFor((s) => s.phase === 'result');
  check(st.game.message === '親が不在のため今回は1位なしです' && !st.game.winnerDrawingId, 'parent absent at select -> skipped');

  // 2分（テストでは3秒）たつと席が解放される
  st = await live[kids2[0]].waitFor((s) => s.players.length === 2, 8000);
  check(!player(st, seats[p2].playerId), 'seat released after hold time');
  const late = client('late');
  r = await late.emit('rejoin', { roomId, ...seats[p2] });
  check(!r.ok, 'rejoin after release fails');
  late.s.disconnect();

  // 自分で退出 → 席は保持、戻れる
  const leaver = kids2.find((n) => seats[n].playerId !== st.hostId);
  const stayer = kids2.find((n) => n !== leaver);
  check((await live[leaver].emit('room:leave')).ok, 'voluntary leave');
  st = await live[stayer].waitFor((s) => player(s, seats[leaver].playerId)?.connected === false);
  check(true, 'leaver shown as away');
  r = await live[leaver].emit('rejoin', { roomId, ...seats[leaver] });
  check(r.ok, 'leaver returns on same socket');

  // 強制終了
  check(!(await live[leaver].emit('room:close')).ok, 'non-host cannot close room');
  check((await live[stayer].emit('room:close')).ok, 'host closes room');
  await sleep(200);
  check(live[leaver].events.includes('closed'), 'members notified of close');
  check((await fetch(`${URL}/api/rooms/${roomId}`)).status === 404, 'closed room is gone');
  for (const c of Object.values(live)) c.s.disconnect();

  // 誰もいなくなって一定時間で部屋が消える
  const { roomId: room2 } = await (await fetch(`${URL}/api/rooms`, { method: 'POST' })).json();
  const solo = client('solo');
  await solo.emit('join', { roomId: room2, name: 'solo', icon: '🐶', role: 'player' });
  solo.s.disconnect();
  await sleep(1500);
  check((await fetch(`${URL}/api/rooms/${room2}`)).ok, 'empty room still alive shortly after');
  await sleep(6000);
  check((await fetch(`${URL}/api/rooms/${room2}`)).status === 404, 'empty room deleted after TTL');

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASSED');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
