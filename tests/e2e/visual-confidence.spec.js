import { test, expect } from '@playwright/test';
import {
  attachJson,
  attachScreenshot,
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
const NEW_ATTACK_EFFECTS = ['prism', 'plasma', 'cryo', 'ion', 'sonic', 'gravity', 'glitch', 'orbital', 'drone', 'shard'];

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

function v2PreviewUrl(extra = {}) {
  const params = new URLSearchParams({
    demo: '0',
    debug: '1',
    controls: '0',
    render: '1080p',
    source: '1',
    ...extra,
  });
  return `${harness.baseUrl}/overlay-v2-preview?${params.toString()}`;
}

function mobileOverlayUrl(extra = {}) {
  const params = new URLSearchParams({
    room_id: harness.roomId,
    overlay_token: harness.overlayToken,
    source: '1',
    transparent: '1',
    layout: 'pip-corner',
    ...extra,
  });
  return `${harness.baseUrl}/overlay/mobile?${params.toString()}`;
}

async function openPreview(page, extra = {}) {
  await harness.start();
  const response = await page.goto(previewUrl(extra), { waitUntil: 'domcontentloaded' });
  expect(response?.ok()).toBe(true);
  await expect(page.getByTestId('overlay-canvas')).toBeVisible();
  await page.waitForFunction(() => Boolean(window.overlayEventEngine && window.__overlayLegacyLayout?.frame), null, { timeout: 8000 });
}

async function openV2Preview(page, extra = {}) {
  await harness.start();
  const response = await page.goto(v2PreviewUrl(extra), { waitUntil: 'domcontentloaded' });
  expect(response?.ok()).toBe(true);
  await expect(page.locator('#phaser-overlay-root canvas')).toBeVisible();
  await page.waitForFunction(() => Boolean(window.__overlayV2Ready && window.overlayV2Scene), null, { timeout: 9000 });
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
  expect(panel, `${label} missing boss entity bounds`).toBeTruthy();
  expect(boss.form, `${label} should render a distinct boss entity`).toBe('rift-tyrant-entity');
  expect(boss.healthDisplay, `${label} should use radial health`).toBe('radial-ring');
  expect(boss.horizontalHealthBars, `${label} should not render a horizontal boss health bar`).toBe(0);
  expect(boss.width / Math.max(1, boss.height), `${label} should read as an entity instead of a bar`).toBeLessThan(3);
  const tolerance = 2;
  expect(Math.abs(boss.left - panel.left), `${label} boss left edge is split from panel`).toBeLessThanOrEqual(tolerance);
  expect(Math.abs(boss.right - panel.right), `${label} boss right edge is split from panel`).toBeLessThanOrEqual(tolerance);
  expect(Math.abs(boss.top - panel.top), `${label} boss top edge is split from panel`).toBeLessThanOrEqual(tolerance);
  expect(Math.abs(boss.bottom - panel.bottom), `${label} boss bottom edge is split from panel`).toBeLessThanOrEqual(tolerance);
}

function rectsOverlap(a, b, tolerance = 0) {
  return a.left < b.right - tolerance &&
    a.right > b.left + tolerance &&
    a.top < b.bottom - tolerance &&
    a.bottom > b.top + tolerance;
}

function assertRectInside(inner, outer, label, tolerance = 1.5) {
  expect(inner, `${label} missing inner rect`).toBeTruthy();
  expect(outer, `${label} missing outer rect`).toBeTruthy();
  expect(inner.left, `${label} left outside`).toBeGreaterThanOrEqual(outer.left - tolerance);
  expect(inner.right, `${label} right outside`).toBeLessThanOrEqual(outer.right + tolerance);
  expect(inner.top, `${label} top outside`).toBeGreaterThanOrEqual(outer.top - tolerance);
  expect(inner.bottom, `${label} bottom outside`).toBeLessThanOrEqual(outer.bottom + tolerance);
}

function assertNoSlotOverlap(a, b, label, tolerance = 0.25) {
  expect(rectsOverlap(a, b, tolerance), `${label} slots overlap`).toBe(false);
}

function assertHordeProminence(layout, label) {
  const frame = layout?.frame;
  const horde = layout?.horde;
  const frameLeft = frame?.left ?? frame?.x;
  const frameTop = frame?.top ?? frame?.y;
  const frameRight = frame?.right ?? frame?.x + frame?.w;
  const frameBottom = frame?.bottom ?? frame?.y + frame?.h;
  expect(horde, `${label} missing horde layout`).toBeTruthy();
  expect(frame, `${label} missing frame`).toBeTruthy();
  expect(horde.left, `${label} horde left outside frame`).toBeGreaterThanOrEqual(frameLeft - 1.5);
  expect(horde.right, `${label} horde right outside frame`).toBeLessThanOrEqual(frameRight + 1.5);
  expect(horde.top, `${label} horde top outside frame`).toBeGreaterThanOrEqual(frameTop - 1.5);
  expect(horde.bottom, `${label} horde bottom outside frame`).toBeLessThanOrEqual(frameBottom + 1.5);
  expect(horde.width, `${label} horde width`).toBeGreaterThanOrEqual(frame.w * 0.9);
  expect(horde.height, `${label} horde height`).toBeGreaterThanOrEqual(frame.h * 0.1);
}

function assertPlayerCardSlots(layout, label, options = {}) {
  const players = layout?.players || [];
  expect(players.length, `${label} missing player cards`).toBeGreaterThanOrEqual(options.minPlayers ?? 5);
  if (layout?.frame?.h) {
    const visibleCards = players.slice(0, options.minPlayers ?? 5).sort((a, b) => a.left - b.left);
    visibleCards.forEach((player, index) => {
      expect(player.height, `${label} player ${index + 1} circle size`).toBeGreaterThanOrEqual(layout.frame.h * 0.22);
      expect(player.height, `${label} player ${index + 1} circle maximum`).toBeLessThanOrEqual(layout.frame.h * 0.27);
    });
    for (let index = 1; index < visibleCards.length; index += 1) {
      expect(
        visibleCards[index].left - visibleCards[index - 1].right,
        `${label} player ${index}/${index + 1} horizontal clearance`
      ).toBeGreaterThanOrEqual(14);
    }
  }
  players.slice(0, options.minPlayers ?? 5).forEach((player, index) => {
    const cardLabel = `${label} player ${index + 1}`;
    const slots = player.slots || {};
    const isCircular = player.text?.cardDesign === 'circular-crest-player-card';
    expect(slots.card, `${cardLabel} missing card slot`).toBeTruthy();
    if (isCircular) {
      expect(Math.abs(slots.card.w - slots.card.h), `${cardLabel} circular card aspect`).toBeLessThanOrEqual(slots.card.h * 0.08);
    }
    for (const key of ['name', 'avatar', 'hpBar', 'statusBadges']) {
      assertRectInside(slots[key], slots.card, `${cardLabel} ${key} slot`);
    }
    for (const key of ['nameText', 'hpText', 'statusText']) {
      assertRectInside(slots[key], slots.card, `${cardLabel} ${key}`);
    }
    expect(slots.handle, `${cardLabel} handle slot should not render`).toBeNull();
    expect(slots.handleText, `${cardLabel} handle text should not render`).toBeNull();
    expect(slots.commandBadge, `${cardLabel} command badge should not render separately`).toBeNull();
    expect(slots.commandText, `${cardLabel} command text should not render separately`).toBeNull();
    expect(slots.rank, `${cardLabel} rank slot should not render`).toBeNull();
    expect(slots.rankBadge, `${cardLabel} rank badge should not render`).toBeNull();
    expect(slots.rankText, `${cardLabel} rank text should not render`).toBeNull();
    expect(slots.ko, `${cardLabel} ko slot should not render`).toBeNull();
    expect(slots.koBadge, `${cardLabel} ko badge should not render`).toBeNull();
    expect(slots.koText, `${cardLabel} ko text should not render`).toBeNull();
    assertRectInside(slots.nameText, slots.name, `${cardLabel} name text`, 3);
    assertRectInside(slots.hpText, slots.hpBar, `${cardLabel} hp text`, 3);
    assertRectInside(slots.statusText, slots.statusBadges, `${cardLabel} status text`, 2.5);
    expect(slots.nameText.h, `${cardLabel} source-scale name readability`).toBeGreaterThanOrEqual(Math.max(14.5, slots.card.h * (isCircular ? 0.06 : 0.13)));
    expect(slots.avatar.h, `${cardLabel} source-scale avatar readability`).toBeGreaterThanOrEqual(Math.max(56, slots.card.h * 0.34));
    expect(slots.avatar.w, `${cardLabel} source-scale avatar width`).toBeGreaterThanOrEqual(Math.max(56, slots.card.w * 0.25));
    expect(slots.hpBar.h, `${cardLabel} source-scale hp medallion readability`).toBeGreaterThanOrEqual(Math.max(32, slots.card.h * 0.19));
    expect(slots.hpBar.w, `${cardLabel} hp medallion should stay compact`).toBeLessThanOrEqual(slots.card.w * (isCircular ? 0.46 : 0.42));
    expect(slots.hpText.h, `${cardLabel} source-scale hp text readability`).toBeGreaterThanOrEqual(Math.max(14, slots.card.h * 0.09));
    assertNoSlotOverlap(slots.name, slots.avatar, `${cardLabel} name/avatar`);
    assertNoSlotOverlap(slots.name, slots.hpBar, `${cardLabel} name/hp`);
    assertNoSlotOverlap(slots.statusBadges, slots.hpBar, `${cardLabel} status/hp`);
    assertNoSlotOverlap(slots.avatar, slots.hpBar, `${cardLabel} avatar/hp`);
    expect(slots.name.bottom, `${cardLabel} name should lead the card hierarchy`).toBeLessThan(slots.avatar.top);
    expect(slots.avatar.bottom, `${cardLabel} health and status should sit below the fighter`).toBeLessThan(slots.hpBar.top);
    expect(slots.avatar.bottom, `${cardLabel} status should sit below the fighter`).toBeLessThan(slots.statusBadges.top);
    expect(player.text?.cardDesign, `${cardLabel} card design marker`).toBe('circular-crest-player-card');
    expect(player.text?.nameHasReplacement, `${cardLabel} name contains replacement glyph`).toBe(false);
    expect(player.text?.fittedName || '', `${cardLabel} missing fitted name`).not.toBe('');
    expect(player.text?.fittedName || '', `${cardLabel} name should stay on one line`).not.toMatch(/[\r\n]/);
    expect(player.text?.handle || '', `${cardLabel} handle should be hidden by default`).toBe('');
    expect(player.text?.koLabel || '', `${cardLabel} ko label should not render`).toBe('');
    expect(player.text?.hpLabel || '', `${cardLabel} missing hp label`).toMatch(/^\d+\s+HP$/);
    expect(player.text?.statusLabel || '', `${cardLabel} missing status label`).not.toBe('');
    if (player.text?.emojiSource === 'player-icon-medallion') {
      expect(player.text?.iconEmoji || '', `${cardLabel} missing emoji crest`).not.toBe('');
      expect(player.text?.emojiRendered, `${cardLabel} emoji should render as the card crest`).toBe(true);
    } else {
      expect(player.text?.iconEmoji || '', `${cardLabel} fallback cards should not report an emoji`).toBe('');
      expect(player.text?.emojiRendered, `${cardLabel} fallback insignia should render when no emoji exists`).toBe(false);
      expect(player.text?.emojiSource, `${cardLabel} emoji source`).toBe('fallback-insignia');
    }
    expect(['healthy', 'damaged', 'critical', 'ko'], `${cardLabel} unknown health state`).toContain(player.text?.healthState);
    expect(player.text?.nameCenterDelta ?? 999, `${cardLabel} name center drift`).toBeLessThanOrEqual(2);
  });
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
  const minVisibleCount = options.minVisibleCount ?? 5;
  await page.waitForFunction((expectedVisibleCount) => {
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
    if (!scene?.classList.contains('active') || !scene.classList.contains('stats-visible')) return false;
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
    let visibleCount = 0;
    for (const selector of selectors) {
      for (const el of document.querySelectorAll(selector)) {
        const rect = el.getBoundingClientRect();
        if (effectiveOpacity(el) > 0.05 && rect.width > 0 && rect.height > 0) visibleCount += 1;
      }
    }
    return visibleCount >= expectedVisibleCount;
  }, minVisibleCount, { timeout: options.visibleTimeout ?? 5000 });

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
  expect(result.visibleCount).toBeGreaterThanOrEqual(minVisibleCount);
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
  expect(result.status?.masterVolume).toBe(0.5);
  expect(result.status?.assignedEvents).toEqual(expect.arrayContaining(['attack', 'gift', 'kill', 'respawn', 'heal', 'follow']));
  expect(result.status?.eventFiles).toMatchObject({
    attack: 'sound1.mp3',
    gift: 'sound2.mp3',
    kill: 'sound3.mp3',
    respawn: 'sound4.mp3',
    heal: 'sound5.mp3',
    follow: 'sound6.mp3',
    socialBoost: 'sound6.mp3',
    engagementSurge: 'sound2.mp3',
    laser: 'sound4.mp3',
    arc: 'sound4.mp3',
    pulse: 'sound7.mp3',
    orbital: 'sound9.mp3',
  });
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
  expect(status.domCount).toBeLessThanOrEqual(options.maxDomCount ?? 1);
  expect(status.closingDomCount).toBeLessThanOrEqual(1);
  return status;
}

async function assertBannerCombatGap(page, testInfo, label, options = {}) {
  await page.waitForTimeout(options.settleMs ?? 480);
  const status = await assertBannerBacklog(page, testInfo, label, options);
  const active = status.active?.rect;
  const lane = status.lane;
  expect(active, `${label} missing active banner rect`).toBeTruthy();
  expect(lane, `${label} missing banner lane`).toBeTruthy();
  expect(status.laneSource, `${label} should use combat-gap banner lane`).toBe('combat-gap');
  if (options.expectHordeSide !== false) {
    expect(status.laneAnchor, `${label} should prefer the Horde-side banner lane`).toBe('horde-side');
  }
  expect(status.playerBottom, `${label} missing player bottom telemetry`).toBeGreaterThan(0);
  expect(status.hordeTop, `${label} missing horde top telemetry`).toBeGreaterThan(status.playerBottom);
  expect(status.availableGap, `${label} combat gap too small`).toBeGreaterThan(options.minAvailableGap ?? 24);
  assertRectInside(active, lane, `${label} active banner in lane`, options.tolerance ?? 2.5);
  expect(active.top, `${label} banner should sit below player cards`).toBeGreaterThan(status.playerBottom + (options.minSeparation ?? 1));
  expect(active.bottom, `${label} banner should sit above horde`).toBeLessThan(status.hordeTop - (options.minSeparation ?? 1));
  if (options.expectLowerPlacement !== false) {
    const activeCenter = (active.top + active.bottom) / 2;
    const playerDistance = activeCenter - status.playerBottom;
    const hordeDistance = status.hordeTop - activeCenter;
    expect(
      playerDistance + (options.lowerPlacementTolerance ?? 8),
      `${label} banner should sit closer to the Horde than the player cards`
    ).toBeGreaterThanOrEqual(hordeDistance);
  }
  if (options.avoidBoss) {
    expect(status.bossTop, `${label} missing boss top telemetry`).toBeGreaterThan(status.playerBottom);
    expect(status.bossBottom, `${label} missing boss bottom telemetry`).toBeGreaterThan(status.bossTop);
    expect(
      active.bottom <= status.bossTop - (options.minSeparation ?? 1) ||
        active.top >= status.bossBottom + (options.minSeparation ?? 1),
      `${label} banner should not overlap boss HUD`
    ).toBe(true);
  }
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

async function auditOverflowHordeEffectViewport(page, testInfo) {
  await openPreview(page);
  await waitForDemoLayout(page, { horde: true });
  await page.waitForFunction(() => typeof window.overlayEventEngine?.testOverflowHordeEffect === 'function', null, { timeout: 5000 });
  const result = await page.evaluate(() => window.overlayEventEngine.testOverflowHordeEffect());
  await attachJson(testInfo, 'overflow-horde-effect', result);
  expect(result?.fired).toBe(true);
  expect(result?.droppedDuringProbe).toBe(0);
  expect(result?.hordeMembers).toContain('overflow_7');
  expect(result?.status?.unownedEffects).toBe(0);
  expect(result?.status?.ownedEffects).toBeGreaterThanOrEqual(1);
  await expectCanvasQuality(page, testInfo, '[data-testid="overlay-canvas"]', { name: 'overflow-horde-effect-canvas', minLitRatio: 0.04 });
}

async function auditEffectCatalogViewport(page, testInfo) {
  await openPreview(page);
  await waitForDemoLayout(page, { horde: true });
  await page.waitForFunction(() => typeof window.overlayEventEngine?.testEffectCatalog === 'function', null, { timeout: 5000 });
  const result = await page.evaluate(effects => window.overlayEventEngine.testEffectCatalog(effects), NEW_ATTACK_EFFECTS);
  await attachJson(testInfo, 'new-effect-catalog', result);
  expect(result?.requested).toBe(NEW_ATTACK_EFFECTS.length);
  expect(result?.firedCount).toBe(NEW_ATTACK_EFFECTS.length);
  expect(result?.effects?.map(item => item.effect)).toEqual(NEW_ATTACK_EFFECTS);
  expect(result?.effects?.every(item => item.fired)).toBe(true);
  expect(result?.status?.unownedEffects).toBe(0);
  expect(result?.status?.ownedEffects).toBeGreaterThanOrEqual(NEW_ATTACK_EFFECTS.length);
  expect(result?.status?.particles).toBeLessThanOrEqual(220);
  await expectCanvasQuality(page, testInfo, '[data-testid="overlay-canvas"]', { name: 'new-effect-catalog-canvas', minLitRatio: 0.05 });
}

async function auditOrbitalTrackingViewport(page, testInfo) {
  await openPreview(page);
  await waitForDemoLayout(page, { horde: true });
  await page.waitForFunction(() => typeof window.overlayEventEngine?.testOrbitalTracking === 'function', null, { timeout: 5000 });
  const result = await page.evaluate(() => window.overlayEventEngine.testOrbitalTracking());
  await attachJson(testInfo, 'orbital-tracking-result', result);
  expect(result?.fired).toBe(true);
  expect(result?.droppedDuringProbe).toBe(0);
  expect(result?.status?.unownedEffects).toBe(0);
  expect(result?.status?.ownedEffects).toBeGreaterThanOrEqual(1);

  await page.waitForFunction(() => {
    const geometry = window.__overlayLastOrbitalGeometry;
    return geometry && geometry.beamProgress > 0.3;
  }, null, { timeout: 2500 });
  const geometry = await page.evaluate(() => window.__overlayLastOrbitalGeometry || null);
  await attachJson(testInfo, 'orbital-tracking-geometry', geometry);
  expect(geometry?.projectedTargetDrift).toBeLessThanOrEqual(0.5);
  expect(geometry?.origin?.y).toBeLessThan((geometry?.target?.y || 0) - 40);
  await attachScreenshot(page, testInfo, 'orbital-tracking-preview');
  await expectCanvasQuality(page, testInfo, '[data-testid="overlay-canvas"]', { name: 'orbital-tracking-canvas', minLitRatio: 0.045 });
}

async function auditAttackGeometryViewport(page, testInfo) {
  await openPreview(page);
  await waitForDemoLayout(page, { horde: true });
  await page.waitForFunction(() => typeof window.overlayEventEngine?.testAttackGeometry === 'function', null, { timeout: 5000 });
  const result = await page.evaluate(() => window.overlayEventEngine.testAttackGeometry());
  await attachJson(testInfo, 'attack-geometry-result', result);
  expect(result?.firedCount).toBe(result?.results?.length);
  expect(result?.droppedDuringProbe).toBe(0);
  expect(result?.status?.unownedEffects).toBe(0);
  for (const item of result?.results || []) {
    expect(item.fired, `${item.name} should fire`).toBe(true);
    const geometry = item.geometry;
    expect(Number.isFinite(geometry?.origin?.x), `${item.name} missing origin x`).toBe(true);
    expect(Number.isFinite(geometry?.origin?.y), `${item.name} missing origin y`).toBe(true);
    expect(Number.isFinite(geometry?.targetPoint?.x), `${item.name} missing target x`).toBe(true);
    expect(Number.isFinite(geometry?.targetPoint?.y), `${item.name} missing target y`).toBe(true);
    expect(geometry?.distance, `${item.name} collapsed attack path`).toBeGreaterThan(24);
  }
  await expectCanvasQuality(page, testInfo, '[data-testid="overlay-canvas"]', { name: 'attack-geometry-canvas', minLitRatio: 0.045 });
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
  await assertBannerBacklog(page, testInfo, 'event-storm-banners', { maxQueued: 3, maxDomCount: 1 });
}

async function auditHotAttackStormViewport(page, testInfo) {
  await openPreview(page);
  await waitForDemoLayout(page, { horde: true });
  await page.waitForFunction(() => typeof window.overlayEventEngine?.testHotAttackStorm === 'function', null, { timeout: 5000 });
  const storm = await page.evaluate(() => window.overlayEventEngine.testHotAttackStorm(180));
  await attachJson(testInfo, 'hot-attack-storm-result', storm);
  expect(storm?.requested).toBeGreaterThanOrEqual(160);
  expect(storm?.status?.motion?.hotMode).toBe(true);
  expect(storm?.status?.motion?.hotReason).toContain('storm');
  expect(storm?.status?.visualQueue?.totalQueued).toBeLessThanOrEqual(70);
  await expect.poll(async () => page.evaluate(() => window.overlayEventEngine?.status?.().visualQueue?.totalQueued || 0), { timeout: 14000 }).toBeLessThanOrEqual(4);
  await page.waitForTimeout(300);
  const status = await page.evaluate(() => window.overlayEventEngine?.status?.() || null);
  await attachJson(testInfo, 'hot-attack-storm-status', status);
  expect(status?.motion?.hotMode).toBe(true);
  expect(status?.motion?.activeAttacks).toBeLessThanOrEqual(8);
  expect(status?.motion?.particles).toBeLessThanOrEqual(112);
  expect(status?.visualQueue?.stats?.handlerErrors).toBe(0);
  await expectCanvasQuality(page, testInfo, '[data-testid="overlay-canvas"]', { name: 'hot-attack-storm-canvas', minLitRatio: 0.04 });
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
  await page.waitForFunction(() => window.overlayEventEngine?.status?.().background?.waiting?.state === 'ready', null, { timeout: 8000 });
  const layout = await readLegacyLayout(page, testInfo, 'signed-live-waiting-layout');
  expect(layout.players).toEqual([]);
  const waitingUi = await page.evaluate(() => {
    const status = document.querySelector('#status-badge');
    return {
      background: window.overlayEventEngine?.status?.().background?.waiting || null,
      activeBannerCount: document.querySelectorAll('.banner:not(.closing)').length,
      statusText: status?.textContent || '',
      statusVisibility: status ? getComputedStyle(status).visibility : '',
    };
  });
  await attachJson(testInfo, 'signed-live-waiting-ui', waitingUi);
  expect(waitingUi.background).toMatchObject({ state: 'ready', hasImage: true });
  expect(waitingUi.activeBannerCount, 'waiting state should not show a duplicate rich banner').toBe(0);
  expect(waitingUi.statusText).toContain('WAITING FOR PLAYERS');
  expect(waitingUi.statusVisibility, 'waiting state should hide the duplicate status badge').toBe('hidden');
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
  assertHordeProminence(layout, 'demo-battle');
  assertPlayerCardSlots(layout, 'demo-battle');
  await page.evaluate(() => window.overlayEventEngine.testBannerPlacement('kill', {
    title: 'NeonAce eliminated ShadowByte',
    meta: '7 total kills | streak x5 | momentum x4',
    durationMs: 12000,
  }));
  await page.waitForFunction(() => Boolean(document.querySelector('.banner:not(.closing)')), null, { timeout: 6000 });
  await assertBannerCombatGap(page, testInfo, 'demo-battle-banner');
  await assertConnectionStatus(page, testInfo, 'demo-battle', { mode: 'demo', state: 'demo', ready: true, demoMode: true, connected: false });
  await assertOverlayAudioStatus(page, testInfo, 'demo-battle');
  await assertVisualQueueHealth(page, testInfo, 'demo-battle', { maxQueued: 0 });
  await expectCanvasQuality(page, testInfo, '[data-testid="overlay-canvas"]', { name: 'demo-battle-canvas' });
  await freezeOverlayVisuals(page, testInfo, 'demo-battle-freeze');
  await expectStableScreenshot(page.getByTestId('overlay-source-frame'), testInfo, 'demo-battle-five-players-horde');
  await expectNoHorizontalOverflow(page);
  await expectNoPageErrors(errors, testInfo, 'demo-battle');
});

test('@visual player composition remains collision-free across roster sizes and source resolutions', async ({ page }, testInfo) => {
  sourceProjectOnly(testInfo);
  const errors = await watchPage(page, harness.baseUrl);
  const resolutions = [
    { width: 1920, height: 1080 },
    { width: 1400, height: 788 },
    { width: 1280, height: 720 },
  ];
  const rosterSizes = [1, 3, 5, 7];
  const results = [];

  for (const resolution of resolutions) {
    await page.setViewportSize(resolution);
    await openPreview(page);
    await page.waitForFunction(() => typeof window.overlayEventEngine?.testPlayerCards === 'function', null, { timeout: 5000 });

    for (const rosterSize of rosterSizes) {
      const roster = Array.from({ length: rosterSize }, (_, index) => ({
        uniqueId: `layout_${rosterSize}_${index + 1}`,
        nickname: index === rosterSize - 1 ? `Very_Long_Player_Label_${rosterSize}_${index + 1}` : `Player${index + 1}`,
        hp: 180 - index * 7,
        maxHp: 200,
        kills: rosterSize - index,
        iconEmoji: index % 2 ? '\u26a1' : '\u2694\ufe0f',
      }));
      await page.evaluate(players => window.overlayEventEngine.testPlayerCards(players), roster);
      await page.waitForFunction(expected => {
        const layout = window.__overlayLegacyLayout;
        return layout?.players?.length === Math.min(5, expected)
          && (expected <= 5 || Boolean(layout.horde));
      }, rosterSize, { timeout: 5000 });
      await page.waitForTimeout(180);
      const layout = await page.evaluate(() => window.__overlayLegacyLayout);
      expect(layout.collisions, `${resolution.width}x${resolution.height} roster ${rosterSize} collisions`).toEqual([]);
      expect(layout.leaks, `${resolution.width}x${resolution.height} roster ${rosterSize} leaks`).toEqual([]);
      assertPlayerCardSlots(layout, `${resolution.width}x${resolution.height} roster ${rosterSize}`, {
        minPlayers: Math.min(5, rosterSize),
      });
      if (rosterSize > 5) assertHordeProminence(layout, `${resolution.width}x${resolution.height} roster ${rosterSize}`);
      results.push({ resolution, rosterSize, layout });
    }
  }

  await attachJson(testInfo, 'responsive-player-composition', results);
  await expectNoHorizontalOverflow(page);
  await expectNoPageErrors(errors, testInfo, 'responsive-player-composition');
});

test('@visual open-space banner expands without crowding the player card', async ({ page }, testInfo) => {
  sourceProjectOnly(testInfo);
  const errors = await watchPage(page, harness.baseUrl);
  await openPreview(page);
  await page.waitForFunction(() => typeof window.overlayEventEngine?.testPlayerCards === 'function', null, { timeout: 5000 });
  await page.evaluate(() => {
    window.overlayEventEngine.testPlayerCards([
      { uniqueId: 'banner_solo', nickname: 'NovaPrime', hp: 190, maxHp: 200, kills: 8, iconEmoji: '\u2694\ufe0f' },
    ]);
    window.overlayEventEngine.testBannerPlacement('info', {
      title: 'The arena is ready',
      meta: 'Mention a fighter to launch an attack',
      durationMs: 12000,
    });
  });
  await page.waitForFunction(() => {
    const status = window.overlayEventEngine?.status?.().banner;
    return status?.active?.className?.includes('is-expanded') && status.active.rect?.height >= 104;
  }, null, { timeout: 6000 });
  await page.waitForTimeout(260);
  const status = await page.evaluate(() => window.overlayEventEngine.status().banner);
  await attachJson(testInfo, 'open-space-banner-status', status);
  expect(status.active.className).toContain('is-expanded');
  expect(status.active.rect.height).toBeGreaterThanOrEqual(104);
  expect(status.domCount).toBe(1);
  const layout = await readLegacyLayout(page, testInfo, 'open-space-banner-layout');
  expect(layout.collisions, 'open-space banner layout collisions').toEqual([]);
  assertPlayerCardSlots(layout, 'open-space-banner', { minPlayers: 1 });
  await freezeOverlayVisuals(page, testInfo, 'open-space-banner-freeze');
  await expectStableScreenshot(page.getByTestId('overlay-source-frame'), testInfo, 'open-space-expanded-banner', { maxDiffPixelRatio: 0.08 });
  await expectNoHorizontalOverflow(page);
  await expectNoPageErrors(errors, testInfo, 'open-space-banner');
});

test('@visual player cards keep stats and special-character names aligned', async ({ page }, testInfo) => {
  sourceProjectOnly(testInfo);
  const errors = await watchPage(page, harness.baseUrl);
  await openPreview(page);
  await page.waitForFunction(() => typeof window.overlayEventEngine?.testPlayerCards === 'function', null, { timeout: 5000 });
  const roster = [
    { uniqueId: 'card_plain', nickname: 'NebulaX', hp: 180, maxHp: 200, kills: 3, iconEmoji: '\u2694\ufe0f', cardAccentType: 'attack', cardAccentLabel: 'LASER', teamColor: '#55e7ff' },
    { uniqueId: 'card_fire', nickname: '\u{1f525}Queen\u{1f525}', hp: 150, maxHp: 190, kills: 27, iconEmoji: '\u{1f525}', cardAccentType: 'shield', cardAccentLabel: 'DEF', teamColor: '#f6c95b' },
    { uniqueId: 'card_accent', nickname: 'A\u0301lvaro\u2728', hp: 66, maxHp: 160, kills: 0, iconEmoji: '\u2728', cardAccentType: 'heal', cardAccentLabel: 'HEAL', teamColor: '#8fffd2' },
    { uniqueId: 'card_cjk', nickname: '\u73a9\u5bb6\u26a1\u9f8d', hp: 24, maxHp: 170, kills: 108, iconEmoji: '\u26a1', cardAccentType: 'critical', cardAccentLabel: 'CRIT', teamColor: '#ff6a3d' },
    { uniqueId: 'card_long', nickname: 'Name_\u2728\u2728\u2728_MegaDash_Commander', hp: 0, maxHp: 150, kills: 1420, iconEmoji: '\u{1f3ae}', cardAccentType: 'kill', cardAccentLabel: 'KO', teamColor: '#ff78b2' },
  ];
  const result = await page.evaluate(players => window.overlayEventEngine.testPlayerCards(players), roster);
  await attachJson(testInfo, 'special-player-card-roster-result', result);
  expect(result).toMatchObject({ ok: true, count: 5 });
  await waitForDemoLayout(page, { minPlayers: 5, settleMs: 500 });
  const layout = await readLegacyLayout(page, testInfo, 'special-player-card-layout');
  assertPlayerCardSlots(layout, 'special-player-cards');
  const cardsById = Object.fromEntries(layout.players.map(player => [player.id, player]));
  expect(cardsById.card_plain?.text).toMatchObject({ healthState: 'healthy', commandLabel: 'LASER' });
  expect(cardsById.card_fire?.text).toMatchObject({
    healthState: 'healthy',
    commandLabel: 'DEF',
    shieldActive: true,
    shieldOverlay: 'circular-aegis-ring',
  });
  expect(cardsById.card_plain?.text).toMatchObject({ iconEmoji: '\u2694\ufe0f', emojiRendered: true, emojiSource: 'player-icon-medallion' });
  expect(cardsById.card_fire?.text).toMatchObject({ iconEmoji: '\u{1f525}', emojiRendered: true, emojiSource: 'player-icon-medallion' });
  expect(cardsById.card_fire?.slots?.shieldOverlay).toBeTruthy();
  expect(cardsById.card_accent?.text).toMatchObject({ healthState: 'damaged', commandLabel: 'HEAL' });
  expect(cardsById.card_cjk?.text).toMatchObject({ healthState: 'critical', commandLabel: 'CRIT' });
  expect(cardsById.card_long?.text).toMatchObject({ healthState: 'ko', commandLabel: 'KO' });
  await expectCanvasQuality(page, testInfo, '[data-testid="overlay-canvas"]', { name: 'special-player-card-canvas' });
  await freezeOverlayVisuals(page, testInfo, 'special-player-card-freeze');
  await expectNoHorizontalOverflow(page);
  await expectNoPageErrors(errors, testInfo, 'special-player-cards');
});

test('@visual premium esports overlay preview keeps the full HUD readable', async ({ page }, testInfo) => {
  sourceProjectOnly(testInfo);
  const errors = await watchPage(page, harness.baseUrl);
  await openPreview(page);
  await page.waitForFunction(() => typeof window.overlayEventEngine?.testPremiumEsportsPreview === 'function', null, { timeout: 5000 });
  const preview = await page.evaluate(() => window.overlayEventEngine.testPremiumEsportsPreview());
  await attachJson(testInfo, 'premium-esports-preview-result', preview);
  expect(preview).toMatchObject({ ok: true, mode: 'premium-esports-preview' });
  await waitForDemoLayout(page, { minPlayers: 5, horde: true, boss: true, settleMs: 700 });
  const layout = await readLegacyLayout(page, testInfo, 'premium-esports-preview-layout');
  assertPlayerCardSlots(layout, 'premium-esports-preview', { minPlayers: 5 });
  assertBossHudIntegrated(layout, 'premium-esports-preview');
  expect(layout.collisions, 'premium-esports-preview static HUD collisions').toEqual([]);
  await assertBannerCombatGap(page, testInfo, 'premium-esports-preview-banner', { avoidBoss: true });
  await expectCanvasQuality(page, testInfo, '[data-testid="overlay-canvas"]', { name: 'premium-esports-preview-canvas', minLitRatio: 0.05 });
  await freezeOverlayVisuals(page, testInfo, 'premium-esports-preview-freeze');
  await expectStableScreenshot(page.getByTestId('overlay-source-frame'), testInfo, 'premium-esports-preview', { maxDiffPixelRatio: 0.16 });
  await expectNoHorizontalOverflow(page);
  await expectNoPageErrors(errors, testInfo, 'premium-esports-preview');
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
  await page.waitForFunction(() => Boolean(document.querySelector('.banner:not(.closing)')), null, { timeout: 6000 });
  await assertBannerCombatGap(page, testInfo, 'boss-wave-banner', { avoidBoss: true });
  await assertEffectOwnership(page, testInfo, 'boss-wave-effects', { minOwnedEffects: 1 });
  const postEffectLayout = await readLegacyLayout(page, testInfo, 'boss-wave-post-effect-layout');
  expect(postEffectLayout.collisions, 'boss-wave post-effect HUD collisions').toEqual([]);
  await expectCanvasQuality(page, testInfo, '[data-testid="overlay-canvas"]', { name: 'boss-wave-canvas' });
  await freezeOverlayVisuals(page, testInfo, 'boss-wave-freeze');
  await expectStableScreenshot(page.getByTestId('overlay-source-frame'), testInfo, 'boss-wave-integrated-hud', { maxDiffPixelRatio: 0.12 });
  await expectNoHorizontalOverflow(page);
  await expectNoPageErrors(errors, testInfo, 'boss-wave');
});

test('@visual arena power-up glow highlights top contributors without covering cards', async ({ page }, testInfo) => {
  sourceProjectOnly(testInfo);
  const errors = await watchPage(page, harness.baseUrl);
  await openV2Preview(page);
  await page.waitForFunction(() => typeof window.overlayV2Scene?.testArenaPowerUp === 'function', null, { timeout: 5000 });
  const initial = await page.evaluate(() => window.overlayV2Scene.testArenaPowerUp());
  await page.waitForTimeout(700);
  const status = await page.evaluate(() => window.overlayV2Scene.arenaPowerAuditStatus());
  await attachJson(testInfo, 'arena-power-up-v2-status', { initial, status });
  expect(status.active).toBe(true);
  expect(status.hasGlow).toBe(true);
  expect(status.hasChip).toBe(true);
  expect(status.powerLayerChildren).toBeGreaterThan(0);
  expect(status.topCount).toBeGreaterThanOrEqual(3);
  expect(status.chipText).toContain('#1');
  expect(status.countdownText).toMatch(/s$/);
  expect(status.highlighted.map(item => item.rank)).toEqual(expect.arrayContaining([1, 2, 3]));
  expect(status.layout.filter(item => item.powerRank > 0).length).toBeGreaterThanOrEqual(3);
  expect(status.chipBounds?.right).toBeLessThanOrEqual(1920);
  expect(status.chipBounds?.top).toBeGreaterThanOrEqual(0);
  expect(status.chipBounds?.bottom).toBeLessThanOrEqual(status.safe.y + 90);
  const coveredCards = status.layout.filter(card => rectsOverlap(status.chipBounds, card, 8));
  expect(coveredCards).toEqual([]);
  const canvasBox = await page.locator('#phaser-overlay-root canvas').boundingBox();
  await attachJson(testInfo, 'arena-power-up-v2-canvas-box', canvasBox);
  expect(canvasBox?.width).toBeGreaterThan(1200);
  expect(canvasBox?.height).toBeGreaterThan(650);
  await expectNoHorizontalOverflow(page);
  await expectNoPageErrors(errors, testInfo, 'arena-power-up-v2');
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

test('@visual mobile streamer event rail stays minimal and high-signal', async ({ page }, testInfo) => {
  mobileProjectOnly(testInfo);
  const errors = await watchPage(page, harness.baseUrl);
  const response = await page.goto(mobileOverlayUrl({ layout: 'pip-corner', setup: '1' }), { waitUntil: 'domcontentloaded' });
  expect(response?.ok()).toBe(true);
  await expect(page.getByTestId('mobile-overlay-shell')).toBeVisible();
  await page.waitForFunction(() => Boolean(window.mobileOverlayEngine?.testEventBurst), null, { timeout: 8000 });
  const status = await page.evaluate(() => window.mobileOverlayEngine.testEventBurst());
  await page.waitForTimeout(250);
  const telemetry = await page.evaluate(() => window.mobileOverlayEngine.telemetry());
  await attachJson(testInfo, 'mobile-pip-status', status);
  await attachJson(testInfo, 'mobile-pip-telemetry', telemetry);
  await attachScreenshot(page, testInfo, 'mobile-streamer-event-rail');

  expect(telemetry.layout).toBe('pip-corner');
  expect(telemetry.sourceMode).toBe(true);
  expect(telemetry.transparent).toBe(true);
  expect(telemetry.horizontalOverflow).toBeLessThanOrEqual(2);
  expect(telemetry.verticalOverflow).toBeLessThanOrEqual(2);
  expect(telemetry.eventCount).toBeGreaterThanOrEqual(5);
  expect(telemetry.commentCount).toBeGreaterThanOrEqual(4);
  expect(telemetry.playerCount).toBeGreaterThanOrEqual(3);
  expect(telemetry.rects.length).toBeLessThanOrEqual(5);

  for (const rect of telemetry.rects) {
    expect(rect.left, `${rect.testid} left edge`).toBeGreaterThanOrEqual(-1);
    expect(rect.right, `${rect.testid} right edge`).toBeLessThanOrEqual(telemetry.viewport.width + 1);
    expect(rect.top, `${rect.testid} top edge`).toBeGreaterThanOrEqual(-1);
    expect(rect.bottom, `${rect.testid} bottom edge`).toBeLessThanOrEqual(telemetry.viewport.height + 1);
    expect(rect.text, `${rect.testid} should not contain replacement characters`).not.toContain('\uFFFD');
  }
  for (let i = 0; i < telemetry.rects.length; i += 1) {
    for (let j = i + 1; j < telemetry.rects.length; j += 1) {
      expect(rectsOverlap(telemetry.rects[i], telemetry.rects[j], 1), `${telemetry.rects[i].testid} overlaps ${telemetry.rects[j].testid}`).toBe(false);
    }
  }

  const feedCards = await page.locator('[data-testid="mobile-feed-card"]').count();
  expect(feedCards).toBe(0);
  await expect(page.getByTestId('mobile-latest-event')).toContainText(/Boss wave|Gift|Arena Power|KO|Like/i);
  await expect(page.getByTestId('mobile-comment-crawl')).toContainText(/FireQueen|ShadowByte|LikeCrew|MobileBossBreakerUltra/);
  await expect(page.locator('#sourceNote')).toContainText(/signal rail|TikTok chat/);
  await expectNoHorizontalOverflow(page);
  await expectNoPageErrors(errors, testInfo, 'mobile-event-rail');
});

test('@visual reduced-motion mobile overlay keeps banners and sponsor stats usable', async ({ page }, testInfo) => {
  mobileProjectOnly(testInfo);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const errors = await watchPage(page, harness.baseUrl);
  await openPreview(page);
  await waitForDemoLayout(page, { horde: true });
  await page.evaluate(() => window.overlayEventEngine.testBannerPlacement('legendary', {
    title: 'NeonAce eliminated ShadowByte',
    meta: '7 total kills | streak x5 | momentum x4',
    durationMs: 12000,
  }));
  await page.waitForFunction(() => Boolean(document.querySelector('.banner:not(.closing)')), null, { timeout: 6000 });
  await page.evaluate(() => window.overlayEventEngine.testMotionImpact());
  await page.waitForTimeout(250);
  const motion = await page.evaluate(() => window.overlayEventEngine?.status?.().motion || null);
  await attachJson(testInfo, 'reduced-motion-status', motion);
  expect(motion?.reducedMotion).toBe(true);
  expect(motion?.arenaShakeActive).toBe(false);
  expect(motion?.particles).toBeLessThanOrEqual(32);
  await assertEffectOwnership(page, testInfo, 'reduced-motion-effects', { minOwnedEffects: 1 });
  await assertBannerCombatGap(page, testInfo, 'reduced-motion-banner', { minAvailableGap: 20, tolerance: 3 });
  await expectCanvasQuality(page, testInfo, '[data-testid="overlay-canvas"]', { name: 'reduced-motion-canvas', minLitRatio: 0.05 });
  await freezeOverlayVisuals(page, testInfo, 'reduced-motion-freeze');
  await expectStableScreenshot(page.getByTestId('overlay-source-frame'), testInfo, 'reduced-motion-mobile-overlay', { maxDiffPixelRatio: 0.18 });
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

  await test.step('overflow horde effect fallback', async () => {
    await auditOverflowHordeEffectViewport(page, testInfo);
  });

  await test.step('new effect catalog health', async () => {
    await auditEffectCatalogViewport(page, testInfo);
  });

  await test.step('orbital tracking health', async () => {
    await auditOrbitalTrackingViewport(page, testInfo);
  });

  await test.step('attack geometry health', async () => {
    await auditAttackGeometryViewport(page, testInfo);
  });

  await test.step('visual event storm health', async () => {
    await auditEventStormViewport(page, testInfo);
  });

  await test.step('hot attack storm smoothing', async () => {
    await auditHotAttackStormViewport(page, testInfo);
  });

  await page.evaluate(() => window.overlayEventEngine?.resetFrameHealth?.());
  await page.waitForTimeout(900);
  await assertFrameHealth(page, testInfo, 'diagnostic-final-frame', { minSamples: 5 });
  await expectNoPageErrors(errors, testInfo, 'overlay-diagnostics');
});
