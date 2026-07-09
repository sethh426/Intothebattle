import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import jwt from 'jsonwebtoken';

const port = Number(process.env.QA_E2E_PORT || 3537);
const host = '127.0.0.1';
const baseUrl = `http://${host}:${port}`;
const roomId = 'qa-room';
const jwtSecret = 'qa-test-secret';
const e2eSessionToken = 'qa-session-token';
const diskPath = fs.mkdtempSync(path.join(os.tmpdir(), 'intothebattle-qa-'));
const overlayToken = jwt.sign({ purpose: 'overlay', roomId }, jwtSecret, { expiresIn: '1h' });

let server;
let output = '';
let sponsorFixturePath = '';
let sponsorFixtureError = '';

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

async function stopServer() {
  if (!server || server.exitCode !== null) return;
  const exited = new Promise(resolve => server.once('exit', resolve));
  server.kill();
  await Promise.race([
    exited,
    new Promise(resolve => setTimeout(resolve, 2500)),
  ]);
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

async function addAuthCookie(context) {
  await context.addCookies([{ name: 'session_token', value: e2eSessionToken, url: baseUrl }]);
}

async function expectNoHorizontalOverflow(page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(2);
}

async function capture(page, testInfo, name) {
  await page.screenshot({ path: testInfo.outputPath(`${name}.png`), fullPage: true, timeout: 30000 });
}

async function parseJsonResponse(response) {
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch (_err) {
    body = { raw: text };
  }
  expect(response.ok(), text).toBeTruthy();
  return body;
}

function mediaUrl(filename) {
  const params = new URLSearchParams({ room_id: roomId, overlay_token: overlayToken });
  return `${baseUrl}/sponsor/${encodeURIComponent(filename)}?${params.toString()}`;
}

async function readActiveBannerDetails(page, selector = '.banner:not(.closing)') {
  return page.evaluate((wantedSelector) => {
    const banner = document.querySelector(wantedSelector);
    const frame = document.getElementById('overlay-container');
    if (!banner || !frame) return null;
    const bannerRect = banner.getBoundingClientRect();
    const frameRect = frame.getBoundingClientRect();
    const title = banner.querySelector('.banner-title');
    const label = banner.querySelector('[data-testid="command-banner-label"]');
    const commandText = banner.querySelector('[data-testid="command-banner-chip"] strong') || banner.querySelector('.banner-command-run span');
    const ticker = banner.querySelector('[data-testid="command-banner-ticker"]');
    const rail = banner.querySelector('[data-testid="command-banner-rail"]');
    const row = banner.querySelector('[data-testid="command-banner-row"]');
    const titleRect = title?.getBoundingClientRect();
    const labelRect = label?.getBoundingClientRect();
    const commandRect = commandText?.getBoundingClientRect();
    const tickerRect = ticker?.getBoundingClientRect();
    const railRect = rail?.getBoundingClientRect();
    const rowRect = row?.getBoundingClientRect();
    const layout = window.__overlayLegacyLayout || {};
    const bannerStatus = window.overlayEventEngine?.status?.().banner || {};
    const lane = bannerStatus.lane || null;
    const titleStyle = title ? getComputedStyle(title) : null;
    const labelStyle = label ? getComputedStyle(label) : null;
    const commandStyle = commandText ? getComputedStyle(commandText) : null;
    const chips = Array.from(banner.querySelectorAll('[data-testid="command-banner-chip"]'));
    const visibleChips = chips.filter(chip => {
      const style = getComputedStyle(chip);
      const rect = chip.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    });
    return {
      text: (banner.textContent || '').replace(/\s+/g, ' ').trim(),
      bannerCount: document.querySelectorAll(wantedSelector).length,
      tickerCount: banner.querySelectorAll('[data-testid="command-banner-ticker"]').length,
      railCount: banner.querySelectorAll('[data-testid="command-banner-rail"]').length,
      chipCount: chips.length,
      chipTexts: chips.map(chip => (chip.querySelector('strong')?.textContent || '').trim()),
      visibleChipCount: visibleChips.length,
      visibleChipTexts: visibleChips.map(chip => (chip.querySelector('strong')?.textContent || '').trim()),
      clippedChips: visibleChips
        .map(chip => {
          const strong = chip.querySelector('strong');
          return strong && (strong.scrollWidth > strong.clientWidth + 1 || strong.scrollHeight > strong.clientHeight + 1)
            ? (strong.textContent || '').trim()
            : '';
        })
        .filter(Boolean),
      rowCount: banner.querySelectorAll('[data-testid="command-banner-row"]').length,
      kickerCount: banner.querySelectorAll('.banner-kicker').length,
      metaCount: banner.querySelectorAll('.banner-meta').length,
      titleCount: banner.querySelectorAll('.banner-title').length,
      left: bannerRect.left,
      right: bannerRect.right,
      top: bannerRect.top,
      bottom: bannerRect.bottom,
      width: bannerRect.width,
      height: bannerRect.height,
      frameLeft: frameRect.left,
      frameRight: frameRect.right,
      frameTop: frameRect.top,
      frameBottom: frameRect.bottom,
      frameWidth: frameRect.width,
      centerDelta: Math.abs((bannerRect.left + bannerRect.width / 2) - (frameRect.left + frameRect.width / 2)),
      className: banner.className,
      titleHeight: titleRect?.height || 0,
      titleFontSize: titleStyle ? Number.parseFloat(titleStyle.fontSize) : 0,
      titleClipped: title ? title.scrollWidth > title.clientWidth + 1 : false,
      labelHeight: labelRect?.height || 0,
      labelFontSize: labelStyle ? Number.parseFloat(labelStyle.fontSize) : 0,
      labelFontWeight: labelStyle?.fontWeight || '',
      commandHeight: commandRect?.height || 0,
      commandFontSize: commandStyle ? Number.parseFloat(commandStyle.fontSize) : 0,
      commandFontWeight: commandStyle?.fontWeight || '',
      tickerHeight: tickerRect?.height || 0,
      railHeight: railRect?.height || 0,
      rowHeight: rowRect?.height || 0,
      lane,
      laneCenterDelta: lane ? Math.abs((bannerRect.left + bannerRect.width / 2) - (lane.left + lane.width / 2)) : null,
      laneTopDelta: lane ? Math.abs(bannerRect.top - Math.max(lane.top, Math.min(bannerRect.top, lane.bottom - bannerRect.height))) : null,
      bannerCollisions: (layout.collisions || []).filter(item => JSON.stringify(item).toLowerCase().includes('banner')),
    };
  }, selector);
}

async function readSupportUnitDetails(page) {
  return page.evaluate(() => {
    const unit = document.querySelector('[data-testid="support-unit"]');
    const frame = document.getElementById('overlay-container');
    if (!unit || !frame) return null;
    const rect = unit.getBoundingClientRect();
    const frameRect = frame.getBoundingClientRect();
    const style = getComputedStyle(unit);
    const layout = window.__overlayLegacyLayout || {};
    return {
      text: (unit.textContent || '').replace(/\s+/g, ' ').trim(),
      unitCount: document.querySelectorAll('[data-testid="support-unit"]').length,
      visible: style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0,
      healBannerCount: document.querySelectorAll('.banner.heal:not(.closing)').length,
      activeBannerCount: document.querySelectorAll('.banner:not(.closing)').length,
      left: rect.left,
      right: rect.right,
      top: rect.top,
      bottom: rect.bottom,
      width: rect.width,
      height: rect.height,
      frameLeft: frameRect.left,
      frameRight: frameRect.right,
      frameTop: frameRect.top,
      frameBottom: frameRect.bottom,
      frameWidth: frameRect.width,
      centerDelta: Math.abs((rect.left + rect.width / 2) - (frameRect.left + frameRect.width / 2)),
      edge: unit.dataset.edge || '',
      edgeGap: Math.min(rect.left - frameRect.left, frameRect.right - rect.right),
      telemetryChip: layout.supportChip || null,
      supportCollisions: (layout.collisions || []).filter(item => JSON.stringify(item).toLowerCase().includes('support')),
      supportLeaks: (layout.leaks || []).filter(item => JSON.stringify(item).toLowerCase().includes('support')),
    };
  });
}

function makeSponsorFixture() {
  const ffmpegVersion = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' });
  if (ffmpegVersion.status !== 0) {
    sponsorFixtureError = ffmpegVersion.error?.message || 'ffmpeg is not available';
    return;
  }

  const fixture = path.join(diskPath, 'qa-sponsor.webm');
  const result = spawnSync('ffmpeg', [
    '-y',
    '-f', 'lavfi',
    '-i', 'testsrc2=size=640x360:rate=24:duration=1.6',
    '-f', 'lavfi',
    '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',
    '-shortest',
    '-c:v', 'libvpx',
    '-b:v', '900k',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'libopus',
    '-b:a', '64k',
    fixture,
  ], { encoding: 'utf8' });

  if (result.status !== 0 || !fs.existsSync(fixture)) {
    sponsorFixtureError = result.stderr || result.error?.message || 'ffmpeg failed to create fixture';
    return;
  }
  sponsorFixturePath = fixture;
}

test.beforeAll(async () => {
  makeSponsorFixture();
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
      SPONSOR_TRANSCODE_ENABLED: 'true',
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
  await stopServer();
  try { fs.rmSync(diskPath, { recursive: true, force: true }); } catch (_) {}
});

test('dashboard mobile audio manager keeps controls usable at phone widths', async ({ context, page }, testInfo) => {
  await addAuthCookie(context);
  await page.setViewportSize({ width: 393, height: 852 });
  const errors = await watchPage(page);

  await page.goto(`${baseUrl}/dashboard`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByText('IntoTheBattle Command Center')).toBeVisible();
  await page.locator('#audioWorkflow').evaluate(el => { el.open = true; });
  await page.locator('#audioLibrary').evaluate(container => {
    const row = document.createElement('div');
    row.className = 'audio-row';
    row.innerHTML = `
      <div class="audio-name">creator-upload-final-round-sudden-death-super-long-sound-name-that-must-wrap.mp3</div>
      <div class="audio-size">8.4 MB</div>
      <div class="audio-actions">
        <button class="btn btn-secondary" type="button">Play</button>
        <a class="btn btn-secondary" href="/audio/example.mp3" download>Download</a>
      </div>
    `;
    container.replaceChildren(row);
  });

  await expect(page.locator('#audioManagerCard')).toBeVisible();
  await expect(page.locator('#audioVolumeInput')).toBeVisible();
  await expect(page.locator('#audioVolumeInput')).toHaveValue('50');
  await page.locator('#audioVolumeInput').evaluate(input => {
    input.value = '65';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await expect(page.locator('#audioVolumeLabel')).toHaveText('65%');
  await expect(page.locator('#audioLibrary .audio-row')).toBeVisible();
  await expect(page.locator('#audioLibrary .audio-actions .btn')).toHaveCount(2);
  await expectNoHorizontalOverflow(page);

  const badBoxes = await page.evaluate(() => {
    const viewportWidth = document.documentElement.clientWidth;
    return Array.from(document.querySelectorAll('#audioManagerCard .audio-row, #audioManagerCard .btn, #audioManagerCard input[type=range], #audioManagerCard .volume-value')).map(el => {
      const rect = el.getBoundingClientRect();
      return { text: el.textContent.trim(), left: rect.left, right: rect.right, width: rect.width };
    }).filter(box => box.left < -1 || box.right > viewportWidth + 1 || box.width < 24);
  });
  expect(badBoxes).toEqual([]);
  await capture(page, testInfo, 'qa-dashboard-mobile-audio');
  expect(errors).toEqual([]);
});

test('v1 overlay banner stays centered, bounded, and readable', async ({ page }, testInfo) => {
  const errors = await watchPage(page);
  const params = new URLSearchParams({
    room_id: roomId,
    overlay_token: overlayToken,
    demo: '1',
    banner_preview: '1',
    banner_title: 'NeonAce eliminated ShadowByte',
    banner_meta: '7 total kills | streak x5 | momentum x4',
    banner_duration: '5200',
  });
  await page.goto(`${baseUrl}/overlay?${params.toString()}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__overlayLegacyLayout?.players?.length >= 5, null, { timeout: 7000 });
  await page.waitForFunction(() => {
    const banner = Array.from(document.querySelectorAll('.banner'))
      .find(el => /NEONACE/i.test(el.textContent || '') && !el.classList.contains('closing'));
    if (!banner) return false;
    const rect = banner.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && getComputedStyle(banner).visibility !== 'hidden';
  }, null, { timeout: 5000 });
  await page.waitForTimeout(300);

  const geometry = await page.evaluate(() => {
    const el = Array.from(document.querySelectorAll('.banner'))
      .find(node => /NEONACE/i.test(node.textContent || '') && !node.classList.contains('closing'));
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    const title = el.querySelector('.banner-title')?.getBoundingClientRect();
    const meta = el.querySelector('.banner-meta')?.getBoundingClientRect();
    return {
      className: el.className,
      left: rect.left,
      right: rect.right,
      top: rect.top,
      bottom: rect.bottom,
      width: rect.width,
      height: rect.height,
      centerDelta: Math.abs((rect.left + rect.width / 2) - viewport.width / 2),
      viewport,
      titleHeight: title?.height || 0,
      metaHeight: meta?.height || 0,
    };
  });

  expect(geometry).toBeTruthy();
  expect(geometry.left).toBeGreaterThanOrEqual(0);
  expect(geometry.right).toBeLessThanOrEqual(geometry.viewport.width);
  expect(geometry.top).toBeGreaterThanOrEqual(0);
  expect(geometry.bottom).toBeLessThanOrEqual(geometry.viewport.height);
  expect(geometry.width).toBeGreaterThanOrEqual(Math.min(240, geometry.viewport.width * 0.6));
  expect(geometry.width).toBeLessThanOrEqual(geometry.viewport.width * 0.92);
  const nanoBanner = geometry.className.includes('is-nano');
  const smallBanner = nanoBanner || geometry.height < 44;
  if (smallBanner) {
    expect(geometry.height).toBeGreaterThanOrEqual(26);
    expect(geometry.height).toBeLessThanOrEqual(36);
    if (nanoBanner) {
      expect(geometry.metaHeight).toBe(0);
    } else {
      expect(geometry.metaHeight).toBeGreaterThan(4);
      expect(geometry.metaHeight).toBeLessThanOrEqual(10);
    }
  } else {
    expect(geometry.height).toBeGreaterThanOrEqual(42);
    expect(geometry.metaHeight).toBeGreaterThan(7);
  }
  expect(geometry.centerDelta).toBeLessThanOrEqual(Math.max(18, geometry.viewport.width * 0.035));
  expect(geometry.titleHeight).toBeGreaterThan(12);

  await expectNoHorizontalOverflow(page);
  await capture(page, testInfo, 'qa-overlay-v1-banner');
  expect(errors).toEqual([]);
});

test('all rich banner types stay centered, readable, and collision-free', async ({ page }, testInfo) => {
  const errors = await watchPage(page);
  const params = new URLSearchParams({
    room_id: roomId,
    overlay_token: overlayToken,
    demo: '1',
    debug: '1',
    controls: '0',
    demo_autoplay: '0',
  });
  await page.goto(`${baseUrl}/overlay?${params.toString()}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__overlayLegacyLayout?.players?.length >= 5, null, { timeout: 7000 });
  await page.waitForFunction(() => typeof window.overlayEventEngine?.testBannerPlacement === 'function', null, { timeout: 5000 });

  for (const type of ['kill', 'streak', 'gift', 'special', 'follow', 'heal', 'legendary', 'commands']) {
    await page.evaluate((bannerType) => window.overlayEventEngine.testBannerPlacement(bannerType, { durationMs: 12000 }), type);
    await page.waitForFunction((bannerType) => {
      const banner = document.querySelector(`.banner.${bannerType}:not(.closing)`);
      return Boolean(banner && banner.getBoundingClientRect().width > 0 && getComputedStyle(banner).visibility !== 'hidden');
    }, type, { timeout: 5000 });
    await page.waitForTimeout(180);

    const details = await readActiveBannerDetails(page, `.banner.${type}:not(.closing)`);
    expect(details, `${type} banner details`).toBeTruthy();
    expect(details.bannerCount, `${type} banner count`).toBe(1);
    expect(details.left, `${type} left frame bound`).toBeGreaterThanOrEqual(details.frameLeft - 1);
    expect(details.right, `${type} right frame bound`).toBeLessThanOrEqual(details.frameRight + 1);
    expect(details.top, `${type} top frame bound`).toBeGreaterThanOrEqual(details.frameTop - 1);
    expect(details.bottom, `${type} bottom frame bound`).toBeLessThanOrEqual(details.frameBottom + 1);
    expect(details.centerDelta, `${type} center delta`).toBeLessThanOrEqual(Math.max(18, details.frameWidth * 0.045));
    expect(details.lane, `${type} banner lane telemetry`).toBeTruthy();
    expect(details.left, `${type} lane left bound`).toBeGreaterThanOrEqual(details.lane.left - 2);
    expect(details.right, `${type} lane right bound`).toBeLessThanOrEqual(details.lane.right + 2);
    expect(details.top, `${type} lane top bound`).toBeGreaterThanOrEqual(details.lane.top - 3);
    expect(details.bottom, `${type} lane bottom bound`).toBeLessThanOrEqual(details.lane.bottom + 3);
    expect(details.laneCenterDelta, `${type} lane center delta`).toBeLessThanOrEqual(Math.max(4, details.lane.width * 0.015));
    expect(details.bannerCollisions, `${type} collisions: ${JSON.stringify(details, null, 2)}`).toEqual([]);

    if (type === 'commands') {
      const compactVisibleCommands = ['engage', '@name', '!attack @name', '!attack @horde', '!attack @boss', '!shield', '!heal @name', '!commands'];
      const microVisibleCommands = ['engage', '@name', '!attack @horde', '!attack @boss', '!shield', '!commands'];
      const expectedVisibleCommands = details.className.includes('is-nano')
        ? ['engage', '@name', '!shield', '!commands']
        : details.className.includes('is-micro')
          ? microVisibleCommands
          : details.className.includes('is-compact')
            ? compactVisibleCommands
            : ['engage', '@name', 'chat', '!attack @name', '!attack @horde', '!attack @boss', '!shield', '!heal @name', '!commands'];
      expect(details.rowCount, 'command row count').toBe(1);
      expect(details.railCount, 'command rail count').toBe(1);
      expect(details.tickerCount, 'command ticker count').toBe(0);
      expect(details.chipCount, 'command chip count').toBeGreaterThanOrEqual(9);
      expect(details.visibleChipTexts, 'visible command chips').toEqual(expectedVisibleCommands);
      expect(details.clippedChips, 'command chip clipping').toEqual([]);
      expect(details.kickerCount, 'command kicker rows').toBe(0);
      expect(details.metaCount, 'command meta rows').toBe(0);
      expect(details.titleCount, 'command title rows').toBe(0);
      expect(details.labelHeight, 'command label readable height').toBeGreaterThan(10);
      expect(details.commandHeight, 'command text readable height').toBeGreaterThan(10);
      expect(details.commandFontSize, 'command chip font size').toBeGreaterThanOrEqual(8);
    } else {
      expect(details.titleCount, `${type} title row`).toBe(1);
      expect(details.titleHeight, `${type} title readable height`).toBeGreaterThan(12);
      expect(details.titleFontSize, `${type} title stream font`).toBeGreaterThanOrEqual(13);
      expect(details.titleClipped, `${type} title clipping`).toBe(false);
    }
  }

  await expectNoHorizontalOverflow(page);
  await capture(page, testInfo, 'qa-overlay-all-banner-types-readable');
  expect(errors).toEqual([]);
});

test('command banner shows one static viewer command rail', async ({ context, page }, testInfo) => {
  await addAuthCookie(context);
  const errors = await watchPage(page);
  const params = new URLSearchParams({
    room_id: roomId,
    overlay_token: overlayToken,
    mode: 'live',
    controls: '0',
    debug: '1',
  });
  await page.goto(`${baseUrl}/overlay?${params.toString()}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => Boolean(window.__overlayLegacyLayout?.frame), null, { timeout: 7000 });

  await expect.poll(async () => {
    const response = await context.request.get(`${baseUrl}/api/status`);
    if (!response.ok()) return false;
    const body = await response.json();
    return Boolean(body.overlayConnected);
  }, { timeout: 8000 }).toBe(true);

  const testEvent = await context.request.post(`${baseUrl}/api/overlay/test/attack`);
  const testEventBody = await parseJsonResponse(testEvent);
  expect(testEventBody.success).toBe(true);
  await page.waitForFunction(() => window.__overlayLegacyLayout?.players?.length >= 3, null, { timeout: 7000 });

  const response = await context.request.post(`${baseUrl}/api/overlay/command-banners`);
  const result = await parseJsonResponse(response);
  expect(result.banners).toBe(1);
  expect(result.overlayConnected).toBe(true);

  await page.waitForFunction(() => {
    const banners = Array.from(document.querySelectorAll('.banner.commands:not(.closing)'));
    return banners.length === 1 && Boolean(banners[0].querySelector('[data-testid="command-banner-rail"]'));
  }, null, { timeout: 7000 });
  await page.waitForTimeout(350);

  const details = await readActiveBannerDetails(page, '.banner.commands:not(.closing)');

  expect(details).toBeTruthy();
  expect(details.bannerCount).toBe(1);
  expect(details.rowCount).toBe(1);
  expect(details.railCount).toBe(1);
  expect(details.tickerCount).toBe(0);
  expect(details.chipCount).toBe(9);
  expect(details.kickerCount).toBe(0);
  expect(details.metaCount).toBe(0);
  expect(details.titleCount).toBe(0);
  const expectedCommands = ['engage', '@name', 'chat', '!attack @name', '!attack @horde', '!attack @boss', '!shield', '!heal @name', '!commands'];
  const compactVisibleCommands = ['engage', '@name', '!attack @name', '!attack @horde', '!attack @boss', '!shield', '!heal @name', '!commands'];
  const microVisibleCommands = ['engage', '@name', '!attack @horde', '!attack @boss', '!shield', '!commands'];
  const expectedVisibleCommands = details.className.includes('is-nano')
    ? ['engage', '@name', '!shield', '!commands']
    : details.className.includes('is-micro')
      ? microVisibleCommands
      : details.className.includes('is-compact')
        ? compactVisibleCommands
        : expectedCommands;
  for (const text of ['PLAY BY ENGAGING', ...expectedCommands]) {
    expect(details.text).toContain(text);
  }
  expect(details.chipTexts).toEqual(expectedCommands);
  expect(details.visibleChipTexts).toEqual(expectedVisibleCommands);
  expect(details.clippedChips).toEqual([]);
  expect(details.text).not.toContain('CHAT COMMANDS');
  expect(details.text).not.toContain('Type these in TikTok chat');
  expect(details.text).not.toContain('Basic attacks:');
  expect(details.text).not.toContain('Effects:');
  expect(details.left).toBeGreaterThanOrEqual(details.frameLeft - 1);
  expect(details.right).toBeLessThanOrEqual(details.frameRight + 1);
  expect(details.top).toBeGreaterThanOrEqual(details.frameTop - 1);
  expect(details.bottom).toBeLessThanOrEqual(details.frameBottom + 1);
  expect(details.lane).toBeTruthy();
  expect(details.left).toBeGreaterThanOrEqual(details.lane.left - 2);
  expect(details.right).toBeLessThanOrEqual(details.lane.right + 2);
  expect(details.top).toBeGreaterThanOrEqual(details.lane.top - 3);
  expect(details.bottom).toBeLessThanOrEqual(details.lane.bottom + 3);
  expect(details.laneCenterDelta).toBeLessThanOrEqual(Math.max(4, details.lane.width * 0.015));
  expect(details.labelHeight).toBeGreaterThan(10);
  expect(details.commandHeight).toBeGreaterThan(10);
  expect(details.railHeight).toBeGreaterThan(20);
  expect(details.rowHeight).toBeGreaterThan(24);
  expect(details.commandFontSize).toBeGreaterThanOrEqual(8);
  expect(details.bannerCollisions, JSON.stringify(details, null, 2)).toEqual([]);

  await expectNoHorizontalOverflow(page);
  await capture(page, testInfo, 'qa-overlay-command-banner-rail');
  expect(errors).toEqual([]);
});

test('like heal support feedback uses one compact unit', async ({ page }, testInfo) => {
  const errors = await watchPage(page);
  const params = new URLSearchParams({
    room_id: roomId,
    overlay_token: overlayToken,
    demo: '1',
    debug: '1',
    controls: '0',
    demo_autoplay: '0',
  });
  await page.goto(`${baseUrl}/overlay?${params.toString()}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__overlayLegacyLayout?.players?.length >= 5, null, { timeout: 7000 });
  await page.waitForFunction(() => typeof window.overlayEventEngine?.testSupportUnit === 'function', null, { timeout: 5000 });

  const probe = await page.evaluate(() => window.overlayEventEngine.testSupportUnit());
  expect(probe.visible).toBe(true);
  await page.waitForFunction(() => {
    const unit = document.querySelector('[data-testid="support-unit"]');
    return Boolean(unit && getComputedStyle(unit).visibility !== 'hidden' && unit.getBoundingClientRect().width > 0);
  }, null, { timeout: 5000 });
  await page.waitForTimeout(250);

  const details = await readSupportUnitDetails(page);
  expect(details).toBeTruthy();
  expect(details.unitCount).toBe(1);
  expect(details.visible).toBe(true);
  expect(details.text).not.toContain('SUPPORT');
  expect(details.text).toMatch(/\+3 Likes/i);
  expect(details.text).toMatch(/\+25 HP/i);
  expect(details.text).toMatch(/Shield/i);
  expect(details.healBannerCount).toBe(0);
  expect(details.left).toBeGreaterThanOrEqual(details.frameLeft - 1);
  expect(details.right).toBeLessThanOrEqual(details.frameRight + 1);
  expect(details.top).toBeGreaterThanOrEqual(details.frameTop - 1);
  expect(details.bottom).toBeLessThanOrEqual(details.frameBottom + 1);
  expect(details.width).toBeLessThanOrEqual(Math.max(150, details.frameWidth * 0.3));
  expect(details.centerDelta).toBeGreaterThanOrEqual(details.frameWidth * 0.2);
  expect(details.edge).toMatch(/^top-(left|right)$/);
  expect(details.edgeGap).toBeLessThanOrEqual(Math.max(26, details.frameWidth * 0.045));
  expect(details.telemetryChip, JSON.stringify(details, null, 2)).toBeTruthy();
  expect(details.supportCollisions, JSON.stringify(details, null, 2)).toEqual([]);
  expect(details.supportLeaks, JSON.stringify(details, null, 2)).toEqual([]);

  await expectNoHorizontalOverflow(page);
  await capture(page, testInfo, 'qa-overlay-support-unit');
  expect(errors).toEqual([]);
});

test('critical v1 pages pass automated accessibility checks', async ({ context, page }) => {
  await addAuthCookie(context);

  for (const [name, pathname, readySelector] of [
    ['dashboard', '/dashboard', '#nextActionPanel'],
    ['paywall', '/paywall', 'body'],
    ['v1 overlay', `/overlay?room_id=${roomId}&overlay_token=${encodeURIComponent(overlayToken)}&demo=1`, 'canvas'],
  ]) {
    await page.goto(`${baseUrl}${pathname}`, { waitUntil: 'domcontentloaded' });
    await expect(page.locator(readySelector).first()).toBeVisible();
    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
    const seriousViolations = results.violations
      .filter(violation => ['serious', 'critical'].includes(violation.impact))
      .map(violation => ({
        page: name,
        id: violation.id,
        impact: violation.impact,
        targets: violation.nodes.slice(0, 4).map(node => node.target.join(' ')),
      }));
    expect(seriousViolations, JSON.stringify(seriousViolations, null, 2)).toEqual([]);
  }
});

test('creator pro sponsor video upload, serving, and v1 overlay playback work together', async ({ context, page }, testInfo) => {
  test.skip(testInfo.project.name.includes('mobile'), 'media pipeline is covered once in the desktop project');
  test.skip(!sponsorFixturePath, sponsorFixtureError || 'missing sponsor video fixture');

  await addAuthCookie(context);
  const errors = await watchPage(page);
  const uploadResponse = await context.request.post(`${baseUrl}/api/sponsor/upload`, {
    multipart: {
      sponsor: {
        name: 'qa-sponsor.webm',
        mimeType: 'video/webm',
        buffer: fs.readFileSync(sponsorFixturePath),
      },
      partner: 'QA Brand',
      title: 'QA Sponsor Moment',
      subtitle: 'Automated media pipeline check',
    },
  });
  const upload = await parseJsonResponse(uploadResponse);
  expect(upload.success).toBe(true);
  expect(upload.file?.filename).toMatch(/-normalized\.mp4$/);
  expect(upload.file?.originalName).toBe('qa-sponsor.webm');
  expect(upload.file?.mimeType).toBe('video/mp4');
  expect(upload.file?.normalized).toBe(true);
  expect(upload.file?.processingStatus).toBe('normalized');
  expect(upload.file?.readinessStatus).toBe('ready');
  const filename = upload.file.filename;

  const libraryResponse = await context.request.get(`${baseUrl}/api/sponsors`);
  const library = await parseJsonResponse(libraryResponse);
  expect(library.library.some(file => file.filename === filename)).toBe(true);

  const rangeResponse = await context.request.get(mediaUrl(filename), { headers: { Range: 'bytes=0-7' } });
  expect(rangeResponse.status()).toBe(206);
  expect(rangeResponse.headers()['accept-ranges']).toBe('bytes');
  expect(rangeResponse.headers()['content-range']).toMatch(/^bytes 0-7\/\d+$/);
  expect((await rangeResponse.body()).length).toBe(8);

  const fullMediaResponse = await context.request.get(mediaUrl(filename));
  expect(fullMediaResponse.status()).toBe(200);
  expect(fullMediaResponse.headers()['content-type']).toContain('video/mp4');
  const etag = fullMediaResponse.headers().etag;
  expect(etag).toBeTruthy();
  const cachedMediaResponse = await context.request.get(mediaUrl(filename), { headers: { 'If-None-Match': etag } });
  expect(cachedMediaResponse.status()).toBe(304);

  const params = new URLSearchParams({ room_id: roomId, overlay_token: overlayToken });
  await page.goto(`${baseUrl}/overlay?${params.toString()}`, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('canvas')).toBeVisible();
  await expect.poll(async () => {
    const res = await context.request.get(`${baseUrl}/api/status`);
    const body = await res.json();
    return body.overlayCount || 0;
  }, { timeout: 8000 }).toBeGreaterThan(0);
  await expect.poll(async () => page.evaluate(() => window.overlayEventEngine?.status?.().connection?.state || ''), {
    timeout: 8000,
  }).toBe('registered');
  const connectionStatus = await page.evaluate(() => window.overlayEventEngine?.status?.().connection || null);
  expect(connectionStatus).toMatchObject({
    mode: 'signed',
    ready: true,
    connected: true,
    registered: true,
    hasOverlayToken: true,
  });
  expect(connectionStatus).not.toHaveProperty('overlayToken');

  const playResponse = await context.request.post(`${baseUrl}/api/sponsor/play`, {
    data: {
      filename,
      partner: 'QA Brand',
      title: 'QA Sponsor Moment',
      subtitle: 'Automated media pipeline check',
      timingProfile: 'full',
      durationMs: 6000,
      muted: true,
      fit: 'contain',
      statsMode: 'endcap',
    },
  });
  const play = await parseJsonResponse(playResponse);
  expect(play.success).toBe(true);
  expect(play.status).toBe('preparing');
  expect(play.scene?.filename).toBe(filename);
  expect(play.scene?.videoUrl).toContain(encodeURIComponent(filename));

  await page.waitForFunction(() => {
    const scene = document.querySelector('#sponsorScene');
    return scene?.classList.contains('active') && document.body.classList.contains('sponsor-active');
  }, null, { timeout: 12000 });
  try {
    await page.waitForFunction(() => document.querySelector('#sponsorTitle')?.textContent?.includes('QA Sponsor Moment'), null, { timeout: 12000 });
  } catch (err) {
    const overlayDiagnostics = await page.evaluate(() => {
      const scene = document.querySelector('#sponsorScene');
      const video = document.querySelector('#sponsorVideo');
      return {
        bodySponsorActive: document.body.classList.contains('sponsor-active'),
        sponsorState: window.overlaySponsorScene?.state?.() || null,
        sceneClass: scene?.className || '',
        title: document.querySelector('#sponsorTitle')?.textContent || '',
        subtitle: document.querySelector('#sponsorSubtitle')?.textContent || '',
        mediaStatus: document.querySelector('#sponsorMediaStatus')?.textContent || '',
        video: video ? {
          currentSrc: video.currentSrc || video.src || '',
          readyState: video.readyState,
          networkState: video.networkState,
          error: video.error?.code || null,
          paused: video.paused,
          ended: video.ended,
          currentTime: video.currentTime,
          duration: Number.isFinite(video.duration) ? video.duration : null,
          videoWidth: video.videoWidth,
          videoHeight: video.videoHeight,
        } : null,
        eventEngine: window.overlayEventEngine?.status?.() || null,
      };
    });
    const libraryAfterFailure = await parseJsonResponse(await context.request.get(`${baseUrl}/api/sponsors`));
    throw new Error(`Sponsor overlay did not reach live title: ${err.message}\n${JSON.stringify({ overlayDiagnostics, libraryAfterFailure, play, errors }, null, 2)}`);
  }
  await expect(page.locator('#sponsorScene')).toBeVisible();
  await expect(page.locator('#sponsorTitle')).toContainText('QA Sponsor Moment');
  await expect(page.locator('#sponsorSubtitle')).toContainText('Automated media pipeline check');

  const playback = await page.locator('#sponsorVideo').evaluate(video => ({
    src: video.currentSrc || video.src,
    readyState: video.readyState,
    muted: video.muted,
    width: video.videoWidth,
    height: video.videoHeight,
  }));
  expect(playback.src).toContain(encodeURIComponent(filename));
  expect(playback.readyState).toBeGreaterThanOrEqual(2);
  expect(playback.muted).toBe(true);
  expect(playback.width).toBeGreaterThan(0);
  expect(playback.height).toBeGreaterThan(0);

  await page.waitForFunction(() => document.querySelector('#sponsorScene')?.classList.contains('stats-visible'), null, { timeout: 10000 });
  const visual = await page.evaluate(() => {
    function visibleBox(selector) {
      const el = document.querySelector(selector);
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return {
        selector,
        display: style.display,
        visibility: style.visibility,
        opacity: Number(style.opacity),
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height,
        text: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 90),
      };
    }
    const scene = document.querySelector('#sponsorScene');
    const video = document.querySelector('#sponsorVideo');
    const poster = document.querySelector('#sponsorPoster');
    const sceneRect = scene?.getBoundingClientRect();
    const videoRect = video?.getBoundingClientRect();
    const boxes = [
      '#sponsorTitle',
      '#sponsorSubtitle',
      '#sponsorLiveStats',
      '.sponsor-stats-head',
      '.sponsor-stat',
      '.sponsor-stat-value',
      '.sponsor-stat-sub',
    ].flatMap(selector => Array.from(document.querySelectorAll(selector)).map(el => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return {
        selector,
        display: style.display,
        visibility: style.visibility,
        opacity: Number(style.opacity),
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height,
        text: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 90),
      };
    })).filter(box => box.display !== 'none' && box.visibility !== 'hidden' && box.opacity > 0.05 && box.width > 0 && box.height > 0);
    const outside = sceneRect ? boxes.filter(box => (
      box.left < sceneRect.left - 1 ||
      box.right > sceneRect.right + 1 ||
      box.top < sceneRect.top - 1 ||
      box.bottom > sceneRect.bottom + 1
    )) : boxes;
    return {
      sceneClass: scene?.className || '',
      sceneFit: scene?.dataset?.videoFit || '',
      videoObjectFit: video ? getComputedStyle(video).objectFit : '',
      videoInsideScene: Boolean(sceneRect && videoRect && (() => {
        const tolerance = Math.max(24, Math.max(sceneRect.width, sceneRect.height) * 0.04);
        return videoRect.left >= sceneRect.left - tolerance &&
          videoRect.right <= sceneRect.right + tolerance &&
          videoRect.top >= sceneRect.top - tolerance &&
          videoRect.bottom <= sceneRect.bottom + tolerance;
      })()),
      videoBox: videoRect ? { width: videoRect.width, height: videoRect.height } : null,
      posterBox: visibleBox('#sponsorPoster'),
      statsVisible: scene?.classList.contains('stats-visible') || false,
      outside,
    };
  });
  expect(visual.sceneClass).toContain('active');
  expect(visual.sceneClass).toContain('contain');
  expect(visual.sceneFit).toBe('contain');
  expect(visual.videoInsideScene).toBe(true);
  expect(visual.videoBox?.width).toBeGreaterThan(100);
  expect(visual.videoBox?.height).toBeGreaterThan(50);
  expect(visual.posterBox).toBeTruthy();
  expect(visual.statsVisible).toBe(true);
  expect(visual.outside).toEqual([]);

  await expectNoHorizontalOverflow(page);
  await capture(page, testInfo, 'qa-sponsor-video-playback');
  await context.request.post(`${baseUrl}/api/sponsor/stop`);
  expect(errors).toEqual([]);
});
