import { test, expect } from '@playwright/test';
import {
  addAuthCookie,
  attachJson,
  attachScreenshot,
  createServerHarness,
  expectNoHorizontalOverflow,
  expectNoPageErrors,
  freezeOverlayVisuals,
  parseJsonResponse,
  readLegacyLayout,
  watchPage,
} from './support/playwright-harness.js';

const harness = createServerHarness({
  port: Number(process.env.FULL_GATE_E2E_PORT || 3547),
  roomId: 'full-gate-room',
  diskPrefix: 'intothebattle-full-gate-',
});

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  await harness.start();
});

test.afterAll(async () => {
  await harness.stop();
});

async function gotoWatched(page, pathname, testInfo, readyLocator, label) {
  const errors = await watchPage(page, harness.baseUrl);
  await test.step(`open ${label}`, async () => {
    await page.goto(`${harness.baseUrl}${pathname}`, { waitUntil: 'domcontentloaded' });
    await expect(readyLocator(page)).toBeVisible();
    await page.waitForLoadState('load');
  });
  await expectNoHorizontalOverflow(page);
  await attachScreenshot(page, testInfo, label);
  return errors;
}

test('@cross-browser marketing, auth, and conversion pages keep semantic structure', async ({ page }, testInfo) => {
  let errors = await gotoWatched(page, '/signup', testInfo, page => page.getByRole('main'), 'signup-conversion');
  await expect(page.getByRole('heading', { name: /Launch your first battle overlay/i })).toBeVisible();
  await expect(page.getByRole('link', { name: /Start free with Google/i })).toBeVisible();
  await expect(page.locator('#googleSignupLink')).toHaveAttribute('href', '/auth/google?next=%2Fdashboard%3Fwelcome%3D1');
  await expect(page.locator('#emailSignupLink')).toHaveAttribute('href', '/register?next=%2Fdashboard%3Fwelcome%3D1');
  await expect(page.locator('#loginLink')).toHaveAttribute('href', '/login?next=%2Fdashboard%3Fwelcome%3D1');
  await expect(page.getByText('Open setup preview, copy the source, and test the battle.')).toBeVisible();
  await expect(page.getByText('Free means you can create and test the battle overlay.')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Create creator account' })).toMatchAriaSnapshot(`
    - region "Create creator account":
      - heading "Create your room"
      - link /Start free with Google/
      - link "Use email instead"
  `);
  await expectNoPageErrors(errors, testInfo, 'signup');

  errors = await gotoWatched(page, '/paywall', testInfo, page => page.getByRole('main'), 'paywall-conversion');
  await expect(page.getByRole('heading', { name: /Upgrade only when you need custom brand control/i })).toBeVisible();
  await expect(page.getByText('The battle overlay can be tested before you pay.')).toBeVisible();
  await expect(page.getByRole('button', { name: /Back to Command Center/i })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Creator Pro subscription' })).toMatchAriaSnapshot(`
    - region "Creator Pro subscription":
      - button /Log in to upgrade|Continue to PayPal/
      - button /Back to Command Center/
      - link /Contact support/
  `);
  await expectNoPageErrors(errors, testInfo, 'paywall');

  errors = await gotoWatched(page, '/login', testInfo, page => page.locator('#accountLoginForm'), 'login');
  await expect(page.getByRole('heading', { name: /Enter your command center/i })).toBeVisible();
  await expect(page.locator('#googleLoginBtn')).toHaveAttribute('href', '/auth/google?next=%2Fdashboard');
  await expect(page.getByLabel('Email address')).toBeVisible();
  await expect(page.getByLabel('Password')).toBeVisible();
  await expect(page.getByRole('button', { name: /^Sign in$/i })).toBeVisible();
  await expectNoPageErrors(errors, testInfo, 'login');

  errors = await gotoWatched(page, '/register', testInfo, page => page.locator('#registerBtn'), 'register');
  await expect(page.locator('.google-option a')).toHaveAttribute('href', '/auth/google?next=%2Fdashboard%3Fwelcome%3D1');
  await expectNoPageErrors(errors, testInfo, 'register');
});

test('@cross-browser sponsor page keeps the partner story inspectable', async ({ page }, testInfo) => {
  const errors = await gotoWatched(page, '/sponsors', testInfo, page => page.getByRole('heading', { name: /Put your brand inside/i }), 'sponsors');
  await expect(page.getByRole('link', { name: /Start a sponsor conversation/i })).toBeVisible();
  await expect(page.getByRole('heading', { name: /What sponsors get/i })).toBeVisible();
  await expect(page.getByRole('heading', { name: /Activation formats/i })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Activation formats' })).toMatchAriaSnapshot(`
    - region "Activation formats":
      - heading "Activation formats" [level=2]
      - article:
        - heading "Pre-stream sponsor slate" [level=3]
      - article:
        - heading "Mid-battle video break" [level=3]
  `);
  await expectNoPageErrors(errors, testInfo, 'sponsors');
});

test('@cross-browser authenticated dashboard exposes real creator controls', async ({ context, page }, testInfo) => {
  await addAuthCookie(context, harness);
  const welcomeRedirect = await context.request.get(`${harness.baseUrl}/dashboard/welcome`, { maxRedirects: 0 });
  expect(welcomeRedirect.status()).toBe(302);
  expect(welcomeRedirect.headers().location).toBe('/dashboard?welcome=1');

  const errors = await gotoWatched(page, '/dashboard?welcome=1', testInfo, page => page.getByRole('heading', { name: 'IntoTheBattle Command Center' }), 'dashboard-command-center');

  await expect(page.getByTestId('welcome-setup-panel')).toBeVisible();
  await expect(page.locator('#subscription-chip')).toBeVisible();
  await expect(page.locator('#nextActionPanel')).toBeVisible();
  await expect(page.locator('#streamModeLabel')).toBeVisible();
  await expect(page.locator('#streamModePill')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start Setup Demo' }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open Live Overlay' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Test Live Overlay' })).toBeVisible();
  await page.locator('#liveWorkflow').evaluate(el => { el.open = true; });
  await expect(page.getByRole('button', { name: 'Boss Wave' })).toBeVisible();
  await expect(page.locator('[data-beta-feature="overlay-v2"]')).toBeHidden();
  await expect(page.locator('#launchActionGrid')).toMatchAriaSnapshot(`
    - button /Start setup demo/
    - button /Copy setup source/
    - button /Open source/
    - button /Send test event/
    - button /Connect TikTok/
    - button /Start live battle/
  `);
  await expect(page.locator('#setupChecklistCard')).toMatchAriaSnapshot(`
    - heading "Get live without guessing."
    - button /Start setup demo/
    - button /Copy setup source/
    - button /Open source/
  `);
  await expectNoPageErrors(errors, testInfo, 'dashboard');
});

test('@dashboard setup rehearsal changes demo state and then resets toward real setup', async ({ context, page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-desktop', 'state-changing dashboard confidence runs once in desktop Chromium');
  await addAuthCookie(context, harness);
  const errors = await watchPage(page, harness.baseUrl);

  await test.step('start setup rehearsal from authenticated API', async () => {
    const start = await context.request.post(`${harness.baseUrl}/api/stream/setup/start`, {
      data: { action: 'attack' },
    });
    const body = await parseJsonResponse(start);
    expect(body.setupRehearsal?.active).toBe(true);
  });

  await test.step('dashboard shows setup demo and demo players', async () => {
    await page.goto(`${harness.baseUrl}/dashboard`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: 'IntoTheBattle Command Center' })).toBeVisible();
    await expect.poll(async () => {
      const res = await context.request.get(`${harness.baseUrl}/api/status`);
      const body = await res.json();
      return {
        mode: body.streamMode?.mode,
        playerSource: body.streamMode?.playerSource,
        demoPlayerCount: body.demoPlayerCount,
      };
    }, { timeout: 9000 }).toMatchObject({
      mode: 'setup-demo',
      playerSource: 'demo',
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.locator('#streamModeLabel')).toContainText('Setup Demo');
    await expect(page.locator('#streamModeDetail')).toContainText('Demo events are running');
    await expect(page.locator('#streamModePill')).toContainText('Setup Demo');
    await expect(page.locator('#playerSourceCounts')).toContainText(/Demo [1-9]/);
    await expect(page.locator('#nextActionPanel')).toContainText('Open the signed setup preview');
    await expect(page.locator('#nextActionButtons').getByRole('button', { name: 'Open Setup Preview' })).toBeVisible();
    await expect(page.locator('#nextActionButtons').getByRole('button', { name: 'Copy Setup URL' })).toBeVisible();
  });

  await test.step('reset clears demo state without pretending real stream players exist', async () => {
    const reset = await context.request.post(`${harness.baseUrl}/api/stream/setup/reset`);
    const body = await parseJsonResponse(reset);
    expect(body.setupRehearsal?.active).toBe(false);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.locator('#streamModeLabel')).not.toContainText('Setup Demo');
    await expect(page.locator('#playerSourceCounts')).toContainText('Demo 0');
    const status = await parseJsonResponse(await context.request.get(`${harness.baseUrl}/api/status`));
    expect(status.streamMode.playerSource).not.toBe('demo');
    expect(status.realPlayerCount).toBe(0);
  });

  await expectNoHorizontalOverflow(page);
  await attachScreenshot(page, testInfo, 'dashboard-setup-reset');
  await expectNoPageErrors(errors, testInfo, 'dashboard-setup');
});

test('@dashboard signed overlay state does not leak secrets in debug status', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-desktop', 'signed overlay confidence runs once in desktop Chromium');
  const errors = await watchPage(page, harness.baseUrl);
  const overlayUrl = `${harness.baseUrl}/overlay?room_id=${encodeURIComponent(harness.roomId)}&overlay_token=${encodeURIComponent(harness.overlayToken)}&mode=live&debug=1`;

  await test.step('open signed live overlay', async () => {
    await page.goto(overlayUrl, { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('overlay-canvas')).toBeVisible();
    await page.waitForFunction(() => window.__overlayLegacyLayout?.frame && Array.isArray(window.__overlayLegacyLayout.players), null, { timeout: 7000 });
  });

  const layout = await readLegacyLayout(page, testInfo, 'signed-live-layout');
  expect(layout.players).toEqual([]);
  await freezeOverlayVisuals(page, testInfo, 'signed-live-freeze');

  const status = await page.evaluate(() => window.overlayEventEngine?.status?.() || null);
  await attachJson(testInfo, 'signed-overlay-status', status);
  expect(status?.connection).toMatchObject({
    mode: 'signed',
    hasOverlayToken: true,
  });
  expect(status.connection).not.toHaveProperty('overlayToken');
  expect(JSON.stringify(status)).not.toContain(harness.overlayToken);
  await expect(page.locator('body')).not.toContainText(harness.overlayToken);
  await expectNoHorizontalOverflow(page);
  await attachScreenshot(page, testInfo, 'signed-overlay-no-secret-leak');
  await expectNoPageErrors(errors, testInfo, 'signed-overlay');
});
