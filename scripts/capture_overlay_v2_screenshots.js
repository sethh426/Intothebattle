import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import jwt from 'jsonwebtoken';

const port = Number(process.env.OVERLAY_CAPTURE_PORT || 3539);
const host = '127.0.0.1';
const baseUrl = `http://${host}:${port}`;
const roomId = process.env.OVERLAY_CAPTURE_ROOM_ID || 'capture-room';
const jwtSecret = process.env.OVERLAY_CAPTURE_SECRET || 'overlay-capture-secret';
const diskPath = fs.mkdtempSync(path.join(os.tmpdir(), 'intothebattle-overlay-capture-'));
const overlayToken = jwt.sign({ purpose: 'overlay', roomId }, jwtSecret, { expiresIn: '1h' });
const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const outputDir = path.join(process.cwd(), 'test-results', 'overlay-v2-captures', timestamp);

let output = '';
let server;

function stopServer() {
  if (server && !server.killed) server.kill();
  try { fs.rmSync(diskPath, { recursive: true, force: true }); } catch (_) {}
}

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
    await new Promise(resolve => setTimeout(resolve, 450));
  }
  throw new Error(`server did not become healthy\n${output}`);
}

async function captureVariant(browser, variant) {
  const context = await browser.newContext({
    viewport: variant.viewport,
    deviceScaleFactor: variant.deviceScaleFactor || 1,
    isMobile: Boolean(variant.isMobile),
  });
  const page = await context.newPage();
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

  const params = new URLSearchParams({
    room_id: roomId,
    overlay_token: overlayToken,
    demo: '1',
    render: variant.render || '1080p',
  });
  if (variant.layout) params.set('layout', variant.layout);
  if (variant.source) params.set('source', '1');

  await page.goto(`${baseUrl}/overlay-v2?${params.toString()}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__overlayV2Ready === true, null, { timeout: 8000 });
  await page.waitForFunction(() => Array.isArray(window.__overlayV2Layout) && window.__overlayV2Layout.length >= 5, null, { timeout: 8000 });
  await page.waitForTimeout(Number(process.env.OVERLAY_CAPTURE_DELAY_MS || variant.delayMs || 1500));

  const screenshotPath = path.join(outputDir, `overlay-v2-${variant.name}-${timestamp}.png`);
  await page.screenshot({ path: screenshotPath, fullPage: true });
  const layout = await page.evaluate(() => window.__overlayV2Layout || []);
  const canvas = await page.locator('#phaser-overlay-root canvas').evaluate(el => ({
    width: el.width,
    height: el.height,
    stage: el.getAttribute('data-stage'),
  }));
  await context.close();

  return { name: variant.name, screenshotPath, errors, layout, canvas };
}

try {
  fs.mkdirSync(outputDir, { recursive: true });
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
      E2E_SESSION_TOKEN: 'overlay-capture-session',
      E2E_ROOM_ID: roomId,
      LOG_LEVEL: 'error',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', chunk => { output += chunk.toString(); });
  server.stderr.on('data', chunk => { output += chunk.toString(); });
  await waitForHealth();

  const browser = await chromium.launch();
  const variants = [
    { name: 'desktop', viewport: { width: 1440, height: 1000 }, render: '1080p', delayMs: 1300 },
    { name: 'source-1080p', viewport: { width: 1920, height: 1080 }, render: '1080p', delayMs: 1300, source: true },
    { name: 'mobile', viewport: { width: 390, height: 844 }, render: '1080p', delayMs: 1300, isMobile: true, deviceScaleFactor: 2 },
  ];
  const captures = [];
  for (const variant of variants) {
    captures.push(await captureVariant(browser, variant));
  }
  await browser.close();

  const manifestPath = path.join(outputDir, `manifest-${timestamp}.json`);
  fs.writeFileSync(manifestPath, JSON.stringify({ timestamp, baseUrl, captures }, null, 2));
  console.log(`Overlay v2 screenshots saved to ${outputDir}`);
  for (const capture of captures) {
    console.log(`${capture.name}: ${capture.screenshotPath}`);
    if (capture.errors.length) {
      console.warn(`${capture.name} browser issues:\n${capture.errors.join('\n')}`);
    }
  }
  console.log(`manifest: ${manifestPath}`);
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
