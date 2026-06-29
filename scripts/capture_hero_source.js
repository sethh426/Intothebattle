/**
 * Capture fresh hero source footage for the homepage Remotion video.
 *
 * Records a 33-second clip with bursts timed to align with the 6 shot
 * boundaries in the Remotion composition (each shot is ~4.5–6s):
 *
 *   Burst 1 @ 1.2s  → plays through shots 1–2 (intro + full overlay reveal)
 *   Burst 2 @ 5.5s  → plays through shots 2–3 (full overlay + chat effects)
 *   Burst 3 @ 10.0s → plays through shot 3–4 (chat effects + gift/social)
 *   Burst 4 @ 14.5s → plays through shot 4–5 (gift + engagement value)
 *   Burst 5 @ 19.0s → plays through shot 5 (energy / peak action)
 *   Burst 6 @ 24.0s → plays through shot 6 (brand close, some residual action)
 *
 * Output: public/remotion/hero-source.mp4
 */

import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const host = '127.0.0.1';
const port = Number(process.env.HERO_CAPTURE_PORT || 3542);
const baseUrl = `http://${host}:${port}`;
const width = 1920;
const height = 1080;
const durationMs = 33000;
const diskPath = fs.mkdtempSync(path.join(os.tmpdir(), 'itb-hero-capture-'));
const webmDir = path.join(diskPath, 'webm');
const mp4Path = process.env.HERO_MP4_PATH
  ? path.resolve(process.env.HERO_MP4_PATH)
  : path.join(process.cwd(), 'public', 'remotion', 'hero-source.mp4');

let output = '';
let server;

function stopServer() {
  if (server && !server.killed) server.kill();
  try { fs.rmSync(diskPath, { recursive: true, force: true }); } catch (_) {}
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
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

async function transcodeToMp4(webmPath) {
  const ffmpeg = process.env.FFMPEG_PATH
    || (fs.existsSync('./node_modules/@remotion/compositor-linux-x64-gnu/ffmpeg')
      ? path.resolve('./node_modules/@remotion/compositor-linux-x64-gnu/ffmpeg')
      : 'ffmpeg');
  fs.mkdirSync(path.dirname(mp4Path), { recursive: true });
  await new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, [
      '-y',
      '-i', webmPath,
      '-vf', `scale=${width}:${height}:flags=lanczos`,
      '-c:v', 'libx264',
      '-preset', 'medium',
      '-crf', '18',
      '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart',
      mp4Path,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}\n${out}`));
    });
  });
}

// Burst schedule: fire testBurst at these timestamps (ms from recording start)
const BURST_SCHEDULE = [1200, 5500, 10000, 14500, 19000, 24000];

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

  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 1,
    recordVideo: { dir: webmDir, size: { width, height } },
  });
  const page = await context.newPage();
  const issues = [];
  page.on('pageerror', err => issues.push(`pageerror: ${err.message}`));

  const url = `${baseUrl}/overlay-preview?demo=1&controls=0&debug=0&demo_autoplay=0&banner_preview=1`;
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => Boolean(window.overlayEventEngine), null, { timeout: 10000 });
  await wait(600);

  // Fire bursts at scheduled times while recording
  const startedAt = Date.now();
  for (const delay of BURST_SCHEDULE) {
    const remaining = delay - (Date.now() - startedAt);
    if (remaining > 0) await wait(remaining);
    await page.evaluate(() => window.overlayEventEngine?.testBurst?.()).catch(() => {});
    console.log(`  Burst fired at ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
  }

  // Wait for rest of recording duration
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
  console.log(`\nHero source MP4: ${mp4Path}`);
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
