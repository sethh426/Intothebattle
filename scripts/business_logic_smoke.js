import assert from 'node:assert/strict';
import {
  buildPlanEntitlements,
  isPaidAccessCode,
  isPaidAuthRecord,
} from '../tiktokbr/services/entitlements.js';
import {
  isSubscriptionAccessActive,
  isSubscriptionAccessBlocked,
  localStatusForPayPalWebhookEvent,
  normalizePayPalSubscriptionStatus,
} from '../tiktokbr/services/billingPolicy.js';

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
      getLatestUserSubscription: () => ({ status: 'suspended' }),
    }),
    false,
    'suspended user subscriptions should not be paid'
  );
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

testEntitlements();
testBillingPolicy();
console.log('Business logic smoke checks passed');
