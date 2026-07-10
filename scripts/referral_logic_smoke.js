import assert from 'node:assert/strict';
import {
  REFERRAL_CODE_COOLDOWN_HOURS,
  buildReferralChatMessage,
  buildReferralShareUrl,
  canResetReferralCode,
  normalizeReferralCode,
  secondsUntilReferralReset,
  suggestedReferralCode,
  validateReferralCode,
} from '../tiktokbr/services/referrals.js';

assert.equal(REFERRAL_CODE_COOLDOWN_HOURS, 234);
assert.equal(normalizeReferralCode('  mr_clouds-7  '), 'MR_CLOUDS-7');

assert.deepEqual(validateReferralCode('clouds_7').ok, true);
assert.equal(validateReferralCode('abc').ok, false);
assert.equal(validateReferralCode('bad code').ok, false);
assert.equal(validateReferralCode('admin').ok, false);

const now = new Date('2026-07-09T12:00:00Z');
assert.equal(canResetReferralCode({ reset_available_at: '2026-07-09T11:59:00Z' }, now), true);
assert.equal(canResetReferralCode({ reset_available_at: '2026-07-09T12:01:00Z' }, now), false);
assert.equal(secondsUntilReferralReset({ reset_available_at: '2026-07-09T12:01:00Z' }, now), 60);

assert.equal(buildReferralShareUrl('https://intothebattle.com/', 'SF_CLOUDS'), 'https://intothebattle.com/signup?ref=SF_CLOUDS');
assert.equal(buildReferralShareUrl('', 'SF_CLOUDS'), '/signup?ref=SF_CLOUDS');
assert.equal(
  buildReferralChatMessage('https://intothebattle.com/', 'SF_CLOUDS'),
  'Want your own IntoTheBattle arena? Use my code SF_CLOUDS when you sign up: https://intothebattle.com/signup?ref=SF_CLOUDS'
);
assert.equal(suggestedReferralCode({ id: 42, tiktok_username: '@Mr.Clouds' }), 'MRCLOUDS');

console.log('Referral logic smoke checks passed');
