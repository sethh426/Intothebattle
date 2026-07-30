/**
 * Capture fresh real overlay footage for homepage/demo video assets.
 *
 * Records a 34-second clip with real overlay attack/effect moments timed to
 * keep the homepage video active throughout playback.
 *
 * Default output: public/remotion/hero-source.mp4
 * Homepage output: set HERO_MP4_PATH and HERO_POSTER_PATH.
 */

import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const host = '127.0.0.1';
const port = Number(process.env.HERO_CAPTURE_PORT || 3542);
const baseUrl = `http://${host}:${port}`;
const width = Number(process.env.HERO_CAPTURE_WIDTH || 1920);
const height = Number(process.env.HERO_CAPTURE_HEIGHT || 1080);
const durationMs = Number(process.env.HERO_CAPTURE_DURATION_MS || 34000);
const trimStartSeconds = Math.max(0, Number(process.env.HERO_CAPTURE_TRIM_START_SECONDS || 0.85) || 0);
const diskPath = fs.mkdtempSync(path.join(os.tmpdir(), 'itb-hero-capture-'));
const webmDir = path.join(diskPath, 'webm');
const mp4Path = process.env.HERO_MP4_PATH
  ? path.resolve(process.env.HERO_MP4_PATH)
  : path.join(process.cwd(), 'public', 'remotion', 'hero-source.mp4');
const posterPath = process.env.HERO_POSTER_PATH
  ? path.resolve(process.env.HERO_POSTER_PATH)
  : '';

let output = '';
let server;

function stopServer() {
  if (server && !server.killed) server.kill();
  try { fs.rmSync(diskPath, { recursive: true, force: true }); } catch (_) {}
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function resolveFfmpeg() {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  const platformPackage = process.platform === 'win32'
    ? '@remotion/compositor-win32-x64-msvc'
    : process.platform === 'darwin'
      ? '@remotion/compositor-darwin-x64'
      : '@remotion/compositor-linux-x64-gnu';
  const executable = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const remotionFfmpeg = path.resolve('node_modules', platformPackage, executable);
  return fs.existsSync(remotionFfmpeg) ? remotionFfmpeg : 'ffmpeg';
}

async function waitForHealth() {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (server?.exitCode !== null) {
      throw new Error(`Server exited early (code ${server.exitCode})\n${output}`);
    }
    try {
      const res = await fetch(`${baseUrl}/healthz`);
      if (res.status === 200) return;
    } catch (_) {}
    await wait(400);
  }
  throw new Error(`Server did not become healthy\n${output.slice(-1000)}`);
}

function runFfmpeg(args, label) {
  const ffmpeg = resolveFfmpeg();
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`${label} ffmpeg exited ${code}\n${out}`));
    });
  });
}

async function transcodeToMp4(webmPath) {
  fs.mkdirSync(path.dirname(mp4Path), { recursive: true });
  const trimArgs = trimStartSeconds > 0 ? ['-ss', String(trimStartSeconds)] : [];
  await runFfmpeg([
    '-y',
    '-i', webmPath,
    ...trimArgs,
    '-vf', `scale=${width}:${height}:flags=lanczos`,
    '-r', '30',
    '-c:v', 'libx264',
    '-preset', 'medium',
    '-crf', '16',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    mp4Path,
  ], 'transcode');
}

async function extractPoster() {
  if (!posterPath) return;
  fs.mkdirSync(path.dirname(posterPath), { recursive: true });
  await runFfmpeg([
    '-y',
    '-ss', '3.2',
    '-i', mp4Path,
    '-frames:v', '1',
    '-q:v', '2',
    posterPath,
  ], 'poster');
}

async function triggerShowcaseMoment(page, index) {
  return page.evaluate((momentIndex) => {
    const engine = window.overlayEventEngine;
    if (!engine) return { ok: false, reason: 'missing overlayEventEngine' };

    if (momentIndex % 3 === 0) engine.testEffectOwnership?.();
    if (momentIndex % 2 === 0) engine.testBoss?.();
    engine.testBurst?.();

    window.setTimeout(() => engine.testMotionImpact?.(), 240);
    window.setTimeout(() => engine.testBurst?.(), 520);

    if (momentIndex % 2 === 1) {
      window.setTimeout(() => engine.testEventStorm?.(28), 820);
    }

    return { ok: true, momentIndex, status: engine.status?.() };
  }, index);
}

const SHOWCASE_SCHEDULE = [700, 3300, 6400, 9600, 12800, 16000, 19300, 22600, 26000, 29400];

try {
  fs.mkdirSync(webmDir, { recursive: true });

  server = spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      HOST: host,
      NODE_ENV: 'test',
      API_KEY: 'test',
      JWT_SECRET: 'hero-capture-secret',
      OVERLAY_TOKEN_SECRET: 'hero-capture-secret',
      ENABLE_ROOM_SCOPED: 'true',
      SKIP_DB: 'true',
      DEV_TEST_MODE: 'true',
      DISK_PATH: diskPath,
      APP_BASE_URL: baseUrl,
      LOG_LEVEL: 'error',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', chunk => { output += chunk.toString(); });
  server.stderr.on('data', chunk => { output += chunk.toString(); });

  await waitForHealth();
  console.log('Server ready. Starting capture...');

  const launchOptions = {
    args: [
      '--autoplay-policy=no-user-gesture-required',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
    ],
  };
  if (process.env.PLAYWRIGHT_CHROMIUM_PATH) {
    launchOptions.executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH;
  }
  const browser = await chromium.launch(launchOptions);
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 1,
    recordVideo: { dir: webmDir, size: { width, height } },
  });
  const page = await context.newPage();
  const issues = [];
  page.on('pageerror', err => issues.push(`pageerror: ${err.message}`));
  page.on('console', msg => {
    if (msg.type() === 'error') issues.push(`console error: ${msg.text()}`);
  });

  const url = `${baseUrl}/overlay-preview?demo=1&controls=0&debug=0&demo_autoplay=0&banner_preview=1`;
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => Boolean(window.overlayEventEngine), null, { timeout: 10000 });
  await wait(700);

  const startedAt = Date.now();
  for (let i = 0; i < SHOWCASE_SCHEDULE.length; i += 1) {
    const delay = SHOWCASE_SCHEDULE[i];
    const remaining = delay - (Date.now() - startedAt);
    if (remaining > 0) await wait(remaining);
    const result = await triggerShowcaseMoment(page, i).catch(err => ({ ok: false, reason: err.message }));
    console.log(`  Showcase moment ${i + 1} at ${((Date.now() - startedAt) / 1000).toFixed(1)}s: ${result.ok ? 'ok' : result.reason}`);
  }

  const elapsed = Date.now() - startedAt;
  const remaining = durationMs - elapsed;
  if (remaining > 0) await wait(remaining);

  const video = page.video();
  await context.close();
  await browser.close();

  const webmPath = video ? await video.path() : '';
  if (!webmPath || !fs.existsSync(webmPath)) {
    throw new Error('Playwright did not create a WebM recording.');
  }

  console.log('Transcoding to MP4...');
  await transcodeToMp4(webmPath);
  await extractPoster();
  console.log(`\nHero source MP4: ${mp4Path}`);
  if (posterPath) console.log(`Poster: ${posterPath}`);
  if (issues.length) console.warn(`Browser issues:\n${issues.join('\n')}`);
} catch (err) {
  console.error(err?.stack || err);
  if (output) {
    console.error('\n--- server output ---');
    console.error(output.slice(-2000));
  }
  process.exitCode = 1;
} finally {
  stopServer();
}
