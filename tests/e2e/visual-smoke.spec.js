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
    if (msg.type() === 'error') errors.push(`console error: ${msg.text()}`);
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
  await page.screenshot({ path: testInfo.outputPath(`${name}.png`), fullPage: true });
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
  ['paywall', '/paywall', 'body'],
]) {
  test(`${name} renders without local browser errors`, async ({ page }, testInfo) => {
    await expectHealthyPage(page, testInfo, pathname, selector, name);
  });
}

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
  await expect(page.getByRole('button', { name: 'Open Overlay' }).first()).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await capture(page, testInfo, 'dashboard');
  expect(errors).toEqual([]);
});

test('signed overlay renders a nonblank canvas', async ({ page }, testInfo) => {
  const errors = await watchPage(page);
  await page.goto(`${baseUrl}/overlay?room_id=${roomId}&overlay_token=${encodeURIComponent(overlayToken)}`, { waitUntil: 'domcontentloaded' });
  const canvas = page.locator('canvas');
  await expect(canvas).toBeVisible();
  await page.waitForTimeout(1000);

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
