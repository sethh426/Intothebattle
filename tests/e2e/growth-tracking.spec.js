import { test, expect } from '@playwright/test';
import {
  addAuthCookie,
  createServerHarness,
  expectNoHorizontalOverflow,
  expectNoPageErrors,
  watchPage,
} from './support/playwright-harness.js';

const harness = createServerHarness({
  port: Number(process.env.GROWTH_E2E_PORT || 3567),
  roomId: 'growth-gate-room',
  diskPrefix: 'intothebattle-growth-gate-',
  env: {
    GROWTH_TRACKING_ENABLED: 'true',
    GROWTH_API_SYNC_ENABLED: 'false',
    SEGMENT_WRITE_KEY: '',
    SEGMENT_BROWSER_WRITE_KEY: 'segment-browser-playwright-key',
  },
});

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  await harness.start();
});

test.afterAll(async () => {
  await harness.stop();
});

async function collectGrowthRequests(page) {
  const requests = [];
  await page.route('**/api/growth/events', async route => {
    const request = route.request();
    try {
      requests.push(request.postDataJSON());
    } catch (_err) {
      requests.push({ raw: request.postData() || '' });
    }
    await route.continue();
  });
  return requests;
}

test('@cross-browser signup tracking is consent-gated and keeps TikTok attribution', async ({ page }, testInfo) => {
  const errors = await watchPage(page, harness.baseUrl);
  const growthRequests = await collectGrowthRequests(page);

  await page.goto(`${harness.baseUrl}/signup?utm_source=tiktok&utm_medium=paid&utm_campaign=creator_growth&utm_content=hook_a&ttclid=ttclid-playwright`, {
    waitUntil: 'domcontentloaded',
  });
  await expect(page.getByRole('main')).toBeVisible();
  await expect(page.locator('#itb-growth-consent')).toBeVisible();
  await page.waitForTimeout(700);
  expect(growthRequests, 'growth requests before consent').toEqual([]);

  const storedBeforeConsent = await page.evaluate(() => ({
    consent: window.localStorage.getItem('itb_growth_consent'),
    anonymousId: window.localStorage.getItem('itb_growth_anon'),
    attribution: JSON.parse(window.localStorage.getItem('itb_growth_attribution') || '{}'),
  }));
  expect(storedBeforeConsent.consent).toBeNull();
  expect(storedBeforeConsent.anonymousId).toMatch(/^anon_/);
  expect(storedBeforeConsent.attribution).toMatchObject({
    utm_source: 'tiktok',
    utm_medium: 'paid',
    utm_campaign: 'creator_growth',
    utm_content: 'hook_a',
    ttclid: 'ttclid-playwright',
  });

  await page.getByRole('button', { name: 'Allow' }).click();
  await expect.poll(() => page.evaluate(() => window.intothebattleGrowth?.consent?.().state), { timeout: 5000 }).toBe('granted');
  const publicConfig = await page.evaluate(async () => fetch('/api/public-config', { cache: 'no-store' }).then(response => response.json()));
  expect(publicConfig.growth).toMatchObject({ enabled: true, paidChannel: 'tiktok', consentRequired: true });
  const viewResults = await page.evaluate(async () => {
    window.intothebattleGrowth?.flushPageEvents?.();
    return Promise.all([
      window.intothebattleGrowth.track('page_viewed', { page_type: 'signup_viewed', test_probe: true }, { seed: 'playwright-page-signup' }),
      window.intothebattleGrowth.track('signup_viewed', { test_probe: true }, { seed: 'playwright-signup-viewed' }),
    ]);
  });
  expect(viewResults.every(result => result?.success === true)).toBe(true);
  await expect.poll(() => growthRequests.map(request => request.eventName), { timeout: 8000 }).toEqual(
    expect.arrayContaining(['page_viewed', 'signup_viewed'])
  );

  const signupViewed = growthRequests.find(request => request.eventName === 'signup_viewed');
  expect(signupViewed.consent).toMatchObject({ analytics: true, ads: true, state: 'granted' });
  expect(signupViewed.attribution).toMatchObject({
    utm_source: 'tiktok',
    utm_medium: 'paid',
    utm_campaign: 'creator_growth',
    utm_content: 'hook_a',
    ttclid: 'ttclid-playwright',
  });
  expect(JSON.stringify(signupViewed)).not.toContain('segment-browser-playwright-key');

  await page.locator('#emailSignupLink').evaluate(element => {
    element.addEventListener('click', event => event.preventDefault(), { capture: true });
  });
  await page.getByRole('link', { name: 'Use email instead' }).click();
  await expect.poll(() => growthRequests.map(request => request.eventName), { timeout: 8000 }).toEqual(
    expect.arrayContaining(['signup_cta_clicked'])
  );
  const ctaClicked = growthRequests.find(request => request.eventName === 'signup_cta_clicked');
  expect(ctaClicked.properties).toMatchObject({
    signup_page: 'room_proof_v2',
    source_event: 'signup_email_click',
    signup_choice: 'email',
  });

  await expectNoHorizontalOverflow(page);
  await expectNoPageErrors(errors, testInfo, 'growth-signup');
});

test('@dashboard authenticated growth events cover dashboard open and overlay copy', async ({ context, page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-desktop', 'dashboard growth actions only need one authenticated Chromium pass');
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async () => undefined },
    });
  });
  await addAuthCookie(context, harness);
  await context.addCookies([
    { name: 'itb_growth_consent', value: 'granted', url: harness.baseUrl },
    { name: 'itb_growth_anon', value: 'anon-dashboard-playwright', url: harness.baseUrl },
  ]);

  const errors = await watchPage(page, harness.baseUrl);
  const growthRequests = await collectGrowthRequests(page);

  await page.goto(`${harness.baseUrl}/dashboard?utm_source=tiktok&utm_campaign=dashboard_growth&ttclid=ttclid-dashboard`, {
    waitUntil: 'domcontentloaded',
  });
  await expect(page.getByRole('heading', { name: 'IntoTheBattle Command Center' })).toBeVisible();
  const dashboardResult = await page.evaluate(async () => {
    window.intothebattleGrowth?.flushPageEvents?.();
    return window.intothebattleGrowth.track('dashboard_opened', { test_probe: true }, { seed: 'playwright-dashboard-opened' });
  });
  expect(dashboardResult?.success).toBe(true);
  await expect.poll(() => growthRequests.map(request => request.eventName), { timeout: 8000 }).toEqual(
    expect.arrayContaining(['page_viewed', 'dashboard_opened'])
  );

  const dashboardOpened = growthRequests.find(request => request.eventName === 'dashboard_opened');
  expect(dashboardOpened.anonymousId).toBe('anon-dashboard-playwright');
  expect(dashboardOpened.consent).toMatchObject({ analytics: true, ads: true, state: 'granted' });
  expect(dashboardOpened.attribution).toMatchObject({
    utm_source: 'tiktok',
    utm_campaign: 'dashboard_growth',
    ttclid: 'ttclid-dashboard',
  });

  await expect(page.locator('#overlayUrlField')).not.toHaveValue(/Loading/i);
  await page.locator('#launchWorkflow').evaluate(element => { element.open = true; });
  await page.getByRole('button', { name: 'Copy Live URL' }).click();
  await expect.poll(() => growthRequests.map(request => request.eventName), { timeout: 8000 }).toEqual(
    expect.arrayContaining(['overlay_url_copied'])
  );
  const overlayCopied = growthRequests.find(request => request.eventName === 'overlay_url_copied');
  expect(overlayCopied.properties).toMatchObject({ source: 'live_overlay' });

  await expectNoHorizontalOverflow(page);
  await expectNoPageErrors(errors, testInfo, 'growth-dashboard');
});
