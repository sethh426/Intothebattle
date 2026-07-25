import assert from 'node:assert/strict';
import {
  DEFAULT_REFERRAL_REWARD_CENTS,
  FREE_FOREVER_REFERRAL_THRESHOLD,
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
assert.equal(DEFAULT_REFERRAL_REWARD_CENTS, 0);
assert.equal(FREE_FOREVER_REFERRAL_THRESHOLD, 25);
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
  'Want your own IntoTheBattle arena? Use my code SF_CLOUDS when you sign up: https://intothebattle.com/r/SF_CLOUDS'
);
assert.equal(suggestedReferralCode({ id: 42, tiktok_username: '@Mr.Clouds' }), 'MRCLOUDS');

function createReferralMemoryDb() {
  const state = {
    clicks: [],
    attributions: [],
    rewards: [],
    subscriptions: [],
    users: [],
    notifyCallCount: 0,
    codes: [{ id: 1, user_id: 101, code: 'NEON_777', free_forever_notified_at: null }],
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
      if (/SELECT \* FROM streamer_referral_codes WHERE user_id = \?/i.test(sql)) {
        return {
          get(userId) {
            return state.codes.find(row => Number(row.user_id) === Number(userId)) || null;
          },
        };
      }
      if (/UPDATE streamer_referral_codes\s+SET free_forever_notified_at/i.test(sql)) {
        return {
          run(userId) {
            const row = state.codes.find(r => Number(r.user_id) === Number(userId));
            if (!row || row.free_forever_notified_at) return { rows: [] };
            row.free_forever_notified_at = 'now';
            return { rows: [{ id: row.id }] };
          },
        };
      }
      if (/SELECT \* FROM referral_attributions WHERE referred_user_id = \?/i.test(sql)) {
        return {
          get(referredUserId) {
            return state.attributions.find(row => Number(row.referred_user_id) === Number(referredUserId)) || null;
          },
        };
      }
      if (/SELECT id\s+FROM subscriptions/i.test(sql)) {
        return {
          get(userId) {
            return state.subscriptions.find(row => Number(row.user_id) === Number(userId)) || null;
          },
        };
      }
      if (/UPDATE referral_attributions\s+SET status = 'qualified'/i.test(sql)) {
        return {
          run(attributionId) {
            const row = state.attributions.find(r => Number(r.id) === Number(attributionId));
            if (row) row.status = 'qualified';
            return { rows: [] };
          },
        };
      }
      if (/INSERT INTO referral_rewards/i.test(sql)) {
        return {
          run(attributionId, referrerUserId, referredUserId, amountCents, currency, notes) {
            if (state.rewards.some(r => Number(r.attribution_id) === Number(attributionId))) return { rows: [] };
            const id = state.rewards.length + 1;
            state.rewards.push({ id, attribution_id: attributionId, referrer_user_id: referrerUserId, referred_user_id: referredUserId, amount_cents: amountCents, currency, notes });
            return { rows: [{ id }] };
          },
        };
      }
      if (/SELECT COUNT\(\*\) AS count\s+FROM referral_attributions\s+WHERE referrer_user_id = \? AND status = 'qualified'/i.test(sql)) {
        return {
          get(referrerUserId) {
            const count = state.attributions.filter(r => Number(r.referrer_user_id) === Number(referrerUserId) && r.status === 'qualified').length;
            return { count };
          },
        };
      }
      if (/SELECT email, name, tiktok_username FROM users WHERE id = \?/i.test(sql)) {
        return {
          get(userId) {
            state.notifyCallCount += 1;
            return state.users.find(row => Number(row.id) === Number(userId)) || null;
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
          run(referralCodeId, referrerUserId, referredUserId, referralClickId, codeSnapshot, signupMethod) {
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

// Free Forever milestone: 25 qualified referrals should notify exactly once
// and stop accruing cash (DEFAULT_REFERRAL_REWARD_CENTS is now 0).
const milestoneDb = createReferralMemoryDb();
milestoneDb.state.users.push({ id: 101, email: 'creator@example.com', name: 'Creator One', tiktok_username: 'creatorone' });
for (let i = 0; i < FREE_FOREVER_REFERRAL_THRESHOLD + 2; i += 1) {
  const referredUserId = 900 + i;
  milestoneDb.state.attributions.push({
    id: i + 1,
    referrer_user_id: 101,
    referred_user_id: referredUserId,
    status: 'signup_pending',
  });
  milestoneDb.state.subscriptions.push({
    user_id: referredUserId,
    status: 'active',
    admin_granted: 0,
    paypal_subscription_id: `sub_${referredUserId}`,
  });
  const result = qualifyReferralForUser(milestoneDb, referredUserId, { source: 'paid_subscription' });
  assert.equal(result.qualified, true);
}
assert.equal(milestoneDb.state.rewards.length, FREE_FOREVER_REFERRAL_THRESHOLD + 2);
assert.ok(milestoneDb.state.rewards.every(r => r.amount_cents === 0), 'new referral rewards should carry $0 (cash reward retired)');
assert.equal(milestoneDb.state.codes[0].free_forever_notified_at, 'now', 'referrer should be flagged once threshold is crossed');
assert.equal(milestoneDb.state.notifyCallCount, 1, 'milestone notification should fire exactly once, not on every referral past 25');

console.log('Referral logic smoke checks passed');
