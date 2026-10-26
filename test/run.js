// テスト用にサーバーを起動し、テストを順番に実行する
//   npm test             … サーバーのテスト（ステップ1〜5）
//   npm run test:browser … 実際のブラウザで画面を操作するテスト（Chrome が必要）
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SERVER_TESTS = ['step1', 'step2', 'step3', 'step4', 'step5'].map((n) => `${n}.test.js`);
const files = process.argv.includes('--browser') ? ['browser.js'] : SERVER_TESTS;

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer().listen(0, () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

async function waitForServer(url, timeoutMs = 10000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // まだ起動中
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('テスト用サーバーが起動しませんでした');
}

function run(file, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(__dirname, file)], { env, stdio: 'inherit' });
    child.on('exit', (code) => resolve(code === 0));
  });
}

(async () => {
  const port = await freePort();
  const url = `http://localhost:${port}`;
  // 待ち時間を短くして、2分待つ処理も数秒で確かめられるようにする
  const env = {
    ...process.env,
    PORT: String(port),
    TEST_URL: url,
    SEAT_HOLD_MS: '3000',
    EMPTY_ROOM_TTL_MS: '3000',
    RATE_PHASE_MS: '1500',
  };
  const server = spawn(process.execPath, [path.join(ROOT, 'server.js')], { env, stdio: 'ignore' });

  let failed = [];
  try {
    await waitForServer(url);
    for (const file of files) {
      console.log(`\n==== ${file} ====`);
      if (!(await run(file, env))) failed.push(file);
    }
  } catch (err) {
    console.error(err.message);
    failed = ['(起動)'];
  } finally {
    server.kill();
  }

  console.log(failed.length ? `\n失敗: ${failed.join(', ')}` : '\nすべてのテストに合格しました');
  process.exit(failed.length ? 1 : 0);
})();
