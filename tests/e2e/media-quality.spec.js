import { test, expect } from '@playwright/test';
import {
  attachJson,
  createServerHarness,
  expectNoPageErrors,
  expectVideoAssetQuality,
  watchPage,
} from './support/playwright-harness.js';

const harness = createServerHarness({
  port: Number(process.env.MEDIA_GATE_E2E_PORT || 3577),
  roomId: 'media-gate-room',
  diskPrefix: 'intothebattle-media-gate-',
});

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  await harness.start();
});

test.afterAll(async () => {
  await harness.stop();
});

async function expectPosterImageQuality(page, testInfo, url, options = {}) {
  const result = await page.evaluate(async ({ src, minWidth, minHeight }) => {
    function waitForImage(img) {
      return new Promise((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error('poster image failed to decode'));
      });
    }
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.src = src;
    await waitForImage(img);
    const width = Math.min(480, img.naturalWidth || 480);
    const height = Math.max(1, Math.round(width * (img.naturalHeight || 270) / Math.max(1, img.naturalWidth || 480)));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, width, height);
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
      lums.push(lum);
    }
    for (let i = 1; i < lums.length; i += 1) {
      edgeSamples += 1;
      if (Math.abs(lums[i] - lums[i - 1]) > 34) edges += 1;
    }
    return {
      naturalWidth: img.naturalWidth,
      naturalHeight: img.naturalHeight,
      minWidth,
      minHeight,
      litRatio: lit / Math.max(1, samples),
      brightRatio: bright / Math.max(1, samples),
      colorBuckets: buckets.size,
      contrast: maxLum - minLum,
      edgeRatio: edges / Math.max(1, edgeSamples),
      dataUrl: canvas.toDataURL('image/png'),
    };
  }, {
    src: url,
    minWidth: options.minWidth || 640,
    minHeight: options.minHeight || 360,
  });

  await attachJson(testInfo, `${options.name || 'poster'}-quality`, {
    ...result,
    dataUrl: undefined,
  });
  await testInfo.attach(`${options.name || 'poster'}-sample.png`, {
    body: Buffer.from((result.dataUrl.split(',')[1] || ''), 'base64'),
    contentType: 'image/png',
  });
  expect(result.naturalWidth).toBeGreaterThanOrEqual(options.minWidth || 640);
  expect(result.naturalHeight).toBeGreaterThanOrEqual(options.minHeight || 360);
  expect(result.litRatio).toBeGreaterThan(options.minLitRatio ?? 0.08);
  expect(result.brightRatio).toBeGreaterThan(options.minBrightRatio ?? 0.004);
  expect(result.colorBuckets).toBeGreaterThanOrEqual(options.minColorBuckets ?? 10);
  expect(result.contrast).toBeGreaterThan(options.minContrast ?? 32);
  expect(result.edgeRatio).toBeGreaterThan(options.minEdgeRatio ?? 0.01);
  return result;
}

test('@media generated Remotion videos decode, advance, and expose useful frames', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-desktop', 'generated media gate runs once in Chromium desktop');
  const errors = await watchPage(page, harness.baseUrl);
  await page.goto(`${harness.baseUrl}/`, { waitUntil: 'domcontentloaded' });

  const assets = [
    {
      name: 'homepage-real-overlay-source',
      path: '/media/remotion/homepage-real-overlay-source.mp4',
      minWidth: 1280,
      minHeight: 720,
      minColorBuckets: 12,
      minEdgeRatio: 0.012,
    },
    {
      name: 'homepage-battle-demo',
      path: '/media/remotion/homepage-battle-demo.mp4',
      minWidth: 1280,
      minHeight: 720,
      minColorBuckets: 12,
      minEdgeRatio: 0.012,
    },
    {
      name: 'growth-battle-demo-vertical',
      path: '/media/remotion/growth-battle-demo-vertical.mp4',
      minWidth: 720,
      minHeight: 1280,
      minColorBuckets: 12,
      minEdgeRatio: 0.01,
    },
  ];

  for (const asset of assets) {
    await test.step(`validate ${asset.name}`, async () => {
      await expectVideoAssetQuality(page, testInfo, `${harness.baseUrl}${asset.path}`, asset);
    });
  }

  await expectNoPageErrors(errors, testInfo, 'media-assets');
});

test('@media homepage poster image is not blank or unusably cropped', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-desktop', 'poster gate runs once in Chromium desktop');
  const errors = await watchPage(page, harness.baseUrl);
  await page.goto(`${harness.baseUrl}/`, { waitUntil: 'domcontentloaded' });
  await expectPosterImageQuality(page, testInfo, `${harness.baseUrl}/media/remotion/homepage-real-overlay-poster.jpg`, {
    name: 'homepage-real-overlay-poster',
    minWidth: 1280,
    minHeight: 720,
    minColorBuckets: 12,
    minEdgeRatio: 0.01,
  });
  await expectNoPageErrors(errors, testInfo, 'poster');
});
