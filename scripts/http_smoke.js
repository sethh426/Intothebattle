import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import jwt from 'jsonwebtoken';

const port = Number(process.env.SMOKE_PORT || 3517);
const host = '127.0.0.1';
const baseUrl = `http://${host}:${port}`;
const roomId = 'smoke-room';
const jwtSecret = 'smoke-test-secret';
const metricsToken = 'smoke-metrics-token';
const diskPath = fs.mkdtempSync(path.join(os.tmpdir(), 'intothebattle-smoke-'));
const overlayToken = jwt.sign({ purpose: 'overlay', roomId }, jwtSecret, { expiresIn: '1h' });

const server = spawn(process.execPath, ['server.js'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    PORT: String(port),
    HOST: host,
    NODE_ENV: 'production',
    API_KEY: 'test',
    JWT_SECRET: jwtSecret,
    OVERLAY_TOKEN_SECRET: jwtSecret,
    SKIP_DB: 'true',
    DEV_TEST_MODE: 'false',
    DISK_PATH: diskPath,
    METRICS_TOKEN: metricsToken,
    DIAGNOSTICS_TOKEN: metricsToken,
    SENTRY_DSN: 'https://public@example.ingest.sentry.io/1',
    SUPPORT_EMAIL: 'support@intothebattle.test',
    INCIDENT_RUNBOOK_URL: 'https://intothebattle.test/runbooks/incident-response',
    OPERATIONS_ALERT_EMAIL: 'ops@intothebattle.test',
    BACKUP_RESTORE_VERIFIED_AT: new Date().toISOString(),
    APP_BASE_URL: 'https://intothebattle.test',
    POSTMARK_API_TOKEN: 'postmark-smoke-token',
    POSTMARK_MESSAGE_STREAM: 'outbound',
    EMAIL_FROM: 'IntoTheBattle <no-reply@intothebattle.test>',
    PAYPAL_CLIENT_ID: 'paypal-smoke-client',
    PAYPAL_CLIENT_SECRET: 'paypal-smoke-secret',
    PAYPAL_MODE: 'live',
    PAYPAL_PLAN_ID: 'P-SMOKEPLAN',
    PAYPAL_WEBHOOK_ID: 'WH-SMOKE',
    GOOGLE_CLIENT_ID: 'google-smoke-client',
    GOOGLE_CLIENT_SECRET: 'google-smoke-secret',
    GOOGLE_OAUTH_REDIRECT_URI: 'https://intothebattle.test/auth/google/callback',
    WRITEFREELY_PUBLIC_URL: 'https://updates.intothebattle.test',
    GROWTH_TRACKING_ENABLED: 'false',
    GROWTH_API_SYNC_ENABLED: 'false',
    SEGMENT_WRITE_KEY: '',
    SEGMENT_BROWSER_WRITE_KEY: 'segment-browser-smoke-key',
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

async function request(pathname, options = {}) {
  return fetch(`${baseUrl}${pathname}`, { redirect: 'manual', ...options });
}

async function waitForHealth() {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) {
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

async function expectStatus(pathname, expectedStatus, options = {}) {
  const res = await request(pathname, options);
  assert(res.status === expectedStatus, `${pathname} expected ${expectedStatus}, received ${res.status}`);
  return res;
}

try {
  await waitForHealth();

  await expectStatus('/healthz', 200);
  for (const pathname of ['/', '/home', '/login', '/signup', '/paywall', '/how-to-play', '/battlegrounds', '/site-map', '/overlay-preview', '/overlay/mobile-preview', '/overlay-v2-preview', '/overlay-phaser.html']) {
    await expectStatus(pathname, 200);
  }
  const blog = await expectStatus('/blog', 200);
  const blogText = await blog.text();
  assert(blogText.includes('IntoTheBattle'), '/blog should render the local blog index');
  assert(blogText.includes('rel="canonical"'), '/blog should include a canonical URL');
  assert(blogText.includes('application/ld+json'), '/blog should include JSON-LD structured data');
  const updates = await expectStatus('/updates', 200);
  assert((await updates.text()).includes('IntoTheBattle'), '/updates should render the local blog index');
  for (const pathname of ['/favicon.ico', '/favicon-48.png', '/apple-touch-icon.png', '/site-icon-512.png', '/site.webmanifest', '/intothebattlelogo_logo_only.svg', '/logo.svg', '/og-intothebattle.png', '/brand-identity-square.png', '/robots.txt', '/sitemap.xml', '/css/site-refresh.css', '/js/clarity-loader.js', '/js/growth-tracker.js', '/js/overlay-scene.js', '/js/overlay-v2.js', '/js/overlay/stage-config.js', '/js/overlay/overlay-normalizers.js', '/js/overlay/overlay-diagnostics.js', '/js/overlay/overlay-audio.js', '/js/overlay/video-agent.js', '/vendor/phaser/phaser.min.js']) {
    await expectStatus(pathname, 200);
  }
  const publicConfig = await expectStatus('/api/public-config', 200);
  const publicConfigBody = await publicConfig.json();
  assert(publicConfigBody.growth?.enabled === false, 'public growth config should default disabled in smoke');
  assert(publicConfigBody.growth?.paidChannel === 'tiktok', 'public growth config should declare TikTok as the paid channel');
  assert(publicConfigBody.growth?.consentRequired === true, 'public growth config should require consent');
  assert(publicConfigBody.growth?.segmentBrowserWriteKey === null, 'disabled growth config should not expose Segment browser keys');
  const sitemapXml = await expectStatus('/sitemap.xml', 200);
  const sitemapText = await sitemapXml.text();
  assert(sitemapXml.headers.get('content-type')?.includes('application/xml'), '/sitemap.xml should be served as XML');
  assert(sitemapText.includes('xmlns:video'), '/sitemap.xml should expose the video sitemap namespace');
  assert(sitemapText.includes('homepage-real-overlay-source.mp4'), '/sitemap.xml should include the homepage demo video');
  await expectStatus('/growth-assets/missing-growth-asset.png', 404);

  const dashboard = await expectStatus('/dashboard', 302);
  assert((dashboard.headers.get('location') || '').startsWith('/login'), '/dashboard should redirect to /login');

  const dashboardWelcome = await expectStatus('/dashboard/welcome', 302);
  assert((dashboardWelcome.headers.get('location') || '').startsWith('/login'), '/dashboard/welcome should redirect to /login when signed out');

  const profile = await expectStatus('/profile', 302);
  assert((profile.headers.get('location') || '').startsWith('/login'), '/profile should redirect to /login');

  const profileHtml = await expectStatus('/profile.html', 302);
  assert((profileHtml.headers.get('location') || '').startsWith('/profile'), '/profile.html should redirect to /profile');

  const adminMarketing = await expectStatus('/admin/marketing', 302);
  assert((adminMarketing.headers.get('location') || '').startsWith('/admin/login'), '/admin/marketing should redirect to /admin/login');
  await expectStatus('/admin/issue-code', 403, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', Origin: 'https://evil.example' },
    body: 'email=evil@example.com',
  });
  await expectStatus('/admin/users/free-pro/grant', 403, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', Origin: 'https://evil.example' },
    body: 'account=creator%40example.com',
  });
  const unauthGrant = await expectStatus('/admin/users/free-pro/grant', 302, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', Origin: baseUrl },
    body: 'account=creator%40example.com',
  });
  assert((unauthGrant.headers.get('location') || '').startsWith('/admin/login'), 'admin Creator Pro grant should require admin login');

  await expectStatus('/server.js', 404);
  await expectStatus('/package.json', 404);
  await expectStatus('/package-lock.json', 404);
  await expectStatus('/overlay-legacy.html', 404);

  await expectStatus('/api/status', 401);
  await expectStatus('/api/subscription/status', 401);
  await expectStatus('/api/stream/setup/start', 401, { method: 'POST' });
  await expectStatus('/api/stream/setup/reset', 401, { method: 'POST' });
  await expectStatus('/api/signup-intent', 403, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Origin: 'https://evil.example' },
    body: JSON.stringify({ email: 'security-smoke@example.com', source: 'smoke' }),
  });
  const sameOriginSignup = await expectStatus('/api/signup-intent', 200, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Origin: baseUrl },
    body: JSON.stringify({ email: 'security-smoke@example.com', source: 'smoke' }),
  });
  const sameOriginSignupBody = await sameOriginSignup.json();
  assert(sameOriginSignupBody.success === true, 'same-origin signup intent should remain allowed');
  await expectStatus('/api/growth/events', 403, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Origin: 'https://evil.example' },
    body: JSON.stringify({
      eventName: 'signup_cta_clicked',
      eventId: 'signup_cta_clicked:cross-origin-smoke',
      anonymousId: 'anon-cross-origin-smoke',
      consent: { analytics: true, ads: true, state: 'granted' },
    }),
  });
  const noConsentGrowthEvent = await expectStatus('/api/growth/events', 200, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Origin: baseUrl, Cookie: 'itb_growth_consent=denied; itb_growth_anon=anon-http-smoke' },
    body: JSON.stringify({
      eventName: 'signup_cta_clicked',
      eventId: 'signup_cta_clicked:http-smoke',
      anonymousId: 'anon-http-smoke',
      consent: { analytics: false, ads: false, state: 'denied' },
      properties: { cta: 'signup' },
      attribution: { utm_source: 'tiktok', ttclid: 'ttclid-http-smoke' },
    }),
  });
  const noConsentGrowthBody = await noConsentGrowthEvent.json();
  assert(noConsentGrowthBody.success === true, 'same-origin no-consent growth event should be accepted for audit');
  assert(noConsentGrowthBody.forwarded === false, 'no-consent growth event must not be forwarded');
  assert(noConsentGrowthBody.eventId === 'signup_cta_clicked:http-smoke', 'growth event response should keep dedup event id');
  assert(!JSON.stringify(noConsentGrowthBody).includes('segment-browser-smoke-key'), 'growth event response must not leak Segment keys');
  const battlegrounds = await expectStatus('/api/public/battlegrounds', 200);
  const battlegroundsBody = await battlegrounds.json();
  assert(Array.isArray(battlegroundsBody.posts), 'battlegrounds list should return posts array');
  const battlegroundPost = await expectStatus('/api/public/battlegrounds', 200, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Origin: baseUrl },
    body: JSON.stringify({
      creatorName: 'Smoke Creator',
      tiktokUsername: 'smoke_creator',
      battleTitle: 'Smoke Test Battle',
      description: 'Smoke test battle post.',
      battleUrl: 'https://www.tiktok.com/@smoke_creator/live',
    }),
  });
  const battlegroundPostBody = await battlegroundPost.json();
  assert(battlegroundPostBody.success === true, 'battlegrounds post should be accepted');
  const paypalConfig = await expectStatus('/api/paypal/config', 200);
  const paypalConfigBody = await paypalConfig.json();
  assert(paypalConfigBody.authenticated === false, 'unauthenticated paypal config should return safe login prompt');
  assert(!paypalConfigBody.clientId, 'unauthenticated paypal config should not expose client id');
  await expectStatus('/metrics', 401);
  await expectStatus('/metrics', 200, { headers: { Authorization: `Bearer ${metricsToken}` } });
  await expectStatus('/api/runtime/diagnostics', 401);
  const diagnostics = await expectStatus('/api/runtime/diagnostics', 200, { headers: { Authorization: `Bearer ${metricsToken}` } });
  const diagnosticsBody = await diagnostics.json();
  assert(diagnosticsBody.ok === true, 'diagnostics should report ok');
  assert(diagnosticsBody.storage?.ok === true, 'diagnostics storage check should report ok');
  assert(diagnosticsBody.database?.mode === 'stub', 'diagnostics should report stub database in smoke mode');
  assert(diagnosticsBody.growth?.enabled === false, 'growth API sync should be disabled by default');
  assert(diagnosticsBody.growthEvents?.enabled === false, 'growth event forwarding should be disabled by default');
  assert(diagnosticsBody.growthEvents?.paidChannel === 'tiktok', 'growth event diagnostics should keep TikTok as the paid channel');
  assert(diagnosticsBody.growthEvents?.canonicalEvents?.includes('subscription_started'), 'growth event diagnostics should expose the canonical event spine');
  await expectStatus('/api/runtime/launch-readiness', 401);
  const readiness = await expectStatus('/api/runtime/launch-readiness', 503, { headers: { Authorization: `Bearer ${metricsToken}` } });
  const readinessBody = await readiness.json();
  assert(readinessBody.ok === false, 'production-mode launch readiness should fail when the smoke uses stub DB');
  assert(
    readinessBody.checks?.some(check => check.id === 'database-not-stubbed' && check.status === 'fail'),
    'launch readiness should block production when SKIP_DB=true'
  );
  assert(readinessBody.checks?.some(check => check.id === 'storage-writable' && check.status === 'pass'), 'launch readiness should include storage check');
  await expectStatus('/api/runtime/growth-sync-test', 401, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'growth-smoke@example.com' }),
  });
  const growthTest = await expectStatus('/api/runtime/growth-sync-test', 200, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${metricsToken}` },
    body: JSON.stringify({ email: 'growth-smoke@example.com' }),
  });
  const growthTestBody = await growthTest.json();
  assert(growthTestBody.success === true && growthTestBody.skipped === true, 'growth sync test should skip safely when disabled');
  await expectStatus('/api/dev/test-mode', 404, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Origin: baseUrl },
    body: JSON.stringify({ enabled: true }),
  });
  await expectStatus('/api/test/status', 404);
  await expectStatus('/api/test/spawn', 404, { method: 'POST', headers: { Origin: baseUrl } });

  await expectStatus(`/overlay?room_id=${roomId}`, 401);
  await expectStatus(`/overlay?room_id=${roomId}&overlay_token=bad`, 401);
  await expectStatus(`/overlay?room_id=${roomId}&overlay_token=${encodeURIComponent(overlayToken)}`, 200);
  await expectStatus(`/overlay?setup=1&controls=1&debug=1&room_id=${roomId}&overlay_token=${encodeURIComponent(overlayToken)}`, 200);
  await expectStatus(`/overlay/mobile?room_id=${roomId}`, 401);
  await expectStatus(`/overlay/mobile?room_id=${roomId}&overlay_token=bad`, 401);
  await expectStatus(`/overlay/mobile?room_id=${roomId}&overlay_token=${encodeURIComponent(overlayToken)}&source=1&transparent=1&layout=pip-corner`, 200);
  await expectStatus(`/overlay/mobile?setup=1&room_id=${roomId}&overlay_token=${encodeURIComponent(overlayToken)}&source=1&layout=chat-replacement`, 200);
  await expectStatus(`/overlay-v2?room_id=${roomId}`, 401);
  await expectStatus(`/overlay-v2?room_id=${roomId}&overlay_token=bad`, 401);
  await expectStatus(`/overlay-v2?room_id=${roomId}&overlay_token=${encodeURIComponent(overlayToken)}`, 200);
  await expectStatus(`/overlay-v2?setup=1&render=1080p&source=1&room_id=${roomId}&overlay_token=${encodeURIComponent(overlayToken)}`, 200);
  await expectStatus(`/state?room_id=${roomId}&overlay_token=${encodeURIComponent(overlayToken)}`, 200);
  await expectStatus(`/state?room_id=${roomId}&overlay_token=bad`, 401);

  await expectStatus(`/background/missing.png?room_id=${roomId}&overlay_token=${encodeURIComponent(overlayToken)}`, 404);
  await expectStatus(`/audio/missing.mp3?room_id=${roomId}&overlay_token=${encodeURIComponent(overlayToken)}`, 404);
  await expectStatus(`/sponsor/missing.mp4?room_id=${roomId}&overlay_token=${encodeURIComponent(overlayToken)}`, 404);
  await expectStatus(`/sponsor/missing.mp4?room_id=${roomId}&overlay_token=bad`, 401);
  const sponsorDir = path.join(diskPath, 'sponsors', roomId);
  fs.mkdirSync(sponsorDir, { recursive: true });
  const sponsorFixture = Buffer.from('0123456789abcdef');
  fs.writeFileSync(path.join(sponsorDir, 'range-test.mp4'), sponsorFixture);
  const sponsorPath = `/sponsor/range-test.mp4?room_id=${roomId}&overlay_token=${encodeURIComponent(overlayToken)}`;
  const rangeResponse = await expectStatus(sponsorPath, 206, { headers: { Range: 'bytes=2-6' } });
  assert(rangeResponse.headers.get('accept-ranges') === 'bytes', 'sponsor media should advertise byte ranges');
  assert(rangeResponse.headers.get('content-range') === `bytes 2-6/${sponsorFixture.length}`, 'sponsor media should return the requested content range');
  assert(rangeResponse.headers.get('content-type')?.startsWith('video/mp4'), 'sponsor media should use a video content type');
  assert((await rangeResponse.arrayBuffer()).byteLength === 5, 'sponsor media range body should match requested size');
  const fullSponsorResponse = await expectStatus(sponsorPath, 200);
  const sponsorEtag = fullSponsorResponse.headers.get('etag');
  assert(Boolean(sponsorEtag), 'sponsor media should include an etag');
  await expectStatus(sponsorPath, 304, { headers: { 'If-None-Match': sponsorEtag } });
  await expectStatus(`/backgrounds/${roomId}/missing.png`, 404);
  await expectStatus(`/audio/${roomId}/missing.mp3`, 404);

  console.log('HTTP smoke checks passed');
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
