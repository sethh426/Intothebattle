import { expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import jwt from 'jsonwebtoken';

export function createServerHarness(options = {}) {
  const port = Number(options.port || process.env.E2E_PORT || 3557);
  const host = options.host || '127.0.0.1';
  const baseUrl = `http://${host}:${port}`;
  const roomId = options.roomId || 'playwright-gate-room';
  const jwtSecret = options.jwtSecret || 'playwright-gate-secret';
  const e2eSessionToken = options.e2eSessionToken || 'playwright-gate-session';
  const diskPath = fs.mkdtempSync(path.join(os.tmpdir(), options.diskPrefix || 'intothebattle-playwright-gate-'));
  const overlayToken = jwt.sign({ purpose: 'overlay', roomId }, jwtSecret, { expiresIn: '1h' });
  let server = null;
  let output = '';

  async function request(pathname, requestOptions = {}) {
    return fetch(`${baseUrl}${pathname}`, { redirect: 'manual', ...requestOptions });
  }

  async function waitForHealth() {
    const deadline = Date.now() + Number(options.healthTimeoutMs || process.env.E2E_HEALTH_TIMEOUT_MS || 60000);
    while (Date.now() < deadline) {
      if (server?.exitCode !== null) {
        throw new Error(`server exited early with code ${server.exitCode}\n${output}`);
      }
      try {
        const res = await request('/healthz');
        if (res.status === 200) return;
      } catch (_) {}
      await new Promise(resolve => setTimeout(resolve, 400));
    }
    throw new Error(`server did not become healthy\n${output}`);
  }

  async function start() {
    if (server && server.exitCode === null && !server.killed) return;
    server = null;
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
        ...options.env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    server.stdout.on('data', chunk => { output += chunk.toString(); });
    server.stderr.on('data', chunk => { output += chunk.toString(); });
    await waitForHealth();
  }

  async function stop() {
    if (server && server.exitCode === null && !server.killed) {
      const exited = new Promise(resolve => server.once('exit', resolve));
      server.kill();
      await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 2500))]);
    }
    try { fs.rmSync(diskPath, { recursive: true, force: true }); } catch (_) {}
  }

  return {
    baseUrl,
    roomId,
    overlayToken,
    e2eSessionToken,
    diskPath,
    request,
    start,
    stop,
    output: () => output,
  };
}

export async function addAuthCookie(context, harness) {
  await context.addCookies([{ name: 'session_token', value: harness.e2eSessionToken, url: harness.baseUrl }]);
}

export async function parseJsonResponse(response) {
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch (_) {
    body = { raw: text };
  }
  expect(response.ok(), text).toBeTruthy();
  return body;
}

export async function watchPage(page, baseUrl, options = {}) {
  const errors = [];
  const ignoreConsole = options.ignoreConsole || [/Failed to load resource: net::ERR_NETWORK_CHANGED\b/];
  const ignoreRequestFailure = options.ignoreRequestFailure || [
    /\.(?:mp4|webm|m4a|mp3)(?:\?| |\b).*net::ERR_ABORTED\b/i,
  ];
  page.on('pageerror', err => errors.push(`pageerror: ${err.message}`));
  page.on('console', msg => {
    const text = msg.text();
    if (msg.type() === 'error' && !ignoreConsole.some(pattern => pattern.test(text))) {
      errors.push(`console error: ${text}`);
    }
  });
  page.on('requestfailed', req => {
    try {
      if (new URL(req.url()).origin === baseUrl) {
        const text = `request failed: ${req.method()} ${req.url()} ${req.failure()?.errorText || ''}`;
        if (!ignoreRequestFailure.some(pattern => pattern.test(text))) errors.push(text);
      }
    } catch (_) {}
  });
  return errors;
}

export async function expectNoPageErrors(errors, testInfo, label = 'page') {
  if (errors.length) {
    await attachJson(testInfo, `${label}-errors`, errors);
  }
  expect(errors).toEqual([]);
}

export async function expectNoHorizontalOverflow(page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(2);
}

export async function attachJson(testInfo, name, value) {
  await testInfo.attach(`${name}.json`, {
    body: JSON.stringify(value, null, 2),
    contentType: 'application/json',
  });
}

export async function attachScreenshot(page, testInfo, name, options = {}) {
  const screenshot = await page.screenshot({ fullPage: true, timeout: 30000, ...options });
  await testInfo.attach(`${name}.png`, { body: screenshot, contentType: 'image/png' });
  return screenshot;
}

export async function expectStableScreenshot(pageOrLocator, testInfo, name, options = {}) {
  const assertSnapshots = process.env.PLAYWRIGHT_SNAPSHOT_ASSERT !== '0';
  if (assertSnapshots) {
    await expect(pageOrLocator).toHaveScreenshot(`${name}.png`, {
      animations: 'disabled',
      caret: 'hide',
      maxDiffPixelRatio: options.maxDiffPixelRatio ?? 0.08,
      threshold: options.threshold ?? 0.2,
      mask: options.mask || [],
      timeout: options.timeout || 10000,
    });
    return;
  }
  const screenshot = await pageOrLocator.screenshot({ animations: 'disabled', timeout: 30000 });
  await testInfo.attach(`${name}.png`, { body: screenshot, contentType: 'image/png' });
}

export async function freezeOverlayVisuals(page, testInfo, label = 'overlay-freeze') {
  const result = await page.evaluate(() => {
    if (typeof window.overlayEventEngine?.freezeVisuals !== 'function') {
      return { available: false, layout: window.__overlayLegacyLayout || null };
    }
    return { available: true, ...window.overlayEventEngine.freezeVisuals() };
  });
  await attachJson(testInfo, label, result);
  expect(result.available, 'overlay freeze hook missing').toBe(true);
  return result;
}

export async function expectCanvasQuality(page, testInfo, selector = 'canvas', options = {}) {
  const metrics = await page.locator(selector).first().evaluate(canvas => {
    const context = canvas.getContext('2d');
    if (!context || canvas.width <= 0 || canvas.height <= 0) return null;
    const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const pixelCount = canvas.width * canvas.height;
    const pixelStep = Math.max(1, Math.floor(pixelCount / 16000));
    const buckets = new Set();
    let samples = 0;
    let opaque = 0;
    let lit = 0;
    let bright = 0;
    let minLum = 255;
    let maxLum = 0;
    let edgeSamples = 0;
    let edges = 0;

    function lumAt(pixelIndex) {
      const offset = pixelIndex * 4;
      return (data[offset] * 0.2126) + (data[offset + 1] * 0.7152) + (data[offset + 2] * 0.0722);
    }

    for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex += pixelStep) {
      const offset = pixelIndex * 4;
      const r = data[offset];
      const g = data[offset + 1];
      const b = data[offset + 2];
      const a = data[offset + 3];
      const lum = (r * 0.2126) + (g * 0.7152) + (b * 0.0722);
      samples += 1;
      if (a > 16) opaque += 1;
      if (r + g + b > 45) lit += 1;
      if (Math.max(r, g, b) > 85) bright += 1;
      minLum = Math.min(minLum, lum);
      maxLum = Math.max(maxLum, lum);
      buckets.add(`${r >> 4},${g >> 4},${b >> 4},${a >> 5}`);
      const rightPixel = pixelIndex + 1;
      const lowerPixel = pixelIndex + canvas.width;
      if ((pixelIndex % canvas.width) < canvas.width - 1 && lowerPixel < pixelCount) {
        const edge = Math.abs(lum - lumAt(rightPixel)) + Math.abs(lum - lumAt(lowerPixel));
        edgeSamples += 1;
        if (edge > 42) edges += 1;
      }
    }

    return {
      width: canvas.width,
      height: canvas.height,
      samples,
      opaqueRatio: opaque / Math.max(1, samples),
      litRatio: lit / Math.max(1, samples),
      brightRatio: bright / Math.max(1, samples),
      colorBuckets: buckets.size,
      contrast: maxLum - minLum,
      edgeRatio: edges / Math.max(1, edgeSamples),
    };
  });

  await attachJson(testInfo, options.name || 'canvas-quality', metrics);
  expect(metrics, 'canvas metrics unavailable').toBeTruthy();
  expect(metrics.opaqueRatio).toBeGreaterThan(options.minOpaqueRatio ?? 0.82);
  expect(metrics.litRatio).toBeGreaterThan(options.minLitRatio ?? 0.08);
  expect(metrics.brightRatio).toBeGreaterThan(options.minBrightRatio ?? 0.004);
  expect(metrics.colorBuckets).toBeGreaterThanOrEqual(options.minColorBuckets ?? 8);
  expect(metrics.contrast).toBeGreaterThan(options.minContrast ?? 30);
  expect(metrics.edgeRatio).toBeGreaterThan(options.minEdgeRatio ?? 0.004);
  return metrics;
}

export async function readLegacyLayout(page, testInfo, label = 'legacy-layout') {
  const layout = await page.evaluate(() => window.__overlayLegacyLayout || null);
  await attachJson(testInfo, label, layout);
  expect(layout?.frame, `${label} missing frame`).toBeTruthy();
  expect(layout.leaks || []).toEqual([]);
  expect(layout.collisions || []).toEqual([]);
  expect(layout.domLayerLeaks || []).toEqual([]);
  return layout;
}

export async function expectVideoAssetQuality(page, testInfo, url, options = {}) {
  const result = await page.evaluate(async ({ src, sampleTimes, minWidth, minHeight }) => {
    function waitFor(target, event, timeoutMs = 8000) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${event}`)), timeoutMs);
        target.addEventListener(event, () => {
          clearTimeout(timer);
          resolve();
        }, { once: true });
      });
    }

    function frameMetrics(video) {
      const canvas = document.createElement('canvas');
      const width = Math.min(480, video.videoWidth || video.clientWidth || 480);
      const height = Math.max(1, Math.round(width * (video.videoHeight || 270) / Math.max(1, video.videoWidth || 480)));
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(video, 0, 0, width, height);
      const data = ctx.getImageData(0, 0, width, height).data;
      const pixelCount = width * height;
      const step = Math.max(1, Math.floor(pixelCount / 9000));
      const buckets = new Set();
      let samples = 0;
      let lit = 0;
      let bright = 0;
      let minLum = 255;
      let maxLum = 0;
      let edgeSamples = 0;
      let edges = 0;
      let signature = 0;
      const lums = [];
      for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex += step) {
        const offset = pixelIndex * 4;
        const r = data[offset];
        const g = data[offset + 1];
        const b = data[offset + 2];
        const lum = (r * 0.2126) + (g * 0.7152) + (b * 0.0722);
        samples += 1;
        if (r + g + b > 45) lit += 1;
        if (Math.max(r, g, b) > 85) bright += 1;
        minLum = Math.min(minLum, lum);
        maxLum = Math.max(maxLum, lum);
        buckets.add(`${r >> 4},${g >> 4},${b >> 4}`);
        signature = (signature + Math.round(lum) * ((samples % 31) + 1)) % 1000003;
        lums.push(lum);
      }
      for (let i = 1; i < lums.length; i += 1) {
        edgeSamples += 1;
        if (Math.abs(lums[i] - lums[i - 1]) > 34) edges += 1;
      }
      return {
        width,
        height,
        dataUrl: canvas.toDataURL('image/png'),
        litRatio: lit / Math.max(1, samples),
        brightRatio: bright / Math.max(1, samples),
        colorBuckets: buckets.size,
        contrast: maxLum - minLum,
        edgeRatio: edges / Math.max(1, edgeSamples),
        signature,
      };
    }

    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.crossOrigin = 'anonymous';
    document.body.appendChild(video);
    video.src = src;
    await waitFor(video, 'loadedmetadata');
    const metadata = {
      duration: video.duration,
      videoWidth: video.videoWidth,
      videoHeight: video.videoHeight,
      readyState: video.readyState,
      error: video.error ? { code: video.error.code, message: video.error.message } : null,
    };
    if (metadata.videoWidth < minWidth || metadata.videoHeight < minHeight) return { metadata, frames: [], advanced: false };

    const frames = [];
    for (const time of sampleTimes) {
      const targetTime = Math.min(Math.max(0.05, time), Math.max(0.05, (video.duration || time + 1) - 0.05));
      if (Math.abs(video.currentTime - targetTime) > 0.03) {
        const seeked = waitFor(video, 'seeked');
        video.currentTime = targetTime;
        await seeked;
      } else {
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      }
      frames.push({ time: video.currentTime, ...frameMetrics(video) });
    }
    const before = video.currentTime;
    await video.play().catch(() => {});
    await new Promise(resolve => setTimeout(resolve, 550));
    const advanced = video.currentTime > before + 0.2;
    video.pause();
    video.remove();
    return { metadata, frames, advanced };
  }, {
    src: url,
    sampleTimes: options.sampleTimes || [0.4, 1.2, 2.4],
    minWidth: options.minWidth || 640,
    minHeight: options.minHeight || 360,
  });

  await attachJson(testInfo, `${options.name || 'video'}-quality`, {
    url,
    metadata: result.metadata,
    frames: result.frames.map(({ dataUrl, ...frame }) => frame),
    advanced: result.advanced,
  });
  for (const [index, frame] of result.frames.entries()) {
    const base64 = frame.dataUrl.split(',')[1] || '';
    await testInfo.attach(`${options.name || 'video'}-frame-${index}.png`, {
      body: Buffer.from(base64, 'base64'),
      contentType: 'image/png',
    });
  }

  expect(result.metadata.error).toBeNull();
  expect(result.metadata.videoWidth).toBeGreaterThanOrEqual(options.minWidth || 640);
  expect(result.metadata.videoHeight).toBeGreaterThanOrEqual(options.minHeight || 360);
  expect(result.metadata.readyState).toBeGreaterThanOrEqual(1);
  expect(result.advanced).toBe(true);
  expect(result.frames.length).toBeGreaterThanOrEqual(2);
  for (const frame of result.frames) {
    expect(frame.litRatio).toBeGreaterThan(options.minLitRatio ?? 0.08);
    expect(frame.brightRatio).toBeGreaterThan(options.minBrightRatio ?? 0.004);
    expect(frame.colorBuckets).toBeGreaterThanOrEqual(options.minColorBuckets ?? 10);
    expect(frame.contrast).toBeGreaterThan(options.minContrast ?? 32);
    expect(frame.edgeRatio).toBeGreaterThan(options.minEdgeRatio ?? 0.01);
  }
  expect(new Set(result.frames.map(frame => frame.signature)).size).toBeGreaterThan(1);
  return result;
}
