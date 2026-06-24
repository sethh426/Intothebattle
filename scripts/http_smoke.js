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
    DIAGNOSTICS_TOKEN: metricsToken,
    APP_BASE_URL: 'https://intothebattle.test',
    POSTMARK_API_TOKEN: 'postmark-smoke-token',
    POSTMARK_MESSAGE_STREAM: 'outbound',
    EMAIL_FROM: 'IntoTheBattle <no-reply@intothebattle.test>',
    PAYPAL_CLIENT_ID: 'paypal-smoke-client',
    PAYPAL_CLIENT_SECRET: 'paypal-smoke-secret',
    PAYPAL_MODE: 'live',
    PAYPAL_PLAN_ID: 'P-SMOKEPLAN',
    PAYPAL_WEBHOOK_ID: 'WH-SMOKE',
    GOOGLE_CLIENT_ID: 'google-smoke-client',
    GOOGLE_CLIENT_SECRET: 'google-smoke-secret',
    GOOGLE_OAUTH_REDIRECT_URI: 'https://intothebattle.test/auth/google/callback',
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
  for (const pathname of ['/', '/home', '/login', '/signup', '/paywall', '/how-to-play', '/site-map', '/overlay-preview', '/overlay-v2-preview', '/overlay-phaser.html']) {
    await expectStatus(pathname, 200);
  }
  for (const pathname of ['/intothebattlelogo_logo_only.svg', '/logo.svg', '/robots.txt', '/sitemap.xml', '/js/overlay-scene.js', '/js/overlay-v2.js', '/vendor/phaser/phaser.min.js']) {
    await expectStatus(pathname, 200);
  }

  const dashboard = await expectStatus('/dashboard', 302);
  assert((dashboard.headers.get('location') || '').startsWith('/login'), '/dashboard should redirect to /login');

  const profile = await expectStatus('/profile', 302);
  assert((profile.headers.get('location') || '').startsWith('/login'), '/profile should redirect to /login');

  const profileHtml = await expectStatus('/profile.html', 302);
  assert((profileHtml.headers.get('location') || '').startsWith('/profile'), '/profile.html should redirect to /profile');

  const adminMarketing = await expectStatus('/admin/marketing', 302);
  assert((adminMarketing.headers.get('location') || '').startsWith('/admin/login'), '/admin/marketing should redirect to /admin/login');

  await expectStatus('/server.js', 404);
  await expectStatus('/package.json', 404);
  await expectStatus('/package-lock.json', 404);
  await expectStatus('/overlay-legacy.html', 404);

  await expectStatus('/api/status', 401);
  await expectStatus('/api/subscription/status', 401);
  await expectStatus('/api/stream/setup/start', 401, { method: 'POST' });
  await expectStatus('/api/stream/setup/reset', 401, { method: 'POST' });
  await expectStatus('/api/signup-intent', 403, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Origin: 'https://evil.example' },
    body: JSON.stringify({ email: 'security-smoke@example.com', source: 'smoke' }),
  });
  const sameOriginSignup = await expectStatus('/api/signup-intent', 200, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Origin: baseUrl },
    body: JSON.stringify({ email: 'security-smoke@example.com', source: 'smoke' }),
  });
  const sameOriginSignupBody = await sameOriginSignup.json();
  assert(sameOriginSignupBody.success === true, 'same-origin signup intent should remain allowed');
  const paypalConfig = await expectStatus('/api/paypal/config', 200);
  const paypalConfigBody = await paypalConfig.json();
  assert(paypalConfigBody.authenticated === false, 'unauthenticated paypal config should return safe login prompt');
  assert(!paypalConfigBody.clientId, 'unauthenticated paypal config should not expose client id');
  await expectStatus('/metrics', 401);
  await expectStatus('/metrics', 200, { headers: { Authorization: `Bearer ${metricsToken}` } });
  await expectStatus('/api/runtime/diagnostics', 401);
  const diagnostics = await expectStatus('/api/runtime/diagnostics', 200, { headers: { Authorization: `Bearer ${metricsToken}` } });
  const diagnosticsBody = await diagnostics.json();
  assert(diagnosticsBody.ok === true, 'diagnostics should report ok');
  assert(diagnosticsBody.storage?.ok === true, 'diagnostics storage check should report ok');
  assert(diagnosticsBody.database?.mode === 'stub', 'diagnostics should report stub database in smoke mode');
  assert(diagnosticsBody.growth?.enabled === false, 'growth API sync should be disabled by default');
  await expectStatus('/api/runtime/launch-readiness', 401);
  const readiness = await expectStatus('/api/runtime/launch-readiness', 200, { headers: { Authorization: `Bearer ${metricsToken}` } });
  const readinessBody = await readiness.json();
  assert(readinessBody.ok === true, 'launch readiness should have no hard failures in smoke mode');
  assert(readinessBody.checks?.some(check => check.id === 'storage-writable' && check.status === 'pass'), 'launch readiness should include storage check');
  await expectStatus('/api/runtime/growth-sync-test', 401, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'growth-smoke@example.com' }),
  });
  const growthTest = await expectStatus('/api/runtime/growth-sync-test', 200, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${metricsToken}` },
    body: JSON.stringify({ email: 'growth-smoke@example.com' }),
  });
  const growthTestBody = await growthTest.json();
  assert(growthTestBody.success === true && growthTestBody.skipped === true, 'growth sync test should skip safely when disabled');

  await expectStatus(`/overlay?room_id=${roomId}`, 401);
  await expectStatus(`/overlay?room_id=${roomId}&overlay_token=bad`, 401);
  await expectStatus(`/overlay?room_id=${roomId}&overlay_token=${encodeURIComponent(overlayToken)}`, 200);
  await expectStatus(`/overlay?setup=1&controls=1&debug=1&room_id=${roomId}&overlay_token=${encodeURIComponent(overlayToken)}`, 200);
  await expectStatus(`/overlay-v2?room_id=${roomId}`, 401);
  await expectStatus(`/overlay-v2?room_id=${roomId}&overlay_token=bad`, 401);
  await expectStatus(`/overlay-v2?room_id=${roomId}&overlay_token=${encodeURIComponent(overlayToken)}`, 200);
  await expectStatus(`/overlay-v2?setup=1&render=1080p&source=1&room_id=${roomId}&overlay_token=${encodeURIComponent(overlayToken)}`, 200);
  await expectStatus(`/state?room_id=${roomId}&overlay_token=${encodeURIComponent(overlayToken)}`, 200);
  await expectStatus(`/state?room_id=${roomId}&overlay_token=bad`, 401);

  await expectStatus(`/background/missing.png?room_id=${roomId}&overlay_token=${encodeURIComponent(overlayToken)}`, 404);
  await expectStatus(`/audio/missing.mp3?room_id=${roomId}&overlay_token=${encodeURIComponent(overlayToken)}`, 404);
  await expectStatus(`/sponsor/missing.mp4?room_id=${roomId}&overlay_token=${encodeURIComponent(overlayToken)}`, 404);
  await expectStatus(`/sponsor/missing.mp4?room_id=${roomId}&overlay_token=bad`, 401);
  const sponsorDir = path.join(diskPath, 'sponsors', roomId);
  fs.mkdirSync(sponsorDir, { recursive: true });
  const sponsorFixture = Buffer.from('0123456789abcdef');
  fs.writeFileSync(path.join(sponsorDir, 'range-test.mp4'), sponsorFixture);
  const sponsorPath = `/sponsor/range-test.mp4?room_id=${roomId}&overlay_token=${encodeURIComponent(overlayToken)}`;
  const rangeResponse = await expectStatus(sponsorPath, 206, { headers: { Range: 'bytes=2-6' } });
  assert(rangeResponse.headers.get('accept-ranges') === 'bytes', 'sponsor media should advertise byte ranges');
  assert(rangeResponse.headers.get('content-range') === `bytes 2-6/${sponsorFixture.length}`, 'sponsor media should return the requested content range');
  assert(rangeResponse.headers.get('content-type')?.startsWith('video/mp4'), 'sponsor media should use a video content type');
  assert((await rangeResponse.arrayBuffer()).byteLength === 5, 'sponsor media range body should match requested size');
  const fullSponsorResponse = await expectStatus(sponsorPath, 200);
  const sponsorEtag = fullSponsorResponse.headers.get('etag');
  assert(Boolean(sponsorEtag), 'sponsor media should include an etag');
  await expectStatus(sponsorPath, 304, { headers: { 'If-None-Match': sponsorEtag } });
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
