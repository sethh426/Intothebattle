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

async function readLayout(page, label, pageErrors, options = {}) {
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
  let layout = null;
  const requiredDomType = options.requiredDomType || '';
  const layoutDeadline = Date.now() + (requiredDomType ? 6000 : 0);
  do {
    layout = await page.evaluate(() => window.__overlayLegacyLayout);
    if (!requiredDomType || layout?.domObjects?.some(item => item.type === requiredDomType && item.stageBound === true)) break;
    await page.waitForTimeout(50);
  } while (Date.now() < layoutDeadline);
  if (requiredDomType && !layout?.domObjects?.some(item => item.type === requiredDomType && item.stageBound === true)) {
    await waitForStageDomLayer(page, label, requiredDomType, pageErrors);
    layout = await page.evaluate(() => window.__overlayLegacyLayout);
  }
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

function assertBossHudIntegrated(layout, label) {
  const boss = layout?.boss;
  const panel = boss?.panel;
  assert(boss && panel, `${label} missing boss HUD layout`);
  const tolerance = 2;
  assert(Math.abs(boss.left - panel.left) <= tolerance, `${label} boss left edge is split from panel`);
  assert(Math.abs(boss.right - panel.right) <= tolerance, `${label} boss right edge is split from panel`);
  assert(Math.abs(boss.top - panel.top) <= tolerance, `${label} boss top edge is split from panel`);
  assert(Math.abs(boss.bottom - panel.bottom) <= tolerance, `${label} boss bottom edge is split from panel`);
}

async function waitForStageDomLayer(page, label, type, pageErrors) {
  await page.waitForFunction(expectedType => {
    const layout = window.__overlayLegacyLayout;
    return layout?.domObjects?.some(item => item.type === expectedType && item.stageBound === true);
  }, type, { timeout: 6000 }).catch(async err => {
    const state = await page.evaluate(expectedType => {
      const visibleLayer = document.querySelector(`.${expectedType}:not(.closing)`);
      const anyLayer = document.querySelector(`.${expectedType}`);
      return {
        href: location.href,
        visibleLayer: Boolean(visibleLayer),
        layerClass: anyLayer?.className || '',
        layerParentId: anyLayer?.parentElement?.id || '',
        layerPosition: anyLayer ? getComputedStyle(anyLayer).position : '',
        layout: window.__overlayLegacyLayout || null,
      };
    }, type).catch(() => null);
    throw new Error(`${label} did not expose stage-bound ${type}: ${err.message}\npageErrors=${pageErrors.join(' | ')}\nstate=${JSON.stringify(state)}`);
  });
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

async function assertSponsorSceneFits(page, label, options = {}) {
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
    const statsEl = document.getElementById('sponsorLiveStats');
    const statsRect = statsEl?.getBoundingClientRect();
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

    const offCenterText = [];
    for (const selector of ['.sponsor-stats-head', '.sponsor-stat', '.sponsor-stat-label', '.sponsor-stat-value', '.sponsor-stat-sub']) {
      for (const el of document.querySelectorAll(`#sponsorLiveStats ${selector}`)) {
        const rect = el.getBoundingClientRect();
        if (effectiveOpacity(el) <= 0.05 || rect.width === 0 || rect.height === 0) continue;
        const style = getComputedStyle(el);
        if (style.textAlign !== 'center') {
          offCenterText.push({
            selector,
            textAlign: style.textAlign,
            text: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80),
          });
        }
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
      offCenterText,
      visibleCount: boxes.length,
      hasStats: Boolean(statsRect?.height),
      statsCenterDelta: statsRect ? Math.abs((statsRect.left + statsRect.width / 2) - (sceneRect.left + sceneRect.width / 2)) : null,
      sceneWidth: sceneRect.width,
    };
  });

  assert(!result.missing, `${label} missing sponsor scene`);
  assert(result.sceneClass.includes('active'), `${label} sponsor scene is not active: ${result.sceneClass}`);
  assert(result.sceneClass.includes('stats-visible'), `${label} sponsor stats did not become visible: ${result.sceneClass}`);
  assert(result.hasStats, `${label} sponsor stats have no visible box`);
  assert(result.visibleCount >= (options.minVisibleCount ?? 5), `${label} sponsor scene has too few visible elements: ${JSON.stringify(result)}`);
  assert(result.outside.length === 0, `${label} sponsor elements escaped frame: ${JSON.stringify(result.outside)}`);
  assert(result.statsCenterDelta != null && result.statsCenterDelta <= Math.max(2, result.sceneWidth * 0.01), `${label} sponsor stats are not centered: ${JSON.stringify(result)}`);
  assert(result.offCenterText.length === 0, `${label} sponsor stats text is not centered: ${JSON.stringify(result.offCenterText)}`);
}

async function assertSponsorMediaAgent(page, label) {
  const result = await page.evaluate(() => ({
    hasModule: typeof window.IntoTheBattleOverlayVideoAgent?.create === 'function',
    status: window.overlayEventEngine?.status?.().sponsorMedia || null,
  }));
  assert(result.hasModule, `${label} missing sponsor video-agent module`);
  assert(result.status?.agent === 'video-agent', `${label} sponsor media status is unavailable: ${JSON.stringify(result)}`);
  assert(result.status.hasScene, `${label} sponsor media agent is not bound to the scene: ${JSON.stringify(result.status)}`);
  assert(result.status.hasVideoElement, `${label} sponsor media agent is not bound to the video element: ${JSON.stringify(result.status)}`);
  assert(result.status.hasPosterElement, `${label} sponsor media agent is not bound to the poster element: ${JSON.stringify(result.status)}`);
  assert(result.status.stateClass !== 'video-error', `${label} sponsor media agent is in an error state: ${JSON.stringify(result.status)}`);
}

async function assertConnectionStatus(page, label, options = {}) {
  const status = await page.evaluate(() => window.overlayEventEngine?.status?.().connection || null);
  assert(status, `${label} connection status is unavailable`);
  assert(!Object.prototype.hasOwnProperty.call(status, 'overlayToken'), `${label} connection status leaked token material`);
  assert(status.hasOverlayToken === Boolean(status.hasOverlayToken), `${label} connection token flag is not boolean: ${JSON.stringify(status)}`);
  if (options.mode) assert(status.mode === options.mode, `${label} connection mode mismatch: ${JSON.stringify(status)}`);
  if (options.state) assert(status.state === options.state, `${label} connection state mismatch: ${JSON.stringify(status)}`);
  if (options.ready != null) assert(status.ready === options.ready, `${label} connection readiness mismatch: ${JSON.stringify(status)}`);
  if (options.demoMode != null) assert(status.demoMode === options.demoMode, `${label} demo mode mismatch: ${JSON.stringify(status)}`);
  if (options.connected != null) assert(status.connected === options.connected, `${label} connection flag mismatch: ${JSON.stringify(status)}`);
  assert(status.retryTimerActive === false || status.mode !== 'demo', `${label} demo connection should not have register retry timers: ${JSON.stringify(status)}`);
  return status;
}

async function assertSponsorQueueHealth(page, label, options = {}) {
  const status = await page.evaluate(() => window.overlayEventEngine?.status?.().sponsor || null);
  assert(status, `${label} sponsor queue status is unavailable`);
  assert(status.maxQueued === 3, `${label} sponsor queue cap changed unexpectedly: ${JSON.stringify(status)}`);
  assert(status.queued <= (options.maxQueued ?? status.maxQueued), `${label} sponsor queue exceeded cap: ${JSON.stringify(status)}`);
  assert(status.stats?.maxDepth <= status.maxQueued, `${label} sponsor queue max depth exceeded cap: ${JSON.stringify(status)}`);
  if (options.minDropped != null) {
    assert(status.stats?.dropped >= options.minDropped, `${label} sponsor queue did not drop overflow: ${JSON.stringify(status)}`);
  }
  if (options.minCleared != null) {
    assert(status.stats?.cleared >= options.minCleared, `${label} sponsor queue did not clear expected entries: ${JSON.stringify(status)}`);
  }
  if (options.state) {
    assert(status.state === options.state, `${label} sponsor state mismatch: ${JSON.stringify(status)}`);
  }
  return status;
}

async function assertOverlayAudioStatus(page, label) {
  const result = await page.evaluate(() => ({
    hasModule: Boolean(window.IntoTheBattleOverlayAudio?.defaultAudioConfig),
    status: window.overlayEventEngine?.status?.().audio || null,
  }));
  assert(result.hasModule, `${label} missing overlay audio module`);
  assert(result.status?.module === 'overlay-audio', `${label} audio status is unavailable: ${JSON.stringify(result)}`);
  for (const eventName of ['attack', 'gift', 'kill', 'respawn', 'heal', 'follow']) {
    assert(result.status.assignedEvents.includes(eventName), `${label} missing audio assignment for ${eventName}: ${JSON.stringify(result.status)}`);
  }
  assert(result.status.filenames.length >= 5, `${label} has too few configured audio files: ${JSON.stringify(result.status)}`);
  assert(result.status.cachedCount === result.status.filenames.length, `${label} did not preload active audio files: ${JSON.stringify(result.status)}`);
  assert(result.status.errorCount === 0, `${label} audio preload has media errors: ${JSON.stringify(result.status)}`);
  assert(result.status.warningCount === 0, `${label} audio emitted warnings before playback: ${JSON.stringify(result.status)}`);
  assert(result.status.pendingReplayType === '', `${label} audio has a pending replay before playback: ${JSON.stringify(result.status)}`);
}

async function resetFrameHealth(page) {
  await page.evaluate(() => window.overlayEventEngine?.resetFrameHealth?.());
}

async function waitForFrameSamples(page, label, minSamples = 18, timeoutMs = 5000) {
  await page.waitForFunction(samples => {
    const status = window.overlayEventEngine?.status?.().frame;
    return status?.samples >= samples;
  }, minSamples, { timeout: timeoutMs }).catch(async err => {
    const state = await page.evaluate(() => window.overlayEventEngine?.status?.() || null).catch(() => null);
    throw new Error(`${label} did not collect frame samples: ${err.message}\nstate=${JSON.stringify(state)}`);
  });
}

async function assertFrameHealth(page, label, options = {}) {
  const status = await page.evaluate(() => window.overlayEventEngine?.status?.().frame || null);
  assert(status, `${label} frame health status is unavailable`);
  assert(status.samples >= (options.minSamples ?? 18), `${label} has too few frame samples: ${JSON.stringify(status)}`);
  assert(status.avgDeltaMs <= (options.maxAvgDeltaMs ?? 150), `${label} average frame delta is too high: ${JSON.stringify(status)}`);
  assert(status.p95DeltaMs <= (options.maxP95DeltaMs ?? 420), `${label} p95 frame delta is too high: ${JSON.stringify(status)}`);
  assert(status.recentMaxDeltaMs <= (options.maxRecentDeltaMs ?? 720), `${label} recent frame spike is too high: ${JSON.stringify(status)}`);
  assert(status.recentVeryLongFrames <= (options.maxRecentVeryLongFrames ?? 28), `${label} has too many recent very long frames: ${JSON.stringify(status)}`);
  return status;
}

async function waitForBackgroundState(page, label, state, timeoutMs = 6000) {
  await page.waitForFunction(expectedState => {
    const status = window.overlayEventEngine?.status?.().background;
    return status?.state === expectedState;
  }, state, { timeout: timeoutMs }).catch(async err => {
    const current = await page.evaluate(() => window.overlayEventEngine?.status?.().background || null).catch(() => null);
    throw new Error(`${label} background did not reach ${state}: ${err.message}\nstate=${JSON.stringify(current)}`);
  });
}

async function assertBackgroundStatus(page, label, options = {}) {
  const status = await page.evaluate(() => window.overlayEventEngine?.status?.().background || null);
  assert(status, `${label} background status is unavailable`);
  assert(!String(status.source || '').includes('overlay_token='), `${label} background source leaked overlay token: ${JSON.stringify(status)}`);
  if (options.state) assert(status.state === options.state, `${label} background state mismatch: ${JSON.stringify(status)}`);
  if (options.hasImage != null) assert(status.hasImage === options.hasImage, `${label} background image flag mismatch: ${JSON.stringify(status)}`);
  if (options.minLoadCount != null) assert(status.loadCount >= options.minLoadCount, `${label} background load count too low: ${JSON.stringify(status)}`);
  if (options.minErrorCount != null) assert(status.errorCount >= options.minErrorCount, `${label} background error count too low: ${JSON.stringify(status)}`);
  if (options.minClearCount != null) assert(status.clearCount >= options.minClearCount, `${label} background clear count too low: ${JSON.stringify(status)}`);
  if (options.usingPrevious != null) assert(status.usingPrevious === options.usingPrevious, `${label} background previous-image flag mismatch: ${JSON.stringify(status)}`);
  if (options.minNaturalWidth != null) assert(status.naturalWidth >= options.minNaturalWidth, `${label} background natural width too low: ${JSON.stringify(status)}`);
  return status;
}

async function assertBannerBacklog(page, label, options = {}) {
  const status = await page.evaluate(() => window.overlayEventEngine?.status?.().banner || null);
  assert(status, `${label} banner status is unavailable`);
  assert(status.queued <= (options.maxQueued ?? 3), `${label} banner queue exceeded cap: ${JSON.stringify(status)}`);
  assert(status.domCount <= (options.maxDomCount ?? 2), `${label} has too many banner DOM nodes: ${JSON.stringify(status)}`);
  assert(status.detachedDomCount === 0, `${label} has detached banner DOM nodes: ${JSON.stringify(status)}`);
  assert(status.oldestQueuedAgeMs <= (options.maxOldestQueuedAgeMs ?? 14000), `${label} banner queue contains stale items: ${JSON.stringify(status)}`);
  return status;
}

async function assertVisualQueueHealth(page, label, options = {}) {
  const status = await page.evaluate(() => window.overlayEventEngine?.status?.().visualQueue || null);
  assert(status, `${label} visual queue status is unavailable`);
  assert(status.stats?.handlerErrors === 0, `${label} visual queue handler errors: ${JSON.stringify(status)}`);
  assert(status.totalQueued <= (options.maxQueued ?? 18), `${label} visual queue is not draining: ${JSON.stringify(status)}`);
  assert(status.oldestAgeMs <= (options.maxOldestAgeMs ?? 5000), `${label} visual queue contains stale items: ${JSON.stringify(status)}`);
  if (options.minProcessed != null) {
    assert(status.stats?.processed >= options.minProcessed, `${label} visual queue did not process expected events: ${JSON.stringify(status)}`);
  }
  return status;
}

async function waitForVisualQueueHealth(page, label, options = {}) {
  const targets = {
    maxQueued: options.maxQueued ?? 18,
    maxOldestAgeMs: options.maxOldestAgeMs ?? 5000,
    minProcessed: options.minProcessed ?? null,
  };
  await page.waitForFunction(({ maxQueued, maxOldestAgeMs, minProcessed }) => {
    const status = window.overlayEventEngine?.status?.().visualQueue;
    if (!status || status.stats?.handlerErrors !== 0) return false;
    if (status.totalQueued > maxQueued) return false;
    if (status.oldestAgeMs > maxOldestAgeMs) return false;
    if (minProcessed != null && status.stats?.processed < minProcessed) return false;
    return true;
  }, targets, { timeout: options.timeoutMs ?? 9000 }).catch(async err => {
    const state = await page.evaluate(() => window.overlayEventEngine?.status?.() || null).catch(() => null);
    throw new Error(`${label} visual queue did not reach expected health: ${err.message}\nstate=${JSON.stringify(state)}`);
  });
  return assertVisualQueueHealth(page, label, options);
}

async function assertEffectOwnership(page, label, options = {}) {
  const status = await page.evaluate(() => window.overlayEventEngine?.status?.().motion || null);
  assert(status, `${label} motion status is unavailable`);
  assert(status.unownedEffects === 0, `${label} has unowned effects: ${JSON.stringify(status)}`);
  assert(status.ownedEffects >= (options.minOwnedEffects ?? 0), `${label} has too few owned effects: ${JSON.stringify(status)}`);
  if (options.minDroppedEffects != null) {
    assert(status.droppedEffects >= options.minDroppedEffects, `${label} did not record expected dropped effects: ${JSON.stringify(status)}`);
  }
  return status;
}

async function auditEffectOwnershipViewport(browser, viewport) {
  const page = await browser.newPage({ viewport });
  const pageErrors = [];
  page.on('pageerror', err => pageErrors.push(err?.stack || err?.message || String(err)));
  page.on('console', msg => {
    const text = msg.text();
    if (msg.type() === 'error' && !/404 \(Not Found\)/i.test(text)) pageErrors.push(text);
  });
  const search = new URLSearchParams({
    demo: '1',
    debug: '1',
    controls: '0',
    demo_autoplay: '0',
  });
  const label = `${viewport.width}x${viewport.height} effect-ownership`;
  const response = await page.goto(`${baseUrl}/overlay-preview?${search}`, { waitUntil: 'networkidle' });
  assert(response?.ok(), `${label} overlay preview returned ${response?.status()}`);
  await page.waitForFunction(() => typeof window.overlayEventEngine?.testEffectOwnership === 'function', null, { timeout: 5000 });
  const before = await assertEffectOwnership(page, `${label} initial`);
  const probe = await page.evaluate(() => window.overlayEventEngine.testEffectOwnership());
  assert(probe?.results?.playerToPlayer === true, `${label} player-to-player attack did not render: ${JSON.stringify(probe)}`);
  assert(probe?.results?.playerToHorde === true, `${label} player-to-horde attack did not render: ${JSON.stringify(probe)}`);
  assert(probe?.results?.hordeToPlayer === true, `${label} horde-to-player attack did not render: ${JSON.stringify(probe)}`);
  assert(probe?.results?.playerToBoss === true, `${label} player-to-boss attack did not render: ${JSON.stringify(probe)}`);
  assert(probe?.results?.bossToPlayer === true, `${label} boss-to-player attack did not render: ${JSON.stringify(probe)}`);
  assert(probe?.results?.bossToPlayer5 === true, `${label} boss-to-player-five attack did not render: ${JSON.stringify(probe)}`);
  assert(probe?.results?.bossToHorde === true, `${label} boss-to-horde attack did not render: ${JSON.stringify(probe)}`);
  assert(probe?.results?.invalidPlayer === false, `${label} invalid player attack should be dropped: ${JSON.stringify(probe)}`);
  assert(probe?.results?.inactiveBoss === false, `${label} inactive boss attack should be dropped: ${JSON.stringify(probe)}`);
  assert(probe.droppedDuringProbe >= 2, `${label} did not count invalid ownership drops: ${JSON.stringify(probe)}`);
  await page.waitForTimeout(180);
  const after = await assertEffectOwnership(page, `${label} probe`, {
    minOwnedEffects: 7,
    minDroppedEffects: before.droppedEffects + 2,
  });
  assert(after.droppedByReason?.missing_player >= 1, `${label} missing-player drop reason not recorded: ${JSON.stringify(after)}`);
  assert(after.droppedByReason?.boss_inactive >= 1, `${label} inactive-boss drop reason not recorded: ${JSON.stringify(after)}`);
  await readLayout(page, `${label} layout`, pageErrors);
  await assertCanvasHasVisibleContent(page, `${label} canvas`);
  await page.close();
}

async function auditViewport(browser, viewport) {
  const page = await browser.newPage({ viewport });
  const pageErrors = [];
  page.on('pageerror', err => pageErrors.push(err?.stack || err?.message || String(err)));
  page.on('console', msg => {
    const text = msg.text();
    if (msg.type() === 'error' && !/404 \(Not Found\)/i.test(text)) pageErrors.push(text);
  });
  const search = new URLSearchParams({
    demo: '1',
    debug: '1',
    controls: '0',
    demo_autoplay: '0',
    banner_preview: '1',
    banner_title: 'NeonAce eliminated ShadowByte',
    banner_meta: '7 total kills | streak x5 | momentum x4',
    banner_duration: '5200',
  });
  const label = `${viewport.width}x${viewport.height}`;
  const response = await page.goto(`${baseUrl}/overlay-preview?${search}`, { waitUntil: 'networkidle' });
  assert(response?.ok(), `${label} overlay preview returned ${response?.status()}`);
  await page.waitForFunction(() => Boolean(document.querySelector('.banner:not(.closing)')), null, { timeout: 5000 });
  const initialLayout = await readLayout(page, `${label} initial`, pageErrors, { requiredDomType: 'banner' });
  await assertCanvasHasVisibleContent(page, `${label} initial`);
  assertStatusLayerPolicy(initialLayout, `${label} initial`);
  assertStageDomLayer(initialLayout, `${label} initial`, 'banner');
  await assertConnectionStatus(page, `${label} initial`, { mode: 'demo', state: 'demo', ready: true, demoMode: true, connected: false });
  await assertOverlayAudioStatus(page, `${label} initial`);
  await assertVisualQueueHealth(page, `${label} initial`, { maxQueued: 0 });
  await resetFrameHealth(page);
  await waitForFrameSamples(page, `${label} initial frame`, 20);
  await assertFrameHealth(page, `${label} initial frame`, { minSamples: 20 });

  await resetFrameHealth(page);
  await page.evaluate(() => window.overlayEventEngine?.testBurst?.());
  await page.waitForTimeout(900);
  await waitForFrameSamples(page, `${label} burst frame`, 30);
  await assertFrameHealth(page, `${label} burst frame`, { minSamples: 30 });
  await readLayout(page, `${label} burst`, pageErrors);
  await assertCanvasHasVisibleContent(page, `${label} burst`);
  await assertEffectOwnership(page, `${label} burst`);
  await assertVisualQueueHealth(page, `${label} burst`, { maxQueued: 10, minProcessed: 1 });

  await resetFrameHealth(page);
  await page.evaluate(() => window.overlayEventEngine?.testBoss?.());
  await page.waitForTimeout(900);
  await waitForFrameSamples(page, `${label} boss frame`, 40);
  await assertFrameHealth(page, `${label} boss frame`, { minSamples: 40 });
  const bossLayout = await readLayout(page, `${label} boss`, pageErrors);
  assertBossHudIntegrated(bossLayout, `${label} boss`);
  await assertCanvasHasVisibleContent(page, `${label} boss`);
  await assertEffectOwnership(page, `${label} boss`);
  await assertVisualQueueHealth(page, `${label} boss`, { maxQueued: 10, minProcessed: 1 });
  await page.close();
}

async function auditEventStormViewport(browser, viewport) {
  const page = await browser.newPage({ viewport });
  const pageErrors = [];
  page.on('pageerror', err => pageErrors.push(err?.stack || err?.message || String(err)));
  page.on('console', msg => {
    const text = msg.text();
    if (msg.type() === 'error' && !/404 \(Not Found\)/i.test(text)) pageErrors.push(text);
  });
  const search = new URLSearchParams({
    demo: '1',
    debug: '1',
    controls: '0',
    demo_autoplay: '0',
  });
  const label = `${viewport.width}x${viewport.height} event-storm`;
  const response = await page.goto(`${baseUrl}/overlay-preview?${search}`, { waitUntil: 'networkidle' });
  assert(response?.ok(), `${label} overlay preview returned ${response?.status()}`);
  await page.waitForFunction(() => typeof window.overlayEventEngine?.testEventStorm === 'function', null, { timeout: 5000 });
  const initialLayout = await readLayout(page, `${label} initial`, pageErrors);
  await assertCanvasHasVisibleContent(page, `${label} initial`);
  assertStatusLayerPolicy(initialLayout, `${label} initial`);
  await assertBannerBacklog(page, `${label} initial`, { maxQueued: 0, maxDomCount: 1 });
  const before = await assertVisualQueueHealth(page, `${label} initial`, { maxQueued: 0 });

  await resetFrameHealth(page);
  const storm = await page.evaluate(() => window.overlayEventEngine.testEventStorm(132));
  assert(storm?.requested >= 100, `${label} event storm hook did not enqueue enough coverage: ${JSON.stringify(storm)}`);
  assert(storm.status?.totalQueued <= 150, `${label} event storm exceeded bounded queue depth: ${JSON.stringify(storm.status)}`);
  assert(storm.status?.stats?.enqueued > before.stats.enqueued, `${label} event storm did not enqueue events: ${JSON.stringify(storm.status)}`);
  assert(storm.status?.stats?.merged > before.stats.merged, `${label} event storm did not exercise merge paths: ${JSON.stringify(storm.status)}`);
  assert(storm.status?.stats?.trimmed > before.stats.trimmed, `${label} event storm did not exercise trim paths: ${JSON.stringify(storm.status)}`);

  await waitForVisualQueueHealth(page, `${label} drain`, {
    maxQueued: 4,
    maxOldestAgeMs: 17000,
    minProcessed: before.stats.processed + 22,
    timeoutMs: 11000,
  });
  await page.waitForTimeout(1100);
  await waitForFrameSamples(page, `${label} storm frame`, 40);
  await assertFrameHealth(page, `${label} storm frame`, {
    minSamples: 40,
    maxAvgDeltaMs: 180,
    maxP95DeltaMs: 520,
    maxRecentDeltaMs: 900,
    maxRecentVeryLongFrames: 40,
  });
  const layout = await readLayout(page, `${label} drained`, pageErrors);
  await assertCanvasHasVisibleContent(page, `${label} drained`);
  assertStatusLayerPolicy(layout, `${label} drained`);
  await assertBannerBacklog(page, `${label} drained`, { maxQueued: 3, maxDomCount: 2 });
  const transientDom = await page.evaluate(() => ({
    damage: document.querySelectorAll('.damage').length,
    banners: document.querySelectorAll('.banner').length,
  }));
  assert(transientDom.damage <= 4, `${label} left too many damage DOM nodes: ${JSON.stringify(transientDom)}`);
  assert(transientDom.banners <= 2, `${label} left too many banner DOM nodes: ${JSON.stringify(transientDom)}`);
  assert(pageErrors.length === 0, `${label} page errors: ${pageErrors.join(' | ')}`);
  await page.close();
}

async function auditBackgroundViewport(browser, viewport) {
  const page = await browser.newPage({ viewport });
  const pageErrors = [];
  page.on('pageerror', err => pageErrors.push(err?.stack || err?.message || String(err)));
  page.on('console', msg => {
    const text = msg.text();
    if (msg.type() === 'error' && !(/404/i.test(text) && /not found/i.test(text))) pageErrors.push(text);
  });
  const search = new URLSearchParams({
    demo: '1',
    debug: '1',
    controls: '0',
    demo_autoplay: '0',
  });
  const label = `${viewport.width}x${viewport.height} background`;
  const response = await page.goto(`${baseUrl}/overlay-preview?${search}`, { waitUntil: 'networkidle' });
  assert(response?.ok(), `${label} overlay preview returned ${response?.status()}`);
  await page.waitForFunction(() => typeof window.overlayEventEngine?.testBackground === 'function', null, { timeout: 5000 });
  await readLayout(page, `${label} initial`, pageErrors);
  await assertCanvasHasVisibleContent(page, `${label} initial`);
  await assertBackgroundStatus(page, `${label} initial`, { hasImage: false });

  const before = await page.evaluate(() => window.overlayEventEngine.status().background);
  await page.evaluate(() => window.overlayEventEngine.testBackground('valid'));
  await waitForBackgroundState(page, `${label} valid`, 'ready');
  await page.waitForTimeout(250);
  await assertBackgroundStatus(page, `${label} valid`, {
    state: 'ready',
    hasImage: true,
    minLoadCount: before.loadCount + 1,
    minNaturalWidth: 100,
  });
  await assertCanvasHasVisibleContent(page, `${label} valid`);

  const readyStatus = await page.evaluate(() => window.overlayEventEngine.status().background);
  await page.evaluate(() => window.overlayEventEngine.testBackground('missing'));
  await waitForBackgroundState(page, `${label} missing`, 'error');
  await page.waitForTimeout(250);
  await assertBackgroundStatus(page, `${label} missing`, {
    state: 'error',
    hasImage: true,
    minLoadCount: readyStatus.loadCount,
    minErrorCount: readyStatus.errorCount + 1,
    usingPrevious: true,
  });
  await assertCanvasHasVisibleContent(page, `${label} missing fallback`);

  const errorStatus = await page.evaluate(() => window.overlayEventEngine.status().background);
  await page.evaluate(() => window.overlayEventEngine.testBackground('clear'));
  await waitForBackgroundState(page, `${label} clear`, 'cleared');
  await page.waitForTimeout(250);
  await assertBackgroundStatus(page, `${label} clear`, {
    state: 'cleared',
    hasImage: false,
    minClearCount: errorStatus.clearCount + 1,
  });
  await assertCanvasHasVisibleContent(page, `${label} clear fallback`);
  assert(pageErrors.length === 0, `${label} page errors: ${pageErrors.join(' | ')}`);
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
  await assertConnectionStatus(page, label, { mode: 'demo', state: 'demo', ready: true, demoMode: true, connected: false });
  await assertSponsorSceneFits(page, label);
  await assertSponsorMediaAgent(page, label);
  assert(pageErrors.length === 0, `${label} page errors: ${pageErrors.join(' | ')}`);
  await page.close();
}

async function auditSponsorQueueViewport(browser, viewport) {
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
  });
  const label = `${viewport.width}x${viewport.height} sponsor-queue`;
  const response = await page.goto(`${baseUrl}/overlay-preview?${search}`, { waitUntil: 'networkidle' });
  assert(response?.ok(), `${label} overlay preview returned ${response?.status()}`);
  await page.waitForFunction(() => typeof window.overlayEventEngine?.testSponsorQueue === 'function', null, { timeout: 5000 });
  const before = await assertSponsorQueueHealth(page, `${label} initial`, { maxQueued: 0, state: 'battle' });
  await assertConnectionStatus(page, `${label} initial`, { mode: 'demo', state: 'demo', ready: true, demoMode: true, connected: false });

  const stress = await page.evaluate(() => window.overlayEventEngine.testSponsorQueue(9));
  assert(stress?.requested === 9 && stress.skipped === false, `${label} sponsor queue stress did not run: ${JSON.stringify(stress)}`);
  assert(stress.status?.queued <= 3, `${label} sponsor queue stress exceeded cap: ${JSON.stringify(stress.status)}`);
  assert(stress.status?.stats?.dropped >= before.stats.dropped + 5, `${label} sponsor queue stress did not drop overflow: ${JSON.stringify(stress.status)}`);
  await page.waitForFunction(() => document.querySelector('#sponsorScene')?.classList.contains('active'), null, { timeout: 4000 });
  await page.waitForFunction(() => document.querySelector('#sponsorScene')?.classList.contains('stats-visible'), null, { timeout: 6000 });
  await assertSponsorSceneFits(page, label, { minVisibleCount: 3 });
  const activeStatus = await assertSponsorQueueHealth(page, `${label} active`, { maxQueued: 3, minDropped: before.stats.dropped + 5 });
  assert(activeStatus.state === 'intro' || activeStatus.state === 'live', `${label} sponsor stress did not keep a break active: ${JSON.stringify(activeStatus)}`);
  assert(activeStatus.active?.title?.includes('Sponsor Queue Stress'), `${label} active sponsor payload is not from stress probe: ${JSON.stringify(activeStatus.active)}`);

  await page.evaluate(() => window.overlaySponsorScene?.hide?.());
  await page.waitForFunction(() => window.overlayEventEngine?.status?.().sponsor?.state === 'battle', null, { timeout: 5000 });
  const clearedStatus = await assertSponsorQueueHealth(page, `${label} cleared`, {
    maxQueued: 0,
    minDropped: before.stats.dropped + 5,
    minCleared: before.stats.cleared + 3,
    state: 'battle',
  });
  assert(clearedStatus.queued === 0, `${label} sponsor queue did not clear after hide: ${JSON.stringify(clearedStatus)}`);
  assert(pageErrors.length === 0, `${label} page errors: ${pageErrors.join(' | ')}`);
  await page.close();
}

async function auditReducedMotionViewport(browser, viewport) {
  const page = await browser.newPage({ viewport });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const pageErrors = [];
  page.on('pageerror', err => pageErrors.push(err?.stack || err?.message || String(err)));
  page.on('console', msg => {
    if (msg.type() === 'error') pageErrors.push(msg.text());
  });

  const bannerSearch = new URLSearchParams({
    demo: '1',
    debug: '1',
    controls: '0',
    demo_autoplay: '0',
    banner_preview: '1',
    banner_title: 'NeonAce eliminated ShadowByte',
    banner_meta: '7 total kills | streak x5 | momentum x4',
    banner_duration: '5200',
  });
  const label = `${viewport.width}x${viewport.height} reduced-motion`;
  let response = await page.goto(`${baseUrl}/overlay-preview?${bannerSearch}`, { waitUntil: 'networkidle' });
  assert(response?.ok(), `${label} banner preview returned ${response?.status()}`);
  await page.waitForFunction(() => Boolean(document.querySelector('.banner:not(.closing)')), null, { timeout: 5000 });
  await readLayout(page, `${label} banner`, pageErrors, { requiredDomType: 'banner' });
  await assertCanvasHasVisibleContent(page, `${label} banner`);
  const initialMotion = await page.evaluate(() => window.overlayEventEngine?.status?.().motion || null);
  assert(initialMotion?.reducedMotion === true, `${label} did not report reduced motion: ${JSON.stringify(initialMotion)}`);
  const hasMotionProbe = await page.evaluate(() => typeof window.overlayEventEngine?.testMotionImpact === 'function');
  assert(hasMotionProbe, `${label} missing reduced-motion canvas probe`);
  await page.evaluate(() => window.overlayEventEngine.testMotionImpact());
  await page.waitForTimeout(220);
  await assertCanvasHasVisibleContent(page, `${label} canvas impact`);
  const impactMotion = await page.evaluate(() => window.overlayEventEngine?.status?.().motion || null);
  assert(impactMotion?.reducedMotion === true, `${label} lost reduced-motion state: ${JSON.stringify(impactMotion)}`);
  assert(impactMotion?.arenaShakeActive === false, `${label} arena shake ignored reduced motion: ${JSON.stringify(impactMotion)}`);
  assert(impactMotion?.impactBursts <= 1, `${label} impact bursts are unbounded in reduced motion: ${JSON.stringify(impactMotion)}`);
  assert(impactMotion?.particles <= 32, `${label} canvas particles are too dense in reduced motion: ${JSON.stringify(impactMotion)}`);
  await assertEffectOwnership(page, `${label} reduced-motion effects`, { minOwnedEffects: 1 });
  const bannerMotion = await page.evaluate(() => {
    const banner = document.querySelector('.banner:not(.closing)');
    const style = banner ? getComputedStyle(banner) : null;
    const before = banner ? getComputedStyle(banner, '::before') : null;
    const pulse = banner?.querySelector('.banner-pulse');
    return {
      bannerAnimation: style?.animationName || '',
      bannerTransition: style?.transitionDuration || '',
      beforeAnimation: before?.animationName || '',
      pulseDisplay: pulse ? getComputedStyle(pulse).display : '',
    };
  });
  assert(bannerMotion.bannerAnimation === 'none', `${label} banner still animates: ${JSON.stringify(bannerMotion)}`);
  assert(bannerMotion.beforeAnimation === 'none', `${label} banner sweep still animates: ${JSON.stringify(bannerMotion)}`);
  assert(bannerMotion.pulseDisplay === 'none', `${label} banner pulse is still visible: ${JSON.stringify(bannerMotion)}`);

  const sponsorSearch = new URLSearchParams({
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
  response = await page.goto(`${baseUrl}/overlay-preview?${sponsorSearch}`, { waitUntil: 'networkidle' });
  assert(response?.ok(), `${label} sponsor preview returned ${response?.status()}`);
  await page.waitForFunction(() => document.querySelector('#sponsorScene')?.classList.contains('stats-visible'), null, { timeout: 9000 });
  await page.waitForTimeout(400);
  await assertSponsorSceneFits(page, `${label} sponsor`);
  await assertSponsorMediaAgent(page, `${label} sponsor`);
  const sponsorMotion = await page.evaluate(() => {
    const scene = document.getElementById('sponsorScene');
    const stats = document.getElementById('sponsorLiveStats');
    const progress = document.querySelector('.sponsor-progress span');
    const frame = document.querySelector('.sponsor-broadcast-frame');
    return {
      sceneAnimation: scene ? getComputedStyle(scene).animationName : '',
      statsAnimation: stats ? getComputedStyle(stats).animationName : '',
      statsBeforeAnimation: stats ? getComputedStyle(stats, '::before').animationName : '',
      frameAnimation: frame ? getComputedStyle(frame).animationName : '',
      progressAnimation: progress ? getComputedStyle(progress).animationName : '',
    };
  });
  assert(sponsorMotion.sceneAnimation === 'none', `${label} sponsor scene still animates: ${JSON.stringify(sponsorMotion)}`);
  assert(sponsorMotion.statsAnimation === 'none', `${label} sponsor stats still animate: ${JSON.stringify(sponsorMotion)}`);
  assert(sponsorMotion.statsBeforeAnimation === 'none', `${label} sponsor stats border still animates: ${JSON.stringify(sponsorMotion)}`);
  assert(sponsorMotion.frameAnimation === 'none', `${label} sponsor frame still animates: ${JSON.stringify(sponsorMotion)}`);
  assert(sponsorMotion.progressAnimation === 'sponsorProgress', `${label} sponsor progress no longer indicates time: ${JSON.stringify(sponsorMotion)}`);
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
    for (const viewport of [
      { width: 1280, height: 720 },
      { width: 390, height: 844 },
    ]) {
      await auditEventStormViewport(browser, viewport);
    }
    await auditEffectOwnershipViewport(browser, { width: 1280, height: 720 });
    await auditBackgroundViewport(browser, { width: 1280, height: 720 });
    await auditSponsorQueueViewport(browser, { width: 1280, height: 720 });
    await auditReducedMotionViewport(browser, { width: 390, height: 844 });
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
