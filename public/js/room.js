const $ = (id) => document.getElementById(id);

const roomId = decodeURIComponent(location.pathname.split('/')[2] || '');
const socket = io();

let state = null;
let deadline = null; // この端末の時計での締め切り
let boardRoundKey = null;
let submitting = false;
let galleryKey = null;
let topicRoundKey = null;
let zoomedDrawingId = null;

const board = new DrawingBoard($('canvas'), {
  palette: $('color-palette'),
  widthPicker: $('width-picker'),
  eraserButton: $('tool-eraser'),
  undoButton: $('tool-undo'),
  clearButton: $('tool-clear'),
});

// ---- 入室・復帰 ----

const ROOM_NOT_FOUND = '部屋が見つかりません。URLを確認するか、新しく部屋を作ってください。';
const SEAT_KEY = `urodoro.seat.${roomId}`;
let selectedIcon = null;
let inRoom = false; // 席に着いている（切断したら自動で復帰を試みる）

const emitAsync = (event, payload = {}) => new Promise((resolve) => socket.emit(event, payload, resolve));

$('name-input').value = safeStorage('get', 'urodoro.name') || '';
init();

async function init() {
  const info = await loadRoomInfo();
  if (!info) return;

  // 2分以内に戻ってきた場合は、名前を入れ直さずに同じ席へ戻る
  const seat = loadSeat();
  if (seat) {
    const res = await emitAsync('rejoin', { roomId, ...seat });
    if (res.ok) return enterRoom();
    clearSeat();
    showJoinError('前回の席は解放されました。もう一度入室してください');
  }
  renderIconPicker(info.icons);
  if (info.full) showJoinError('部屋が満員です');
  $('join-screen').hidden = false;
}

async function loadRoomInfo() {
  try {
    const res = await fetch(`/api/rooms/${encodeURIComponent(roomId)}`);
    if (res.status === 404) {
      clearSeat();
      showError(ROOM_NOT_FOUND);
      return null;
    }
    return await res.json();
  } catch {
    showError('部屋の情報を読み込めませんでした。再読み込みしてください。');
    return null;
  }
}

function loadSeat() {
  try {
    const seat = JSON.parse(safeStorage('get', SEAT_KEY));
    return seat && typeof seat.playerId === 'string' && typeof seat.token === 'string' ? seat : null;
  } catch {
    return null;
  }
}

function clearSeat() {
  try {
    localStorage.removeItem(SEAT_KEY);
  } catch {
    // 保存できない環境では何もしない
  }
}

function enterRoom() {
  inRoom = true;
  for (const id of ['join-screen', 'left-screen', 'error-screen', 'connection-banner']) $(id).hidden = true;
  $('game-screen').hidden = false;
}

function renderIconPicker(icons) {
  const saved = safeStorage('get', 'urodoro.icon');
  selectedIcon = icons.includes(saved) ? saved : icons[Math.floor(Math.random() * icons.length)];
  const picker = $('icon-picker');
  picker.replaceChildren();
  for (const icon of icons) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'icon-option';
    button.textContent = icon;
    button.setAttribute('role', 'radio');
    button.addEventListener('click', () => {
      selectedIcon = icon;
      updateIconPicker();
    });
    picker.append(button);
  }
  updateIconPicker();
}

function updateIconPicker() {
  for (const button of $('icon-picker').children) {
    const selected = button.textContent === selectedIcon;
    button.classList.toggle('selected', selected);
    button.setAttribute('aria-checked', String(selected));
  }
}

function showJoinError(message) {
  $('join-error').textContent = message;
  $('join-error').hidden = false;
}

$('join-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = $('name-input').value.trim();
  const button = $('join-button');
  button.disabled = true;
  socket.emit('join', { roomId, name, icon: selectedIcon }, (res) => {
    button.disabled = false;
    if (!res.ok) {
      if (res.error === '部屋が見つかりません') return showError(ROOM_NOT_FOUND);
      return showJoinError(res.error);
    }
    safeStorage('set', 'urodoro.name', name);
    safeStorage('set', 'urodoro.icon', selectedIcon);
    // 復帰時の本人確認に使う
    safeStorage('set', SEAT_KEY, JSON.stringify({ playerId: res.playerId, token: res.token }));
    enterRoom();
  });
});

socket.on('state', (next) => {
  if (!inRoom) return;
  state = next;
  deadline = next.remainingMs != null ? Date.now() + next.remainingMs : null;
  render();
});

socket.on('notify', ({ message }) => {
  if (inRoom) showToast(message);
});

socket.on('disconnect', () => {
  if (inRoom) $('connection-banner').hidden = false;
});

// Socket.IO が自動で再接続したら、同じ席に戻る
socket.on('connect', async () => {
  if (!inRoom) return;
  const seat = loadSeat();
  const res = seat ? await emitAsync('rejoin', { roomId, ...seat }) : { ok: false };
  if (res.ok) {
    $('connection-banner').hidden = true;
    return;
  }
  clearSeat();
  showError('接続が切れている間に、席が解放されたか部屋が終了しました。');
});

socket.on('replaced', () => {
  showError('別のタブや端末でこの部屋に入り直したため、この画面の接続は終了しました。');
});

socket.on('room:closed', () => {
  clearSeat();
  showError('ホストが部屋を終了しました。');
});

function showError(message) {
  inRoom = false;
  for (const id of ['join-screen', 'game-screen', 'left-screen', 'zoom', 'confirm', 'connection-banner']) $(id).hidden = true;
  $('error-message').textContent = message;
  $('error-screen').hidden = false;
}

// ---- 退出・部屋の終了 ----

$('leave-room').addEventListener('click', async () => {
  if (!(await confirmDialog('退出しますか？\n2分以内なら同じ席に戻れます。'))) return;
  inRoom = false;
  await emitAsync('room:leave');
  $('game-screen').hidden = true;
  $('zoom').hidden = true;
  $('left-screen').hidden = false;
});

$('return-room').addEventListener('click', async () => {
  const seat = loadSeat();
  const res = seat ? await emitAsync('rejoin', { roomId, ...seat }) : { ok: false };
  if (res.ok) return enterRoom();
  clearSeat();
  showError('席が解放されたか、部屋が終了しました。');
});

$('close-room').addEventListener('click', async () => {
  if (!(await confirmDialog('部屋を終了しますか？\n全員が退出になり、成績も消えます。'))) return;
  emitAction('room:close');
});

async function transferHost(player) {
  if (!(await confirmDialog(`${player.name}さんにホストを譲りますか？`))) return;
  emitAction('host:transfer', { playerId: player.id });
}

// 確認ダイアログ（ブラウザ標準の confirm は使わない）
function confirmDialog(message) {
  return new Promise((resolve) => {
    $('confirm-message').textContent = message;
    $('confirm').hidden = false;
    $('confirm-ok').focus();
    const finish = (result) => {
      $('confirm').hidden = true;
      $('confirm-ok').removeEventListener('click', onOk);
      $('confirm-cancel').removeEventListener('click', onCancel);
      resolve(result);
    };
    const onOk = () => finish(true);
    const onCancel = () => finish(false);
    $('confirm-ok').addEventListener('click', onOk);
    $('confirm-cancel').addEventListener('click', onCancel);
  });
}

// ---- 描画 ----

const PHASE_SECTION = {
  lobby: 'phase-lobby',
  topic: 'phase-topic',
  draw: 'phase-draw',
  collect: 'phase-draw',
  select: 'phase-select',
  result: 'phase-result',
};

function render() {
  const s = state;
  const g = s.game;

  renderPlayers();
  $('close-room').hidden = !isHost();
  $('round-info').textContent = g ? `${g.lap}周目　ラウンド ${g.round} / ${g.roundsPerLap}` : '';
  $('notice').textContent = s.notice || '';
  $('notice').hidden = !s.notice;

  for (const id of new Set(Object.values(PHASE_SECTION))) $(id).hidden = id !== PHASE_SECTION[s.phase];

  if (s.phase === 'lobby') renderLobby();
  if (s.phase === 'topic') renderTopic();
  if (s.phase === 'draw' || s.phase === 'collect') renderDraw();
  if (s.phase === 'select') renderSelect();
  if (s.phase === 'result') renderResult();
  if (s.phase !== 'select' && s.phase !== 'result') closeZoom();
  updateTimer();
}

function renderPlayers() {
  const list = $('player-list');
  list.replaceChildren();
  for (const p of state.players) {
    const li = document.createElement('li');
    const icon = document.createElement('span');
    icon.className = 'player-icon';
    icon.textContent = p.icon;
    const name = document.createElement('span');
    name.className = 'player-name';
    name.textContent = p.name;
    li.append(icon, name);
    li.classList.toggle('away', !p.connected);
    if (p.id === state.hostId) li.append(badge('👑', 'ホスト'));
    if (p.id === state.pendingHostId) li.append(badge('次のホスト', '次のラウンドからホスト', 'badge-wait'));
    if (state.game && p.id === state.game.parentId) li.append(badge('親', '今回の親', 'badge-parent'));
    if (p.id === state.me) li.append(badge('あなた', null, 'badge-me'));
    if (!p.connected) li.append(badge('離席中', null, 'badge-away'));
    if (state.game && !p.inGame) li.append(badge('次のゲームから', null, 'badge-wait'));
    if (isHost() && p.id !== state.me && p.connected && p.id !== state.pendingHostId) {
      const give = document.createElement('button');
      give.type = 'button';
      give.className = 'btn btn-small btn-give';
      give.textContent = '👑を譲る';
      give.addEventListener('click', () => transferHost(p));
      li.append(give);
    }

    const stats = document.createElement('span');
    stats.className = 'player-stats';
    stats.textContent = `🏆${p.stats.wins}　❤${p.stats.likes}`;
    stats.title = `1位 ${p.stats.wins}回・いいね ${p.stats.likes}`;
    li.append(stats);
    list.append(li);
  }
}

function badge(text, title, className = '') {
  const span = document.createElement('span');
  span.className = `badge ${className}`;
  span.textContent = text;
  if (title) span.title = title;
  return span;
}

function nameOf(playerId, fallback = '（退出した人）') {
  return state.players.find((p) => p.id === playerId)?.name ?? fallback;
}

const isHost = () => state.hostId === state.me;
const isParent = () => state.game?.parentId === state.me;
const isChild = () => !!state.game?.childIds.includes(state.me);
const roundKey = () => `${state.game.lap}-${state.game.round}`;

function renderLobby() {
  $('room-url').value = `${location.origin}/r/${state.roomId}`;
  const enough = state.players.length >= 2;
  $('start-game').hidden = !isHost();
  $('start-game').disabled = !enough;
  if (isHost()) {
    $('lobby-wait').textContent = enough ? '準備ができたら「ゲーム開始」を押してください。' : '2人以上集まると開始できます。';
  } else {
    $('lobby-wait').textContent = `ホスト（${nameOf(state.hostId)}）がゲームを始めるのを待っています…`;
  }
  renderSettings();
}

const SETTING_SELECTS = ['setting-topic-time', 'setting-draw-time', 'setting-parents', 'setting-laps'];

function renderSettings() {
  for (const id of SETTING_SELECTS) {
    const select = $(id);
    const { key, unit } = select.dataset;
    const rule = state.settingRules[key];
    const options = [];
    if (key === 'parentsPerLap') options.push({ value: 'all', label: '全員' });
    for (let v = rule.min; v <= rule.max; v += rule.step ?? 1) options.push({ value: String(v), label: `${v}${unit}` });

    // 選択肢が変わったときだけ作り直す（開いているドロップダウンを閉じないように）
    const signature = options.map((o) => o.value).join(',');
    if (select.dataset.signature !== signature) {
      select.dataset.signature = signature;
      select.replaceChildren(...options.map(({ value, label }) => new Option(label, value)));
    }
    const current = state.settings[key];
    select.value = current === null ? 'all' : String(current);
    select.disabled = !isHost();
  }
  $('settings-hint').textContent = isHost() ? '' : '設定を変更できるのはホストだけです。';
}

for (const id of SETTING_SELECTS) {
  $(id).addEventListener('change', (e) => {
    const { key } = e.target.dataset;
    const value = e.target.value === 'all' ? null : Number(e.target.value);
    emitAction('settings:update', { [key]: value });
  });
}

function renderTopic() {
  const parent = isParent();
  $('topic-form').hidden = !parent;
  $('topic-wait').hidden = parent;
  if (parent) {
    if (topicRoundKey !== roundKey()) {
      topicRoundKey = roundKey();
      $('topic-input').value = '';
      $('topic-input').maxLength = state.limits.topicMax;
      $('topic-input').focus();
    }
  } else {
    $('topic-wait').textContent = `${nameOf(state.game.parentId)}さんがお題を考えています…`;
  }
}

function renderDraw() {
  const g = state.game;
  $('draw-topic').textContent = g.topic;
  $('draw-topic-auto').hidden = !g.topicAuto;

  const drawing = isChild() && !g.submitted;
  if (drawing && boardRoundKey !== roundKey()) {
    boardRoundKey = roundKey();
    board.reset();
  }
  board.setEnabled(drawing && state.phase === 'draw' && !submitting);
  $('submit-drawing').disabled = state.phase !== 'draw' || submitting;
  $('draw-board').hidden = !drawing;
  $('draw-wait').hidden = drawing;

  const progress = `（提出 ${g.submittedCount} / ${g.childIds.length}）`;
  if (isChild()) {
    $('draw-wait').textContent = `提出しました！ほかの人を待っています${progress}`;
  } else if (isParent()) {
    $('draw-wait').textContent = `子がお題を描いています。お楽しみに！${progress}`;
  } else {
    $('draw-wait').textContent = `子がお題を描いています${progress}`;
  }

  // 時間切れ：描きかけの絵をそのまま提出する
  if (state.phase === 'collect' && drawing && !submitting) submitDrawing();
}

function submitDrawing() {
  submitting = true;
  board.setEnabled(false);
  $('submit-drawing').disabled = true;
  socket.emit('drawing:submit', { image: board.toDataURL() }, (res) => {
    submitting = false;
    if (!res.ok) showToast(res.error);
    if (state) render();
  });
}

function renderSelect() {
  const g = state.game;
  $('select-topic').textContent = g.topic;
  const parentAway = !state.players.find((p) => p.id === g.parentId)?.connected;
  $('select-info').textContent = isParent()
    ? '1位にしたい絵をタップして選んでください'
    : parentAway
      ? `${nameOf(g.parentId)}さんが離席中です。時間内に戻れば選べます…`
      : `${nameOf(g.parentId)}さんが1位を選んでいます…`;
  renderGallery($('select-gallery'), false);
}

function renderResult() {
  const g = state.game;
  $('result-topic').textContent = g.topic;
  const winner = g.drawings.find((d) => d.id === g.winnerDrawingId);
  $('result-message').textContent = winner ? `🏆 1位は ${winner.authorName}さん！` : (g.message || '今回は1位なしです');
  renderGallery($('result-gallery'), true);

  const last = g.lap >= g.laps && g.round >= g.roundsPerLap;
  $('next-round').hidden = !isHost();
  $('next-round').textContent = last ? 'ゲームを終える' : '次へ進む';
  $('result-wait').textContent = isHost() ? '' : `ホスト（${nameOf(state.hostId)}）が次へ進むのを待っています…`;
}

const likeButtons = new Map(); // drawingId -> button

function renderGallery(container, reveal) {
  const g = state.game;
  const key = `${state.phase}:${roundKey()}:${g.drawings.map((d) => d.id).join(',')}`;
  if (galleryKey !== key || container.childElementCount !== g.drawings.length) {
    galleryKey = key;
    buildGallery(container, reveal);
  }
  if (reveal) updateLikeButtons();
}

function buildGallery(container, reveal) {
  const g = state.game;
  likeButtons.clear();
  container.replaceChildren();
  for (const d of g.drawings) {
    const card = document.createElement('div');
    card.className = 'drawing-card';
    if (reveal && d.id === g.winnerDrawingId) card.classList.add('winner');

    const thumb = document.createElement('button');
    thumb.type = 'button';
    thumb.className = 'drawing-thumb';
    thumb.addEventListener('click', () => openZoom(d));
    const img = document.createElement('img');
    img.src = d.image;
    img.alt = reveal ? `${d.authorName}さんの絵` : '子の絵';
    thumb.append(img);
    card.append(thumb);

    if (reveal) {
      const footer = document.createElement('div');
      footer.className = 'drawing-footer';
      const caption = document.createElement('span');
      caption.className = 'drawing-author';
      caption.textContent = (d.id === g.winnerDrawingId ? '🏆 ' : '') + d.authorName;
      const like = document.createElement('button');
      like.type = 'button';
      like.className = 'like-button';
      like.addEventListener('click', () => emitAction('drawing:like', { drawingId: d.id }));
      likeButtons.set(d.id, like);
      footer.append(caption, like);
      card.append(footer);
    }
    container.append(card);
  }
}

function updateLikeButtons() {
  const me = state.players.find((p) => p.id === state.me);
  const canLike = !!me?.inGame;
  for (const d of state.game.drawings) {
    const button = likeButtons.get(d.id);
    if (!button) continue;
    const mine = d.authorId === state.me;
    button.textContent = `${d.likedByMe ? '❤' : '♡'} ${d.likeCount}`;
    button.classList.toggle('liked', d.likedByMe);
    button.disabled = mine || d.likedByMe || !canLike;
    button.title = mine ? '自分の絵にはいいねできません'
      : d.likedByMe ? 'いいねしました'
        : canLike ? 'いいね' : '観戦中はいいねできません';
  }
}

// ---- 拡大表示 ----

function openZoom(drawing) {
  zoomedDrawingId = drawing.id;
  $('zoom-image').src = drawing.image;
  $('zoom-caption').textContent = drawing.authorName ? `${drawing.authorName}さんの絵` : '';
  $('zoom-select').hidden = !(state.phase === 'select' && isParent());
  $('zoom').hidden = false;
}

function closeZoom() {
  zoomedDrawingId = null;
  $('zoom').hidden = true;
}

$('zoom-close').addEventListener('click', closeZoom);
$('zoom').addEventListener('click', (e) => {
  if (e.target === $('zoom')) closeZoom();
});
$('zoom-select').addEventListener('click', () => {
  const drawingId = zoomedDrawingId;
  closeZoom();
  emitAction('winner:select', { drawingId });
});

// ---- 操作 ----

function emitAction(event, payload = {}) {
  socket.emit(event, payload, (res) => {
    if (!res.ok) showToast(res.error);
  });
}

$('start-game').addEventListener('click', () => emitAction('game:start'));
$('next-round').addEventListener('click', () => emitAction('game:next'));
$('submit-drawing').addEventListener('click', () => {
  if (!submitting) submitDrawing();
});
$('topic-form').addEventListener('submit', (e) => {
  e.preventDefault();
  emitAction('topic:submit', { topic: $('topic-input').value });
});

$('copy-url').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('room-url').value);
    showToast('URLをコピーしました');
  } catch {
    $('room-url').select();
    showToast('URLを選択しました。コピーして友達に送ってください');
  }
});

// ---- タイマー・通知 ----

function updateTimer() {
  const timer = $('timer');
  if (!deadline || !inRoom) {
    timer.hidden = true;
    return;
  }
  const seconds = Math.ceil(Math.max(0, deadline - Date.now()) / 1000);
  timer.textContent = `残り ${seconds}秒`;
  timer.classList.toggle('timer-urgent', seconds <= 5);
  timer.hidden = false;
}
setInterval(updateTimer, 250);

let toastTimer = null;
function showToast(message) {
  const toast = $('toast');
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.hidden = true;
  }, 2500);
}

function safeStorage(op, key, value) {
  try {
    if (op === 'get') return localStorage.getItem(key);
    localStorage.setItem(key, value);
  } catch {
    // プライベートモードなどで保存できなくても遊べるようにする
  }
  return null;
}
