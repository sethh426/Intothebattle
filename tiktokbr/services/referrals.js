import crypto from 'node:crypto';
import {
  COUNCIL_ASCENDANT_WARDEN_THRESHOLD,
  COUNCIL_FOUNDING_RATE_MONTHLY_CENTS,
  COUNCIL_MONTHLY_REWARD_CENTS,
  COUNCIL_RECRUIT_YEAR_BONUS_THRESHOLD,
  buildCouncilProgramSummary,
} from './councilOfAetheris.js';

export const REFERRAL_CODE_COOLDOWN_HOURS = 234;
export const REFERRAL_CODE_COOLDOWN_MS = REFERRAL_CODE_COOLDOWN_HOURS * 60 * 60 * 1000;
export const REFERRAL_CLICK_COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export const DEFAULT_REFERRAL_REWARD_CENTS = COUNCIL_MONTHLY_REWARD_CENTS;
export const FREE_FOREVER_REFERRAL_THRESHOLD = COUNCIL_ASCENDANT_WARDEN_THRESHOLD;

const RESERVED_CODES = new Set([
  'ADMIN',
  'BILLING',
  'FREE',
  'HELP',
  'INTOTHEBATTLE',
  'INTO-THE-BATTLE',
  'LOGIN',
  'NULL',
  'OWNER',
  'PAYPAL',
  'REGISTER',
  'ROOT',
  'SIGNUP',
  'SUPPORT',
  'UNDEFINED',
]);

const CODE_PATTERN = /^[A-Z0-9_-]{4,24}$/;

function referralError(message, statusCode = 400, extra = {}) {
  return Object.assign(new Error(message), { statusCode, ...extra });
}

function formatDateForSql(date = new Date()) {
  const parsed = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 19).replace('T', ' ');
}

function parseDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function numberValue(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function cleanNotes(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 500);
}

function cleanText(value, maxLength = 500) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function cleanQueryValue(value, maxLength = 180) {
  const raw = Array.isArray(value) ? value[0] : value;
  return cleanText(raw, maxLength);
}

function referralClickIdValue(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function hashReferralValue(value) {
  const text = cleanText(value, 1000);
  if (!text) return '';
  return crypto.createHash('sha256').update(text).digest('hex');
}

function rewardAmountCents(value, fallback = defaultRewardAmountCents()) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(0, Math.min(10000000, Math.round(number)));
}

function defaultRewardAmountCents() {
  return rewardAmountCents(process.env.REFERRAL_REWARD_DEFAULT_CENTS, DEFAULT_REFERRAL_REWARD_CENTS);
}

function foundingRateOpen() {
  const value = String(process.env.COUNCIL_FOUNDING_RATE_OPEN || process.env.REFERRAL_FOUNDING_RATE_OPEN || 'true').trim().toLowerCase();
  return !['0', 'false', 'no', 'closed', 'off'].includes(value);
}

function foundingMonthlyRewardCents() {
  return rewardAmountCents(process.env.COUNCIL_FOUNDING_MONTHLY_REWARD_CENTS, COUNCIL_FOUNDING_RATE_MONTHLY_CENTS);
}

function standardMonthlyRewardCents() {
  return rewardAmountCents(process.env.COUNCIL_MONTHLY_REWARD_CENTS, defaultRewardAmountCents());
}

function monthlyRewardCentsForNewReferral() {
  return foundingRateOpen() ? foundingMonthlyRewardCents() : standardMonthlyRewardCents();
}

function monthPeriodRange(now = new Date()) {
  const current = parseDate(now) || new Date();
  const start = new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth(), 1, 0, 0, 0));
  const end = new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth() + 1, 1, 0, 0, 0));
  return {
    start,
    end,
    startSql: formatDateForSql(start),
    endSql: formatDateForSql(end),
  };
}

function rewardCurrency() {
  const currency = String(process.env.REFERRAL_REWARD_CURRENCY || 'USD').trim().toUpperCase();
  return /^[A-Z]{3}$/.test(currency) ? currency : 'USD';
}

function firstRow(result) {
  return result?.rows?.[0] || null;
}

function buildCodeSeed(user = {}) {
  const source = user.tiktok_username || user.name || String(user.email || '').split('@')[0] || 'creator';
  const seed = String(source)
    .replace(/^@+/, '')
    .toUpperCase()
    .replace(/[^A-Z0-9_-]/g, '')
    .slice(0, 18);
  return seed.length >= 4 ? seed : `CREATOR${user.id || ''}`.slice(0, 18);
}

export function normalizeReferralCode(value) {
  return String(value || '').trim().toUpperCase();
}

export function validateReferralCode(value) {
  const code = normalizeReferralCode(value);
  if (!code) return { ok: false, code, error: 'Enter a referral code.' };
  if (!CODE_PATTERN.test(code)) {
    return {
      ok: false,
      code,
      error: 'Use 4-24 characters: letters, numbers, hyphens, or underscores only.',
    };
  }
  if (RESERVED_CODES.has(code)) {
    return { ok: false, code, error: 'That code is reserved. Choose another one.' };
  }
  return { ok: true, code, error: '' };
}

export function suggestedReferralCode(user = {}) {
  const seed = buildCodeSeed(user);
  return validateReferralCode(seed).ok ? seed : `CREATOR${user.id || ''}`.slice(0, 24);
}

export function secondsUntilReferralReset(row, now = new Date()) {
  const availableAt = parseDate(row?.reset_available_at);
  if (!availableAt) return 0;
  return Math.max(0, Math.ceil((availableAt.getTime() - now.getTime()) / 1000));
}

export function canResetReferralCode(row, now = new Date()) {
  return secondsUntilReferralReset(row, now) <= 0;
}

export function buildReferralShareUrl(baseUrl, code) {
  const normalized = normalizeReferralCode(code);
  if (!normalized) return '';
  const base = String(baseUrl || process.env.APP_BASE_URL || '').trim().replace(/\/+$/, '');
  if (!base) return `/r/${encodeURIComponent(normalized)}`;
  try {
    const url = new URL(`/r/${encodeURIComponent(normalized)}`, base);
    return url.toString();
  } catch (_err) {
    return `/r/${encodeURIComponent(normalized)}`;
  }
}

export function buildReferralChatMessage(baseUrl, code) {
  const normalized = normalizeReferralCode(code);
  const shareUrl = buildReferralShareUrl(baseUrl, normalized);
  if (!normalized || !shareUrl) return '';
  return `The Council of Aetheris is forming. Use my IntoTheBattle referral link and claim your seat: ${shareUrl}`;
}

export function getReferralCodeForUser(database, userId) {
  if (!userId) return null;
  return database.prepare('SELECT * FROM streamer_referral_codes WHERE user_id = ? LIMIT 1').get(userId) || null;
}

export function getReferralSummary(database, user, options = {}) {
  if (!user?.id) throw referralError('Unauthorized', 401);
  if (options.settleRewards !== false) {
    settleClearedReferralRewards(database, { referrerUserId: user.id, now: options.now });
  }
  const codeRow = getReferralCodeForUser(database, user.id);
  const code = codeRow?.code || '';
  const statusRows = database.prepare(`
    SELECT status, COUNT(*) AS count
    FROM referral_attributions
    WHERE referrer_user_id = ?
    GROUP BY status
  `).all(user.id);
  const activePaidRow = database.prepare(`
    SELECT COUNT(DISTINCT a.id) AS count
    FROM referral_attributions a
    JOIN subscriptions s ON s.user_id = a.referred_user_id
      AND LOWER(s.status) = 'active'
      AND COALESCE(s.admin_granted, 0) = 0
      AND s.paypal_subscription_id IS NOT NULL
    WHERE a.referrer_user_id = ?
      AND a.status = 'qualified'
  `).get(user.id) || {};
  const projectedRow = database.prepare(`
    SELECT COALESCE(SUM(COALESCE(a.recurring_reward_cents, ?)), 0) AS amount_cents
    FROM referral_attributions a
    JOIN subscriptions s ON s.user_id = a.referred_user_id
      AND LOWER(s.status) = 'active'
      AND COALESCE(s.admin_granted, 0) = 0
      AND s.paypal_subscription_id IS NOT NULL
    WHERE a.referrer_user_id = ?
      AND a.status = 'qualified'
  `).get(defaultRewardAmountCents(), user.id) || {};
  const rewardRows = database.prepare(`
    SELECT status, COUNT(*) AS count, COALESCE(SUM(amount_cents), 0) AS amount_cents
    FROM referral_recurring_rewards
    WHERE referrer_user_id = ?
    GROUP BY status
  `).all(user.id);
  const clickStats = database.prepare(`
    SELECT
      COUNT(*) AS total_clicks,
      COUNT(converted_at) AS converted_clicks,
      COUNT(DISTINCT COALESCE(NULLIF(anonymous_id, ''), NULLIF(ip_hash, ''), CAST(id AS TEXT))) AS unique_clicks
    FROM referral_clicks
    WHERE referrer_user_id = ?
  `).get(user.id) || {};
  const recent = database.prepare(`
    SELECT
      a.status,
      a.signup_method,
      a.code_snapshot,
      a.signup_at,
      a.qualified_at,
      a.created_at,
      referred.name AS referred_name,
      referred.tiktok_username AS referred_tiktok,
      rr.status AS reward_status,
      rr.amount_cents,
      rr.currency,
      rr.period_start,
      rr.period_end
    FROM referral_attributions a
    LEFT JOIN users referred ON referred.id = a.referred_user_id
    LEFT JOIN referral_recurring_rewards rr ON rr.id = (
      SELECT rr2.id
      FROM referral_recurring_rewards rr2
      WHERE rr2.attribution_id = a.id
      ORDER BY rr2.period_start DESC, rr2.created_at DESC
      LIMIT 1
    )
    WHERE a.referrer_user_id = ?
    ORDER BY a.created_at DESC
    LIMIT 10
  `).all(user.id);

  const stats = {
    signups: 0,
    qualified: 0,
    pendingReview: 0,
    approved: 0,
    paid: 0,
    rejected: 0,
    pendingAmountCents: 0,
    approvedAmountCents: 0,
    paidAmountCents: 0,
    monthlyProjectedCents: 0,
    clicks: numberValue(clickStats.total_clicks),
    uniqueClicks: numberValue(clickStats.unique_clicks),
    convertedClicks: numberValue(clickStats.converted_clicks),
    clickToSignupRate: 0,
    signupToQualifiedRate: 0,
  };

  for (const row of statusRows) {
    const count = numberValue(row.count);
    stats.signups += count;
  }
  stats.qualified = numberValue(activePaidRow.count);

  for (const row of rewardRows) {
    const status = String(row.status || '');
    const count = numberValue(row.count);
    const amount = numberValue(row.amount_cents);
    if (status === 'pending_review') {
      stats.pendingReview += count;
      stats.pendingAmountCents += amount;
    } else if (status === 'approved') {
      stats.approved += count;
      stats.approvedAmountCents += amount;
    } else if (status === 'paid') {
      stats.paid += count;
      stats.paidAmountCents += amount;
    } else if (status === 'rejected') {
      stats.rejected += count;
    }
  }

  stats.clickToSignupRate = stats.clicks > 0 ? Math.round((stats.signups / stats.clicks) * 1000) / 10 : 0;
  stats.signupToQualifiedRate = stats.signups > 0 ? Math.round((stats.qualified / stats.signups) * 1000) / 10 : 0;
  stats.monthlyProjectedCents = numberValue(projectedRow.amount_cents);

  return {
    code,
    hasCode: Boolean(code),
    suggestedCode: suggestedReferralCode(user),
    shareUrl: buildReferralShareUrl(options.baseUrl, code),
    chatText: buildReferralChatMessage(options.baseUrl, code),
    cooldownHours: REFERRAL_CODE_COOLDOWN_HOURS,
    resetAvailableAt: codeRow?.reset_available_at || null,
    resetCountdownSeconds: secondsUntilReferralReset(codeRow),
    canReset: codeRow ? canResetReferralCode(codeRow) : true,
    resetCount: numberValue(codeRow?.reset_count),
    stats,
    program: buildCouncilProgramSummary(stats, {
      rewardAmountCents: defaultRewardAmountCents(),
      monthlyEarningsCents: stats.monthlyProjectedCents,
      foundingRateOpen: foundingRateOpen(),
    }),
    recent,
  };
}

export function claimOrResetReferralCode(database, user, requestedCode) {
  if (!user?.id) throw referralError('Unauthorized', 401);
  const validation = validateReferralCode(requestedCode);
  if (!validation.ok) throw referralError(validation.error, 400);
  const { code } = validation;

  return database.transaction(() => {
    const existing = getReferralCodeForUser(database, user.id);
    const conflict = database.prepare('SELECT * FROM streamer_referral_codes WHERE UPPER(code) = ? AND user_id <> ? LIMIT 1').get(code, user.id);
    if (conflict) throw referralError('That code is already taken. Choose another one.', 409);

    if (existing && normalizeReferralCode(existing.code) === code) {
      return getReferralSummary(database, user);
    }

    const now = new Date();
    const nowSql = formatDateForSql(now);
    const resetAvailableSql = formatDateForSql(new Date(now.getTime() + REFERRAL_CODE_COOLDOWN_MS));

    if (!existing) {
      database.prepare(`
        INSERT INTO streamer_referral_codes (user_id, code, reset_count, last_reset_at, reset_available_at, created_at, updated_at)
        VALUES (?, ?, 0, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `).run(user.id, code, nowSql, resetAvailableSql);
      return getReferralSummary(database, user);
    }

    const secondsRemaining = secondsUntilReferralReset(existing, now);
    if (secondsRemaining > 0) {
      throw referralError('Referral code resets are still cooling down.', 429, { retryAfterSeconds: secondsRemaining });
    }

    database.prepare(`
      UPDATE streamer_referral_codes
      SET code = ?, reset_count = COALESCE(reset_count, 0) + 1, last_reset_at = ?, reset_available_at = ?, updated_at = CURRENT_TIMESTAMP
      WHERE user_id = ?
    `).run(code, nowSql, resetAvailableSql, user.id);
    return getReferralSummary(database, user);
  })();
}

export function recordReferralClick(database, {
  referralCode,
  anonymousId = '',
  ip = '',
  userAgent = '',
  referrer = '',
  landingPath = '',
  query = {},
} = {}) {
  const validation = validateReferralCode(referralCode);
  if (!validation.ok) return { recorded: false, reason: 'invalid_code' };

  const codeRow = database.prepare('SELECT * FROM streamer_referral_codes WHERE UPPER(code) = ? LIMIT 1').get(validation.code);
  if (!codeRow) return { recorded: false, reason: 'code_not_found' };

  const result = database.prepare(`
    INSERT INTO referral_clicks (
      referral_code_id,
      referrer_user_id,
      code_snapshot,
      anonymous_id,
      ip_hash,
      user_agent_hash,
      referrer_url,
      landing_path,
      utm_source,
      utm_medium,
      utm_campaign,
      utm_content,
      ttclid,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    RETURNING id
  `).run(
    codeRow.id,
    codeRow.user_id,
    codeRow.code,
    cleanText(anonymousId, 120),
    hashReferralValue(ip),
    hashReferralValue(userAgent),
    cleanText(referrer, 500),
    cleanText(landingPath, 500),
    cleanQueryValue(query.utm_source),
    cleanQueryValue(query.utm_medium),
    cleanQueryValue(query.utm_campaign),
    cleanQueryValue(query.utm_content),
    cleanQueryValue(query.ttclid)
  );

  const inserted = firstRow(result);
  return inserted
    ? { recorded: true, clickId: inserted.id, code: codeRow.code, referrerUserId: codeRow.user_id }
    : { recorded: false, reason: 'insert_failed' };
}

export function recordReferralAttribution(database, { referralCode, referredUserId, signupMethod = 'unknown', referralClickId = null } = {}) {
  const validation = validateReferralCode(referralCode);
  if (!validation.ok || !referredUserId) return { recorded: false, reason: validation.ok ? 'missing_user' : 'invalid_code' };

  const codeRow = database.prepare('SELECT * FROM streamer_referral_codes WHERE UPPER(code) = ? LIMIT 1').get(validation.code);
  if (!codeRow) return { recorded: false, reason: 'code_not_found' };
  if (Number(codeRow.user_id) === Number(referredUserId)) return { recorded: false, reason: 'self_referral' };

  const clickId = referralClickIdValue(referralClickId);
  const clickRow = clickId
    ? database.prepare('SELECT * FROM referral_clicks WHERE id = ? AND referral_code_id = ? LIMIT 1').get(clickId, codeRow.id)
    : null;
  const lockedMonthlyRewardCents = monthlyRewardCentsForNewReferral();
  const foundingLockedAt = foundingRateOpen() ? formatDateForSql(new Date()) : null;

  const result = database.prepare(`
    INSERT INTO referral_attributions (
      referral_code_id, referrer_user_id, referred_user_id, referral_click_id, code_snapshot, signup_method,
      status, signup_at, recurring_reward_cents, founding_rate_locked_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'signup_pending', CURRENT_TIMESTAMP, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(referred_user_id) DO NOTHING
    RETURNING id
  `).run(
    codeRow.id,
    codeRow.user_id,
    referredUserId,
    clickRow?.id || null,
    codeRow.code,
    String(signupMethod || 'unknown').slice(0, 40),
    lockedMonthlyRewardCents,
    foundingLockedAt
  );

  const inserted = firstRow(result);
  if (!inserted) return { recorded: false, reason: 'already_attributed' };

  if (clickRow?.id) {
    database.prepare(`
      UPDATE referral_clicks
      SET converted_user_id = ?, converted_at = COALESCE(converted_at, CURRENT_TIMESTAMP), updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(referredUserId, clickRow.id);
  }

  return {
    recorded: true,
    attributionId: inserted.id,
    referrerUserId: codeRow.user_id,
    referralClickId: clickRow?.id || null,
  };
}

function createCouncilMonthlyReward(database, { attribution, subscription, now = new Date(), notes = '' } = {}) {
  if (!attribution?.id || !attribution?.referrer_user_id || !attribution?.referred_user_id || !subscription?.id) {
    return { created: false, reason: 'missing_reward_context' };
  }
  const period = monthPeriodRange(now);
  const amount = rewardAmountCents(attribution.recurring_reward_cents, monthlyRewardCentsForNewReferral());
  const result = database.prepare(`
    INSERT INTO referral_recurring_rewards (
      attribution_id,
      referrer_user_id,
      referred_user_id,
      subscription_id,
      period_start,
      period_end,
      status,
      amount_cents,
      currency,
      founding_rate_locked,
      notes,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'pending_review', ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(attribution_id, period_start) DO NOTHING
    RETURNING id
  `).run(
    attribution.id,
    attribution.referrer_user_id,
    attribution.referred_user_id,
    subscription.id,
    period.startSql,
    period.endSql,
    amount,
    rewardCurrency(),
    attribution.founding_rate_locked_at ? 1 : 0,
    cleanNotes(notes || 'Council monthly referral reward.')
  );
  const row = firstRow(result);
  return { created: Boolean(row), id: row?.id || null, periodStart: period.startSql, amountCents: amount };
}

function ensureCouncilYearBonusClaim(database, userId, options = {}) {
  if (!userId) return { created: false, reason: 'missing_user' };
  const origin = database.prepare('SELECT * FROM referral_attributions WHERE referred_user_id = ? LIMIT 1').get(userId);
  if (!origin) return { created: false, reason: 'not_recruited_creator' };

  const qualified = database.prepare(`
    SELECT COUNT(DISTINCT a.id) AS count
    FROM referral_attributions a
    JOIN subscriptions s ON s.user_id = a.referred_user_id
      AND LOWER(s.status) = 'active'
      AND COALESCE(s.admin_granted, 0) = 0
      AND s.paypal_subscription_id IS NOT NULL
    WHERE a.referrer_user_id = ?
      AND a.status = 'qualified'
  `).get(userId);
  const activeCount = numberValue(qualified?.count);
  if (activeCount < COUNCIL_RECRUIT_YEAR_BONUS_THRESHOLD) {
    return { created: false, reason: 'threshold_not_met', activeCount };
  }

  const notes = cleanNotes(options.notes || `Creator reached ${activeCount} active paid referrals and can claim one full year free.`);
  const result = database.prepare(`
    INSERT INTO council_year_bonus_claims (
      user_id,
      originating_referrer_user_id,
      originating_attribution_id,
      trigger_referral_count,
      status,
      grant_months,
      notes,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, 'pending_review', 12, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(user_id) DO NOTHING
    RETURNING id
  `).run(
    userId,
    origin.referrer_user_id,
    origin.id,
    activeCount,
    notes
  );
  const row = firstRow(result);
  return { created: Boolean(row), id: row?.id || null, activeCount };
}

export function qualifyReferralForUser(database, referredUserId, options = {}) {
  if (!referredUserId) return { qualified: false, reason: 'missing_user' };
  const attribution = database.prepare('SELECT * FROM referral_attributions WHERE referred_user_id = ? LIMIT 1').get(referredUserId);
  if (!attribution) return { qualified: false, reason: 'no_attribution' };

  const activePaidSubscription = database.prepare(`
    SELECT id, paypal_subscription_id, started_at, created_at, updated_at
    FROM subscriptions
    WHERE user_id = ?
      AND LOWER(status) = 'active'
      AND COALESCE(admin_granted, 0) = 0
      AND paypal_subscription_id IS NOT NULL
    ORDER BY updated_at DESC, created_at DESC
    LIMIT 1
  `).get(referredUserId);
  if (!activePaidSubscription) return { qualified: false, reason: 'no_active_paid_subscription' };

  const alreadyQualified = String(attribution.status || '') === 'qualified';
  const monthlyRateCents = rewardAmountCents(attribution.recurring_reward_cents, monthlyRewardCentsForNewReferral());
  const foundingLockedAt = attribution.founding_rate_locked_at || (foundingRateOpen() ? formatDateForSql(new Date()) : null);

  if (!alreadyQualified) {
    database.prepare(`
      UPDATE referral_attributions
      SET status = 'qualified',
          qualified_at = COALESCE(qualified_at, CURRENT_TIMESTAMP),
          recurring_reward_cents = COALESCE(recurring_reward_cents, ?),
          founding_rate_locked_at = COALESCE(founding_rate_locked_at, ?),
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(monthlyRateCents, foundingLockedAt, attribution.id);
  }

  const notes = cleanNotes(options.notes || `Council founding monthly reward locked at ${monthlyRateCents} cents while this paid subscription stays active.`);
  const result = database.prepare(`
    INSERT INTO referral_rewards (
      attribution_id, referrer_user_id, referred_user_id, status, amount_cents, currency, notes, created_at, updated_at
    ) VALUES (?, ?, ?, 'pending_review', ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(attribution_id) DO NOTHING
    RETURNING id
  `).run(
    attribution.id,
    attribution.referrer_user_id,
    attribution.referred_user_id,
    monthlyRateCents,
    rewardCurrency(),
    notes
  );
  const monthlyReward = createCouncilMonthlyReward(database, {
    attribution: { ...attribution, recurring_reward_cents: monthlyRateCents, founding_rate_locked_at: foundingLockedAt },
    subscription: activePaidSubscription,
    now: options.now || new Date(),
    notes,
  });
  ensureCouncilYearBonusClaim(database, attribution.referrer_user_id, { now: options.now || new Date() });

  return {
    qualified: true,
    attributionId: attribution.id,
    rewardCreated: Boolean(firstRow(result)),
    monthlyRewardCreated: monthlyReward.created,
    monthlyRewardId: monthlyReward.id || null,
  };
}

export function settleClearedReferralRewards(database, options = {}) {
  const safeLimit = Math.max(1, Math.min(500, Math.round(numberValue(options.limit, 200))));
  const clauses = ["COALESCE(a.status, 'signup_pending') <> 'disqualified'"];
  const params = [];
  if (options.referrerUserId) {
    clauses.push('a.referrer_user_id = ?');
    params.push(options.referrerUserId);
  }
  params.push(safeLimit);

  const rows = database.prepare(`
    SELECT a.referred_user_id
    FROM referral_attributions a
    JOIN subscriptions s ON s.user_id = a.referred_user_id
      AND LOWER(s.status) = 'active'
      AND COALESCE(s.admin_granted, 0) = 0
      AND s.paypal_subscription_id IS NOT NULL
    WHERE ${clauses.join(' AND ')}
    GROUP BY a.id
    ORDER BY MIN(COALESCE(s.started_at, s.created_at, s.updated_at)) ASC
    LIMIT ?
  `).all(...params);

  let settled = 0;
  let pending = 0;
  for (const row of rows) {
    const result = qualifyReferralForUser(database, row.referred_user_id, {
      source: 'monthly_founder_rate',
      notes: 'Council monthly referral reward accrued for an active paid subscriber.',
      now: options.now || new Date(),
    });
    if (result.qualified) settled += 1;
    else pending += 1;
  }
  return { checked: rows.length, settled, pending };
}

export function listReferralAdminRows(database, options = {}) {
  settleClearedReferralRewards(database, { limit: 500, now: options.now });
  const config = typeof options === 'number' ? { limit: options } : (options || {});
  const safeLimit = Math.max(1, Math.min(500, Math.round(numberValue(config.limit, 200))));
  const clauses = [];
  const params = [];
  const status = cleanText(config.status, 40).toLowerCase();
  const search = cleanText(config.search, 120).toLowerCase();
  const code = normalizeReferralCode(config.code);

  if (status) {
    clauses.push('(LOWER(a.status) = ? OR LOWER(COALESCE(rr.status, ?)) = ?)');
    params.push(status, 'waiting_for_paid_conversion', status);
  }
  if (code) {
    clauses.push('UPPER(a.code_snapshot) LIKE ?');
    params.push(`%${code}%`);
  }
  if (search) {
    clauses.push(`(
      LOWER(COALESCE(a.code_snapshot, '')) LIKE ?
      OR LOWER(COALESCE(referrer.email, '')) LIKE ?
      OR LOWER(COALESCE(referrer.name, '')) LIKE ?
      OR LOWER(COALESCE(referrer.tiktok_username, '')) LIKE ?
      OR LOWER(COALESCE(referred.email, '')) LIKE ?
      OR LOWER(COALESCE(referred.name, '')) LIKE ?
      OR LOWER(COALESCE(referred.tiktok_username, '')) LIKE ?
    )`);
    const like = `%${search}%`;
    params.push(like, like, like, like, like, like, like);
  }

  params.push(safeLimit);
  return database.prepare(`
    SELECT
      a.id AS attribution_id,
      a.status AS attribution_status,
      a.referral_click_id,
      a.signup_method,
      a.code_snapshot,
      a.signup_at,
      a.qualified_at,
      a.created_at,
      c.created_at AS click_at,
      c.utm_source,
      c.utm_medium,
      c.utm_campaign,
      c.ttclid,
      r.id AS reward_id,
      r.status AS reward_status,
      r.amount_cents,
      r.currency,
      r.notes,
      r.approved_at,
      r.rejected_at,
      r.paid_at,
      rr.id AS monthly_reward_id,
      rr.status AS monthly_reward_status,
      rr.amount_cents AS monthly_amount_cents,
      rr.currency AS monthly_currency,
      rr.period_start AS monthly_period_start,
      rr.period_end AS monthly_period_end,
      rr.approved_at AS monthly_approved_at,
      rr.rejected_at AS monthly_rejected_at,
      rr.paid_at AS monthly_paid_at,
      rr.notes AS monthly_notes,
      referrer.id AS referrer_id,
      referrer.email AS referrer_email,
      referrer.name AS referrer_name,
      referrer.tiktok_username AS referrer_tiktok,
      referred.id AS referred_id,
      referred.email AS referred_email,
      referred.name AS referred_name,
      referred.tiktok_username AS referred_tiktok,
      s.paypal_subscription_id AS active_paypal_subscription_id,
      s.started_at AS subscription_started_at,
      s.created_at AS subscription_created_at,
      s.updated_at AS subscription_updated_at
    FROM referral_attributions a
    LEFT JOIN referral_rewards r ON r.attribution_id = a.id
    LEFT JOIN referral_recurring_rewards rr ON rr.id = (
      SELECT rr2.id
      FROM referral_recurring_rewards rr2
      WHERE rr2.attribution_id = a.id
      ORDER BY rr2.period_start DESC, rr2.created_at DESC
      LIMIT 1
    )
    LEFT JOIN referral_clicks c ON c.id = a.referral_click_id
    LEFT JOIN users referrer ON referrer.id = a.referrer_user_id
    LEFT JOIN users referred ON referred.id = a.referred_user_id
    LEFT JOIN subscriptions s ON s.id = (
      SELECT s2.id
      FROM subscriptions s2
      WHERE s2.user_id = a.referred_user_id
        AND LOWER(s2.status) = 'active'
        AND COALESCE(s2.admin_granted, 0) = 0
        AND s2.paypal_subscription_id IS NOT NULL
      ORDER BY s2.updated_at DESC, s2.created_at DESC
      LIMIT 1
    )
    ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
    ORDER BY a.created_at DESC
    LIMIT ?
  `).all(...params).map(row => ({
    ...row,
    reward_status: row.monthly_reward_status || row.reward_status,
    amount_cents: row.monthly_amount_cents ?? row.amount_cents,
    currency: row.monthly_currency || row.currency,
    approved_at: row.monthly_approved_at || row.approved_at,
    rejected_at: row.monthly_rejected_at || row.rejected_at,
    paid_at: row.monthly_paid_at || row.paid_at,
    notes: row.monthly_notes || row.notes,
  }));
}

export function updateReferralRewardStatus(database, rewardId, status, patch = {}) {
  const id = Number(rewardId);
  if (!Number.isInteger(id) || id <= 0) throw referralError('Invalid reward id.', 400);
  const nextStatus = String(status || '').trim().toLowerCase();
  if (!['pending_review', 'approved', 'rejected', 'paid'].includes(nextStatus)) {
    throw referralError('Invalid reward status.', 400);
  }

  const reward = database.prepare('SELECT * FROM referral_rewards WHERE id = ? LIMIT 1').get(id);
  if (!reward) throw referralError('Reward not found.', 404);

  const amount = rewardAmountCents(patch.amountCents, numberValue(reward.amount_cents));
  const notes = cleanNotes(patch.notes || reward.notes || '');

  if (nextStatus === 'approved') {
    database.prepare(`
      UPDATE referral_rewards
      SET status = 'approved', amount_cents = ?, notes = ?, approved_at = COALESCE(approved_at, CURRENT_TIMESTAMP), updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(amount, notes, id);
  } else if (nextStatus === 'paid') {
    database.prepare(`
      UPDATE referral_rewards
      SET status = 'paid', amount_cents = ?, notes = ?, approved_at = COALESCE(approved_at, CURRENT_TIMESTAMP), paid_at = COALESCE(paid_at, CURRENT_TIMESTAMP), updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(amount, notes, id);
  } else if (nextStatus === 'rejected') {
    database.prepare(`
      UPDATE referral_rewards
      SET status = 'rejected', amount_cents = ?, notes = ?, rejected_at = COALESCE(rejected_at, CURRENT_TIMESTAMP), updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(amount, notes, id);
  } else {
    database.prepare(`
      UPDATE referral_rewards
      SET status = 'pending_review', amount_cents = ?, notes = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(amount, notes, id);
  }

  return database.prepare('SELECT * FROM referral_rewards WHERE id = ? LIMIT 1').get(id);
}

export function updateRecurringReferralRewardStatus(database, rewardId, status, patch = {}) {
  const id = Number(rewardId);
  if (!Number.isInteger(id) || id <= 0) throw referralError('Invalid monthly reward id.', 400);
  const nextStatus = String(status || '').trim().toLowerCase();
  if (!['pending_review', 'approved', 'rejected', 'paid'].includes(nextStatus)) {
    throw referralError('Invalid monthly reward status.', 400);
  }

  const reward = database.prepare('SELECT * FROM referral_recurring_rewards WHERE id = ? LIMIT 1').get(id);
  if (!reward) throw referralError('Monthly reward not found.', 404);

  const amount = rewardAmountCents(patch.amountCents, numberValue(reward.amount_cents));
  const notes = cleanNotes(patch.notes || reward.notes || '');

  if (nextStatus === 'approved') {
    database.prepare(`
      UPDATE referral_recurring_rewards
      SET status = 'approved', amount_cents = ?, notes = ?, approved_at = COALESCE(approved_at, CURRENT_TIMESTAMP), updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(amount, notes, id);
  } else if (nextStatus === 'paid') {
    database.prepare(`
      UPDATE referral_recurring_rewards
      SET status = 'paid', amount_cents = ?, notes = ?, approved_at = COALESCE(approved_at, CURRENT_TIMESTAMP), paid_at = COALESCE(paid_at, CURRENT_TIMESTAMP), updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(amount, notes, id);
  } else if (nextStatus === 'rejected') {
    database.prepare(`
      UPDATE referral_recurring_rewards
      SET status = 'rejected', amount_cents = ?, notes = ?, rejected_at = COALESCE(rejected_at, CURRENT_TIMESTAMP), updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(amount, notes, id);
  } else {
    database.prepare(`
      UPDATE referral_recurring_rewards
      SET status = 'pending_review', amount_cents = ?, notes = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(amount, notes, id);
  }

  return database.prepare('SELECT * FROM referral_recurring_rewards WHERE id = ? LIMIT 1').get(id);
}

export function listCouncilYearBonusClaims(database, options = {}) {
  const safeLimit = Math.max(1, Math.min(500, Math.round(numberValue(options.limit, 100))));
  return database.prepare(`
    SELECT
      claim.*,
      user.email AS user_email,
      user.name AS user_name,
      user.tiktok_username AS user_tiktok,
      origin.code_snapshot AS originating_code,
      referrer.email AS originating_referrer_email,
      referrer.name AS originating_referrer_name,
      referrer.tiktok_username AS originating_referrer_tiktok
    FROM council_year_bonus_claims claim
    LEFT JOIN users user ON user.id = claim.user_id
    LEFT JOIN referral_attributions origin ON origin.id = claim.originating_attribution_id
    LEFT JOIN users referrer ON referrer.id = claim.originating_referrer_user_id
    ORDER BY claim.created_at DESC
    LIMIT ?
  `).all(safeLimit);
}

export function getCouncilYearBonusClaim(database, claimId) {
  const id = Number(claimId);
  if (!Number.isInteger(id) || id <= 0) throw referralError('Invalid one-year bonus claim id.', 400);
  const claim = database.prepare(`
    SELECT
      claim.*,
      user.email AS user_email,
      user.name AS user_name,
      user.tiktok_username AS user_tiktok
    FROM council_year_bonus_claims claim
    LEFT JOIN users user ON user.id = claim.user_id
    WHERE claim.id = ?
    LIMIT 1
  `).get(id);
  if (!claim) throw referralError('One-year bonus claim not found.', 404);
  return claim;
}

export function updateCouncilYearBonusClaimStatus(database, claimId, status, patch = {}) {
  const id = Number(claimId);
  if (!Number.isInteger(id) || id <= 0) throw referralError('Invalid one-year bonus claim id.', 400);
  const nextStatus = String(status || '').trim().toLowerCase();
  if (!['pending_review', 'approved', 'rejected', 'granted'].includes(nextStatus)) {
    throw referralError('Invalid one-year bonus status.', 400);
  }

  const claim = getCouncilYearBonusClaim(database, id);
  const notes = cleanNotes(patch.notes || claim.notes || '');
  if (nextStatus === 'approved') {
    database.prepare(`
      UPDATE council_year_bonus_claims
      SET status = 'approved',
          notes = ?,
          approved_at = COALESCE(approved_at, CURRENT_TIMESTAMP),
          rejected_at = NULL,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(notes, id);
  } else if (nextStatus === 'granted') {
    database.prepare(`
      UPDATE council_year_bonus_claims
      SET status = 'granted',
          notes = ?,
          approved_at = COALESCE(approved_at, CURRENT_TIMESTAMP),
          granted_at = COALESCE(granted_at, CURRENT_TIMESTAMP),
          rejected_at = NULL,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(notes, id);
  } else if (nextStatus === 'rejected') {
    database.prepare(`
      UPDATE council_year_bonus_claims
      SET status = 'rejected',
          notes = ?,
          rejected_at = COALESCE(rejected_at, CURRENT_TIMESTAMP),
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(notes, id);
  } else {
    database.prepare(`
      UPDATE council_year_bonus_claims
      SET status = 'pending_review',
          notes = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(notes, id);
  }

  return getCouncilYearBonusClaim(database, id);
}
