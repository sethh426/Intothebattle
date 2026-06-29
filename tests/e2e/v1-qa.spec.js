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
      SPONSOR_TRANSCODE_ENABLED: 'false',
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
  await expect(page.locator('#audioLibrary .audio-row')).toBeVisible();
  await expect(page.locator('#audioLibrary .audio-actions .btn')).toHaveCount(2);
  await expectNoHorizontalOverflow(page);

  const badBoxes = await page.evaluate(() => {
    const viewportWidth = document.documentElement.clientWidth;
    return Array.from(document.querySelectorAll('#audioManagerCard .audio-row, #audioManagerCard .btn')).map(el => {
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
  const banner = page.locator('.banner', { hasText: 'NEONACE' }).last();
  await expect(banner).toBeVisible({ timeout: 5000 });
  await page.waitForTimeout(700);

  const geometry = await banner.evaluate(el => {
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

  expect(geometry.left).toBeGreaterThanOrEqual(0);
  expect(geometry.right).toBeLessThanOrEqual(geometry.viewport.width);
  expect(geometry.top).toBeGreaterThanOrEqual(0);
  expect(geometry.bottom).toBeLessThanOrEqual(geometry.viewport.height);
  expect(geometry.width).toBeGreaterThanOrEqual(Math.min(240, geometry.viewport.width * 0.6));
  expect(geometry.width).toBeLessThanOrEqual(geometry.viewport.width * 0.86);
  if (geometry.className.includes('is-nano')) {
    expect(geometry.height).toBeGreaterThanOrEqual(28);
    expect(geometry.height).toBeLessThanOrEqual(36);
    expect(geometry.metaHeight).toBe(0);
  } else {
    expect(geometry.height).toBeGreaterThanOrEqual(44);
    expect(geometry.metaHeight).toBeGreaterThan(6);
  }
  expect(geometry.centerDelta).toBeLessThanOrEqual(Math.max(18, geometry.viewport.width * 0.035));
  expect(geometry.titleHeight).toBeGreaterThan(9);

  await expectNoHorizontalOverflow(page);
  await capture(page, testInfo, 'qa-overlay-v1-banner');
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
  expect(upload.file?.filename).toMatch(/\.webm$/);
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
  expect(fullMediaResponse.headers()['content-type']).toContain('video/webm');
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

  await expectNoHorizontalOverflow(page);
  await capture(page, testInfo, 'qa-sponsor-video-playback');
  await context.request.post(`${baseUrl}/api/sponsor/stop`);
  expect(errors).toEqual([]);
});
