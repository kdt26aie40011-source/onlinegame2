// 実際のブラウザ（Chrome）で画面を操作して一通り遊ぶ
const path = require('path');
const { chromium } = require('playwright-core');

const URL = process.env.TEST_URL || 'http://localhost:3000';
const SHOTS = path.join(__dirname, 'screenshots');
const errors = [];
let failures = 0;
const check = (cond, msg) => { console.log(`${cond ? 'OK  ' : 'FAIL'} ${msg}`); if (!cond) failures++; };

async function open(browser, label, viewport) {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`[${label}] ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('404')) errors.push(`[${label}] console: ${m.text()}`); });
  page.on('response', (r) => { if (r.status() >= 400) errors.push(`[${label}] HTTP ${r.status()} ${r.url()}`); });
  page.label = label;
  return page;
}

async function join(page, roomUrl, name, role = 'player') {
  await page.goto(roomUrl);
  await page.fill('#name-input', name);
  await page.click(`input[name="role"][value="${role}"]`);
  await page.click('#join-button');
  await page.waitForSelector('#game-screen:not([hidden])');
}

const shot = (page, name) => page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
const visible = (page, sel) => page.isVisible(sel);

async function drawSomething(page) {
  const box = await page.locator('#canvas').boundingBox();
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.3);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(box.x + box.width * (0.2 + i * 0.06), box.y + box.height * (0.3 + (i % 2) * 0.3));
  await page.mouse.up();
}

async function whoSees(pages, selector) {
  for (const p of pages) if (await visible(p, selector)) return p;
  return null;
}

(async () => {
  require('fs').mkdirSync(SHOTS, { recursive: true });
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless: true });
  const A = await open(browser, 'A', { width: 1100, height: 850 });
  const B = await open(browser, 'B', { width: 400, height: 860 }); // スマホ幅
  const S = await open(browser, 'S', { width: 1100, height: 850 });

  // ---- トップ → 部屋作成 → 入室 ----
  await A.goto(URL);
  await shot(A, '01-top');
  await A.click('#create-room');
  await A.waitForURL(/\/r\//);
  const roomUrl = A.url();
  check(/\/r\/[A-Za-z0-9]{12}$/.test(roomUrl), `room url ${roomUrl}`);
  await A.waitForSelector('#icon-picker .icon-option');
  await shot(A, '02-join');
  await join(A, roomUrl, 'ホスト');
  await join(B, roomUrl, 'スマホ');
  await join(S, roomUrl, 'みるひと', 'spectator');
  await A.waitForFunction(() => document.querySelectorAll('#player-list li').length === 2);
  check(await A.locator('#spectator-list li').count() === 1, 'spectator listed separately');
  check(!(await B.isEnabled('#setting-mode')), 'non-host settings disabled');

  // 同名は入室できない
  const dup = await open(browser, 'dup', { width: 800, height: 700 });
  await dup.goto(roomUrl);
  await dup.fill('#name-input', 'ホスト');
  await dup.click('#join-button');
  await dup.waitForSelector('#join-error:not([hidden])');
  check((await dup.textContent('#join-error')).includes('同じ名前'), 'duplicate name error shown');
  await dup.context().close();

  await A.selectOption('#setting-parents', '1');
  await A.waitForFunction(() => document.querySelector('#setting-parents').value === '1');
  await shot(A, '03-lobby-host');
  await shot(B, '04-lobby-phone');

  // ---- 通常モード 1ラウンド ----
  await A.click('#start-game');
  await A.waitForFunction(() => !document.querySelector('#phase-topic').hidden);
  const players = [A, B];
  const parent = await whoSees(players, '#topic-form');
  const child = parent === A ? B : A;
  check(!!parent, `parent is ${parent?.label}`);
  check(await visible(S, '#watch-banner'), 'spectator sees watch banner');
  await shot(parent, '05-topic-parent');
  await parent.fill('#topic-input', 'パンダ');
  await parent.click('#topic-form button[type=submit]');
  await child.waitForSelector('#draw-board:not([hidden])');
  check((await child.textContent('#draw-topic')) === 'パンダ', 'child sees topic');
  await drawSomething(child);
  await shot(child, '06-drawing');
  check(!(await visible(S, '#draw-board')), 'spectator has no canvas');
  await child.click('#submit-drawing');
  await parent.waitForSelector('#select-gallery .drawing-thumb');
  await shot(parent, '07-select');
  await parent.click('#select-gallery .drawing-thumb');
  await parent.waitForSelector('#zoom-select:not([hidden])');
  await parent.click('#zoom-select');
  await A.waitForSelector('#phase-result:not([hidden])');
  await parent.click('#result-gallery .like-button');
  await child.waitForFunction(() => document.querySelector('#toast')?.textContent.includes('いいね'));
  check(true, 'like notification toast');
  await A.waitForFunction(() => document.querySelector('#player-list').textContent.includes('🏆1'));
  check(true, 'winner count shown in player list');
  await shot(A, '08-result');
  await shot(B, '09-result-phone');
  await A.click('#next-round');
  await A.waitForSelector('#phase-lobby:not([hidden])');

  // ---- 観戦者 → 参加者、みんなでうろドロ ----
  await S.click('#switch-role');
  await A.waitForFunction(() => document.querySelectorAll('#player-list li').length === 3);
  check(true, 'spectator switched to player (lobby, immediate)');
  await A.selectOption('#setting-mode', 'minna');
  await A.waitForFunction(() => document.querySelector('#setting-parents').hidden);
  check(true, 'normal-only settings hidden in minna mode');
  await A.click('#start-game');
  const all = [A, B, S];
  for (const [i, p] of all.entries()) {
    await p.waitForSelector('#mtopic-form:not([hidden])');
    await p.fill('#mtopic-input', ['ねこ', 'ロケット', 'すし'][i]);
    if (i === 0) await shot(p, '10-minna-topic');
    await p.click('#mtopic-form button[type=submit]');
  }
  for (let round = 1; round <= 2; round++) {
    for (const p of all) {
      await p.waitForFunction((r) => document.querySelector('#round-info').textContent.includes(`ラウンド ${r}`) && !document.querySelector('#draw-board').hidden, round);
    }
    if (round === 1) await shot(B, '11-minna-draw-phone');
    for (const p of all) {
      await drawSomething(p);
      await p.click('#submit-drawing');
    }
  }
  await A.waitForSelector('#phase-meval:not([hidden])');
  await A.waitForSelector('#meval-gallery .like-button');
  await shot(A, '12-minna-like');
  const btn = A.locator('#meval-gallery .like-button:not([disabled])').first();
  if (await btn.count()) await btn.click();
  await A.waitForSelector('#phase-mresult:not([hidden])', { timeout: 30000 });
  check(await A.locator('.topic-result').count() === 3, '3 topic results shown');
  await shot(A, '13-minna-result');
  await shot(B, '14-minna-result-phone');
  await A.click('#mresult-next');
  await A.waitForSelector('#phase-lobby:not([hidden])');

  // ---- 退出 → 戻る、強制終了 ----
  await B.click('#leave-room');
  await B.click('#confirm-ok');
  await B.waitForSelector('#left-screen:not([hidden])');
  await A.waitForFunction(() => document.querySelector('#player-list').textContent.includes('離席中'));
  await shot(A, '15-away');
  await B.click('#return-room');
  await B.waitForSelector('#game-screen:not([hidden])');
  check(true, 'left and returned to same seat');
  await A.click('#close-room');
  await A.click('#confirm-ok');
  await B.waitForSelector('#error-screen:not([hidden])');
  check((await B.textContent('#error-message')).includes('終了'), 'room closed message');

  check(errors.length === 0, `no page errors${errors.length ? ':\n  ' + errors.join('\n  ') : ''}`);
  await browser.close();
  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASSED');
  process.exit(failures ? 1 : 0);
})().catch(async (e) => {
  console.error(e.message);
  if (errors.length) console.error('page errors:\n  ' + errors.join('\n  '));
  process.exit(1);
});
