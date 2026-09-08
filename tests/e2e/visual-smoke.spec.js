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
  const deadline = Date.now() + Number(process.env.E2E_HEALTH_TIMEOUT_MS || 60000);
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
      const failureText = req.failure()?.errorText || '';
      if (/ERR_ABORTED/.test(failureText) && req.frame().parentFrame()) return;
      if (new URL(req.url()).origin === baseUrl) {
        errors.push(`request failed: ${req.method()} ${req.url()} ${failureText}`);
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

async function expectColorfulCanvas(page, canvas) {
  const image = await canvas.screenshot({ timeout: 30000 });
  const metrics = await page.evaluate(async dataUrl => {
    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = reject;
      img.src = dataUrl;
    });

    const probe = document.createElement('canvas');
    probe.width = img.width;
    probe.height = img.height;
    const ctx = probe.getContext('2d');
    if (!ctx) return { sampleCount: 0, avgSaturation: 0, colorfulRatio: 0 };
    ctx.drawImage(img, 0, 0);

    const width = probe.width;
    const height = probe.height;
    const pixels = ctx.getImageData(0, 0, width, height).data;

    let sampleCount = 0;
    let saturationSum = 0;
    let colorfulCount = 0;
    let greenishCount = 0;
    const hueBuckets = Array.from({ length: 12 }, () => 0);
    const x0 = Math.floor(width * 0.2);
    const x1 = Math.floor(width * 0.8);
    const y0 = Math.floor(height * 0.15);
    const y1 = Math.floor(height * 0.85);

    for (let y = y0; y < y1; y += 8) {
      for (let x = x0; x < x1; x += 8) {
        const offset = (y * width + x) * 4;
        const r = pixels[offset];
        const g = pixels[offset + 1];
        const b = pixels[offset + 2];
        const a = pixels[offset + 3];
        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        if (a < 20 || max < 35) continue;

        const saturation = max === 0 ? 0 : (max - min) / max;
        sampleCount += 1;
        saturationSum += saturation;
        if (saturation > 0.18) colorfulCount += 1;
        if (saturation > 0.2) {
          let hue = 0;
          if (max === r) hue = ((g - b) / (max - min) + (g < b ? 6 : 0)) / 6;
          else if (max === g) hue = ((b - r) / (max - min) + 2) / 6;
          else hue = ((r - g) / (max - min) + 4) / 6;
          const degrees = hue * 360;
          hueBuckets[Math.min(11, Math.floor(degrees / 30))] += 1;
          if (degrees >= 70 && degrees <= 165) greenishCount += 1;
        }
      }
    }

    const saturatedSamples = hueBuckets.reduce((sum, count) => sum + count, 0);
    const maxHueBucket = hueBuckets.reduce((maxCount, count) => Math.max(maxCount, count), 0);
    return {
      sampleCount,
      avgSaturation: sampleCount ? saturationSum / sampleCount : 0,
      colorfulRatio: sampleCount ? colorfulCount / sampleCount : 0,
      hueBucketCount: hueBuckets.filter(count => count > saturatedSamples * 0.035).length,
      dominantHueRatio: saturatedSamples ? maxHueBucket / saturatedSamples : 0,
      greenishRatio: saturatedSamples ? greenishCount / saturatedSamples : 0,
    };
  }, `data:image/png;base64,${image.toString('base64')}`);

  expect(metrics.sampleCount).toBeGreaterThan(80);
  expect(metrics.avgSaturation).toBeGreaterThan(0.2);
  expect(metrics.colorfulRatio).toBeGreaterThan(0.35);
  expect(metrics.hueBucketCount).toBeGreaterThanOrEqual(4);
  expect(metrics.dominantHueRatio).toBeLessThan(0.72);
  expect(metrics.greenishRatio).toBeLessThan(0.68);
}

async function selectVisibleTerritory(page) {
  const canvas = page.locator('#aetheris-root canvas');
  const box = await canvas.boundingBox();
  if (!box) throw new Error('Aetheris canvas was not measurable');

  const statusText = page.getByText(/Unclaimed territory|Claimed territory|Claimed by @|Live:/).first();
  for (const yRatio of [0.34, 0.42, 0.5, 0.58, 0.66]) {
    for (const xRatio of [0.28, 0.36, 0.44, 0.52, 0.6, 0.68, 0.76]) {
      const x = box.x + box.width * xRatio;
      const y = box.y + box.height * yRatio;
      await page.mouse.move(x, y);
      await page.waitForTimeout(80);
      if (await statusText.isVisible().catch(() => false)) {
        await page.mouse.click(x, y);
        await expect(page.getByTestId('aetheris-territory-detail')).toBeVisible();
        return;
      }
    }
  }

  throw new Error('No visible Aetheris territory became hoverable');
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
      E2E_PAID_USER_SESSION_TOKEN: e2eSessionToken,
      E2E_PAID_USER_ROOM_ID: roomId,
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
  await expectColorfulCanvas(page, canvas);
  await expectNoHorizontalOverflow(page);
  await capture(page, testInfo, 'aetheris-preview');
  expect(errors).toEqual([]);
});

test('public Aetheris world is discoverable and renders on WebGL', async ({ page }, testInfo) => {
  const errors = await watchPage(page);

  await page.goto(`${baseUrl}/aetheris`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'Aetheris World' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Claim territory' })).toHaveAttribute('href', '/signup');
  const canvas = page.locator('#aetheris-root canvas');
  await expect(canvas).toBeVisible();
  await page.waitForTimeout(3500);
  const hasWebgl = await canvas.evaluate(el => !!(el.getContext('webgl2') || el.getContext('webgl')));
  expect(hasWebgl).toBe(true);
  await expectNoHorizontalOverflow(page);
  await capture(page, testInfo, 'aetheris-public');
  expect(errors).toEqual([]);
});

test('public navigation and site map expose Aetheris', async ({ page }) => {
  await page.goto(`${baseUrl}/`, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.nav-links a[href="/aetheris"]')).toHaveAttribute('href', '/aetheris');
  await expect(page.getByRole('link', { name: 'Open the Aetheris world map' })).toHaveAttribute('href', '/aetheris');

  await page.goto(`${baseUrl}/site-map`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'Aetheris World' })).toBeVisible();
  await expect(page.getByRole('link', { name: /Explore Aetheris/ })).toHaveAttribute('href', '/aetheris');
});

test('aetheris monumental structures stay inside runtime budgets across four rotations', async ({ page }, testInfo) => {
  test.setTimeout(240000);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(`${baseUrl}/aetheris-preview?diagnostics=1&perf=high`, { waitUntil: 'domcontentloaded' });
  const canvas = page.locator('#aetheris-root canvas');
  await expect(canvas).toBeVisible();
  await page.waitForTimeout(1200);

  const captureCanvas = async name => {
    await canvas.screenshot({
      path: testInfo.outputPath(`${name}.png`),
      timeout: 30000,
    });
  };

  await expect.poll(async () => page.evaluate(() => window.__aetherisDiagnostics?.loadedAssets.length || 0)).toBeGreaterThan(25);
  const diagnostics = await page.evaluate(() => window.__aetherisDiagnostics);
  expect(diagnostics).toBeTruthy();
  expect(diagnostics.failedAssets).toEqual({});
  expect(Object.keys(diagnostics.activeLods)).toHaveLength(10);
  expect(diagnostics.structureStages.ruin + diagnostics.structureStages.claimed
    + diagnostics.structureStages.live + diagnostics.structureStages.high
    + diagnostics.structureStages.packed).toBe(100);
  await testInfo.attach('aetheris-diagnostics.json', {
    body: JSON.stringify(diagnostics, null, 2),
    contentType: 'application/json',
  });
  // CI uses a software WebGL renderer, so FPS is reported for review but cannot be
  // compared to hardware targets. Draw calls and visible triangles are deterministic.
  expect(diagnostics.fps).toBeGreaterThan(0);

  const budgets = {
    high: { drawCalls: 220, triangles: 300000 },
    medium: { drawCalls: 150, triangles: 170000 },
    low: { drawCalls: 100, triangles: 90000 },
  };
  expect(
    diagnostics.drawCalls,
    JSON.stringify(diagnostics, null, 2),
  ).toBeLessThanOrEqual(budgets[diagnostics.perfTier].drawCalls);
  expect(diagnostics.triangles).toBeLessThanOrEqual(budgets[diagnostics.perfTier].triangles);

  const box = await canvas.boundingBox();
  if (!box) throw new Error('Aetheris canvas was not measurable');
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await page.mouse.wheel(0, -180);
  await page.waitForTimeout(500);
  await captureCanvas('aetheris-structures-close');
  await page.mouse.wheel(0, 180);
  await page.waitForTimeout(350);

  for (let index = 0; index < 4; index += 1) {
    const centerX = box.x + box.width * 0.5;
    const centerY = box.y + box.height * 0.5;
    await page.mouse.move(centerX, centerY);
    await page.mouse.down();
    await page.mouse.move(centerX + box.width * 0.16, centerY, { steps: 4 });
    await page.mouse.up();
    const territoryPanel = page.getByTestId('aetheris-territory-detail');
    if (await territoryPanel.isVisible().catch(() => false)) {
      await page.keyboard.press('Escape');
      await expect(territoryPanel).toBeHidden();
    }
    await page.waitForTimeout(250);
    await captureCanvas(`aetheris-structures-rotation-${index + 1}`);
  }
});

test('aetheris falls back when a hero GLB is unavailable', async ({ page }, testInfo) => {
  await page.route('**/frozen-crown-lod1.glb', route => route.abort('failed'));
  await page.goto(`${baseUrl}/aetheris-preview?diagnostics=1`, { waitUntil: 'domcontentloaded' });
  const canvas = page.locator('#aetheris-root canvas');
  await expect(canvas).toBeVisible();
  await expect.poll(async () => page.evaluate(() =>
    window.__aetherisDiagnostics?.failedAssets?.['hero:frozen-crown'] || '',
  )).not.toBe('');
  const hasWebgl = await canvas.evaluate(el => !!(el.getContext('webgl2') || el.getContext('webgl')));
  expect(hasWebgl).toBe(true);
  await capture(page, testInfo, 'aetheris-hero-fallback');
});

test('aetheris preview opens territory details without unsafe labels', async ({ page }, testInfo) => {
  const errors = await watchPage(page);

  await page.goto(`${baseUrl}/aetheris-preview`, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#aetheris-root canvas')).toBeVisible();
  await page.waitForTimeout(3500);

  await selectVisibleTerritory(page);
  const panel = page.getByTestId('aetheris-territory-detail');
  const panelText = await panel.innerText();
  expect(panelText).not.toMatch(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  expect(panelText).not.toMatch(/\broom[_-]?[a-z0-9-]{3,}\b/i);
  expect(panelText).not.toMatch(/\bOpen\b/);
  await capture(page, testInfo, 'aetheris-territory-detail');

  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();

  await selectVisibleTerritory(page);
  await page.getByTestId('aetheris-territory-detail-close').click();
  await expect(panel).toBeHidden();
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
  await page.goto(`${baseUrl}/dashboard?welcome=1#setup`, { waitUntil: 'domcontentloaded' });
  const initialConsent = page.locator('#itb-growth-consent');
  if (await initialConsent.count()) await initialConsent.getByRole('button', { name: 'No thanks' }).click();
  await expect(page.getByText('IntoTheBattle Command Center')).toBeVisible();
  await expect(page.getByTestId('welcome-setup-panel')).toBeVisible();
  await expect(page.locator('#subscription-chip')).toBeVisible();
  await expect(page.locator('#nextActionPanel')).toBeVisible();
  await expect(page.getByRole('tab', { name: /Setup/ })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#launchWorkflow')).toBeVisible();
  await expect(page.locator('#liveWorkflow')).toBeHidden();
  await expect(page.locator('#backgroundFitInput')).toBeAttached();
  await expect(page.getByRole('button', { name: 'Open Live Overlay' })).toBeVisible();
  await expect(page.locator('[data-beta-feature="overlay-v2"]')).toBeHidden();
  await expect(page.locator('#creatorSponsorCard')).toBeAttached();
  await expect(page.locator('#sponsorReadiness')).toBeHidden();
  await expect(page.getByText('Share your videos with chat')).toHaveCount(1);
  await expect(page.locator('#sponsorSelectedSettings')).toBeAttached();
  await expect(page.locator('#sponsorFitInput')).toBeAttached();
  await expect(page.locator('#refreshSponsorPreviewButton')).toBeAttached();
  await expect(page.getByRole('button', { name: 'Preview Selected' })).toHaveCount(0);
  await expectNoHorizontalOverflow(page);
  await capture(page, testInfo, 'dashboard-setup');

  await page.getByRole('tab', { name: /Live Control/ }).click();
  await expect(page).toHaveURL(/#live$/);
  await expect(page.getByRole('tab', { name: /Live Control/ })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByText('Live Session Director')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Boss Wave' })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await capture(page, testInfo, 'dashboard-live');

  await page.getByRole('tab', { name: /Customize/ }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: /Advanced/ })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#toolsWorkflow')).toBeVisible();
  await page.getByRole('tab', { name: /Customize/ }).click();
  await expect(page.locator('#overlayWorkflow')).toBeVisible();
  await expect(page.locator('#brandWorkflow')).toBeVisible();
  await expect(page.locator('#audioWorkflow')).toBeVisible();
  await expect(page.locator('#sceneCard')).toBeVisible();
  await expect(page.locator('#heroSelectorGrid .hero-selector-option')).toHaveCount(6);
  await expect(page.locator('#heroSelectorGrid .hero-selector-option[aria-selected="true"]')).toHaveCount(1);
  await expect(page.locator('#dashboardOverlayPreview')).toHaveAttribute('src', /dashboard_preview=1/);
  await expect(page.locator('#dashboardOverlayPreviewStatus')).toContainText('Room preview', { timeout: 15000 });
  const customizePreviewFrame = page.frames().find(frame => frame.url().includes('dashboard_preview=1'));
  expect(customizePreviewFrame).toBeTruthy();
  await customizePreviewFrame.waitForLoadState('networkidle', { timeout: 15000 });
  await expect(page.locator('#overlay-label')).toHaveText('No overlay connected');
  const customizeWidths = await page.evaluate(() => ({
    scene: document.getElementById('sceneCard')?.getBoundingClientRect().width || 0,
    workflow: document.querySelector('#overlayWorkflow .workflow-body')?.getBoundingClientRect().width || 0,
  }));
  expect(customizeWidths.scene).toBeGreaterThan(customizeWidths.workflow * 0.9);
  await expectNoHorizontalOverflow(page);
  await capture(page, testInfo, 'dashboard-customize');
  await page.goto(`${baseUrl}/dashboard`, { waitUntil: 'domcontentloaded' });
  await expect(page).toHaveURL(/#customize$/);
  await expect(page.getByRole('tab', { name: /Customize/ })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#dashboardOverlayPreviewStatus')).toContainText('Room preview', { timeout: 15000 });
  const rememberedPreviewFrame = page.frames().find(frame => frame.url().includes('dashboard_preview=1'));
  expect(rememberedPreviewFrame).toBeTruthy();
  await rememberedPreviewFrame.waitForLoadState('networkidle', { timeout: 15000 });
  const consent = page.locator('#itb-growth-consent');
  if (await consent.count()) {
    await expect(page.locator('.command-dock')).toBeHidden();
    await consent.getByRole('button', { name: 'No thanks' }).click();
    await expect(page.locator('.command-dock')).toBeVisible();
    if (testInfo.project.name.includes('mobile')) {
      await expect(page.locator('.command-dock .footer-btn:visible')).toHaveCount(2);
    }
  }
  expect(errors).toEqual([]);
});

test('dashboard links to the world globe for logged-in creators', async ({ context, page }) => {
  await context.addCookies([{ name: 'session_token', value: e2eSessionToken, url: baseUrl }]);
  await page.goto(`${baseUrl}/dashboard`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('link', { name: 'Aetheris', exact: true })).toHaveAttribute('href', '/world');
  await expect(page.getByTestId('dashboard-aetheris-link')).toHaveAttribute('href', '/world');
  await expect(page.getByTestId('territory-aetheris-link')).toHaveAttribute('href', '/world');
});

test('world globe renders on WebGL for logged-in creators', async ({ context, page }, testInfo) => {
  await context.addCookies([{ name: 'session_token', value: e2eSessionToken, url: baseUrl }]);
  const errors = await watchPage(page);

  await page.goto(`${baseUrl}/world`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('link', { name: /Dashboard/ })).toBeVisible();
  const canvas = page.locator('#aetheris-root canvas');
  await expect(canvas).toBeVisible();

  // Give the intro dolly time to fully play out before asserting steady state.
  await page.waitForTimeout(3500);

  const hasWebgl = await canvas.evaluate(el => !!(el.getContext('webgl2') || el.getContext('webgl')));
  expect(hasWebgl).toBe(true);
  await expectNoHorizontalOverflow(page);
  await capture(page, testInfo, 'world-globe-logged-in');
  expect(errors).toEqual([]);
});

test('world War Room supports creator opt-in and home selection', async ({ context, page }, testInfo) => {
  await context.addCookies([{ name: 'session_token', value: e2eSessionToken, url: baseUrl }]);
  const errors = await watchPage(page);
  await page.goto(`${baseUrl}/world`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('aetheris-war-room')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Join land wars' })).toBeVisible();
  await page.getByRole('button', { name: 'Join land wars' }).click();
  await expect(page.getByText('Enlisted')).toBeVisible();
  await selectVisibleTerritory(page);
  await expect(page.getByRole('button', { name: 'Establish protected home' })).toBeVisible();
  await page.getByRole('button', { name: 'Establish protected home' }).click();
  await expect.poll(async () => page.evaluate(async () => {
    const response = await fetch('/api/aetheris/war/status');
    const payload = await response.json();
    return payload.holdings?.length || 0;
  })).toBe(1);
  await capture(page, testInfo, 'world-war-room-home-selected');
  expect(errors).toEqual([]);
});

// A logged-out visitor hitting /world directly should be redirected to login, same as
// /dashboard and /stats -- it's gated by the same requireDashboardAccess middleware.
test('world globe requires authentication', async ({ page }) => {
  const response = await request('/world');
  expect(response.status).toBeGreaterThanOrEqual(300);
  expect(response.status).toBeLessThan(400);
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
