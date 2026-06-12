import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import jwt from 'jsonwebtoken';

const port = Number(process.env.SMOKE_PORT || 3517);
const host = '127.0.0.1';
const baseUrl = `http://${host}:${port}`;
const roomId = 'smoke-room';
const jwtSecret = 'smoke-test-secret';
const metricsToken = 'smoke-metrics-token';
const diskPath = fs.mkdtempSync(path.join(os.tmpdir(), 'intothebattle-smoke-'));
const overlayToken = jwt.sign({ purpose: 'overlay', roomId }, jwtSecret, { expiresIn: '1h' });

const server = spawn(process.execPath, ['server.js'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    PORT: String(port),
    HOST: host,
    NODE_ENV: 'production',
    API_KEY: 'test',
    JWT_SECRET: jwtSecret,
    OVERLAY_TOKEN_SECRET: jwtSecret,
    SKIP_DB: 'true',
    DEV_TEST_MODE: 'false',
    DISK_PATH: diskPath,
    METRICS_TOKEN: metricsToken,
    APP_BASE_URL: baseUrl,
    LOG_LEVEL: 'error',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let output = '';
server.stdout.on('data', chunk => { output += chunk.toString(); });
server.stderr.on('data', chunk => { output += chunk.toString(); });

function stopServer() {
  if (!server.killed) server.kill();
  try { fs.rmSync(diskPath, { recursive: true, force: true }); } catch (_) {}
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function request(pathname, options = {}) {
  return fetch(`${baseUrl}${pathname}`, { redirect: 'manual', ...options });
}

async function waitForHealth() {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) {
      throw new Error(`server exited early with code ${server.exitCode}\n${output}`);
    }
    try {
      const res = await request('/healthz');
      if (res.status === 200) return;
    } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(`server did not become healthy\n${output}`);
}

async function expectStatus(pathname, expectedStatus, options = {}) {
  const res = await request(pathname, options);
  assert(res.status === expectedStatus, `${pathname} expected ${expectedStatus}, received ${res.status}`);
  return res;
}

try {
  await waitForHealth();

  await expectStatus('/healthz', 200);
  for (const pathname of ['/', '/home', '/login', '/signup', '/paywall', '/overlay-preview']) {
    await expectStatus(pathname, 200);
  }

  const dashboard = await expectStatus('/dashboard', 302);
  assert((dashboard.headers.get('location') || '').startsWith('/login'), '/dashboard should redirect to /login');

  const profile = await expectStatus('/profile', 302);
  assert((profile.headers.get('location') || '').startsWith('/login'), '/profile should redirect to /login');

  const profileHtml = await expectStatus('/profile.html', 302);
  assert((profileHtml.headers.get('location') || '').startsWith('/profile'), '/profile.html should redirect to /profile');

  await expectStatus('/api/status', 401);
  await expectStatus('/api/subscription/status', 401);
  await expectStatus('/metrics', 401);
  await expectStatus(`/metrics?token=${encodeURIComponent(metricsToken)}`, 200);
  await expectStatus('/api/runtime/diagnostics', 401);
  const diagnostics = await expectStatus(`/api/runtime/diagnostics?token=${encodeURIComponent(metricsToken)}`, 200);
  const diagnosticsBody = await diagnostics.json();
  assert(diagnosticsBody.ok === true, 'diagnostics should report ok');
  assert(diagnosticsBody.storage?.ok === true, 'diagnostics storage check should report ok');
  assert(diagnosticsBody.database?.mode === 'stub', 'diagnostics should report stub database in smoke mode');

  await expectStatus(`/overlay?room_id=${roomId}`, 401);
  await expectStatus(`/overlay?room_id=${roomId}&overlay_token=bad`, 401);
  await expectStatus(`/overlay?room_id=${roomId}&overlay_token=${encodeURIComponent(overlayToken)}`, 200);
  await expectStatus(`/state?room_id=${roomId}&overlay_token=${encodeURIComponent(overlayToken)}`, 200);
  await expectStatus(`/state?room_id=${roomId}&overlay_token=bad`, 401);

  await expectStatus(`/background/missing.png?room_id=${roomId}&overlay_token=${encodeURIComponent(overlayToken)}`, 404);
  await expectStatus(`/audio/missing.mp3?room_id=${roomId}&overlay_token=${encodeURIComponent(overlayToken)}`, 404);
  await expectStatus(`/backgrounds/${roomId}/missing.png`, 404);
  await expectStatus(`/audio/${roomId}/missing.mp3`, 404);

  console.log('HTTP smoke checks passed');
} catch (err) {
  console.error(err?.stack || err);
  if (output) {
    console.error('\n--- server output ---');
    console.error(output);
  }
  process.exitCode = 1;
} finally {
  stopServer();
}
