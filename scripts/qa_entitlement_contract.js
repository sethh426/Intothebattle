import assert from 'node:assert/strict';

import {
  buildPlanEntitlements,
  isActiveSubscription,
  isBetaTesterAccessCode,
  isFullAccessTrialSubscription,
  isPaidAccessCode,
  isPaidAuthRecord,
} from '../tiktokbr/services/entitlements.js';

const futureDate = '2099-12-31T23:59:59.000Z';
const pastDate = '2020-01-01T00:00:00.000Z';

function codeAuth(overrides = {}) {
  return {
    type: 'code',
    record: {
      code: 'QA_CODE',
      email: 'qa@example.com',
      code_type: 'trial',
      subscription_status: 'free',
      is_revoked: 0,
      is_promo: 0,
      ...overrides,
    },
  };
}

function userAuth(subscription, overrides = {}) {
  return {
    type: 'user',
    record: {
      id: 42,
      email: 'qa-user@example.com',
      ...overrides,
    },
    subscription,
  };
}

function expectCreatorPlan(name, auth, expected) {
  const plan = buildPlanEntitlements(auth);
  assert.equal(plan.canUseCreatorSponsors, expected, `${name}: creator sponsor access`);
  assert.equal(plan.platformSponsorManaged, !expected, `${name}: platform sponsor fallback`);
  return plan;
}

const freeCode = codeAuth();
assert.equal(isPaidAccessCode(freeCode.record), false, 'free code is not paid');
assert.equal(isBetaTesterAccessCode(freeCode.record), false, 'free code is not beta');
assert.equal(isPaidAuthRecord(freeCode), false, 'free code auth is not paid');
assert.equal(expectCreatorPlan('free code', freeCode, false).tier, 'free');

const paidCode = codeAuth({ code_type: 'creator-pro', subscription_status: 'active' });
assert.equal(isPaidAccessCode(paidCode.record), true, 'creator-pro code is paid');
assert.equal(isPaidAuthRecord(paidCode), true, 'creator-pro auth is paid');
assert.equal(expectCreatorPlan('creator-pro code', paidCode, true).tier, 'paid');

const paypalPaidCode = codeAuth({ paypal_subscription_id: 'I-SUBSCRIPTION' });
assert.equal(isPaidAccessCode(paypalPaidCode.record), true, 'paypal subscription code is paid');
assert.equal(expectCreatorPlan('paypal paid code', paypalPaidCode, true).planName, 'Creator Pro');

const betaCode = codeAuth({ code_type: 'beta-tester', email: 'betatester@example.com' });
assert.equal(isBetaTesterAccessCode(betaCode.record), true, 'beta tester code is beta');
assert.equal(expectCreatorPlan('beta tester code', betaCode, true).tier, 'beta');

const revokedPaidCode = codeAuth({ code_type: 'paid', subscription_status: 'active', is_revoked: 1 });
assert.equal(isPaidAccessCode(revokedPaidCode.record), false, 'revoked paid code is blocked');
assert.equal(expectCreatorPlan('revoked paid code', revokedPaidCode, false).tier, 'free');

const promoPaidCode = codeAuth({ code_type: 'paid', subscription_status: 'active', is_promo: 1 });
assert.equal(isPaidAccessCode(promoPaidCode.record), false, 'promo paid code is blocked');
assert.equal(expectCreatorPlan('promo paid code', promoPaidCode, false).tier, 'free');

const activeSubscription = { status: 'active', expires_at: pastDate };
assert.equal(isActiveSubscription(activeSubscription), true, 'active subscription is active even with stale expiry metadata');
assert.equal(expectCreatorPlan('active user subscription', userAuth(activeSubscription), true).tier, 'paid');

const trialSubscription = { status: 'trialing', expires_at: futureDate };
assert.equal(isFullAccessTrialSubscription(trialSubscription), true, 'future trial unlocks full access');
assert.equal(expectCreatorPlan('future full-access trial', userAuth(trialSubscription), true).tier, 'trial');

const expiredTrial = { status: 'trialing', expires_at: pastDate };
assert.equal(isFullAccessTrialSubscription(expiredTrial), false, 'expired trial is not full access');
assert.equal(expectCreatorPlan('expired full-access trial', userAuth(expiredTrial), false).tier, 'free');

const councilYearGrant = {
  status: 'trialing',
  plan_type: 'Council Year Free',
  admin_granted: 1,
  started_at: '2026-07-04T12:00:00.000Z',
  expires_at: futureDate,
};
assert.equal(
  expectCreatorPlan('admin-granted Council Year', userAuth(councilYearGrant, { created_at: pastDate }), true).tier,
  'paid'
);

const fetchedSubscriptionAuth = userAuth(null);
const fetchedPlan = buildPlanEntitlements(fetchedSubscriptionAuth, {
  getLatestUserSubscription(userId) {
    assert.equal(userId, 42, 'latest subscription lookup uses auth user id');
    return { status: 'active' };
  },
});
assert.equal(fetchedPlan.canUseCreatorSponsors, true, 'latest active subscription unlocks creator sponsors');
assert.equal(isPaidAuthRecord(fetchedSubscriptionAuth, { getLatestUserSubscription: () => ({ status: 'active' }) }), true);

for (const status of ['canceled', 'expired', 'past_due', 'incomplete', 'unknown', '', null]) {
  assert.equal(isActiveSubscription({ status }), false, `inactive subscription status stays locked: ${status}`);
}

console.log('Entitlement contract QA checks passed');
