export const COUNCIL_PROGRAM_NAME = 'Council of Aetheris';
export const COUNCIL_MONTHLY_REWARD_CENTS = 300;
export const COUNCIL_FOUNDING_RATE_MONTHLY_CENTS = 300;
export const COUNCIL_FIRST_MONTH_GATE_DAYS = 0;
export const COUNCIL_REFERRED_DISCOUNT_PERCENT = 0;
export const COUNCIL_CASH_PAYOUT_MINIMUM_CENTS = 2500;
export const COUNCIL_RECRUIT_YEAR_BONUS_THRESHOLD = 25;
export const COUNCIL_ASCENDANT_WARDEN_THRESHOLD = 25;

export const COUNCIL_RANKS = Object.freeze([
  {
    id: 'aspirant',
    name: 'Aspirant',
    threshold: 0,
    summary: 'Admin-appointed members receive a personal link and can start referring streamers.',
    rewards: [
      'Personal referral link and code',
      '$3 per month for every active paid referral',
      'Founding-window referrals lock the $3 monthly rate forever while payments stay active',
    ],
  },
  {
    id: 'herald',
    name: 'Herald of the Aether',
    threshold: 3,
    summary: 'Three paid referrals unlock the first exclusive visual reward.',
    rewards: [
      'Everything in Aspirant',
      'Exclusive Herald overlay skin',
    ],
  },
  {
    id: 'stormcaller',
    name: 'Stormcaller',
    threshold: 10,
    summary: 'Ten paid referrals unlock early access status.',
    rewards: [
      'Everything in Herald',
      'Early feature access',
    ],
  },
  {
    id: 'ascendant-warden',
    name: 'Ascendant Warden',
    threshold: COUNCIL_ASCENDANT_WARDEN_THRESHOLD,
    summary: 'Twenty-five paid referrals unlock premium status and a voice in the roadmap.',
    rewards: [
      'Everything in Stormcaller',
      'Premium cosmetics',
      'Roadmap vote',
    ],
  },
]);

export const COUNCIL_ELITE_RANK = Object.freeze({
  id: 'aetherarch',
  name: 'Council Elite / Aetherarch',
  threshold: null,
  appointed: true,
  summary: 'Appointed from top Wardens for mentored ambassador growth.',
  rewards: [
    'Everything in Ascendant Warden',
    'Inner-circle Council status',
    'Founder access and special placements',
  ],
});

export function centsToUsd(cents = 0) {
  const value = Number(cents || 0);
  return `$${(Number.isFinite(value) ? value / 100 : 0).toFixed(2)}`;
}

function numberValue(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function activePaidReferralCount(stats = {}) {
  return Math.max(0, Math.round(numberValue(stats.qualified)));
}

export function getCouncilRank(count = 0, options = {}) {
  if (options.elite) return COUNCIL_ELITE_RANK;
  const activeCount = Math.max(0, Math.round(numberValue(count)));
  return [...COUNCIL_RANKS].reverse().find(rank => activeCount >= rank.threshold) || COUNCIL_RANKS[0];
}

export function getNextCouncilRank(count = 0) {
  const activeCount = Math.max(0, Math.round(numberValue(count)));
  return COUNCIL_RANKS.find(rank => activeCount < rank.threshold) || null;
}

export function buildCouncilProgramSummary(stats = {}, options = {}) {
  const rewardAmountCents = Math.max(0, Math.round(numberValue(options.rewardAmountCents, COUNCIL_MONTHLY_REWARD_CENTS)));
  const activeCount = activePaidReferralCount(stats);
  const currentRank = getCouncilRank(activeCount, { elite: Boolean(options.elite) });
  const nextRank = getNextCouncilRank(activeCount);
  const monthlyEarningsCents = Math.max(0, Math.round(numberValue(
    options.monthlyEarningsCents,
    activeCount * rewardAmountCents
  )));
  const previousThreshold = currentRank.threshold ?? COUNCIL_ASCENDANT_WARDEN_THRESHOLD;
  const nextThreshold = nextRank?.threshold ?? previousThreshold;
  const progressSpan = Math.max(1, nextThreshold - previousThreshold);
  const progressPercent = nextRank
    ? Math.max(0, Math.min(100, Math.round(((activeCount - previousThreshold) / progressSpan) * 100)))
    : 100;

  return {
    name: COUNCIL_PROGRAM_NAME,
    monthlyRewardCents: rewardAmountCents,
    monthlyRewardLabel: centsToUsd(rewardAmountCents),
    foundingRateMonthlyCents: COUNCIL_FOUNDING_RATE_MONTHLY_CENTS,
    foundingRateMonthlyLabel: centsToUsd(COUNCIL_FOUNDING_RATE_MONTHLY_CENTS),
    foundingRateOpen: options.foundingRateOpen !== false,
    recruitYearBonusThreshold: COUNCIL_RECRUIT_YEAR_BONUS_THRESHOLD,
    payoutMinimumCents: COUNCIL_CASH_PAYOUT_MINIMUM_CENTS,
    payoutMinimumLabel: centsToUsd(COUNCIL_CASH_PAYOUT_MINIMUM_CENTS),
    activePaidReferralCount: activeCount,
    currentRank,
    nextRank,
    nextRankReferralsNeeded: nextRank ? Math.max(0, nextRank.threshold - activeCount) : 0,
    progressPercent,
    ranks: COUNCIL_RANKS,
    eliteRank: COUNCIL_ELITE_RANK,
    monthlyEarningsCents,
    monthlyEarningsLabel: centsToUsd(monthlyEarningsCents),
    rewardChoiceText: `Earn ${centsToUsd(rewardAmountCents)} every month for every active paid referral.`,
    recruitBonusText: `Creators you sign up can claim a full year free once they refer ${COUNCIL_RECRUIT_YEAR_BONUS_THRESHOLD} paid subscribers of their own.`,
    guardrails: [
      'Council eligibility requires an active admin appointment',
      'Paid referrals must stay active for monthly rewards to continue',
      `${centsToUsd(COUNCIL_CASH_PAYOUT_MINIMUM_CENTS)} minimum cash payout`,
      'W-9 required before the first cash payout',
      'No self-referrals',
      'FTC disclosure required for ambassador posts',
    ],
  };
}
