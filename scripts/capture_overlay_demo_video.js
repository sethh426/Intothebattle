import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const host = '127.0.0.1';
const port = Number(process.env.OVERLAY_DEMO_PORT || 3541);
const baseUrl = `http://${host}:${port}`;
const width = Number(process.env.OVERLAY_DEMO_WIDTH || 1920);
const height = Number(process.env.OVERLAY_DEMO_HEIGHT || 1080);
const durationMs = Number(process.env.OVERLAY_DEMO_DURATION_MS || 22000);
const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const outputDir = path.join(process.cwd(), 'test-results', 'overlay-demo-video', timestamp);
const diskPath = fs.mkdtempSync(path.join(os.tmpdir(), 'intothebattle-overlay-demo-'));
const webmDir = path.join(outputDir, 'raw-webm');
const mp4Path = path.join(outputDir, `intothebattle-real-overlay-demo-${timestamp}.mp4`);
const manifestPath = path.join(outputDir, `manifest-${timestamp}.json`);

let output = '';
let server;

function stopServer() {
  if (server && !server.killed) server.kill();
  try { fs.rmSync(diskPath, { recursive: true, force: true }); } catch (_) {}
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

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
    await wait(450);
  }
  throw new Error(`server did not become healthy\n${output}`);
}

function runProcess(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} exited ${code}\n${stdout}\n${stderr}`));
    });
  });
}

async function transcodeToMp4(webmPath) {
  const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
  await runProcess(ffmpeg, [
    '-y',
    '-i', webmPath,
    '-vf', `scale=${width}:${height}:flags=lanczos`,
    '-c:v', 'libx264',
    '-preset', 'medium',
    '-crf', '18',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    mp4Path,
  ]);
}

async function triggerRealOverlayMoments(page) {
  const schedule = [1400, 5600, 9800, 13800, 17400];
  for (const delay of schedule) {
    setTimeout(() => {
      page.evaluate(() => window.overlayEventEngine?.testBurst?.()).catch(() => {});
    }, delay);
  }
}

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
      JWT_SECRET: 'overlay-demo-video-secret',
      OVERLAY_TOKEN_SECRET: 'overlay-demo-video-secret',
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

  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 1,
    recordVideo: {
      dir: webmDir,
      size: { width, height },
    },
  });
  const page = await context.newPage();
  const browserIssues = [];
  page.on('pageerror', err => browserIssues.push(`pageerror: ${err.message}`));
  page.on('console', msg => {
    if (msg.type() === 'error') browserIssues.push(`console error: ${msg.text()}`);
  });

  const url = `${baseUrl}/overlay-preview?demo=1&controls=0&debug=0&demo_autoplay=0&banner_preview=1`;
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => Boolean(window.overlayEventEngine), null, { timeout: 10000 });
  await page.waitForTimeout(900);
  await triggerRealOverlayMoments(page);
  await page.waitForTimeout(durationMs);

  const video = page.video();
  await context.close();
  await browser.close();
  const webmPath = video ? await video.path() : '';
  if (!webmPath || !fs.existsSync(webmPath)) throw new Error('Playwright did not create a WebM recording.');

  await transcodeToMp4(webmPath);
  fs.writeFileSync(manifestPath, JSON.stringify({
    timestamp,
    source: 'real overlay preview',
    url,
    width,
    height,
    durationMs,
    webmPath,
    mp4Path,
    browserIssues,
    notes: [
      'Generated from the real overlay renderer, not the faux battle-clip mockup.',
      'Use this MP4 as the source footage for the homepage battle preview.',
      'Playwright capture is visual-only; add audio separately if needed.',
    ],
  }, null, 2));

  console.log(`Real overlay demo MP4: ${mp4Path}`);
  console.log(`Raw WebM: ${webmPath}`);
  console.log(`Manifest: ${manifestPath}`);
  if (browserIssues.length) console.warn(`Browser issues:\n${browserIssues.join('\n')}`);
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
