const $ = (id) => document.getElementById(id);

const roomId = decodeURIComponent(location.pathname.split('/')[2] || '');
const socket = io();

let state = null;
let gameSeq = 0; // ゲームごとに増やす（前のゲームの絵や入力を持ち越さないため）
let deadline = null; // この端末の時計での締め切り
let boardKey = null;
let submitting = false;
let topicKey = null;
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
  renderRolePicker(info);
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

function renderRolePicker(info) {
  const radios = document.querySelectorAll('input[name="role"]');
  for (const radio of radios) {
    const full = info.full[radio.value];
    radio.disabled = full;
    $(`role-${radio.value}-note`).textContent = full ? '（満員）' : '';
  }
  // 選べるほうを選んでおく
  const available = [...radios].find((r) => !r.disabled);
  if (available && document.querySelector('input[name="role"]:checked')?.disabled) available.checked = true;
  if (!available) showJoinError('部屋が満員です');
  $('join-ingame').hidden = !info.inGame;
}

function showJoinError(message) {
  $('join-error').textContent = message;
  $('join-error').hidden = false;
}

$('join-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = $('name-input').value.trim();
  const role = document.querySelector('input[name="role"]:checked')?.value;
  const button = $('join-button');
  button.disabled = true;
  socket.emit('join', { roomId, name, icon: selectedIcon, role }, (res) => {
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
  if (next.game && !state?.game) gameSeq++;
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

// ---- 退出・部屋の終了・ホスト譲渡 ----

$('leave-room').addEventListener('click', async () => {
  if (!(await confirmDialog('退出しますか？\n2分以内なら同じ席に戻れます。'))) return;
  inRoom = false;
  state = null;
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

// ---- 状態の読み取り ----

const me = () => state.players.find((p) => p.id === state.me);
const isHost = () => state.hostId === state.me;
const isPlaying = () => !!state.game?.isParticipant; // このゲームで遊んでいる（観戦モードではない）
const isParent = () => state.game?.parentId === state.me;
const isChild = () => !!state.game?.childIds?.includes(state.me);
const isConnected = (playerId) => !!state.players.find((p) => p.id === playerId)?.connected;

function nameOf(playerId, fallback = '（退出した人）') {
  return state.players.find((p) => p.id === playerId)?.name ?? fallback;
}

// ---- 描画 ----

const PHASE_SECTION = {
  lobby: 'phase-lobby',
  topic: 'phase-topic',
  draw: 'phase-draw',
  collect: 'phase-draw',
  select: 'phase-select',
  result: 'phase-result',
  mtopic: 'phase-mtopic',
  mdraw: 'phase-draw',
  mcollect: 'phase-draw',
  mlike: 'phase-meval',
  munique: 'phase-meval',
  mresult: 'phase-mresult',
};

const RENDERERS = {
  lobby: renderLobby,
  topic: renderTopic,
  draw: renderDraw,
  collect: renderDraw,
  select: renderSelect,
  result: renderResult,
  mtopic: renderMinnaTopic,
  mdraw: renderDraw,
  mcollect: renderDraw,
  mlike: renderEvaluation,
  munique: renderEvaluation,
  mresult: renderMinnaResult,
};

function render() {
  renderPlayers();
  renderWatchBanner();
  $('close-room').hidden = !isHost();
  $('round-info').textContent = roundInfo();
  $('notice').textContent = state.notice || '';
  $('notice').hidden = !state.notice;

  for (const id of new Set(Object.values(PHASE_SECTION))) $(id).hidden = id !== PHASE_SECTION[state.phase];
  RENDERERS[state.phase]();

  const zoomable = ['select', 'result', 'mlike', 'munique', 'mresult'];
  if (!zoomable.includes(state.phase)) closeZoom();
  updateTimer();
}

function roundInfo() {
  const g = state.game;
  if (!g) return '';
  if (g.mode === 'normal') return `${g.lap}周目　ラウンド ${g.round} / ${g.roundsPerLap}`;
  switch (state.phase) {
    case 'mtopic': return 'みんなでうろドロ　お題入力';
    case 'mdraw':
    case 'mcollect': return `お絵描き　ラウンド ${g.round} / ${g.totalRounds}`;
    case 'mlike':
    case 'munique': return `評価　お題 ${g.evaluation.index} / ${g.evaluation.total}`;
    default: return 'みんなでうろドロ　結果発表';
  }
}

function renderPlayers() {
  const players = $('player-list');
  const spectators = $('spectator-list');
  players.replaceChildren();
  spectators.replaceChildren();
  for (const p of state.players) {
    (p.role === 'player' ? players : spectators).append(playerItem(p));
  }
  $('spectator-heading').hidden = spectators.childElementCount === 0;
  renderRoleSwitch();
}

function playerItem(p) {
  const g = state.game;
  const li = document.createElement('li');
  li.classList.toggle('away', !p.connected);
  const icon = document.createElement('span');
  icon.className = 'player-icon';
  icon.textContent = p.icon;
  const name = document.createElement('span');
  name.className = 'player-name';
  name.textContent = p.name;
  li.append(icon, name);

  if (p.id === state.hostId) li.append(badge('👑', 'ホスト'));
  if (p.id === state.pendingHostId) li.append(badge('次のホスト', '次のラウンドからホスト', 'badge-wait'));
  if (g && p.id === g.parentId) li.append(badge('親', '今回の親', 'badge-parent'));
  if (p.id === state.me) li.append(badge('あなた', null, 'badge-me'));
  if (!p.connected) li.append(badge('離席中', null, 'badge-away'));
  if (g && p.role === 'player' && !g.participantIds.includes(p.id)) li.append(badge('次のゲームから', null, 'badge-wait'));
  if (p.pendingRole) li.append(badge(p.pendingRole === 'player' ? '次から参加' : '次から観戦', null, 'badge-wait'));

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
  stats.textContent = `🏆${p.stats.wins}　❤${p.stats.likes}　✨${p.stats.uniques}`;
  stats.title = `1位 ${p.stats.wins}回・いいね ${p.stats.likes}・ユニーク ${p.stats.uniques}`;
  li.append(stats);
  return li;
}

function badge(text, title, className = '') {
  const span = document.createElement('span');
  span.className = `badge ${className}`;
  span.textContent = text;
  if (title) span.title = title;
  return span;
}

function renderRoleSwitch() {
  const self = me();
  const button = $('switch-role');
  const target = self.pendingRole ? self.role : (self.role === 'player' ? 'spectator' : 'player');
  button.dataset.role = target;
  if (self.pendingRole) {
    button.textContent = '切り替えを取り消す';
    $('role-hint').textContent = `次のゲームから${self.pendingRole === 'player' ? '参加者' : '観戦者'}になります。`;
  } else {
    button.textContent = target === 'player' ? '🎨 参加者になる' : '👀 観戦者になる';
    $('role-hint').textContent = state.game ? 'ゲーム中に切り替えると、次のゲームから反映されます。' : '';
  }
}

$('switch-role').addEventListener('click', (e) => {
  emitAction('role:switch', { role: e.currentTarget.dataset.role });
});

function renderWatchBanner() {
  const banner = $('watch-banner');
  if (!state.game || isPlaying()) {
    banner.hidden = true;
    return;
  }
  banner.textContent = me().role === 'player'
    ? '👀 観戦中です。次のゲームから参加できます（観戦中は見るだけです）'
    : '👀 観戦中です（見るだけです）';
  banner.hidden = false;
}

// ---- ロビー ----

const MODE_DESCRIPTIONS = {
  normal: '親がお題を出し、子が記憶だけで描き、親が1位を選びます。',
  minna: '全員がお題を出し、ほかの人のお題をすべて描き、みんなで「いいね」と「ユニーク」を付けます。',
};

function renderLobby() {
  const { mode } = state.settings;
  const min = state.limits.minPlayers[mode];
  const count = state.players.filter((p) => p.role === 'player').length;
  const enough = count >= min;

  $('room-url').value = `${location.origin}/r/${state.roomId}`;
  $('start-game').hidden = !isHost();
  $('start-game').disabled = !enough;
  if (isHost()) {
    $('lobby-wait').textContent = enough
      ? '準備ができたら「ゲーム開始」を押してください。'
      : `参加者が${min}人以上集まると開始できます（今 ${count}人）。`;
  } else {
    $('lobby-wait').textContent = `ホスト（${nameOf(state.hostId)}）がゲームを始めるのを待っています…`;
  }
  renderSettings();
}

function renderSettings() {
  const { mode } = state.settings;
  $('setting-mode').value = mode;
  $('setting-mode').disabled = !isHost();
  for (const el of document.querySelectorAll('.settings [data-mode]')) el.hidden = el.dataset.mode !== mode;
  $('mode-description').textContent = MODE_DESCRIPTIONS[mode];

  for (const select of document.querySelectorAll('.setting-number')) {
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

$('setting-mode').addEventListener('change', (e) => emitAction('settings:update', { mode: e.target.value }));
for (const select of document.querySelectorAll('.setting-number')) {
  select.addEventListener('change', (e) => {
    const { key } = e.target.dataset;
    const value = e.target.value === 'all' ? null : Number(e.target.value);
    emitAction('settings:update', { [key]: value });
  });
}

// ---- 通常モード：お題入力 ----

function renderTopic() {
  const g = state.game;
  const parent = isParent();
  $('topic-form').hidden = !parent;
  $('topic-wait').hidden = parent;
  if (parent) {
    resetTopicInput($('topic-input'), `${gameSeq}-${g.lap}-${g.round}-${g.parentId}`);
  } else {
    $('topic-wait').textContent = `${nameOf(g.parentId)}さんがお題を考えています…`;
  }
}

function resetTopicInput(input, key) {
  if (topicKey === key) return;
  topicKey = key;
  input.value = '';
  input.maxLength = state.limits.topicMax;
  input.focus();
}

$('topic-form').addEventListener('submit', (e) => {
  e.preventDefault();
  emitAction('topic:submit', { topic: $('topic-input').value });
});

// ---- みんなでうろドロ：お題入力 ----

function renderMinnaTopic() {
  const g = state.game;
  const canSubmit = isPlaying() && !g.myTopic;
  $('mtopic-form').hidden = !canSubmit;
  $('mtopic-wait').hidden = canSubmit;
  const progress = `（${g.submittedCount} / ${g.submitTotal}人）`;
  if (canSubmit) {
    resetTopicInput($('mtopic-input'), `${gameSeq}-mtopic`);
  } else if (g.myTopic) {
    $('mtopic-wait').textContent = `お題「${g.myTopic}」を出しました。ほかの人を待っています${progress}`;
  } else {
    $('mtopic-wait').textContent = `みんながお題を考えています${progress}`;
  }
}

$('mtopic-form').addEventListener('submit', (e) => {
  e.preventDefault();
  emitAction('topic:submit', { topic: $('mtopic-input').value });
});

// ---- お絵描き（両モード共通） ----

// 自分の描く状況をモードに関係なく同じ形にそろえる
function drawContext() {
  const g = state.game;
  if (g.mode === 'normal') {
    return {
      key: `${gameSeq}-${g.lap}-${g.round}`,
      topic: g.topic,
      auto: g.topicAuto,
      amDrawer: isChild(),
      submitted: g.submitted,
      progress: `（提出 ${g.submittedCount} / ${g.childIds.length}）`,
      waiting: isParent() ? '子がお題を描いています。お楽しみに！' : '子がお題を描いています',
    };
  }
  return {
    key: `${gameSeq}-m-${g.round}`,
    topic: g.assignment?.topic ?? null,
    auto: !!g.assignment?.auto,
    amDrawer: !!g.assignment,
    submitted: g.submitted,
    progress: `（提出 ${g.submittedCount} / ${g.submitTotal}）`,
    waiting: 'みんながそれぞれ違うお題を描いています',
  };
}

function renderDraw() {
  const ctx = drawContext();
  const collecting = state.phase === 'collect' || state.phase === 'mcollect';
  $('draw-topic-banner').hidden = !ctx.topic;
  $('draw-topic').textContent = ctx.topic ?? '';
  $('draw-topic-auto').hidden = !ctx.auto;

  const drawing = ctx.amDrawer && !ctx.submitted;
  if (drawing && boardKey !== ctx.key) {
    boardKey = ctx.key;
    board.reset();
  }
  board.setEnabled(drawing && !collecting && !submitting);
  $('submit-drawing').disabled = collecting || submitting;
  $('draw-board').hidden = !drawing;
  $('draw-wait').hidden = drawing;
  $('draw-wait').textContent = ctx.amDrawer
    ? `提出しました！ほかの人を待っています${ctx.progress}`
    : `${ctx.waiting}${ctx.progress}`;

  // 時間切れ：描きかけの絵をそのまま提出する
  if (collecting && drawing && !submitting) submitDrawing();
}

function submitDrawing() {
  submitting = true;
  board.setEnabled(false);
  $('submit-drawing').disabled = true;
  socket.emit('drawing:submit', { image: board.toDataURL() }, (res) => {
    submitting = false;
    if (!res.ok) showToast(res.error);
    if (state && inRoom) render();
  });
}

$('submit-drawing').addEventListener('click', () => {
  if (!submitting) submitDrawing();
});

// ---- 通常モード：1位選定・結果発表 ----

function renderSelect() {
  const g = state.game;
  $('select-topic').textContent = g.topic;
  $('select-info').textContent = isParent()
    ? '1位にしたい絵をタップして選んでください'
    : !isConnected(g.parentId)
      ? `${nameOf(g.parentId)}さんが離席中です。時間内に戻れば選べます…`
      : `${nameOf(g.parentId)}さんが1位を選んでいます…`;
  renderGallery($('select-gallery'), { reveal: false });
}

function renderResult() {
  const g = state.game;
  $('result-topic').textContent = g.topic;
  const winner = g.drawings.find((d) => d.id === g.winnerDrawingId);
  $('result-message').textContent = winner ? `🏆 1位は ${winner.authorName}さん！` : (g.message || '今回は1位なしです');
  renderGallery($('result-gallery'), { reveal: true });

  const last = g.lap >= g.laps && g.round >= g.roundsPerLap;
  $('next-round').hidden = !isHost();
  $('next-round').textContent = last ? 'ゲームを終える' : '次へ進む';
  $('result-wait').textContent = isHost() ? '' : `ホスト（${nameOf(state.hostId)}）が次へ進むのを待っています…`;
}

$('next-round').addEventListener('click', () => emitAction('game:next'));

// ---- ギャラリー（絵の一覧） ----

// 同じ絵の並びなら作り直さず、ボタンの表示だけ更新する
const galleries = new Map(); // container -> { key, buttons: Map(drawingId -> button) }

function syncGallery(container, key, drawings, buildCard) {
  let gallery = galleries.get(container);
  if (gallery?.key !== key) {
    gallery = { key, buttons: new Map() };
    galleries.set(container, gallery);
    container.replaceChildren(...drawings.map((d) => buildCard(d, gallery.buttons)));
  }
  return gallery.buttons;
}

function drawingCard(d, { caption, winner = false, button = null }) {
  const card = document.createElement('div');
  card.className = 'drawing-card';
  card.classList.toggle('winner', winner);

  const thumb = document.createElement('button');
  thumb.type = 'button';
  thumb.className = 'drawing-thumb';
  thumb.addEventListener('click', () => openZoom(d));
  const img = document.createElement('img');
  img.src = d.url;
  img.alt = d.authorName ? `${d.authorName}さんの絵` : 'みんなの絵';
  img.loading = 'lazy';
  thumb.append(img);
  card.append(thumb);

  if (caption || button) {
    const footer = document.createElement('div');
    footer.className = 'drawing-footer';
    if (caption) {
      const text = document.createElement('span');
      text.className = 'drawing-author';
      text.textContent = caption;
      footer.append(text);
    }
    if (button) footer.append(button);
    card.append(footer);
  }
  return card;
}

function rateButton(onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'like-button';
  button.addEventListener('click', onClick);
  return button;
}

function renderGallery(container, { reveal }) {
  const g = state.game;
  const key = `${gameSeq}:${state.phase}:${g.drawings.map((d) => d.id).join(',')}`;
  const buttons = syncGallery(container, key, g.drawings, (d, map) => {
    if (!reveal) return drawingCard(d, {});
    const like = rateButton(() => emitAction('drawing:rate', { kind: 'like', drawingId: d.id }));
    map.set(d.id, like);
    const winner = d.id === g.winnerDrawingId;
    return drawingCard(d, { caption: (winner ? '🏆 ' : '') + d.authorName, winner, button: like });
  });

  if (!reveal) return;
  for (const d of g.drawings) {
    const button = buttons.get(d.id);
    const mine = d.authorId === state.me;
    button.textContent = `${d.likedByMe ? '❤' : '♡'} ${d.likeCount}`;
    button.classList.toggle('liked', d.likedByMe);
    button.disabled = mine || d.likedByMe || !isPlaying();
    button.title = mine ? '自分の絵にはいいねできません'
      : d.likedByMe ? 'いいねしました'
        : isPlaying() ? 'いいね' : '観戦中はいいねできません';
  }
}

// ---- みんなでうろドロ：評価 ----

const RATE_LABELS = {
  like: { mark: '❤', empty: '♡', name: 'いいね', guide: '上手！好き！と思った絵' },
  unique: { mark: '✨', empty: '☆', name: 'ユニーク', guide: '個性的！おもしろい！と思った絵' },
};

function renderEvaluation() {
  const ev = state.game.evaluation;
  const label = RATE_LABELS[ev.kind];
  $('meval-topic').textContent = ev.topic;
  $('meval-title').textContent = `${label.mark} ${label.name}タイム：${label.guide}を最大${ev.limit}枚`;
  if (!isPlaying()) {
    $('meval-info').textContent = '観戦中は評価できません。';
  } else {
    const mine = ev.isMyTopic ? 'あなたが出したお題です。全員の絵を評価できます。' : '';
    $('meval-info').textContent = `選んだ数 ${ev.used} / ${ev.limit}　${mine}`;
  }

  const key = `${gameSeq}:${state.phase}:${ev.index}`;
  const buttons = syncGallery($('meval-gallery'), key, ev.drawings, (d, map) => {
    const button = rateButton(() => emitAction('drawing:rate', { kind: ev.kind, drawingId: d.id }));
    map.set(d.id, button);
    return drawingCard(d, { button });
  });

  for (const d of ev.drawings) {
    const button = buttons.get(d.id);
    button.classList.toggle('liked', d.marked);
    if (d.mine) {
      button.textContent = 'あなたの絵';
      button.disabled = true;
    } else {
      button.textContent = d.marked ? `${label.mark} 付けた` : `${label.empty} 付ける`;
      button.disabled = !isPlaying() || (!d.marked && ev.used >= ev.limit);
    }
  }
}

// ---- みんなでうろドロ：結果発表 ----

function renderMinnaResult() {
  const { results } = state.game;
  const key = `${gameSeq}:mresult`;
  syncGallery($('mresult-list'), key, results, (topic) => topicResult(topic));

  $('mresult-next').hidden = !isHost();
  $('mresult-wait').textContent = isHost() ? '' : `ホスト（${nameOf(state.hostId)}）がロビーへ戻るのを待っています…`;
}

function topicResult(topic) {
  const section = document.createElement('section');
  section.className = 'card topic-result';
  const title = document.createElement('h3');
  title.textContent = `お題：${topic.text}`;
  const owner = document.createElement('p');
  owner.className = 'hint';
  owner.textContent = `出した人：${topic.ownerName}${topic.auto ? '（時間切れのためランダム）' : ''}`;
  section.append(title, owner);

  if (topic.likeRanking.length === 0) {
    const empty = document.createElement('p');
    empty.textContent = 'このお題の絵はありませんでした。';
    section.append(empty);
    return section;
  }
  section.append(
    ranking('❤ いいね順位', topic.likeRanking, '❤'),
    ranking('✨ ユニーク順位', topic.uniqueRanking, '✨'),
  );
  return section;
}

function ranking(heading, entries, mark) {
  const wrap = document.createElement('div');
  const h = document.createElement('h4');
  h.textContent = heading;
  const gallery = document.createElement('div');
  gallery.className = 'gallery gallery-small';
  for (const entry of entries) {
    const card = drawingCard(entry, {
      caption: `${entry.rank}位 ${entry.authorName}　${mark}${entry.score}`,
      winner: entry.rank === 1 && entry.score > 0,
    });
    gallery.append(card);
  }
  wrap.append(h, gallery);
  return wrap;
}

$('mresult-next').addEventListener('click', () => emitAction('game:next'));

// ---- 拡大表示 ----

function openZoom(drawing) {
  zoomedDrawingId = drawing.id;
  $('zoom-image').src = drawing.url;
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
