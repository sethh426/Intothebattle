import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { io as createSocket } from 'socket.io-client';
import { AETHERIS_TERRITORIES } from '../tiktokbr/services/aetherisCatalog.js';

const port = Number(process.env.AETHERIS_WAR_SMOKE_PORT || 3567);
const host = '127.0.0.1';
const baseUrl = `http://${host}:${port}`;
const diskPath = fs.mkdtempSync(path.join(os.tmpdir(), 'intothebattle-aetheris-war-'));
const attackerToken = 'aetheris-attacker-token';
const defenderToken = 'aetheris-defender-token';
const attackerRoom = 'aetheris-attacker-room';
const defenderRoom = 'aetheris-defender-room';

const server = spawn(process.execPath, ['server.js'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    PORT: String(port),
    HOST: host,
    NODE_ENV: 'test',
    API_KEY: 'test',
    JWT_SECRET: 'aetheris-war-test-secret',
    OVERLAY_TOKEN_SECRET: 'aetheris-war-test-secret',
    ENABLE_ROOM_SCOPED: 'true',
    SKIP_DB: 'true',
    DEV_TEST_MODE: 'true',
    DISK_PATH: diskPath,
    APP_BASE_URL: baseUrl,
    E2E_PAID_USER_SESSION_TOKEN: attackerToken,
    E2E_PAID_USER_ROOM_ID: attackerRoom,
    E2E_ACTIVE_TRIAL_SESSION_TOKEN: defenderToken,
    E2E_ACTIVE_TRIAL_ROOM_ID: defenderRoom,
    EMAIL_DISABLE_SEND: 'true',
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

function headers(token) {
  return { Cookie: `session_token=${token}`, 'Content-Type': 'application/json' };
}

async function request(pathname, options = {}) {
  return fetch(`${baseUrl}${pathname}`, { redirect: 'manual', ...options });
}

async function post(pathname, token, body = {}) {
  const response = await request(pathname, { method: 'POST', headers: headers(token), body: JSON.stringify(body) });
  const payload = await response.json();
  return { response, payload };
}

async function waitForHealth() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`server exited early with code ${server.exitCode}\n${output}`);
    try {
      const response = await request('/healthz');
      if (response.status === 200) return;
    } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  throw new Error(`server did not become healthy\n${output}`);
}

try {
  await waitForHealth();
  const unauthenticated = await request('/api/aetheris/war/status');
  assert(unauthenticated.status === 401, 'private war status must reject signed-out visitors');

  const publicInitial = await request('/api/aetheris/world-state');
  assert(publicInitial.status === 200, 'public world state should load');
  const publicInitialBody = await publicInitial.json();
  assert(Object.keys(publicInitialBody.claims).length === 0, 'preseason test world should start unclaimed');

  const attackerHome = AETHERIS_TERRITORIES[0];
  const frontier = AETHERIS_TERRITORIES.find(territory => attackerHome.neighbors.includes(territory.id));
  const defenderHome = AETHERIS_TERRITORIES.find(territory => frontier.neighbors.includes(territory.id) && territory.id !== attackerHome.id);
  assert(frontier && defenderHome, 'test territories should form a connected attack path');

  assert((await post('/api/aetheris/war/opt-in', attackerToken, { enabled: true })).response.status === 200, 'attacker opt-in should succeed');
  assert((await post('/api/aetheris/war/home', attackerToken, { territoryId: attackerHome.id })).response.status === 200, 'attacker home selection should succeed');
  assert((await post('/api/aetheris/war/opt-in', defenderToken, { enabled: true })).response.status === 200, 'defender opt-in should succeed');
  assert((await post('/api/aetheris/war/home', defenderToken, { territoryId: defenderHome.id })).response.status === 200, 'defender home selection should succeed');

  const expedition = await post('/api/aetheris/war/expeditions', attackerToken, { territoryId: frontier.id });
  assert(expedition.response.status === 200 && expedition.payload.campaign?.phase === 'mobilizing', 'adjacent neutral expedition should mobilize');
  const prematureRound = await post('/api/aetheris/war/rounds/start', attackerToken, { campaignId: expedition.payload.campaign.id, devForceLive: true });
  assert(prematureRound.response.status === 409, 'round scoring must stay closed during mobilization');

  const publicLive = await request('/api/aetheris/world-state');
  const publicLiveBody = await publicLive.json();
  const serialized = JSON.stringify(publicLiveBody);
  assert(publicLiveBody.campaigns.length === 1, 'mobilization should be public immediately');
  assert(!serialized.includes(attackerRoom) && !serialized.includes(defenderRoom), 'public state must not expose private room ids');
  assert(!serialized.includes('@example.com'), 'public state must not expose email addresses');

  const socket = createSocket(`${baseUrl}/aetheris-world`, { transports: ['websocket'], reconnection: false });
  const socketSnapshot = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('worldStateSnapshot timed out')), 5000);
    socket.once('worldStateSnapshot', payload => {
      clearTimeout(timer);
      resolve(payload);
    });
    socket.once('connect_error', error => {
      clearTimeout(timer);
      reject(error);
    });
  });
  socket.disconnect();
  const socketSerialized = JSON.stringify(socketSnapshot);
  assert(socketSnapshot.campaigns?.length === 1, 'socket snapshot should include live mobilization');
  assert(!socketSerialized.includes(attackerRoom) && !socketSerialized.includes(defenderRoom), 'socket state must not expose private room ids');

  console.log('Aetheris war HTTP smoke passed: account gate, opt-in, home selection, adjacent expedition, mobilization timing, and public HTTP/socket privacy.');
} finally {
  stopServer();
}
