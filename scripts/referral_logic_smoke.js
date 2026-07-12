import assert from 'node:assert/strict';
import {
  DEFAULT_REFERRAL_REWARD_CENTS,
  REFERRAL_CODE_COOLDOWN_HOURS,
  buildReferralChatMessage,
  buildReferralShareUrl,
  canResetReferralCode,
  normalizeReferralCode,
  recordReferralAttribution,
  recordReferralClick,
  secondsUntilReferralReset,
  suggestedReferralCode,
  validateReferralCode,
} from '../tiktokbr/services/referrals.js';

assert.equal(REFERRAL_CODE_COOLDOWN_HOURS, 234);
assert.equal(DEFAULT_REFERRAL_REWARD_CENTS, 2500);
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

console.log('Referral logic smoke checks passed');
