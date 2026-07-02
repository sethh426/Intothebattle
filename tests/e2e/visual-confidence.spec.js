import { test, expect } from '@playwright/test';
import {
  attachJson,
  createServerHarness,
  expectCanvasQuality,
  expectNoHorizontalOverflow,
  expectNoPageErrors,
  expectStableScreenshot,
  freezeOverlayVisuals,
  readLegacyLayout,
  watchPage,
} from './support/playwright-harness.js';

const harness = createServerHarness({
  port: Number(process.env.VISUAL_GATE_E2E_PORT || 3567),
  roomId: 'visual-gate-room',
  diskPrefix: 'intothebattle-visual-gate-',
});

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  await harness.start();
});

test.afterAll(async () => {
  await harness.stop();
});

function sourceProjectOnly(testInfo) {
  test.skip(testInfo.project.name !== 'chromium-source-1080p', 'overlay source baselines run in Chromium 1080p source mode');
}

function mobileProjectOnly(testInfo) {
  test.skip(testInfo.project.name !== 'chromium-mobile', 'reduced-motion mobile baseline runs in Chromium mobile');
}

function previewUrl(extra = {}) {
  const params = new URLSearchParams({
    demo: '1',
    debug: '1',
    controls: '0',
    demo_autoplay: '0',
    ...extra,
  });
  return `${harness.baseUrl}/overlay-preview?${params.toString()}`;
}

async function openPreview(page, extra = {}) {
  const response = await page.goto(previewUrl(extra), { waitUntil: 'domcontentloaded' });
  expect(response?.ok()).toBe(true);
  await expect(page.getByTestId('overlay-canvas')).toBeVisible();
  await page.waitForFunction(() => Boolean(window.overlayEventEngine && window.__overlayLegacyLayout?.frame), null, { timeout: 8000 });
}

async function waitForDemoLayout(page, options = {}) {
  const minPlayers = options.minPlayers ?? 5;
  await page.waitForFunction(({ minPlayers: expectedPlayers, hordeRequired, bossRequired }) => {
    const layout = window.__overlayLegacyLayout;
    return layout?.frame &&
      Array.isArray(layout.players) &&
      layout.players.length >= expectedPlayers &&
      (!hordeRequired || Boolean(layout.horde)) &&
      (!bossRequired || Boolean(layout.boss));
  }, {
    minPlayers,
    hordeRequired: Boolean(options.horde),
    bossRequired: Boolean(options.boss),
  }, { timeout: options.timeout || 9000 });
  await page.waitForTimeout(options.settleMs || 350);
}

function assertBossHudIntegrated(layout, label) {
  const boss = layout?.boss;
  const panel = boss?.panel;
  expect(boss, `${label} missing boss layout`).toBeTruthy();
  expect(panel, `${label} missing boss HUD panel layout`).toBeTruthy();
  const tolerance = 2;
  expect(Math.abs(boss.left - panel.left), `${label} boss left edge is split from panel`).toBeLessThanOrEqual(tolerance);
  expect(Math.abs(boss.right - panel.right), `${label} boss right edge is split from panel`).toBeLessThanOrEqual(tolerance);
  expect(Math.abs(boss.top - panel.top), `${label} boss top edge is split from panel`).toBeLessThanOrEqual(tolerance);
  expect(Math.abs(boss.bottom - panel.bottom), `${label} boss bottom edge is split from panel`).toBeLessThanOrEqual(tolerance);
}

async function assertConnectionStatus(page, testInfo, label, options = {}) {
  const status = await page.evaluate(() => window.overlayEventEngine?.status?.().connection || null);
  await attachJson(testInfo, `${label}-connection`, status);
  expect(status, `${label} missing connection status`).toBeTruthy();
  expect(status).not.toHaveProperty('overlayToken');
  expect(status.hasOverlayToken).toEqual(expect.any(Boolean));
  if (options.mode) expect(status.mode).toBe(options.mode);
  if (options.state) expect(status.state).toBe(options.state);
  if (options.ready != null) expect(status.ready).toBe(options.ready);
  if (options.demoMode != null) expect(status.demoMode).toBe(options.demoMode);
  if (options.connected != null) expect(status.connected).toBe(options.connected);
  return status;
}

async function assertSponsorMediaAgent(page, testInfo, label) {
  const result = await page.evaluate(() => ({
    hasModule: typeof window.IntoTheBattleOverlayVideoAgent?.create === 'function',
    status: window.overlayEventEngine?.status?.().sponsorMedia || null,
  }));
  await attachJson(testInfo, `${label}-sponsor-media-agent`, result);
  expect(result.hasModule).toBe(true);
  expect(result.status?.agent).toBe('video-agent');
  expect(result.status?.hasScene).toBe(true);
  expect(result.status?.hasVideoElement).toBe(true);
  expect(result.status?.hasPosterElement).toBe(true);
  expect(result.status?.stateClass).not.toBe('video-error');
  return result.status;
}

async function assertSponsorSceneFits(page, testInfo, label, options = {}) {
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
    const offCenterText = [];
    for (const selector of ['.sponsor-stats-head', '.sponsor-stat', '.sponsor-stat-label', '.sponsor-stat-value', '.sponsor-stat-sub']) {
      for (const el of document.querySelectorAll(`#sponsorLiveStats ${selector}`)) {
        const rect = el.getBoundingClientRect();
        if (effectiveOpacity(el) <= 0.05 || rect.width === 0 || rect.height === 0) continue;
        const style = getComputedStyle(el);
        if (style.textAlign !== 'center') {
          offCenterText.push({ selector, textAlign: style.textAlign, text: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80) });
        }
      }
    }
    const statsRect = document.getElementById('sponsorLiveStats')?.getBoundingClientRect();
    return {
      missing: false,
      sceneClass: scene.className,
      outside,
      offCenterText,
      visibleCount: boxes.length,
      hasStats: Boolean(statsRect?.height),
      statsCenterDelta: statsRect ? Math.abs((statsRect.left + statsRect.width / 2) - (sceneRect.left + sceneRect.width / 2)) : null,
      sceneWidth: sceneRect.width,
    };
  });
  await attachJson(testInfo, `${label}-sponsor-fit`, result);
  expect(result.missing).toBe(false);
  expect(result.sceneClass).toContain('active');
  expect(result.sceneClass).toContain('stats-visible');
  expect(result.visibleCount).toBeGreaterThanOrEqual(options.minVisibleCount ?? 5);
  expect(result.hasStats).toBe(true);
  expect(result.outside).toEqual([]);
  expect(result.offCenterText).toEqual([]);
  expect(result.statsCenterDelta).toBeLessThanOrEqual(Math.max(2, result.sceneWidth * 0.01));
  return result;
}

async function assertOverlayAudioStatus(page, testInfo, label) {
  const result = await page.evaluate(() => ({
    hasModule: Boolean(window.IntoTheBattleOverlayAudio?.defaultAudioConfig),
    status: window.overlayEventEngine?.status?.().audio || null,
  }));
  await attachJson(testInfo, `${label}-audio`, result);
  expect(result.hasModule).toBe(true);
  expect(result.status?.module).toBe('overlay-audio');
  expect(result.status?.assignedEvents).toEqual(expect.arrayContaining(['attack', 'gift', 'kill', 'respawn', 'heal', 'follow']));
  expect(result.status?.cachedCount).toBe(result.status?.filenames?.length);
  expect(result.status?.errorCount).toBe(0);
  return result.status;
}

async function assertVisualQueueHealth(page, testInfo, label, options = {}) {
  const status = await page.evaluate(() => window.overlayEventEngine?.status?.().visualQueue || null);
  await attachJson(testInfo, `${label}-visual-queue`, status);
  expect(status, `${label} missing visual queue status`).toBeTruthy();
  expect(status.totalQueued).toBeLessThanOrEqual(options.maxQueued ?? 12);
  if (options.minProcessed != null) expect(status.stats?.processed).toBeGreaterThanOrEqual(options.minProcessed);
  return status;
}

async function assertSponsorQueueHealth(page, testInfo, label, options = {}) {
  const status = await page.evaluate(() => window.overlayEventEngine?.status?.().sponsor || null);
  await attachJson(testInfo, `${label}-sponsor-queue`, status);
  expect(status, `${label} missing sponsor queue status`).toBeTruthy();
  expect(status.maxQueued).toBe(3);
  expect(status.queued).toBeLessThanOrEqual(options.maxQueued ?? status.maxQueued);
  expect(status.stats?.maxDepth).toBeLessThanOrEqual(status.maxQueued);
  if (options.minDropped != null) expect(status.stats?.dropped).toBeGreaterThanOrEqual(options.minDropped);
  if (options.state) expect(status.state).toBe(options.state);
  return status;
}

async function assertBackgroundStatus(page, testInfo, label, options = {}) {
  const status = await page.evaluate(() => window.overlayEventEngine?.status?.().background || null);
  await attachJson(testInfo, `${label}-background`, status);
  expect(status, `${label} missing background status`).toBeTruthy();
  expect(String(status.source || '')).not.toContain('overlay_token=');
  if (options.state) expect(status.state).toBe(options.state);
  if (options.hasImage != null) expect(status.hasImage).toBe(options.hasImage);
  return status;
}

async function assertFrameHealth(page, testInfo, label, options = {}) {
  const status = await page.evaluate(() => window.overlayEventEngine?.status?.().frame || null);
  await attachJson(testInfo, `${label}-frame`, status);
  expect(status, `${label} missing frame status`).toBeTruthy();
  expect(status.samples).toBeGreaterThanOrEqual(options.minSamples ?? 12);
  expect(status.avgDeltaMs).toBeLessThanOrEqual(options.maxAvgDeltaMs ?? 180);
  expect(status.p95DeltaMs).toBeLessThanOrEqual(options.maxP95DeltaMs ?? 560);
  return status;
}

async function assertBannerBacklog(page, testInfo, label, options = {}) {
  const status = await page.evaluate(() => window.overlayEventEngine?.status?.().banner || null);
  await attachJson(testInfo, `${label}-banner`, status);
  expect(status, `${label} missing banner status`).toBeTruthy();
  expect(status.queued).toBeLessThanOrEqual(options.maxQueued ?? 3);
  expect(status.domCount).toBeLessThanOrEqual(options.maxDomCount ?? 3);
  return status;
}

async function assertEffectOwnership(page, testInfo, label, options = {}) {
  await page.waitForFunction(() => typeof window.overlayEventEngine?.testEffectOwnership === 'function', null, { timeout: 5000 });
  const result = await page.evaluate(() => window.overlayEventEngine.testEffectOwnership());
  await attachJson(testInfo, `${label}-effect-ownership`, result);
  expect(result?.droppedDuringProbe).toBeGreaterThanOrEqual(1);
  expect(result?.status?.unownedEffects).toBe(0);
  expect(result?.status?.ownedEffects).toBeGreaterThanOrEqual(options.minOwnedEffects ?? 1);
  return result;
}

async function auditBackgroundViewport(page, testInfo) {
  await openPreview(page);
  await waitForDemoLayout(page, { horde: true });
  await assertBackgroundStatus(page, testInfo, 'background-initial', { hasImage: false });
  await page.evaluate(() => window.overlayEventEngine.testBackground('valid'));
  await expect.poll(async () => page.evaluate(() => window.overlayEventEngine?.status?.().background?.state || ''), { timeout: 5000 }).toBe('ready');
  await assertBackgroundStatus(page, testInfo, 'background-ready', { state: 'ready', hasImage: true });
  await page.evaluate(() => window.overlayEventEngine.testBackground('missing'));
  await expect.poll(async () => page.evaluate(() => window.overlayEventEngine?.status?.().background?.state || ''), { timeout: 5000 }).toBe('error');
  await assertBackgroundStatus(page, testInfo, 'background-error', { state: 'error', hasImage: true });
  await page.evaluate(() => window.overlayEventEngine.testBackground('clear'));
  await expect.poll(async () => page.evaluate(() => window.overlayEventEngine?.status?.().background?.state || ''), { timeout: 5000 }).toBe('cleared');
  await assertBackgroundStatus(page, testInfo, 'background-cleared', { state: 'cleared', hasImage: false });
}

async function auditSponsorQueueViewport(page, testInfo) {
  await openPreview(page);
  await waitForDemoLayout(page, { horde: true });
  const before = await assertSponsorQueueHealth(page, testInfo, 'sponsor-queue-initial', { maxQueued: 0, state: 'battle' });
  const stress = await page.evaluate(() => window.overlayEventEngine.testSponsorQueue(9));
  await attachJson(testInfo, 'sponsor-queue-stress', stress);
  expect(stress?.requested).toBe(9);
  expect(stress?.status?.queued).toBeLessThanOrEqual(3);
  expect(stress?.status?.stats?.dropped).toBeGreaterThanOrEqual(before.stats.dropped + 5);
  await page.waitForFunction(() => document.querySelector('#sponsorScene')?.classList.contains('stats-visible'), null, { timeout: 7000 });
  await assertSponsorSceneFits(page, testInfo, 'sponsor-queue-active', { minVisibleCount: 1 });
  await assertSponsorQueueHealth(page, testInfo, 'sponsor-queue-active', { maxQueued: 3 });
}

async function auditEffectOwnershipViewport(page, testInfo) {
  await openPreview(page);
  await waitForDemoLayout(page, { horde: true });
  await assertEffectOwnership(page, testInfo, 'effect-ownership', { minOwnedEffects: 1 });
}

async function auditEventStormViewport(page, testInfo) {
  await openPreview(page);
  await waitForDemoLayout(page, { horde: true });
  const before = await assertVisualQueueHealth(page, testInfo, 'event-storm-before', { maxQueued: 0 });
  const storm = await page.evaluate(() => window.overlayEventEngine.testEventStorm(132));
  await attachJson(testInfo, 'event-storm-result', storm);
  expect(storm?.requested).toBeGreaterThanOrEqual(100);
  expect(storm?.status?.totalQueued).toBeLessThanOrEqual(150);
  await expect.poll(async () => page.evaluate(() => window.overlayEventEngine?.status?.().visualQueue?.totalQueued || 0), { timeout: 12000 }).toBeLessThanOrEqual(4);
  await assertVisualQueueHealth(page, testInfo, 'event-storm-after', { maxQueued: 4, minProcessed: before.stats.processed + 12 });
  await assertBannerBacklog(page, testInfo, 'event-storm-banners', { maxQueued: 3, maxDomCount: 3 });
}

test('@visual signed live waiting state stays nonblank and secret-free', async ({ page }, testInfo) => {
  sourceProjectOnly(testInfo);
  const errors = await watchPage(page, harness.baseUrl);
  const params = new URLSearchParams({
    room_id: harness.roomId,
    overlay_token: harness.overlayToken,
    mode: 'live',
    debug: '1',
  });
  const response = await page.goto(`${harness.baseUrl}/overlay?${params.toString()}`, { waitUntil: 'domcontentloaded' });
  expect(response?.ok()).toBe(true);
  await expect(page.getByTestId('overlay-canvas')).toBeVisible();
  await page.waitForFunction(() => window.__overlayLegacyLayout?.frame && Array.isArray(window.__overlayLegacyLayout.players), null, { timeout: 8000 });
  const layout = await readLegacyLayout(page, testInfo, 'signed-live-waiting-layout');
  expect(layout.players).toEqual([]);
  await assertConnectionStatus(page, testInfo, 'signed-live-waiting', { mode: 'signed' });
  await expectCanvasQuality(page, testInfo, '[data-testid="overlay-canvas"]', { name: 'signed-live-waiting-canvas', minLitRatio: 0.04, minEdgeRatio: 0.0015 });
  await freezeOverlayVisuals(page, testInfo, 'signed-live-waiting-freeze');
  await expectStableScreenshot(page.getByTestId('overlay-source-frame'), testInfo, 'signed-live-waiting-state');
  await expectNoHorizontalOverflow(page);
  await expectNoPageErrors(errors, testInfo, 'signed-live-waiting');
});

test('@visual demo battle with five players and horde remains readable', async ({ page }, testInfo) => {
  sourceProjectOnly(testInfo);
  const errors = await watchPage(page, harness.baseUrl);
  await openPreview(page);
  await waitForDemoLayout(page, { horde: true });
  const layout = await readLegacyLayout(page, testInfo, 'demo-battle-layout');
  expect(layout.players.length).toBeGreaterThanOrEqual(5);
  expect(layout.horde).toBeTruthy();
  await assertConnectionStatus(page, testInfo, 'demo-battle', { mode: 'demo', state: 'demo', ready: true, demoMode: true, connected: false });
  await assertOverlayAudioStatus(page, testInfo, 'demo-battle');
  await assertVisualQueueHealth(page, testInfo, 'demo-battle', { maxQueued: 0 });
  await expectCanvasQuality(page, testInfo, '[data-testid="overlay-canvas"]', { name: 'demo-battle-canvas' });
  await freezeOverlayVisuals(page, testInfo, 'demo-battle-freeze');
  await expectStableScreenshot(page.getByTestId('overlay-source-frame'), testInfo, 'demo-battle-five-players-horde');
  await expectNoHorizontalOverflow(page);
  await expectNoPageErrors(errors, testInfo, 'demo-battle');
});

test('@visual boss wave uses one integrated boss HUD and hits all targets', async ({ page }, testInfo) => {
  sourceProjectOnly(testInfo);
  const errors = await watchPage(page, harness.baseUrl);
  await openPreview(page);
  await waitForDemoLayout(page, { horde: true });
  await page.evaluate(() => window.overlayEventEngine.testBoss());
  await waitForDemoLayout(page, { horde: true, boss: true, settleMs: 700 });
  const layout = await readLegacyLayout(page, testInfo, 'boss-wave-layout');
  assertBossHudIntegrated(layout, 'boss-wave');
  await assertEffectOwnership(page, testInfo, 'boss-wave-effects', { minOwnedEffects: 1 });
  await expectCanvasQuality(page, testInfo, '[data-testid="overlay-canvas"]', { name: 'boss-wave-canvas' });
  await freezeOverlayVisuals(page, testInfo, 'boss-wave-freeze');
  await expectStableScreenshot(page.getByTestId('overlay-source-frame'), testInfo, 'boss-wave-integrated-hud');
  await expectNoHorizontalOverflow(page);
  await expectNoPageErrors(errors, testInfo, 'boss-wave');
});

test('@visual sponsor stats endcap fits inside the overlay source frame', async ({ page }, testInfo) => {
  sourceProjectOnly(testInfo);
  const errors = await watchPage(page, harness.baseUrl);
  await openPreview(page, {
    sponsor_preview: '1',
    sponsor_partner: 'Arcade Forge Superlong Partner Name',
    sponsor_title: 'Tonight\'s Arena Spotlight Goes Ultra Wide',
    sponsor_subtitle: 'Premium arena screen preview for stream breaks with battle stats and sponsor copy.',
    sponsor_duration: '30000',
    sponsor_stats: 'always',
    sponsor_timing: 'spotlight',
    sponsor_fit: 'contain',
  });
  await page.waitForFunction(() => document.querySelector('#sponsorScene')?.classList.contains('stats-visible'), null, { timeout: 9000 });
  await assertConnectionStatus(page, testInfo, 'sponsor-stats', { mode: 'demo', state: 'demo', ready: true, demoMode: true, connected: false });
  await assertSponsorMediaAgent(page, testInfo, 'sponsor-stats');
  await assertSponsorSceneFits(page, testInfo, 'sponsor-stats', { minVisibleCount: 1 });
  await expect(page.getByTestId('sponsor-scene')).toMatchAriaSnapshot(`
    - region "Sponsor scene": /Tonight's Arena Spotlight/
  `);
  await freezeOverlayVisuals(page, testInfo, 'sponsor-stats-freeze');
  await expectStableScreenshot(page.getByTestId('sponsor-scene'), testInfo, 'sponsor-stats-endcap');
  await expectNoHorizontalOverflow(page);
  await expectNoPageErrors(errors, testInfo, 'sponsor-stats');
});

test('@visual reduced-motion mobile overlay keeps banners and sponsor stats usable', async ({ page }, testInfo) => {
  mobileProjectOnly(testInfo);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const errors = await watchPage(page, harness.baseUrl);
  await openPreview(page, {
    banner_preview: '1',
    banner_title: 'NeonAce eliminated ShadowByte',
    banner_meta: '7 total kills | streak x5 | momentum x4',
    banner_duration: '5200',
  });
  await waitForDemoLayout(page, { horde: true });
  await page.waitForFunction(() => Boolean(document.querySelector('.banner:not(.closing)')), null, { timeout: 6000 });
  await page.evaluate(() => window.overlayEventEngine.testMotionImpact());
  await page.waitForTimeout(250);
  const motion = await page.evaluate(() => window.overlayEventEngine?.status?.().motion || null);
  await attachJson(testInfo, 'reduced-motion-status', motion);
  expect(motion?.reducedMotion).toBe(true);
  expect(motion?.arenaShakeActive).toBe(false);
  expect(motion?.particles).toBeLessThanOrEqual(32);
  await assertEffectOwnership(page, testInfo, 'reduced-motion-effects', { minOwnedEffects: 1 });
  await expectCanvasQuality(page, testInfo, '[data-testid="overlay-canvas"]', { name: 'reduced-motion-canvas', minLitRatio: 0.05 });
  await freezeOverlayVisuals(page, testInfo, 'reduced-motion-freeze');
  await expectStableScreenshot(page.getByTestId('overlay-source-frame'), testInfo, 'reduced-motion-mobile-overlay');
  await expectNoHorizontalOverflow(page);
  await expectNoPageErrors(errors, testInfo, 'reduced-motion');
});

test('@visual overlay diagnostic hooks emit Playwright artifacts for hard failures', async ({ page }, testInfo) => {
  sourceProjectOnly(testInfo);
  const errors = await watchPage(page, harness.baseUrl, {
    ignoreConsole: [
      /Failed to load resource: net::ERR_NETWORK_CHANGED\b/,
      /Failed to load resource: the server responded with a status of 404 \(Not Found\)/,
    ],
  });

  await test.step('background asset health', async () => {
    await auditBackgroundViewport(page, testInfo);
  });

  await test.step('sponsor queue health', async () => {
    await auditSponsorQueueViewport(page, testInfo);
  });

  await test.step('effect ownership health', async () => {
    await auditEffectOwnershipViewport(page, testInfo);
  });

  await test.step('visual event storm health', async () => {
    await auditEventStormViewport(page, testInfo);
  });

  await page.evaluate(() => window.overlayEventEngine?.resetFrameHealth?.());
  await page.waitForTimeout(650);
  await assertFrameHealth(page, testInfo, 'diagnostic-final-frame', { minSamples: 8 });
  await expectNoPageErrors(errors, testInfo, 'overlay-diagnostics');
});
