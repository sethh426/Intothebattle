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
const activeTrialToken = 'socket-active-trial-user';
const expiredTrialToken = 'socket-expired-trial-user';
const paidUserToken = 'socket-paid-user';
const activeTrialRoomId = 'socket-active-trial-room';
const expiredTrialRoomId = 'socket-expired-trial-room';
const paidUserRoomId = 'socket-paid-user-room';
const overlayClientCount = Number(process.env.SOCKET_SMOKE_OVERLAY_COUNT || 10);
const diskPath = fs.mkdtempSync(path.join(os.tmpdir(), 'intothebattle-socket-smoke-'));
const overlayToken = jwt.sign({ purpose: 'overlay', roomId }, jwtSecret, { expiresIn: '1h' });
const expiredTrialOverlayToken = jwt.sign({ purpose: 'overlay', roomId: expiredTrialRoomId }, jwtSecret, { expiresIn: '1h' });

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

async function expectSocketRejected(options, label, pattern = /unauthorized/i) {
  const socket = connectSocket(options);
  const error = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} unexpectedly did not fail`)), 5000);
    socket.once('connect', () => {
      clearTimeout(timer);
      reject(new Error(`${label} unexpectedly connected`));
    });
    socket.once('connect_error', err => {
      clearTimeout(timer);
      resolve(err);
    });
  });
  assert(pattern.test(error.message), `${label} should fail authorization, got: ${error.message}`);
  socket.disconnect();
}

try {
  await waitForHealth();
  const unauthSubscriptionStatus = await request('/api/subscription/status');
  assert(unauthSubscriptionStatus.status === 401, 'subscription status should require authentication');

  const subscriptionStatusRes = await request('/api/subscription/status', {
    headers: { Cookie: `session_token=${e2eSessionToken}` },
  });
  const subscriptionStatusText = await subscriptionStatusRes.text();
  assert(
    subscriptionStatusRes.status === 200,
    `authenticated subscription status should return 200, got ${subscriptionStatusRes.status}: ${subscriptionStatusText}`
  );
  const subscriptionStatus = JSON.parse(subscriptionStatusText);
  assert(subscriptionStatus.success === true, 'subscription status should report success');
  assert(subscriptionStatus.type === 'code', 'E2E subscription status should use code auth');
  assert(subscriptionStatus.status === 'active', 'E2E subscription status should be active');
  assert(subscriptionStatus.accessAllowed === true, 'E2E subscription status should allow access');
  assert(subscriptionStatus.actionRequired === false, 'E2E subscription status should not require action');

  await expectRejectedOverlaySocket();
  await expectSocketRejected(
    { extraHeaders: { Cookie: `session_token=${expiredTrialToken}` } },
    'expired trial dashboard socket',
    /subscription required/i
  );
  await expectSocketRejected(
    {
      auth: { roomId: expiredTrialRoomId, overlayToken: expiredTrialOverlayToken },
      query: { room_id: expiredTrialRoomId, overlay_token: expiredTrialOverlayToken },
    },
    'expired trial signed overlay socket',
    /subscription required/i
  );

  const activeTrialDashboard = connectSocket({
    extraHeaders: { Cookie: `session_token=${activeTrialToken}` },
  });
  const activeTrialReadyPromise = waitForEvent(activeTrialDashboard, 'serverReady', payload => payload.roomId === activeTrialRoomId);
  await waitForEvent(activeTrialDashboard, 'connect');
  const activeTrialReady = await activeTrialReadyPromise;
  assert(activeTrialReady.roomId === activeTrialRoomId, 'active trial dashboard socket should use the active trial room');
  activeTrialDashboard.disconnect();

  const paidUserDashboard = connectSocket({
    extraHeaders: { Cookie: `session_token=${paidUserToken}` },
  });
  const paidUserReadyPromise = waitForEvent(paidUserDashboard, 'serverReady', payload => payload.roomId === paidUserRoomId);
  await waitForEvent(paidUserDashboard, 'connect');
  const paidUserReady = await paidUserReadyPromise;
  assert(paidUserReady.roomId === paidUserRoomId, 'paid user dashboard socket should use the paid user room');
  paidUserDashboard.disconnect();

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
  const dashboardRosterPromise = waitForEvent(dashboard, 'playerRoster', payload => Array.isArray(payload.players));
  const dashboardModePromise = waitForEvent(dashboard, 'streamModeChanged', payload => payload && typeof payload.mode === 'string');
  dashboard.emit('register', { type: 'dashboard' });
  const initialDashboardCount = await initialDashboardCountPromise;
  assert(initialDashboardCount.count === 0, 'dashboard should initially see zero overlays');
  await dashboardSettingsPromise;
  await dashboardGameStatePromise;
  const initialRoster = await dashboardRosterPromise;
  const initialMode = await dashboardModePromise;
  assert(initialRoster.count === 0, 'dashboard roster should initially be empty');
  assert(Array.isArray(initialMode.blockingReasons), 'stream mode should include blocking reasons');

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

  const authedHeaders = {
    Cookie: `session_token=${e2eSessionToken}`,
    'Content-Type': 'application/json',
  };

  const dashboardStatusRes = await request('/api/status', { headers: authedHeaders });
  assert(dashboardStatusRes.status === 200, `dashboard status should return 200, got ${dashboardStatusRes.status}`);
  const dashboardStatus = await dashboardStatusRes.json();
  assert(dashboardStatus.setupOverlayUrl?.includes('setup=1'), 'status should expose signed setup overlay URL');
  assert(dashboardStatus.setupOverlayV2Url?.includes('setup=1'), 'status should expose signed setup V2 overlay URL');
  assert(dashboardStatus.mobileOverlayUrl?.includes('/overlay/mobile'), 'status should expose signed mobile overlay URL');
  assert(dashboardStatus.setupMobileOverlayUrl?.includes('setup=1'), 'status should expose signed mobile setup overlay URL');
  assert(dashboardStatus.overlayUrl?.includes('mode=live'), 'live overlay URL should carry mode=live');
  assert(dashboardStatus.setupOverlayUrl?.includes('mode=setup'), 'setup overlay URL should carry mode=setup');
  assert(dashboardStatus.streamMode && typeof dashboardStatus.streamMode.mode === 'string', 'status should expose stream mode');
  assert(Array.isArray(dashboardStatus.recentPlayers), 'status should expose recentPlayers');
  assert(Array.isArray(dashboardStatus.recentEvents), 'status should expose recentEvents');

  const sessionStartedStatusPromise = waitForEvent(dashboard, 'sessionStatus', payload => payload.active === true && payload.sessionId, 10000);
  const overlaySessionStartedPromise = waitForEvent(primaryOverlay, 'roundEvent', payload => payload.type === 'session_started', 10000);
  const sessionStartRes = await request('/api/session/start', {
    method: 'POST',
    headers: authedHeaders,
  });
  assert(sessionStartRes.status === 200, `session start should return 200, got ${sessionStartRes.status}`);
  const sessionStart = await sessionStartRes.json();
  assert(sessionStart.success === true && sessionStart.session?.active === true, 'session start should activate the session');
  const sessionStartedStatus = await sessionStartedStatusPromise;
  const overlaySessionStarted = await overlaySessionStartedPromise;
  assert(sessionStartedStatus.phase === 'live', `session phase should be live, got ${sessionStartedStatus.phase}`);
  assert(overlaySessionStarted._sessionId === sessionStartedStatus.sessionId, 'roundEvent should carry active session id');

  const roundStartedStatusPromise = waitForEvent(dashboard, 'sessionStatus', payload => payload.round?.active === true, 10000);
  const overlayRoundStartedPromise = waitForEvent(primaryOverlay, 'roundEvent', payload => payload.type === 'round_started', 10000);
  const roundStartRes = await request('/api/session/round/start', {
    method: 'POST',
    headers: authedHeaders,
    body: JSON.stringify({ durationMs: 60000 }),
  });
  assert(roundStartRes.status === 200, `round start should return 200, got ${roundStartRes.status}`);
  const roundStart = await roundStartRes.json();
  assert(roundStart.success === true && roundStart.session?.round?.active === true, 'round start should activate a timed round');
  const roundStartedStatus = await roundStartedStatusPromise;
  const overlayRoundStarted = await overlayRoundStartedPromise;
  assert(roundStartedStatus.phase === 'live', `round phase should remain live, got ${roundStartedStatus.phase}`);
  assert(overlayRoundStarted._sessionId === sessionStartedStatus.sessionId, 'round started event should stay in the same session');

  const bossStartedStatusPromise = waitForEvent(dashboard, 'sessionStatus', payload => payload.bossWave?.active === true, 10000);
  const overlayBossStartedPromise = waitForEvent(primaryOverlay, 'bossWave', payload => payload.type === 'started' && payload.active === true, 10000);
  const bossStartRes = await request('/api/session/boss/start', {
    method: 'POST',
    headers: authedHeaders,
    body: JSON.stringify({ maxHp: 900 }),
  });
  assert(bossStartRes.status === 200, `boss start should return 200, got ${bossStartRes.status}`);
  const bossStart = await bossStartRes.json();
  assert(bossStart.success === true && bossStart.session?.bossWave?.active === true, 'boss start should activate boss wave state');
  const bossStartedStatus = await bossStartedStatusPromise;
  const overlayBossStarted = await overlayBossStartedPromise;
  assert(bossStartedStatus.phase === 'bossWave', `boss phase should be bossWave, got ${bossStartedStatus.phase}`);
  assert(overlayBossStarted._sessionId === sessionStartedStatus.sessionId, 'boss event should carry active session id');

  const bossStoppedStatusPromise = waitForEvent(dashboard, 'sessionStatus', payload => payload.bossWave?.active === false && payload.bossWave?.status === 'stopped', 10000);
  const overlayBossStoppedPromise = waitForEvent(primaryOverlay, 'bossWave', payload => payload.type === 'stopped' && payload.active === false, 10000);
  const bossStopRes = await request('/api/session/boss/stop', {
    method: 'POST',
    headers: authedHeaders,
  });
  assert(bossStopRes.status === 200, `boss stop should return 200, got ${bossStopRes.status}`);
  await bossStoppedStatusPromise;
  await overlayBossStoppedPromise;

  const powerStartedStatusPromise = waitForEvent(dashboard, 'sessionStatus', payload => payload.arenaPowerUp?.active === true, 10000);
  const overlayPowerStartedPromise = waitForEvent(primaryOverlay, 'arenaPowerUp', payload => payload.type === 'started' && payload.active === true, 10000);
  const powerStartRes = await request('/api/session/power-up/start', {
    method: 'POST',
    headers: authedHeaders,
  });
  assert(powerStartRes.status === 200, `Power-Up start should return 200, got ${powerStartRes.status}`);
  const powerStart = await powerStartRes.json();
  assert(powerStart.success === true && powerStart.session?.arenaPowerUp?.active === true, 'Power-Up start should activate arenaPowerUp session state');
  const powerStartedStatus = await powerStartedStatusPromise;
  const overlayPowerStarted = await overlayPowerStartedPromise;
  assert(powerStartedStatus.arenaPowerUp?.remainingMs > 0, 'Power-Up session status should include remainingMs');
  assert(overlayPowerStarted._sessionId === sessionStartedStatus.sessionId, 'Power-Up event should carry active session id');

  const powerStoppedStatusPromise = waitForEvent(dashboard, 'sessionStatus', payload => payload.arenaPowerUp?.active === false && payload.arenaPowerUp?.status === 'stopped', 10000);
  const overlayPowerStoppedPromise = waitForEvent(primaryOverlay, 'arenaPowerUp', payload => payload.type === 'ended' && payload.active === false, 10000);
  const powerStopRes = await request('/api/session/power-up/stop', {
    method: 'POST',
    headers: authedHeaders,
  });
  assert(powerStopRes.status === 200, `Power-Up stop should return 200, got ${powerStopRes.status}`);
  await powerStoppedStatusPromise;
  await overlayPowerStoppedPromise;

  const roundEndedStatusPromise = waitForEvent(dashboard, 'sessionStatus', payload => payload.round === null, 10000);
  const overlayRoundEndedPromise = waitForEvent(primaryOverlay, 'roundEvent', payload => payload.type === 'round_ended', 10000);
  const roundEndRes = await request('/api/session/round/end', {
    method: 'POST',
    headers: authedHeaders,
  });
  assert(roundEndRes.status === 200, `round end should return 200, got ${roundEndRes.status}`);
  await roundEndedStatusPromise;
  await overlayRoundEndedPromise;

  const sessionEndedStatusPromise = waitForEvent(dashboard, 'sessionStatus', payload => payload.active === false && payload.recap, 10000);
  const overlaySessionEndedPromise = waitForEvent(primaryOverlay, 'roundEvent', payload => payload.type === 'session_ended' && payload.recap, 10000);
  const sessionEndRes = await request('/api/session/end', {
    method: 'POST',
    headers: authedHeaders,
  });
  assert(sessionEndRes.status === 200, `session end should return 200, got ${sessionEndRes.status}`);
  const sessionEnd = await sessionEndRes.json();
  assert(sessionEnd.success === true && sessionEnd.recap, 'session end should return a recap');
  await sessionEndedStatusPromise;
  await overlaySessionEndedPromise;

  const preparePromise = waitForEvent(primaryOverlay, 'sponsorPrepare', payload => payload?.breakId, 10000);
  const sponsorPlayRes = await request('/api/sponsor/play', {
    method: 'POST',
    headers: authedHeaders,
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
  assert(prepared._epoch >= 1, 'sponsor prepare should carry a runtime epoch');

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
  assert(decodedStatus.sessionId === null || typeof decodedStatus.sessionId === 'string', 'sponsor status should include session identity shape');

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

  const livePlayersPromise = waitForEvent(
    primaryOverlay,
    'gameState',
    payload => Object.values(payload || {}).some(player => player?.alive),
    10000
  );
  const dashboardTestRosterPromise = waitForEvent(
    dashboard,
    'playerRoster',
    payload => Array.isArray(payload.players) && payload.players.some(player => player.source === 'test'),
    10000
  );
  const followTestRes = await request('/api/overlay/test/follow', {
    method: 'POST',
    headers: authedHeaders,
  });
  assert(followTestRes.status === 200, `overlay follow test should return 200, got ${followTestRes.status}`);
  await livePlayersPromise;
  const dashboardTestRoster = await dashboardTestRosterPromise;
  assert(dashboardTestRoster.bySource?.test > 0, 'overlay test players should be tagged as test source');

  const passiveCommentAttackPromise = waitForEvent(
    primaryOverlay,
    'attack',
    payload => payload?.passiveCommentAttack === true && payload?.damage === 5 && payload?.targetScope === 'horde',
    10000
  );
  const passiveCommentDamagePromise = waitForEvent(
    primaryOverlay,
    'commentDamage',
    payload => payload?.passiveCommentAttack === true && payload?.damage === 5 && payload?.commandDescription === 'CHAT POKE',
    10000
  );
  const commentOverlayTestRes = await request('/api/overlay/test/comment', {
    method: 'POST',
    headers: authedHeaders,
  });
  assert(commentOverlayTestRes.status === 200, `overlay comment test should return 200, got ${commentOverlayTestRes.status}`);
  const commentOverlayTest = await commentOverlayTestRes.json();
  const passiveCommentResult = commentOverlayTest.result?.result || commentOverlayTest.result;
  assert(passiveCommentResult?.passiveCommentAttack === true, 'plain comment overlay test should mark passiveCommentAttack');
  assert(passiveCommentResult?.damage === 5, `plain comment overlay test should deal 5 damage, got ${passiveCommentResult?.damage}`);
  await passiveCommentAttackPromise;
  await passiveCommentDamagePromise;

  const shareSocialBoostPromise = waitForEvent(
    primaryOverlay,
    'socialBoost',
    payload => payload?.type === 'share' && payload?.fullHeal === true && payload?.selfFullHeal > 0,
    10000
  );
  const shareFullHealStatePromise = waitForEvent(
    primaryOverlay,
    'gameState',
    payload => {
      const player = payload?.arena_nova;
      return player?.alive && Number(player.hp) > 0 && Number(player.hp) === Number(player.maxHp);
    },
    10000
  );
  const shareOverlayTestRes = await request('/api/overlay/test/share', {
    method: 'POST',
    headers: authedHeaders,
  });
  assert(shareOverlayTestRes.status === 200, `overlay share test should return 200, got ${shareOverlayTestRes.status}`);
  const shareOverlayTest = await shareOverlayTestRes.json();
  assert(shareOverlayTest.reward?.fullHeal === true, 'share overlay test should mark fullHeal');
  assert(shareOverlayTest.reward?.selfFullHeal > 0, 'share overlay test should heal the sharer to full');
  await shareSocialBoostPromise;
  await shareFullHealStatePromise;

  const overlayTestPowerStartedPromise = waitForEvent(primaryOverlay, 'arenaPowerUp', payload => payload.type === 'started' && payload.active === true, 10000);
  const overlayTestLeaderboardPromise = waitForEvent(
    primaryOverlay,
    'arenaPowerUp',
    payload => payload.type === 'leaderboard' && Array.isArray(payload.topContributors) && payload.topContributors.length >= 3,
    10000
  );
  const overlayTestPoweredAttackPromise = waitForEvent(
    primaryOverlay,
    'arenaPowerUp',
    payload => payload.type === 'poweredAttack' && payload.poweredAttack === true && payload.powerLabel,
    10000
  );
  const overlayTestAttackPromise = waitForEvent(
    primaryOverlay,
    'attack',
    payload => payload?.poweredAttack === true && payload?.powerLabel && payload?.powerMultiplier >= 3,
    10000
  );
  const powerOverlayTestRes = await request('/api/overlay/test/power-up', {
    method: 'POST',
    headers: authedHeaders,
  });
  assert(powerOverlayTestRes.status === 200, `overlay Power-Up test should return 200, got ${powerOverlayTestRes.status}`);
  const powerOverlayTest = await powerOverlayTestRes.json();
  assert(powerOverlayTest.success === true && powerOverlayTest.arenaPowerUp?.active === true, 'overlay Power-Up test should activate arenaPowerUp state');
  const overlayTestPowerStarted = await overlayTestPowerStartedPromise;
  const overlayTestLeaderboard = await overlayTestLeaderboardPromise;
  const overlayTestPoweredAttack = await overlayTestPoweredAttackPromise;
  const overlayTestAttack = await overlayTestAttackPromise;
  assert(overlayTestPowerStarted.trigger === 'overlay_test', 'overlay Power-Up test should mark overlay_test trigger');
  assert(overlayTestLeaderboard.topContributors[0]?.uniqueId === 'arena_orion', 'overlay Power-Up test should rank seeded gift contributor first');
  assert(overlayTestPoweredAttack.powerLabel, 'Power-Up poweredAttack event should include effect label');
  assert(overlayTestAttack.poweredAttack === true, 'Power-Up command should annotate attack payloads');

  const powerOverlayStopRes = await request('/api/session/power-up/stop', {
    method: 'POST',
    headers: authedHeaders,
  });
  assert(powerOverlayStopRes.status === 200, `Power-Up cleanup stop should return 200, got ${powerOverlayStopRes.status}`);

  const bossHordeAttackPromise = waitForEvent(
    primaryOverlay,
    'attack',
    payload => payload?.attacker === '__BOSS__' && payload?.target === '__HORDE__' && payload?.targetScope === 'horde',
    9000
  );
  const bossAttackSummaryPromise = waitForEvent(
    primaryOverlay,
    'bossWave',
    payload => payload?.type === 'attack'
      && Array.isArray(payload.targets)
      && payload.targets.some(target => target.uniqueId === '__HORDE__' && target.targetScope === 'horde')
      && payload.targets.filter(target => target.targetScope === 'top').length >= 5,
    9000
  );
  const bossOverlayTestRes = await request('/api/overlay/test/boss', {
    method: 'POST',
    headers: authedHeaders,
  });
  assert(bossOverlayTestRes.status === 200, `overlay boss test should return 200, got ${bossOverlayTestRes.status}`);
  const bossHordeAttack = await bossHordeAttackPromise;
  const bossAttackSummary = await bossAttackSummaryPromise;
  assert(bossHordeAttack.affectedCount > 0, 'boss horde attack should damage reserve players');
  assert(bossAttackSummary.targets.length >= 6, 'boss attack summary should include five players plus the horde');

  const resetStreamPromise = waitForEvent(dashboard, 'tiktokConnection', payload => payload.status === 'disconnected', 10000);
  const resetSessionStatusPromise = waitForEvent(dashboard, 'sessionStatus', payload => payload.active === false && payload.phase === 'idle', 10000);
  const resetGameStatePromise = waitForEvent(
    primaryOverlay,
    'gameState',
    payload => Object.values(payload || {}).filter(player => player?.alive).length === 0,
    10000
  );
  const resetRes = await request('/api/reset', {
    method: 'POST',
    headers: authedHeaders,
  });
  assert(resetRes.status === 200, `stream reset should return 200, got ${resetRes.status}`);
  await resetStreamPromise;
  await resetSessionStatusPromise;
  await resetGameStatePromise;

  const setupActiveDashboardPromise = waitForEvent(dashboard, 'setupMode', payload => payload.active === true, 10000);
  const setupActiveOverlayPromise = waitForEvent(primaryOverlay, 'setupMode', payload => payload.active === true, 10000);
  const setupPlayersPromise = waitForEvent(
    primaryOverlay,
    'gameState',
    payload => Object.values(payload || {}).filter(player => player?.alive).length > 0,
    10000
  );
  const setupRosterPromise = waitForEvent(
    dashboard,
    'playerRoster',
    payload => Array.isArray(payload.players) && payload.players.some(player => player.source === 'demo'),
    10000
  );
  const setupStartRes = await request('/api/stream/setup/start', {
    method: 'POST',
    headers: authedHeaders,
    body: JSON.stringify({ action: 'attack' }),
  });
  assert(setupStartRes.status === 200, `setup rehearsal start should return 200, got ${setupStartRes.status}`);
  const setupStart = await setupStartRes.json();
  assert(setupStart.success === true && setupStart.setupRehearsal?.active === true, 'setup rehearsal should activate');
  assert(setupStart.overlayUrl?.includes('setup=1'), 'setup start response should include setup overlay URL');
  assert(setupStart.mobileOverlayUrl?.includes('/overlay/mobile'), 'setup start response should include mobile setup overlay URL');
  await setupActiveDashboardPromise;
  await setupActiveOverlayPromise;
  await setupPlayersPromise;
  const setupRoster = await setupRosterPromise;
  assert(setupRoster.bySource?.demo > 0, 'setup rehearsal players should be tagged as demo source');

  const setupResetDashboardPromise = waitForEvent(dashboard, 'setupMode', payload => payload.active === false, 10000);
  const setupResetOverlayPromise = waitForEvent(primaryOverlay, 'setupMode', payload => payload.active === false, 10000);
  const setupResetPlayersPromise = waitForEvent(
    primaryOverlay,
    'gameState',
    payload => Object.values(payload || {}).filter(player => player?.alive).length === 0,
    10000
  );
  const setupResetRes = await request('/api/stream/setup/reset', {
    method: 'POST',
    headers: authedHeaders,
  });
  assert(setupResetRes.status === 200, `setup rehearsal reset should return 200, got ${setupResetRes.status}`);
  const setupReset = await setupResetRes.json();
  assert(setupReset.success === true && setupReset.setupRehearsal?.active === false, 'setup rehearsal should reset');
  await setupResetDashboardPromise;
  await setupResetOverlayPromise;
  await setupResetPlayersPromise;

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
