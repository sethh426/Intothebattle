import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import jwt from 'jsonwebtoken';

const port = Number(process.env.E2E_PORT || 3527);
const host = '127.0.0.1';
const baseUrl = `http://${host}:${port}`;
const roomId = 'e2e-room';
const jwtSecret = 'e2e-test-secret';
const e2eSessionToken = 'e2e-session-token';
const diskPath = fs.mkdtempSync(path.join(os.tmpdir(), 'intothebattle-e2e-'));
const overlayToken = jwt.sign({ purpose: 'overlay', roomId }, jwtSecret, { expiresIn: '1h' });

let server;
let output = '';

async function request(pathname) {
  return fetch(`${baseUrl}${pathname}`, { redirect: 'manual' });
}

async function waitForHealth() {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (server?.exitCode !== null) {
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

async function watchPage(page) {
  const errors = [];
  page.on('pageerror', err => errors.push(`pageerror: ${err.message}`));
  page.on('console', msg => {
    const text = msg.text();
    if (msg.type() === 'error' && !/Failed to load resource: net::ERR_NETWORK_CHANGED\b/.test(text)) {
      errors.push(`console error: ${text}`);
    }
  });
  page.on('requestfailed', req => {
    try {
      if (new URL(req.url()).origin === baseUrl) {
        errors.push(`request failed: ${req.method()} ${req.url()} ${req.failure()?.errorText || ''}`);
      }
    } catch (_) {}
  });
  return errors;
}

async function expectNoHorizontalOverflow(page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(2);
}

async function capture(page, testInfo, name) {
  await page.screenshot({ path: testInfo.outputPath(`${name}.png`), fullPage: true, timeout: 30000 });
}

async function expectHealthyPage(page, testInfo, pathname, selector, name) {
  const errors = await watchPage(page);
  await page.goto(`${baseUrl}${pathname}`, { waitUntil: 'domcontentloaded' });
  await expect(page.locator(selector)).toBeVisible();
  await page.waitForLoadState('load');
  await expectNoHorizontalOverflow(page);
  await capture(page, testInfo, name);
  expect(errors).toEqual([]);
}

test.beforeAll(async () => {
  server = spawn(process.execPath, ['server.js'], {
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
      DEV_TEST_MODE: 'true',
      DISK_PATH: diskPath,
      APP_BASE_URL: baseUrl,
      E2E_SESSION_TOKEN: e2eSessionToken,
      E2E_ROOM_ID: roomId,
      LOG_LEVEL: 'error',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', chunk => { output += chunk.toString(); });
  server.stderr.on('data', chunk => { output += chunk.toString(); });
  await waitForHealth();
});

test.afterAll(async () => {
  if (server && !server.killed) server.kill();
  try { fs.rmSync(diskPath, { recursive: true, force: true }); } catch (_) {}
});

for (const [name, pathname, selector] of [
  ['home', '/', 'body'],
  ['login', '/login', '#accountLoginForm'],
  ['signup', '/signup', '#googleSignupLink'],
  ['how-to-play', '/how-to-play', '#commands-title'],
  ['site-map', '/site-map', '#site-map-title'],
  ['sponsors', '/sponsors', '.hero'],
  ['paywall', '/paywall', 'body'],
]) {
  test(`${name} renders without local browser errors`, async ({ page }, testInfo) => {
    await expectHealthyPage(page, testInfo, pathname, selector, name);
  });
}

test('home hero video is visible and playable', async ({ page }, testInfo) => {
  const errors = await watchPage(page);
  const mediaResponses = [];
  page.on('response', res => {
    if (res.url().includes('/media/remotion/homepage-real-overlay-')) {
      mediaResponses.push({ url: res.url(), status: res.status() });
    }
  });

  await page.goto(`${baseUrl}/`, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.demo-shell')).toBeVisible();
  const video = page.locator('.frame-wrap video');
  await expect(video).toBeVisible();

  const state = await video.evaluate(async el => {
    if (el.readyState < 1) {
      await new Promise(resolve => el.addEventListener('loadedmetadata', resolve, { once: true }));
    }
    await el.play().catch(() => {});
    await new Promise(resolve => setTimeout(resolve, 800));
    const rect = el.getBoundingClientRect();
    return {
      src: el.currentSrc || el.src,
      currentTime: el.currentTime,
      paused: el.paused,
      readyState: el.readyState,
      videoWidth: el.videoWidth,
      videoHeight: el.videoHeight,
      error: el.error ? { code: el.error.code, message: el.error.message } : null,
      rect: { top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height },
      viewportHeight: window.innerHeight,
    };
  });

  expect(state.src).toContain('/media/remotion/homepage-real-overlay-source.mp4');
  expect(state.error).toBeNull();
  expect(state.readyState).toBeGreaterThanOrEqual(2);
  expect(state.videoWidth).toBeGreaterThanOrEqual(1280);
  expect(state.videoHeight).toBeGreaterThanOrEqual(720);
  expect(state.currentTime).toBeGreaterThan(0);
  expect(state.rect.width).toBeGreaterThan(300);
  expect(state.rect.top).toBeLessThan(state.viewportHeight * 0.75);
  expect(mediaResponses.some(res => [200, 206, 304].includes(res.status))).toBe(true);
  await expectNoHorizontalOverflow(page);
  await capture(page, testInfo, 'home-video');
  expect(errors).toEqual([]);
});

test('profile redirects unauthenticated users to login', async ({ page }, testInfo) => {
  const errors = await watchPage(page);
  await page.goto(`${baseUrl}/profile`, { waitUntil: 'domcontentloaded' });
  await expect(page).toHaveURL(/\/login/);
  await expect(page.locator('#accountLoginForm')).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await capture(page, testInfo, 'profile-redirect');
  expect(errors).toEqual([]);
});

test('dashboard renders with E2E auth fixture', async ({ context, page }, testInfo) => {
  await context.addCookies([{ name: 'session_token', value: e2eSessionToken, url: baseUrl }]);
  const errors = await watchPage(page);
  await page.goto(`${baseUrl}/dashboard`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByText('IntoTheBattle Command Center')).toBeVisible();
  await expect(page.locator('#subscription-chip')).toBeVisible();
  await expect(page.locator('#nextActionPanel')).toBeVisible();
  await expect(page.locator('#backgroundFitInput')).toBeAttached();
  await expect(page.getByRole('button', { name: 'Open Live Overlay' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Copy 1080p Source' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Copy 1440p Source' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Preview Phaser V2' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open V2 1080p' })).toBeVisible();
  await page.locator('#liveWorkflow').evaluate(el => { el.open = true; });
  await expect(page.getByText('Live Session Director')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Boss Wave' })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await capture(page, testInfo, 'dashboard');
  expect(errors).toEqual([]);
});

test('signed overlay renders a nonblank canvas', async ({ page }, testInfo) => {
  const errors = await watchPage(page);
  await page.goto(`${baseUrl}/overlay?room_id=${roomId}&overlay_token=${encodeURIComponent(overlayToken)}`, { waitUntil: 'domcontentloaded' });
  const canvas = page.locator('canvas');
  await expect(canvas).toBeVisible();
  await page.waitForFunction(() => {
    const layout = window.__overlayLegacyLayout;
    return Array.isArray(layout?.players) && layout.players.length >= 5 && layout.horde;
  }, null, { timeout: 7000 });

  const hasVisiblePixels = await canvas.evaluate(el => {
    if (!el.width || !el.height) return false;
    const ctx = el.getContext('2d');
    const sample = ctx.getImageData(0, 0, el.width, el.height).data;
    for (let i = 3; i < sample.length; i += 32) {
      if (sample[i] !== 0) return true;
    }
    return false;
  });
  expect(hasVisiblePixels).toBe(true);
  const legacyLayout = await page.evaluate(() => window.__overlayLegacyLayout);
  expect(legacyLayout.leaks || []).toEqual([]);
  const playerTop = Math.min(...legacyLayout.players.map(player => player.top));
  const playerBottom = Math.max(...legacyLayout.players.map(player => player.bottom));
  const frameTop = legacyLayout.frame.y;
  const frameHeight = legacyLayout.frame.h;
  expect(playerTop).toBeGreaterThan(frameTop + frameHeight * 0.18);
  expect(legacyLayout.horde.top).toBeGreaterThan(playerBottom + frameHeight * 0.22);
  expect(legacyLayout.horde.top).toBeLessThan(frameTop + frameHeight * 0.78);
  if (legacyLayout.boss) {
    expect(legacyLayout.horde.top - legacyLayout.boss.bottom).toBeGreaterThan(frameHeight * 0.02);
  }
  await expectNoHorizontalOverflow(page);
  await capture(page, testInfo, 'overlay');
  expect(errors).toEqual([]);
});

test.skip('signed Phaser overlay v2 renders a fitted broadcast canvas', async ({ page }, testInfo) => {
  const errors = await watchPage(page);
  const params = new URLSearchParams({
    room_id: roomId,
    overlay_token: overlayToken,
    demo: '1',
    render: '1080p',
  });
  await page.goto(`${baseUrl}/overlay-v2?${params.toString()}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__overlayV2Ready === true, null, { timeout: 6000 });
  await page.waitForFunction(() => Array.isArray(window.__overlayV2Layout) && window.__overlayV2Layout.length >= 5, null, { timeout: 6000 });
  const canvas = page.locator('#phaser-overlay-root canvas');
  await expect(canvas).toBeVisible();
  const stage = await canvas.getAttribute('data-stage');
  expect(stage).toBe('1920x1080');
  const box = await canvas.boundingBox();
  expect(box).toBeTruthy();
  expect(Math.abs((box.width / box.height) - (16 / 9))).toBeLessThan(0.02);
  const layout = await page.evaluate(() => window.__overlayV2Layout);
  const sorted = layout.slice().sort((a, b) => a.left - b.left);
  const minGap = sorted.slice(1).reduce((gap, item, index) => Math.min(gap, item.left - sorted[index].right), Infinity);
  expect(minGap).toBeGreaterThanOrEqual(44);
  await page.waitForTimeout(900);
  await expectNoHorizontalOverflow(page);
  await capture(page, testInfo, 'overlay-v2-phaser');
  expect(errors).toEqual([]);
});

test.skip('signed Phaser overlay v2 source mode fills the browser source', async ({ page }, testInfo) => {
  const errors = await watchPage(page);
  const params = new URLSearchParams({
    room_id: roomId,
    overlay_token: overlayToken,
    demo: '1',
    render: '1080p',
    source: '1',
  });
  await page.goto(`${baseUrl}/overlay-v2?${params.toString()}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__overlayV2Ready === true, null, { timeout: 6000 });
  const shellBox = await page.locator('#phaser-overlay-shell').boundingBox();
  const viewport = page.viewportSize();
  expect(shellBox).toBeTruthy();
  expect(Math.abs(shellBox.width - viewport.width)).toBeLessThanOrEqual(2);
  expect(Math.abs(shellBox.height - viewport.height)).toBeLessThanOrEqual(2);
  await capture(page, testInfo, 'overlay-v2-source-mode');
  expect(errors).toEqual([]);
});

test.skip('signed Phaser overlay v2 handles production event parity hooks', async ({ page }, testInfo) => {
  const errors = await watchPage(page);
  const params = new URLSearchParams({
    room_id: roomId,
    overlay_token: overlayToken,
    demo: '1',
    render: '1080p',
  });
  await page.goto(`${baseUrl}/overlay-v2?${params.toString()}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__overlayV2Ready === true, null, { timeout: 6000 });
  await page.waitForFunction(() => Array.isArray(window.__overlayV2Layout) && window.__overlayV2Layout.length >= 5, null, { timeout: 6000 });

  const parityResult = await page.evaluate(() => {
    const scene = window.overlayV2Scene;
    window.__sponsorReports = [];
    scene.setSponsorPlaybackReporter((payload, status, message) => {
      window.__sponsorReports.push({ breakId: payload.breakId, status, message });
    });
    scene.handleBossWave({ type: 'started', active: true, hp: 900, maxHp: 900, title: 'Test Boss' });
    scene.handleAttackEvent({ attacker: 'demo-1', attackerScope: 'top', target: 'demo-2', targetScope: 'top', damage: 42, critical: true });
    scene.handleAttackEvent({ attacker: 'demo-3', attackerScope: 'top', target: '@boss', targetScope: 'horde', damage: 86, special: true });
    scene.handleGiftAttackEvent({ attacker: 'demo-4', target: 'demo-5', damage: 120, tier: 'legendary', giftColor: '#f6c95b' });
    scene.handleLikeEvent({ uniqueId: 'demo-1', hearts: 5, color: '#ff78b2' });
    scene.handleHealEvent({ uniqueId: 'demo-2', sourceNick: 'Nova', amount: 48, color: '#99ffda' });
    scene.handleFollowEvent({ uniqueId: 'demo-3', nickname: 'NewFan', color: '#7afcff', hpBoost: 45, strengthBoost: 2, shieldMs: 20000 });
    scene.showSocialBoost({ uniqueId: 'demo-3', nickname: 'NewFan', type: 'share', color: '#7afcff', affectedCount: 5, rallyHeal: 24, combo: 4 });
    scene.showSocialBoost({ uniqueId: 'demo-4', nickname: 'SignalAce', type: 'repost', color: '#f6c95b', affectedCount: 5, rallyHeal: 38, shieldMs: 18000, bossPressure: true, combo: 8 });
    scene.handleEngagementSurge({ uniqueId: 'demo-4', nickname: 'SignalAce', tier: 'viral', tierLabel: 'Viral Rally', combo: 8, score: 16, color: '#f6c95b' });
    scene.handlePlayerCommand({ type: 'emoji', uniqueId: 'demo-4', nickname: 'JettByte', iconEmoji: '*' });
    scene.handleKillEvent({ killer: 'demo-1', victim: 'demo-5', damage: 180 });
    scene.handleStreakEvent({ uniqueId: 'demo-1', nickname: 'NovaStrike', label: 'Rampage', streak: 3, color: '#f6c95b' });
    scene.handleGiftCelebration({ attacker: 'demo-4', nickname: 'JettByte', giftName: 'Galaxy', diamonds: 99, tier: 'legendary' });
    scene.spawnRespawnEffect('demo-5');
    scene.showSoundPulse('attack');
    scene.prepareSponsorBreak({ breakId: 'event-parity-break', durationMs: 1800, title: 'Power Moment' });
    scene.playSponsorBreak({ breakId: 'event-parity-break', durationMs: 1800, title: 'Power Moment', partner: 'Arcade Forge', subtitle: 'Fallback path ready.' });
    return {
      bossActive: Boolean(scene.bossState?.active),
      sponsorActive: document.body.classList.contains('sponsor-active'),
      players: scene.playerGroups.length,
    };
  });
  await page.waitForFunction(() => (window.__sponsorReports || []).some(item => item.status === 'completed'), null, { timeout: 5000 });
  await page.waitForFunction(() => !document.body.classList.contains('sponsor-active'), null, { timeout: 5000 });
  const reports = await page.evaluate(() => window.__sponsorReports || []);

  expect(parityResult.players).toBeGreaterThanOrEqual(5);
  expect(parityResult.bossActive).toBe(true);
  expect(parityResult.sponsorActive).toBe(true);
  expect(reports.map(item => item.status)).toEqual(expect.arrayContaining(['decoded', 'ready', 'live', 'fallback_started', 'completed']));
  await expectNoHorizontalOverflow(page);
  await capture(page, testInfo, 'overlay-v2-event-parity');
  expect(errors).toEqual([]);
});

test('signed overlay sponsor preview renders transitioned ad scene', async ({ page }, testInfo) => {
  const errors = await watchPage(page);
  const params = new URLSearchParams({
    room_id: roomId,
    overlay_token: overlayToken,
    sponsor_preview: '1',
    sponsor_partner: 'Arcade Forge',
    sponsor_title: 'Tonight\'s Arena Spotlight',
    sponsor_subtitle: 'Premium arena screen preview for stream breaks.',
    sponsor_duration: '15000',
  });
  await page.goto(`${baseUrl}/overlay?${params.toString()}`, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#sponsorScene')).toHaveClass(/active/, { timeout: 3000 });
  await expect(page.getByText('Tonight\'s Arena Spotlight')).toBeVisible();
  await expect(page.locator('.panel-wrapper')).toBeHidden();
  await expect(page.locator('#status-badge')).toBeHidden();
  await expectNoHorizontalOverflow(page);
  await capture(page, testInfo, 'overlay-sponsor-preview');
  expect(errors).toEqual([]);
});

test.skip('signed Phaser overlay v2 sponsor preview renders broadcast break', async ({ page }, testInfo) => {
  const errors = await watchPage(page);
  const params = new URLSearchParams({
    room_id: roomId,
    overlay_token: overlayToken,
    sponsor_preview: '1',
    sponsor_partner: 'Arcade Forge',
    sponsor_title: 'Power Moment',
    sponsor_subtitle: 'Battle stats return at the end of the break.',
    sponsor_duration: '9000',
    render: '1080p',
  });
  await page.goto(`${baseUrl}/overlay-v2?${params.toString()}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__overlayV2Ready === true, null, { timeout: 6000 });
  await expect(page.locator('#phaser-overlay-root canvas')).toBeVisible();
  await page.waitForTimeout(1400);
  const hasSponsorLayer = await page.evaluate(() => document.body.classList.contains('sponsor-active'));
  expect(hasSponsorLayer).toBe(true);
  await expectNoHorizontalOverflow(page);
  await capture(page, testInfo, 'overlay-v2-sponsor-preview');
  expect(errors).toEqual([]);
});
