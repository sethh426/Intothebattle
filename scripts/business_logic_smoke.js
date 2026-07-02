import assert from 'node:assert/strict';
import {
  buildPlanEntitlements,
  isBetaTesterAccessCode,
  isPaidAccessCode,
  isPaidAuthRecord,
} from '../tiktokbr/services/entitlements.js';
import {
  isSubscriptionAccessActive,
  isSubscriptionAccessBlocked,
  localStatusForPayPalWebhookEvent,
  normalizePayPalSubscriptionStatus,
} from '../tiktokbr/services/billingPolicy.js';
import { extractIconEmojiCommand } from '../tiktokbr/services/chatCommands.js';
import { buildLaunchReadinessReport } from '../tiktokbr/services/launchReadiness.js';
import { evaluateSponsorMediaQuality } from '../tiktokbr/sponsorMediaProcessor.js';

function testEntitlements() {
  assert.equal(
    isPaidAccessCode({
      subscription_status: 'active',
      code_type: 'trial',
      is_revoked: 0,
      is_promo: 0,
    }),
    false,
    'plain active trial codes must not unlock paid controls'
  );

  assert.equal(
    isPaidAccessCode({
      subscription_status: 'active',
      paypal_subscription_id: 'I-123',
      is_revoked: 0,
      is_promo: 0,
    }),
    true,
    'PayPal-linked codes should be paid'
  );

  assert.equal(
    isPaidAccessCode({
      code_type: 'creator_pro',
      is_revoked: '0',
      is_promo: '0',
    }),
    true,
    'creator_pro code types should be paid'
  );

  assert.equal(
    isPaidAccessCode({
      code_type: 'paid',
      is_revoked: '1',
    }),
    false,
    'revoked paid codes should not be paid'
  );

  const freePlan = buildPlanEntitlements({
    type: 'code',
    record: { subscription_status: 'active', code_type: 'trial' },
  });
  assert.deepEqual(freePlan, {
    tier: 'free',
    planName: 'Free',
    canUseCreatorSponsors: false,
    platformSponsorManaged: true,
    betaTester: false,
  });

  assert.equal(
    isBetaTesterAccessCode({
      code_type: 'beta-tester',
      is_revoked: 0,
      is_promo: 0,
    }),
    true,
    'beta-tester access-code types should be recognized'
  );

  const betaPlan = buildPlanEntitlements({
    type: 'code',
    record: { subscription_status: 'active', code_type: 'beta-tester' },
  });
  assert.deepEqual(betaPlan, {
    tier: 'beta',
    planName: 'Beta Tester',
    canUseCreatorSponsors: true,
    platformSponsorManaged: false,
    betaTester: true,
  });

  const paidAuth = { type: 'user', record: { id: 7 } };
  assert.equal(
    isPaidAuthRecord(paidAuth, {
      getLatestUserSubscription: () => ({ status: 'active' }),
    }),
    true,
    'active user subscriptions should be paid'
  );
  assert.equal(
    isPaidAuthRecord(paidAuth, {
      getLatestUserSubscription: () => ({
        status: 'trialing',
        expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      }),
    }),
    true,
    'active full-access user trials should unlock creator controls'
  );
  assert.equal(
    isPaidAuthRecord(paidAuth, {
      getLatestUserSubscription: () => ({
        status: 'trialing',
        expires_at: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
      }),
    }),
    false,
    'expired user trials should not unlock creator controls'
  );
  assert.equal(
    isPaidAuthRecord(paidAuth, {
      getLatestUserSubscription: () => ({ status: 'suspended' }),
    }),
    false,
    'suspended user subscriptions should not be paid'
  );

  const trialPlan = buildPlanEntitlements(paidAuth, {
    getLatestUserSubscription: () => ({
      status: 'trialing',
      expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    }),
  });
  assert.deepEqual(trialPlan, {
    tier: 'trial',
    planName: '7-Day Full Access',
    canUseCreatorSponsors: true,
    platformSponsorManaged: false,
    betaTester: false,
  });
}

function testBillingPolicy() {
  assert.equal(normalizePayPalSubscriptionStatus('ACTIVE'), 'active');
  assert.equal(normalizePayPalSubscriptionStatus('APPROVAL_PENDING'), 'pending');
  assert.equal(normalizePayPalSubscriptionStatus('SUSPENDED'), 'suspended');
  assert.equal(localStatusForPayPalWebhookEvent('BILLING.SUBSCRIPTION.ACTIVATED'), 'active');
  assert.equal(localStatusForPayPalWebhookEvent('BILLING.SUBSCRIPTION.SUSPENDED'), 'suspended');
  assert.equal(localStatusForPayPalWebhookEvent('BILLING.SUBSCRIPTION.CANCELLED'), 'cancelled');
  assert.equal(localStatusForPayPalWebhookEvent('BILLING.SUBSCRIPTION.EXPIRED'), 'expired');
  assert.equal(isSubscriptionAccessActive('active'), true);
  assert.equal(isSubscriptionAccessActive('pending'), false);
  assert.equal(isSubscriptionAccessBlocked('suspended'), true);
  assert.equal(isSubscriptionAccessBlocked('pending'), false);
}

function testChatIconCommands() {
  assert.equal(extractIconEmojiCommand('!🌟'), '🌟');
  assert.equal(extractIconEmojiCommand('!emoji🔱'), '🔱');
  assert.equal(extractIconEmojiCommand('!emoji 🔱'), '🔱');
  assert.equal(extractIconEmojiCommand('/emoji 🔱'), '🔱');
  assert.equal(extractIconEmojiCommand('  !emoji   🔱  extra text'), '🔱');

  assert.equal(extractIconEmojiCommand('🌟'), '');
  assert.equal(extractIconEmojiCommand('emoji 🔱'), '');
  assert.equal(extractIconEmojiCommand('!emoji'), '');
  assert.equal(extractIconEmojiCommand('!emojifoo'), '');
  assert.equal(extractIconEmojiCommand('!join'), '');
  assert.equal(extractIconEmojiCommand('!shield'), '');
}

function testSponsorMediaQualityGate() {
  const tools = { ffmpegAvailable: false, ffprobeAvailable: true };
  const goodMp4 = evaluateSponsorMediaQuality({
    file: { filename: 'brand.mp4', size: 8 * 1024 * 1024, mimetype: 'video/mp4' },
    metadata: {
      filename: 'brand.mp4',
      fileSize: 8 * 1024 * 1024,
      mimeType: 'video/mp4',
      durationSeconds: 20,
      width: 1920,
      height: 1080,
      videoCodec: 'h264',
      audioCodec: 'aac',
    },
    tools,
    strict: true,
  });
  assert.equal(goodMp4.status, 'ready', 'OBS-safe MP4 creative should pass quality gate');

  const tooLong = evaluateSponsorMediaQuality({
    file: { filename: 'long.mp4', size: 8 * 1024 * 1024, mimetype: 'video/mp4' },
    metadata: { filename: 'long.mp4', fileSize: 8 * 1024 * 1024, mimeType: 'video/mp4', durationSeconds: 180, width: 1920, height: 1080, videoCodec: 'h264', audioCodec: 'aac' },
    tools,
    strict: true,
  });
  assert.equal(tooLong.status, 'blocked', 'over-long sponsor creative should be blocked');

  const productionWebmWithoutFfmpeg = evaluateSponsorMediaQuality({
    file: { filename: 'clip.webm', size: 8 * 1024 * 1024, mimetype: 'video/webm' },
    metadata: { filename: 'clip.webm', fileSize: 8 * 1024 * 1024, mimeType: 'video/webm', durationSeconds: 20, width: 1280, height: 720, videoCodec: 'vp9', audioCodec: 'opus' },
    tools,
    strict: true,
  });
  assert.equal(productionWebmWithoutFfmpeg.status, 'blocked', 'strict production gate should block non-normalized WebM');
  assert.ok(productionWebmWithoutFfmpeg.blockers.some(message => /H\.264|Non-MP4/.test(message)));

  const warningOnly = evaluateSponsorMediaQuality({
    file: { filename: 'square.mp4', size: 8 * 1024 * 1024, mimetype: 'video/mp4' },
    metadata: { filename: 'square.mp4', fileSize: 8 * 1024 * 1024, mimeType: 'video/mp4', durationSeconds: 40, width: 1080, height: 1080, videoCodec: 'h264', audioCodec: 'aac' },
    tools,
    strict: true,
  });
  assert.equal(warningOnly.status, 'warn', 'non-ideal but playable creative should warn instead of block');
}

function testLaunchReadinessSponsorMediaGate() {
  const report = buildLaunchReadinessReport({
    env: {
      NODE_ENV: 'production',
      SPONSOR_STRICT_MEDIA_GATE: 'false',
    },
    sponsorTools: {
      ffmpegAvailable: true,
      ffmpeg: 'ffmpeg',
      ffprobeAvailable: true,
      ffprobe: 'ffprobe',
    },
  });
  const gateCheck = report.checks.find(check => check.id === 'sponsor-media-gate');
  assert.equal(gateCheck?.status, 'fail', 'launch readiness should fail production when sponsor media gate is disabled');
}

testEntitlements();
testBillingPolicy();
testChatIconCommands();
testSponsorMediaQualityGate();
testLaunchReadinessSponsorMediaGate();
console.log('Business logic smoke checks passed');
