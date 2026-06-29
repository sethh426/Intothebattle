import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { chromium } from '@playwright/test';

const port = Number(process.env.OVERLAY_AUDIT_PORT || 3529);
const host = '127.0.0.1';
const baseUrl = `http://${host}:${port}`;
const diskPath = fs.mkdtempSync(path.join(os.tmpdir(), 'intothebattle-overlay-audit-'));

const server = spawn(process.execPath, ['server.js'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    PORT: String(port),
    HOST: host,
    NODE_ENV: 'production',
    API_KEY: 'test',
    JWT_SECRET: 'overlay-audit-secret',
    OVERLAY_TOKEN_SECRET: 'overlay-audit-secret',
    SKIP_DB: 'true',
    DEV_TEST_MODE: 'false',
    DISK_PATH: diskPath,
    APP_BASE_URL: 'https://intothebattle.test',
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

async function waitForHealth() {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`server exited early with code ${server.exitCode}\n${output}`);
    try {
      const res = await fetch(`${baseUrl}/healthz`);
      if (res.ok) return;
    } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 400));
  }
  throw new Error(`server did not become healthy\n${output}`);
}

async function readLayout(page, label, pageErrors) {
  await page.waitForFunction(() => window.__overlayLegacyLayout?.players?.length > 0, null, { timeout: 12000 }).catch(async err => {
    const state = await page.evaluate(() => ({
      href: location.href,
      title: document.title,
      bodyText: document.body?.innerText?.slice(0, 500) || '',
      hasCanvas: Boolean(document.getElementById('canvas')),
      hasEngine: Boolean(window.overlayEventEngine),
      layout: window.__overlayLegacyLayout || null,
    })).catch(() => null);
    throw new Error(`${label} did not expose overlay layout: ${err.message}\npageErrors=${pageErrors.join(' | ')}\nstate=${JSON.stringify(state)}`);
  });
  await page.waitForTimeout(350);
  const layout = await page.evaluate(() => window.__overlayLegacyLayout);
  const leaks = layout?.leaks || [];
  const collisions = layout?.collisions || [];
  assert(leaks.length === 0, `${label} leaked outside frame: ${leaks.join(', ')}`);
  assert(collisions.length === 0, `${label} has touching/overlap collisions: ${collisions.join(', ')}`);
  return layout;
}

async function auditViewport(browser, viewport) {
  const page = await browser.newPage({ viewport });
  const pageErrors = [];
  page.on('pageerror', err => pageErrors.push(err?.stack || err?.message || String(err)));
  page.on('console', msg => {
    if (msg.type() === 'error') pageErrors.push(msg.text());
  });
  const search = new URLSearchParams({
    demo: '1',
    debug: '1',
    controls: '0',
    banner_preview: '1',
    banner_title: 'NeonAce eliminated ShadowByte',
    banner_meta: '7 total kills | streak x5 | momentum x4',
  });
  const label = `${viewport.width}x${viewport.height}`;
  const response = await page.goto(`${baseUrl}/overlay-preview?${search}`, { waitUntil: 'networkidle' });
  assert(response?.ok(), `${label} overlay preview returned ${response?.status()}`);
  await readLayout(page, `${label} initial`, pageErrors);

  await page.evaluate(() => window.overlayEventEngine?.testBurst?.());
  await page.waitForTimeout(900);
  await readLayout(page, `${label} burst`, pageErrors);

  await page.evaluate(() => window.overlayEventEngine?.testBoss?.());
  await page.waitForTimeout(900);
  await readLayout(page, `${label} boss`, pageErrors);
  await page.close();
}

try {
  await waitForHealth();
  const browser = await chromium.launch();
  try {
    for (const viewport of [
      { width: 1920, height: 1080 },
      { width: 1280, height: 720 },
      { width: 960, height: 540 },
    ]) {
      await auditViewport(browser, viewport);
    }
  } finally {
    await browser.close();
  }
  console.log('Overlay visual audit passed');
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
