import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import jwt from 'jsonwebtoken';

const port = Number(process.env.ACCOUNT_TRIAL_SMOKE_PORT || 3547);
const host = '127.0.0.1';
const baseUrl = `http://${host}:${port}`;
const jwtSecret = 'account-trial-smoke-secret';
const diskPath = fs.mkdtempSync(path.join(os.tmpdir(), 'intothebattle-account-trial-'));

const activeTrialToken = 'account-trial-active-token';
const expiredTrialToken = 'account-trial-expired-token';
const paidUserToken = 'account-trial-paid-token';
const activeTrialRoomId = 'account-active-trial-room';
const expiredTrialRoomId = 'account-expired-trial-room';
const paidUserRoomId = 'account-paid-user-room';
const expiredOverlayToken = jwt.sign({ purpose: 'overlay', roomId: expiredTrialRoomId }, jwtSecret, { expiresIn: '1h' });

const server = spawn(process.execPath, ['server.js'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    PORT: String(port),
    HOST: host,
    NODE_ENV: 'test',
    API_KEY: 'test',
    JWT_SECRET: jwtSecret,
    OVERLAY_TOKEN_SECRET: jwtSecret,
    ENABLE_ROOM_SCOPED: 'true',
    SKIP_DB: 'true',
    DEV_TEST_MODE: 'false',
    DISK_PATH: diskPath,
    APP_BASE_URL: baseUrl,
    E2E_ACTIVE_TRIAL_SESSION_TOKEN: activeTrialToken,
    E2E_ACTIVE_TRIAL_ROOM_ID: activeTrialRoomId,
    E2E_EXPIRED_TRIAL_SESSION_TOKEN: expiredTrialToken,
    E2E_EXPIRED_TRIAL_ROOM_ID: expiredTrialRoomId,
    E2E_PAID_USER_SESSION_TOKEN: paidUserToken,
    E2E_PAID_USER_ROOM_ID: paidUserRoomId,
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

function cookie(token) {
  return { Cookie: `session_token=${token}` };
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

async function expectSubscription(token, expected) {
  const res = await expectStatus('/api/subscription/status', 200, {
    headers: cookie(token),
  });
  const body = await res.json();
  for (const [key, value] of Object.entries(expected)) {
    assert(body[key] === value, `subscription status ${key} expected ${value}, received ${body[key]}`);
  }
  return body;
}

try {
  await waitForHealth();

  const expiredDashboard = await expectStatus('/dashboard', 302, {
    headers: cookie(expiredTrialToken),
  });
  assert(
    expiredDashboard.headers.get('location') === '/paywall?reason=trial_expired',
    'expired trial dashboard should redirect to trial-expired paywall'
  );

  const expiredStatus = await expectStatus('/api/status', 402, {
    headers: cookie(expiredTrialToken),
  });
  const expiredStatusBody = await expiredStatus.json();
  assert(expiredStatusBody.success === false, 'expired /api/status should fail');
  assert(expiredStatusBody.reason === 'trial_expired', 'expired /api/status should include trial_expired reason');
  assert(expiredStatusBody.paywallUrl === '/paywall?reason=trial_expired', 'expired /api/status should include paywall URL');

  const expiredMutation = await expectStatus('/api/session/start', 402, {
    method: 'POST',
    headers: { ...cookie(expiredTrialToken), 'Content-Type': 'application/json' },
  });
  const expiredMutationBody = await expiredMutation.json();
  assert(expiredMutationBody.reason === 'trial_expired', 'expired dashboard mutations should return trial_expired');

  const expiredSubscription = await expectSubscription(expiredTrialToken, {
    type: 'user',
    accessAllowed: false,
    actionRequired: true,
    reason: 'trial_expired',
    paywallUrl: '/paywall?reason=trial_expired',
  });
  assert(expiredSubscription.subscription?.expiresAt, 'expired subscription status should expose effective trial expiry');

  const expiredOverlay = await expectStatus(
    `/overlay?room_id=${expiredTrialRoomId}&overlay_token=${encodeURIComponent(expiredOverlayToken)}`,
    302
  );
  assert(
    expiredOverlay.headers.get('location') === '/paywall?reason=trial_expired',
    'expired signed overlay should redirect to trial-expired paywall'
  );

  const expiredState = await expectStatus(
    `/state?room_id=${expiredTrialRoomId}&overlay_token=${encodeURIComponent(expiredOverlayToken)}`,
    402
  );
  const expiredStateBody = await expiredState.json();
  assert(expiredStateBody.reason === 'trial_expired', 'expired signed state should return trial_expired');

  await expectStatus('/dashboard', 200, { headers: cookie(activeTrialToken) });
  await expectStatus('/api/status', 200, { headers: cookie(activeTrialToken) });
  await expectSubscription(activeTrialToken, {
    type: 'user',
    status: 'trialing',
    tier: 'trial',
    accessAllowed: true,
    actionRequired: false,
  });

  await expectStatus('/dashboard', 200, { headers: cookie(paidUserToken) });
  await expectStatus('/api/status', 200, { headers: cookie(paidUserToken) });
  await expectSubscription(paidUserToken, {
    type: 'user',
    status: 'active',
    tier: 'paid',
    accessAllowed: true,
    actionRequired: false,
  });

  stopServer();
  console.log('Account trial HTTP smoke checks passed');
} catch (err) {
  stopServer();
  console.error(output);
  console.error(err);
  process.exit(1);
}
