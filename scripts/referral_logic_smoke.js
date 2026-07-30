import assert from 'node:assert/strict';
import {
  DEFAULT_REFERRAL_REWARD_CENTS,
  REFERRAL_CODE_COOLDOWN_HOURS,
  buildReferralChatMessage,
  buildReferralShareUrl,
  canResetReferralCode,
  normalizeReferralCode,
  qualifyReferralForUser,
  recordReferralAttribution,
  recordReferralClick,
  secondsUntilReferralReset,
  suggestedReferralCode,
  validateReferralCode,
} from '../tiktokbr/services/referrals.js';

assert.equal(REFERRAL_CODE_COOLDOWN_HOURS, 234);
assert.equal(DEFAULT_REFERRAL_REWARD_CENTS, 300);
assert.equal(normalizeReferralCode('  mr_clouds-7  '), 'MR_CLOUDS-7');

assert.deepEqual(validateReferralCode('clouds_7').ok, true);
assert.equal(validateReferralCode('abc').ok, false);
assert.equal(validateReferralCode('bad code').ok, false);
assert.equal(validateReferralCode('admin').ok, false);

const now = new Date('2026-07-09T12:00:00Z');
assert.equal(canResetReferralCode({ reset_available_at: '2026-07-09T11:59:00Z' }, now), true);
assert.equal(canResetReferralCode({ reset_available_at: '2026-07-09T12:01:00Z' }, now), false);
assert.equal(secondsUntilReferralReset({ reset_available_at: '2026-07-09T12:01:00Z' }, now), 60);

assert.equal(buildReferralShareUrl('https://intothebattle.com/', 'SF_CLOUDS'), 'https://intothebattle.com/r/SF_CLOUDS');
assert.equal(buildReferralShareUrl('', 'SF_CLOUDS'), '/r/SF_CLOUDS');
assert.equal(
  buildReferralChatMessage('https://intothebattle.com/', 'SF_CLOUDS'),
  'The Council of Aetheris is forming. Use my IntoTheBattle referral link and claim your seat: https://intothebattle.com/r/SF_CLOUDS'
);
assert.equal(suggestedReferralCode({ id: 42, tiktok_username: '@Mr.Clouds' }), 'MRCLOUDS');

function createReferralMemoryDb() {
  const state = {
    clicks: [],
    attributions: [],
    rewards: [],
    recurringRewards: [],
    subscriptions: [],
    codes: [{ id: 1, user_id: 101, code: 'NEON_777' }],
  };
  return {
    state,
    prepare(sql) {
      if (/SELECT \* FROM streamer_referral_codes WHERE UPPER\(code\)/i.test(sql)) {
        return {
          get(code) {
            return state.codes.find(row => row.code.toUpperCase() === String(code || '').toUpperCase()) || null;
          },
        };
      }
      if (/INSERT INTO referral_clicks/i.test(sql)) {
        return {
          run(referralCodeId, referrerUserId, codeSnapshot, anonymousId, ipHash, userAgentHash, referrerUrl, landingPath, utmSource) {
            const id = state.clicks.length + 1;
            state.clicks.push({
              id,
              referral_code_id: referralCodeId,
              referrer_user_id: referrerUserId,
              code_snapshot: codeSnapshot,
              anonymous_id: anonymousId,
              ip_hash: ipHash,
              user_agent_hash: userAgentHash,
              referrer_url: referrerUrl,
              landing_path: landingPath,
              utm_source: utmSource,
              converted_user_id: null,
              converted_at: null,
            });
            return { rows: [{ id }] };
          },
        };
      }
      if (/SELECT \* FROM referral_clicks WHERE id =/i.test(sql)) {
        return {
          get(id, referralCodeId) {
            return state.clicks.find(row => Number(row.id) === Number(id) && Number(row.referral_code_id) === Number(referralCodeId)) || null;
          },
        };
      }
      if (/INSERT INTO referral_attributions/i.test(sql)) {
        return {
          run(referralCodeId, referrerUserId, referredUserId, referralClickId, codeSnapshot, signupMethod, recurringRewardCents, foundingRateLockedAt) {
            if (state.attributions.some(row => Number(row.referred_user_id) === Number(referredUserId))) return { rows: [] };
            const id = state.attributions.length + 1;
            state.attributions.push({
              id,
              referral_code_id: referralCodeId,
              referrer_user_id: referrerUserId,
              referred_user_id: referredUserId,
              referral_click_id: referralClickId,
              code_snapshot: codeSnapshot,
              signup_method: signupMethod,
              status: 'signup_pending',
              qualified_at: null,
              recurring_reward_cents: recurringRewardCents,
              founding_rate_locked_at: foundingRateLockedAt,
            });
            return { rows: [{ id }] };
          },
        };
      }
      if (/SELECT \* FROM referral_attributions WHERE referred_user_id/i.test(sql)) {
        return {
          get(referredUserId) {
            return state.attributions.find(row => Number(row.referred_user_id) === Number(referredUserId)) || null;
          },
        };
      }
      if (/SELECT id, paypal_subscription_id, started_at, created_at, updated_at\s+FROM subscriptions/i.test(sql)) {
        return {
          get(userId) {
            return state.subscriptions.find(row =>
              Number(row.user_id) === Number(userId) &&
              String(row.status || '').toLowerCase() === 'active' &&
              !Number(row.admin_granted || 0) &&
              row.paypal_subscription_id
            ) || null;
          },
        };
      }
      if (/UPDATE referral_attributions/i.test(sql)) {
        return {
          run(monthlyRateCents, foundingLockedAt, id) {
            const attribution = state.attributions.find(row => Number(row.id) === Number(id));
            if (attribution) {
              attribution.status = 'qualified';
              attribution.qualified_at = attribution.qualified_at || 'now';
              attribution.recurring_reward_cents = attribution.recurring_reward_cents || monthlyRateCents;
              attribution.founding_rate_locked_at = attribution.founding_rate_locked_at || foundingLockedAt;
            }
            return { rows: [] };
          },
        };
      }
      if (/INSERT INTO referral_rewards/i.test(sql)) {
        return {
          run(attributionId, referrerUserId, referredUserId, amountCents, currency, notes) {
            if (state.rewards.some(row => Number(row.attribution_id) === Number(attributionId))) return { rows: [] };
            const id = state.rewards.length + 1;
            state.rewards.push({
              id,
              attribution_id: attributionId,
              referrer_user_id: referrerUserId,
              referred_user_id: referredUserId,
              status: 'pending_review',
              amount_cents: amountCents,
              currency,
              notes,
            });
            return { rows: [{ id }] };
          },
        };
      }
      if (/INSERT INTO referral_recurring_rewards/i.test(sql)) {
        return {
          run(attributionId, referrerUserId, referredUserId, subscriptionId, periodStart, periodEnd, amountCents, currency, foundingRateLocked, notes) {
            if (state.recurringRewards.some(row => (
              Number(row.attribution_id) === Number(attributionId) &&
              row.period_start === periodStart
            ))) return { rows: [] };
            const id = state.recurringRewards.length + 1;
            state.recurringRewards.push({
              id,
              attribution_id: attributionId,
              referrer_user_id: referrerUserId,
              referred_user_id: referredUserId,
              subscription_id: subscriptionId,
              period_start: periodStart,
              period_end: periodEnd,
              status: 'pending_review',
              amount_cents: amountCents,
              currency,
              founding_rate_locked: foundingRateLocked,
              notes,
            });
            return { rows: [{ id }] };
          },
        };
      }
      if (/UPDATE referral_clicks/i.test(sql)) {
        return {
          run(referredUserId, id) {
            const click = state.clicks.find(row => Number(row.id) === Number(id));
            if (click) {
              click.converted_user_id = referredUserId;
              click.converted_at = 'now';
            }
            return { rows: [] };
          },
        };
      }
      throw new Error(`Unexpected referral SQL in smoke test: ${sql}`);
    },
  };
}

const memoryDb = createReferralMemoryDb();
const click = recordReferralClick(memoryDb, {
  referralCode: 'neon_777',
  anonymousId: 'anon-1',
  ip: '203.0.113.10',
  userAgent: 'Playwright',
  referrer: 'https://tiktok.com/@creator/live',
  landingPath: '/r/NEON_777?utm_source=tiktok',
  query: { utm_source: 'tiktok' },
});
assert.equal(click.recorded, true);
assert.equal(click.clickId, 1);
assert.equal(memoryDb.state.clicks[0].utm_source, 'tiktok');

const attribution = recordReferralAttribution(memoryDb, {
  referralCode: 'NEON_777',
  referredUserId: 202,
  signupMethod: 'email',
  referralClickId: click.clickId,
});
assert.equal(attribution.recorded, true);
assert.equal(attribution.referrerUserId, 101);
assert.equal(attribution.referralClickId, 1);
assert.equal(memoryDb.state.clicks[0].converted_user_id, 202);

memoryDb.state.subscriptions.push({
  id: 1,
  user_id: 202,
  status: 'active',
  admin_granted: 0,
  paypal_subscription_id: 'I-TEST',
  started_at: '2026-07-01 00:00:00',
  created_at: '2026-07-01 00:00:00',
  updated_at: '2026-07-01 00:00:00',
});
const clearedGate = qualifyReferralForUser(memoryDb, 202, { now: new Date('2026-07-20T00:00:00Z') });
assert.equal(clearedGate.qualified, true);
assert.equal(clearedGate.rewardCreated, true);
assert.equal(clearedGate.monthlyRewardCreated, true);
assert.equal(memoryDb.state.attributions[0].status, 'qualified');
assert.equal(memoryDb.state.rewards[0].amount_cents, 300);
assert.equal(memoryDb.state.recurringRewards[0].amount_cents, 300);
assert.equal(memoryDb.state.recurringRewards[0].period_start, '2026-07-01 00:00:00');

const duplicateMonth = qualifyReferralForUser(memoryDb, 202, { now: new Date('2026-07-25T00:00:00Z') });
assert.equal(duplicateMonth.qualified, true);
assert.equal(duplicateMonth.monthlyRewardCreated, false);
assert.equal(memoryDb.state.recurringRewards.length, 1);

console.log('Referral logic smoke checks passed');
