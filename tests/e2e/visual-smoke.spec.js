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

test('home hero world globe renders on WebGL', async ({ page }, testInfo) => {
  const errors = await watchPage(page);

  await page.goto(`${baseUrl}/`, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.globe-shell')).toBeVisible();
  const root = page.locator('.globe-shell #aetheris-root');
  await expect(root).toBeVisible();
  const canvas = root.locator('canvas');
  await expect(canvas).toBeVisible();

  // Give the intro dolly (camera.introDurationSeconds, ~2.8s) time to fully play out
  // before asserting steady state — matches the aetheris-preview test's wait, since
  // home.html now mounts the same React/r3f build.
  await page.waitForTimeout(3500);

  const state = await canvas.evaluate(el => {
    const rect = el.getBoundingClientRect();
    const hasWebgl = !!(el.getContext('webgl2') || el.getContext('webgl'));
    return {
      hasWebgl,
      width: el.width,
      height: el.height,
      rect: { top: rect.top, width: rect.width, height: rect.height },
      viewportHeight: window.innerHeight,
    };
  });

  expect(state.hasWebgl).toBe(true);
  expect(state.width).toBeGreaterThan(0);
  expect(state.height).toBeGreaterThan(0);
  expect(state.rect.width).toBeGreaterThan(300);
  expect(state.rect.top).toBeLessThan(state.viewportHeight * 0.75);
  await expectNoHorizontalOverflow(page);
  await capture(page, testInfo, 'home-globe');
  expect(errors).toEqual([]);
});

test('aetheris preview (React/r3f v0.2 build) renders on WebGL', async ({ page }, testInfo) => {
  const errors = await watchPage(page);

  await page.goto(`${baseUrl}/aetheris-preview`, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#aetheris-root')).toBeVisible();
  const canvas = page.locator('canvas');
  await expect(canvas).toBeVisible();

  // Give the v0.3 intro dolly (camera.introDurationSeconds, ~2.8s) time to fully play
  // out before asserting steady state, so the new async cinematic doesn't introduce
  // flakiness into this check.
  await page.waitForTimeout(3500);

  const state = await canvas.evaluate(el => {
    const rect = el.getBoundingClientRect();
    const hasWebgl = !!(el.getContext('webgl2') || el.getContext('webgl'));
    return {
      hasWebgl,
      width: el.width,
      height: el.height,
      rect: { width: rect.width, height: rect.height },
    };
  });

  expect(state.hasWebgl).toBe(true);
  expect(state.width).toBeGreaterThan(0);
  expect(state.height).toBeGreaterThan(0);
  expect(state.rect.width).toBeGreaterThan(300);
  await expectNoHorizontalOverflow(page);
  await capture(page, testInfo, 'aetheris-preview');
  expect(errors).toEqual([]);
});

test('aetheris preview skips the intro dolly under prefers-reduced-motion', async ({ browser }, testInfo) => {
  const context = await browser.newContext({ reducedMotion: 'reduce' });
  const page = await context.newPage();
  const errors = await watchPage(page);

  await page.goto(`${baseUrl}/aetheris-preview`, { waitUntil: 'domcontentloaded' });
  const canvas = page.locator('canvas');
  await expect(canvas).toBeVisible();
  // No intro dolly to wait out under reduced motion — the camera starts at rest
  // distance immediately, so a short settle is enough.
  await page.waitForTimeout(500);

  const hasWebgl = await canvas.evaluate(el => !!(el.getContext('webgl2') || el.getContext('webgl')));
  expect(hasWebgl).toBe(true);
  await capture(page, testInfo, 'aetheris-preview-reduced-motion');
  expect(errors).toEqual([]);
  await context.close();
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
  await page.goto(`${baseUrl}/dashboard?welcome=1`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByText('IntoTheBattle Command Center')).toBeVisible();
  await expect(page.getByTestId('welcome-setup-panel')).toBeVisible();
  await expect(page.locator('#subscription-chip')).toBeVisible();
  await expect(page.locator('#nextActionPanel')).toBeVisible();
  await expect(page.locator('#backgroundFitInput')).toBeAttached();
  await expect(page.getByRole('button', { name: 'Open Live Overlay' })).toBeVisible();
  await expect(page.locator('[data-beta-feature="overlay-v2"]')).toBeHidden();
  await page.locator('#liveWorkflow').evaluate(el => { el.open = true; });
  await expect(page.getByText('Live Session Director')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Boss Wave' })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await capture(page, testInfo, 'dashboard');
  expect(errors).toEqual([]);
});

test('conversion pages clarify proof before payment and Creator Pro scope', async ({ page }, testInfo) => {
  const errors = await watchPage(page);

  await page.goto(`${baseUrl}/signup`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByText('Start the demo, copy the TikTok Studio source, and test the battle.')).toBeVisible();
  await expect(page.getByText('Free means you can create and test the battle overlay.')).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await capture(page, testInfo, 'conversion-signup-copy');

  await page.goto(`${baseUrl}/paywall`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: /Upgrade only when you need custom brand control/i })).toBeVisible();
  await expect(page.getByText('The battle overlay can be tested before you pay.')).toBeVisible();
  await expect(page.getByText('Questions about billing, setup, or cancellation?')).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await capture(page, testInfo, 'conversion-paywall-copy');

  expect(errors).toEqual([]);
});

test('signed live overlay waits for real players instead of demo fallback', async ({ page }, testInfo) => {
  const errors = await watchPage(page);
  await page.goto(`${baseUrl}/overlay?room_id=${roomId}&overlay_token=${encodeURIComponent(overlayToken)}&mode=live`, { waitUntil: 'domcontentloaded' });
  const canvas = page.locator('canvas');
  await expect(canvas).toBeVisible();
  await page.waitForFunction(() => {
    const layout = window.__overlayLegacyLayout;
    return Array.isArray(layout?.players) && layout.players.length === 0 && layout.frame;
  }, null, { timeout: 7000 });
  await expect(page.locator('#status-badge')).toContainText(/WAITING FOR PLAYERS|WAITING FOR DATA|CONNECTED/);

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
  expect(legacyLayout.players).toEqual([]);
  expect(legacyLayout.horde).toBeNull();
  await expectNoHorizontalOverflow(page);
  await capture(page, testInfo, 'overlay');
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
