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
  s.on('room:closed', () => c.events.push('closed'));
  c.emit = (ev, p = {}) => new Promise((r) => s.emit(ev, p, r));
  c.waitFor = (pred, ms = 10000) => new Promise((resolve, reject) => {
    if (c.state && pred(c.state)) return resolve(c.state);
    const t = setTimeout(() => reject(new Error(`${label} timeout`)), ms);
    c.waiters.push((st) => { if (pred(st)) { clearTimeout(t); resolve(st); return true; } return false; });
  });
  return c;
}

async function createRoom() {
  return (await (await fetch(`${URL}/api/rooms`, { method: 'POST' })).json()).roomId;
}

async function joinAs(roomId, name, role = 'player') {
  const c = client(name);
  const r = await c.emit('join', { roomId, name, icon: '🐶', role });
  c.id = r.playerId;
  c.joinResult = r;
  return c;
}

function finish() {
  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASSED');
  process.exit(failures ? 1 : 0);
}

module.exports = { URL, PNG, check, sleep, client, createRoom, joinAs, finish };
