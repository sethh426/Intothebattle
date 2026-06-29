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
  const domLayerLeaks = layout?.domLayerLeaks || [];
  assert(leaks.length === 0, `${label} leaked outside frame: ${leaks.join(', ')}`);
  assert(collisions.length === 0, `${label} has touching/overlap collisions: ${collisions.join(', ')}`);
  assert(domLayerLeaks.length === 0, `${label} has detached DOM overlay layers: ${domLayerLeaks.join(', ')}`);
  return layout;
}

function assertStageDomLayer(layout, label, type) {
  const domObjects = layout?.domObjects || [];
  assert(
    domObjects.some(item => item.type === type && item.stageBound === true),
    `${label} missing stage-bound ${type} layer`
  );
}

function assertStatusLayerPolicy(layout, label) {
  const status = (layout?.domObjects || []).find(item => item.type === 'status');
  const tinyFrame = layout?.frame?.h < 260 || layout?.frame?.w < 430;
  if (tinyFrame) {
    if (status) assert(status.stageBound === true, `${label} tiny status layer is detached`);
    return;
  }
  assert(status?.stageBound === true, `${label} missing stage-bound status layer`);
}

async function assertCanvasHasVisibleContent(page, label) {
  const metrics = await page.evaluate(() => {
    const canvas = document.getElementById('canvas');
    if (!canvas) return null;
    const context = canvas.getContext('2d');
    if (!context || canvas.width <= 0 || canvas.height <= 0) return null;
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const targetSamples = 12000;
    const pixelCount = canvas.width * canvas.height;
    const pixelStep = Math.max(1, Math.floor(pixelCount / targetSamples));
    let samples = 0;
    let opaque = 0;
    let lit = 0;
    let bright = 0;
    const buckets = new Set();

    for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex += pixelStep) {
      const offset = pixelIndex * 4;
      const r = pixels[offset];
      const g = pixels[offset + 1];
      const b = pixels[offset + 2];
      const a = pixels[offset + 3];
      samples += 1;
      if (a > 16) opaque += 1;
      if (r + g + b > 45) lit += 1;
      if (Math.max(r, g, b) > 80) bright += 1;
      buckets.add(`${r >> 4},${g >> 4},${b >> 4},${a >> 5}`);
    }

    return {
      width: canvas.width,
      height: canvas.height,
      samples,
      opaqueRatio: opaque / Math.max(1, samples),
      litRatio: lit / Math.max(1, samples),
      brightRatio: bright / Math.max(1, samples),
      colorBuckets: buckets.size,
    };
  });

  assert(metrics, `${label} canvas is unavailable`);
  assert(metrics.opaqueRatio > 0.85, `${label} canvas looks transparent: ${JSON.stringify(metrics)}`);
  assert(metrics.litRatio > 0.08, `${label} canvas looks too dark or blank: ${JSON.stringify(metrics)}`);
  assert(metrics.brightRatio > 0.005, `${label} canvas is missing visible highlights: ${JSON.stringify(metrics)}`);
  assert(metrics.colorBuckets >= 8, `${label} canvas has too little color variation: ${JSON.stringify(metrics)}`);
}

async function assertSponsorSceneFits(page, label) {
  const result = await page.evaluate(() => {
    function effectiveOpacity(el) {
      let node = el;
      let opacity = 1;
      while (node && node.nodeType === 1) {
        const style = getComputedStyle(node);
        if (style.display === 'none' || style.visibility === 'hidden') return 0;
        opacity *= Number(style.opacity) || 0;
        node = node.parentElement;
      }
      return opacity;
    }

    const scene = document.getElementById('sponsorScene');
    if (!scene) return { missing: true };
    const sceneRect = scene.getBoundingClientRect();
    const selectors = [
      '#sponsorDisclosure',
      '#sponsorBrand',
      '#sponsorProgress',
      '#sponsorLiveStats',
      '.sponsor-stats-head',
      '.sponsor-stat',
      '.sponsor-stat-value',
      '.sponsor-stat-sub',
      '.sponsor-leader-row',
    ];
    const boxes = [];

    for (const selector of selectors) {
      for (const el of document.querySelectorAll(selector)) {
        const rect = el.getBoundingClientRect();
        if (effectiveOpacity(el) <= 0.05 || rect.width === 0 || rect.height === 0) continue;
        boxes.push({
          selector,
          text: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80),
          left: rect.left,
          top: rect.top,
          right: rect.right,
          bottom: rect.bottom,
          width: rect.width,
          height: rect.height,
        });
      }
    }

    const outside = boxes.filter(item => (
      item.left < sceneRect.left - 1 ||
      item.right > sceneRect.right + 1 ||
      item.top < sceneRect.top - 1 ||
      item.bottom > sceneRect.bottom + 1
    ));
    return {
      missing: false,
      sceneClass: scene.className,
      stageClass: document.getElementById('overlay-container')?.className || '',
      outside,
      visibleCount: boxes.length,
      hasStats: Boolean(document.querySelector('#sponsorLiveStats')?.getBoundingClientRect().height),
    };
  });

  assert(!result.missing, `${label} missing sponsor scene`);
  assert(result.sceneClass.includes('active'), `${label} sponsor scene is not active: ${result.sceneClass}`);
  assert(result.sceneClass.includes('stats-visible'), `${label} sponsor stats did not become visible: ${result.sceneClass}`);
  assert(result.hasStats, `${label} sponsor stats have no visible box`);
  assert(result.visibleCount > 4, `${label} sponsor scene has too few visible elements: ${JSON.stringify(result)}`);
  assert(result.outside.length === 0, `${label} sponsor elements escaped frame: ${JSON.stringify(result.outside)}`);
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
    demo_autoplay: '0',
    banner_preview: '1',
    banner_title: 'NeonAce eliminated ShadowByte',
    banner_meta: '7 total kills | streak x5 | momentum x4',
  });
  const label = `${viewport.width}x${viewport.height}`;
  const response = await page.goto(`${baseUrl}/overlay-preview?${search}`, { waitUntil: 'networkidle' });
  assert(response?.ok(), `${label} overlay preview returned ${response?.status()}`);
  await page.waitForFunction(() => Boolean(document.querySelector('.banner:not(.closing)')), null, { timeout: 5000 });
  const initialLayout = await readLayout(page, `${label} initial`, pageErrors);
  await assertCanvasHasVisibleContent(page, `${label} initial`);
  assertStatusLayerPolicy(initialLayout, `${label} initial`);
  assertStageDomLayer(initialLayout, `${label} initial`, 'banner');

  await page.evaluate(() => window.overlayEventEngine?.testBurst?.());
  await page.waitForTimeout(900);
  await readLayout(page, `${label} burst`, pageErrors);
  await assertCanvasHasVisibleContent(page, `${label} burst`);

  await page.evaluate(() => window.overlayEventEngine?.testBoss?.());
  await page.waitForTimeout(900);
  await readLayout(page, `${label} boss`, pageErrors);
  await assertCanvasHasVisibleContent(page, `${label} boss`);
  await page.close();
}

async function auditSponsorViewport(browser, viewport) {
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
    demo_autoplay: '0',
    sponsor_preview: '1',
    sponsor_partner: 'Arcade Forge Superlong Partner Name',
    sponsor_title: 'Tonight\'s Arena Spotlight Goes Ultra Wide',
    sponsor_subtitle: 'Premium arena screen preview for stream breaks with battle stats and sponsor copy.',
    sponsor_duration: '5000',
    sponsor_stats: 'always',
    sponsor_timing: 'spotlight',
    sponsor_fit: 'contain',
  });
  const label = `${viewport.width}x${viewport.height} sponsor`;
  const response = await page.goto(`${baseUrl}/overlay-preview?${search}`, { waitUntil: 'networkidle' });
  assert(response?.ok(), `${label} overlay preview returned ${response?.status()}`);
  await page.waitForFunction(() => document.querySelector('#sponsorScene')?.classList.contains('active'), null, { timeout: 6000 });
  await page.waitForFunction(() => document.querySelector('#sponsorScene')?.classList.contains('stats-visible'), null, { timeout: 9000 });
  await page.waitForTimeout(800);
  await assertSponsorSceneFits(page, label);
  assert(pageErrors.length === 0, `${label} page errors: ${pageErrors.join(' | ')}`);
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
      { width: 540, height: 960 },
      { width: 390, height: 844 },
    ]) {
      await auditViewport(browser, viewport);
      await auditSponsorViewport(browser, viewport);
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
