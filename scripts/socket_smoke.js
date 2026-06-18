import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import jwt from 'jsonwebtoken';
import { io as createSocket } from 'socket.io-client';

const port = Number(process.env.SOCKET_SMOKE_PORT || 3527);
const host = '127.0.0.1';
const baseUrl = `http://${host}:${port}`;
const roomId = 'socket-smoke-room';
const jwtSecret = 'socket-smoke-secret';
const e2eSessionToken = 'socket-smoke-session';
const overlayClientCount = Number(process.env.SOCKET_SMOKE_OVERLAY_COUNT || 10);
const diskPath = fs.mkdtempSync(path.join(os.tmpdir(), 'intothebattle-socket-smoke-'));
const overlayToken = jwt.sign({ purpose: 'overlay', roomId }, jwtSecret, { expiresIn: '1h' });

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
    E2E_SESSION_TOKEN: e2eSessionToken,
    E2E_ROOM_ID: roomId,
    LOG_LEVEL: 'error',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let output = '';
server.stdout.on('data', chunk => { output += chunk.toString(); });
server.stderr.on('data', chunk => { output += chunk.toString(); });

const sockets = [];

function stopServer() {
  for (const socket of sockets) {
    try { socket.disconnect(); } catch (_) {}
  }
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

function waitForEvent(socket, event, predicate = () => true, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${event}`));
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timer);
      socket.off(event, onEvent);
      socket.off('connect_error', onError);
      socket.off('disconnect', onDisconnect);
    }

    function onEvent(payload) {
      try {
        if (!predicate(payload)) return;
        cleanup();
        resolve(payload);
      } catch (err) {
        cleanup();
        reject(err);
      }
    }

    function onError(err) {
      cleanup();
      reject(err);
    }

    function onDisconnect(reason) {
      cleanup();
      reject(new Error(`Socket disconnected while waiting for ${event}: ${reason}`));
    }

    socket.on(event, onEvent);
    socket.on('connect_error', onError);
    socket.on('disconnect', onDisconnect);
  });
}

function connectSocket(options = {}) {
  const socket = createSocket(baseUrl, {
    transports: ['websocket'],
    timeout: 5000,
    reconnection: false,
    ...options,
  });
  sockets.push(socket);
  return socket;
}

async function expectRejectedOverlaySocket() {
  const socket = connectSocket({
    auth: { roomId, overlayToken: 'bad-token' },
    query: { room_id: roomId, overlay_token: 'bad-token' },
  });

  const error = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Bad overlay socket unexpectedly did not fail')), 5000);
    socket.once('connect', () => {
      clearTimeout(timer);
      reject(new Error('Bad overlay socket unexpectedly connected'));
    });
    socket.once('connect_error', err => {
      clearTimeout(timer);
      resolve(err);
    });
  });
  assert(/unauthorized/i.test(error.message), `Bad overlay socket should fail authorization, got: ${error.message}`);
  socket.disconnect();
}

try {
  await waitForHealth();
  const unauthSubscriptionStatus = await request('/api/subscription/status');
  assert(unauthSubscriptionStatus.status === 401, 'subscription status should require authentication');

  const subscriptionStatusRes = await request('/api/subscription/status', {
    headers: { Cookie: `session_token=${e2eSessionToken}` },
  });
  assert(subscriptionStatusRes.status === 200, 'authenticated subscription status should return 200');
  const subscriptionStatus = await subscriptionStatusRes.json();
  assert(subscriptionStatus.success === true, 'subscription status should report success');
  assert(subscriptionStatus.type === 'code', 'E2E subscription status should use code auth');
  assert(subscriptionStatus.status === 'active', 'E2E subscription status should be active');
  assert(subscriptionStatus.accessAllowed === true, 'E2E subscription status should allow access');
  assert(subscriptionStatus.actionRequired === false, 'E2E subscription status should not require action');

  await expectRejectedOverlaySocket();

  const dashboard = connectSocket({
    extraHeaders: { Cookie: `session_token=${e2eSessionToken}` },
  });
  const dashboardReadyPromise = waitForEvent(dashboard, 'serverReady', payload => payload.roomId === roomId);
  await waitForEvent(dashboard, 'connect');
  const dashboardReady = await dashboardReadyPromise;
  assert(dashboardReady.roomId === roomId, 'dashboard serverReady should use E2E room');
  const initialDashboardCountPromise = waitForEvent(dashboard, 'overlayCount', payload => payload.count === 0);
  const dashboardSettingsPromise = waitForEvent(dashboard, 'overlaySettings', payload => payload && typeof payload === 'object');
  const dashboardGameStatePromise = waitForEvent(dashboard, 'gameState', payload => payload && typeof payload === 'object');
  dashboard.emit('register', { type: 'dashboard' });
  const initialDashboardCount = await initialDashboardCountPromise;
  assert(initialDashboardCount.count === 0, 'dashboard should initially see zero overlays');
  await dashboardSettingsPromise;
  await dashboardGameStatePromise;

  const overlaySockets = [];
  for (let index = 0; index < overlayClientCount; index++) {
    const overlay = connectSocket({
      auth: { roomId, overlayToken },
      query: { room_id: roomId, overlay_token: overlayToken },
    });
    overlaySockets.push(overlay);

    const overlayReadyPromise = waitForEvent(overlay, 'serverReady', payload => payload.roomId === roomId);
    await waitForEvent(overlay, 'connect');
    const overlayReady = await overlayReadyPromise;
    assert(overlayReady.roomId === roomId, 'signed overlay serverReady should use signed room');

    const overlayGameStatePromise = waitForEvent(overlay, 'gameState', payload => payload && typeof payload === 'object');
    const overlayAudioConfigPromise = waitForEvent(overlay, 'audioConfig', payload => payload && typeof payload === 'object');
    const overlaySettingsPromise = waitForEvent(overlay, 'overlaySettings', payload => payload && typeof payload === 'object');
    const overlayLaserColorPromise = waitForEvent(overlay, 'laserColor', value => typeof value === 'string' && value.length > 0);
    const expectedCount = index + 1;
    const dashboardConnectedCountPromise = waitForEvent(
      dashboard,
      'overlayCount',
      payload => payload.count === expectedCount,
      10000
    );
    overlay.emit('register', { type: 'overlay' });

    await overlayGameStatePromise;
    await overlayAudioConfigPromise;
    await overlaySettingsPromise;
    await overlayLaserColorPromise;

    const dashboardConnectedCount = await dashboardConnectedCountPromise;
    assert(
      dashboardConnectedCount.count === expectedCount,
      `dashboard should see overlay count increment to ${expectedCount}`
    );
  }

  const primaryOverlay = overlaySockets[0];
  const preparePromise = waitForEvent(primaryOverlay, 'sponsorPrepare', payload => payload?.breakId, 10000);
  const sponsorPlayRes = await request('/api/sponsor/play', {
    method: 'POST',
    headers: {
      Cookie: `session_token=${e2eSessionToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      partner: 'Socket Smoke',
      title: 'Handshake Proof',
      subtitle: 'Testing sponsor playback state flow.',
      durationMs: 5000,
      muted: true,
      fit: 'contain',
      statsMode: 'endcap',
    }),
  });
  assert(sponsorPlayRes.status === 200, `sponsor play should return 200, got ${sponsorPlayRes.status}`);
  const sponsorPlay = await sponsorPlayRes.json();
  assert(sponsorPlay.success === true && sponsorPlay.breakId, 'sponsor play should return a break id');
  const prepared = await preparePromise;
  assert(prepared.breakId === sponsorPlay.breakId, 'overlay should receive sponsor prepare before playback starts');

  const decodedStatusPromise = waitForEvent(dashboard, 'sponsorBreakStatus', payload => payload.status === 'decoded' && payload.breakId === sponsorPlay.breakId, 10000);
  primaryOverlay.emit('sponsorPlaybackEvent', {
    breakId: sponsorPlay.breakId,
    status: 'decoded',
    readyState: 1,
    mediaWidth: 1920,
    mediaHeight: 1080,
    mediaDurationMs: 5000,
  });
  const decodedStatus = await decodedStatusPromise;
  assert(decodedStatus.decodedAt, 'decoded sponsor status should include decodedAt');

  const readyStatusPromise = waitForEvent(dashboard, 'sponsorBreakStatus', payload => payload.status === 'ready' && payload.breakId === sponsorPlay.breakId, 10000);
  const startingStatusPromise = waitForEvent(dashboard, 'sponsorBreakStatus', payload => payload.status === 'starting' && payload.breakId === sponsorPlay.breakId, 10000);
  const showScenePromise = waitForEvent(primaryOverlay, 'sponsorScene', payload => payload.action === 'show' && payload.breakId === sponsorPlay.breakId, 10000);
  primaryOverlay.emit('sponsorPlaybackEvent', {
    breakId: sponsorPlay.breakId,
    status: 'ready',
    readyState: 2,
    mediaWidth: 1920,
    mediaHeight: 1080,
    mediaDurationMs: 5000,
  });
  const readyStatus = await readyStatusPromise;
  assert(readyStatus.readyAt, 'ready sponsor status should include readyAt');
  await startingStatusPromise;
  await showScenePromise;

  const liveStatusPromise = waitForEvent(dashboard, 'sponsorBreakStatus', payload => payload.status === 'live' && payload.breakId === sponsorPlay.breakId, 10000);
  primaryOverlay.emit('sponsorPlaybackEvent', { breakId: sponsorPlay.breakId, status: 'live', readyState: 2 });
  await liveStatusPromise;

  const playbackStartedPromise = waitForEvent(
    dashboard,
    'sponsorBreakStatus',
    payload => payload.status === 'live' && /waiting for first frame/i.test(payload.message || '') && payload.breakId === sponsorPlay.breakId,
    10000
  );
  primaryOverlay.emit('sponsorPlaybackEvent', { breakId: sponsorPlay.breakId, status: 'playing', readyState: 2, currentTime: 0.1 });
  await playbackStartedPromise;

  const firstFramePromise = waitForEvent(dashboard, 'sponsorBreakStatus', payload => payload.status === 'playing' && payload.breakId === sponsorPlay.breakId, 10000);
  primaryOverlay.emit('sponsorPlaybackEvent', { breakId: sponsorPlay.breakId, status: 'first_frame', readyState: 4, currentTime: 0.2 });
  const firstFrameStatus = await firstFramePromise;
  assert(firstFrameStatus.firstFrameAt, 'first frame sponsor status should include firstFrameAt');

  const videoCompletedPromise = waitForEvent(dashboard, 'sponsorBreakStatus', payload => payload.status === 'video_completed' && payload.breakId === sponsorPlay.breakId, 10000);
  primaryOverlay.emit('sponsorPlaybackEvent', { breakId: sponsorPlay.breakId, status: 'video_completed', readyState: 4, currentTime: 5 });
  await videoCompletedPromise;

  const completedPromise = waitForEvent(dashboard, 'sponsorBreakStatus', payload => payload.status === 'completed' && payload.breakId === sponsorPlay.breakId, 10000);
  primaryOverlay.emit('sponsorPlaybackEvent', { breakId: sponsorPlay.breakId, status: 'completed', readyState: 4, currentTime: 5 });
  await completedPromise;

  for (let index = overlaySockets.length - 1; index >= 0; index--) {
    const expectedCount = index;
    const dashboardDisconnectedCountPromise = waitForEvent(
      dashboard,
      'overlayCount',
      payload => payload.count === expectedCount,
      10000
    );
    overlaySockets[index].disconnect();
    const dashboardDisconnectedCount = await dashboardDisconnectedCountPromise;
    assert(
      dashboardDisconnectedCount.count === expectedCount,
      `dashboard should see overlay count decrement to ${expectedCount}`
    );
  }

  console.log('Socket smoke checks passed');
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
