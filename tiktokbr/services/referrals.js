export const REFERRAL_CODE_COOLDOWN_HOURS = 234;
export const REFERRAL_CODE_COOLDOWN_MS = REFERRAL_CODE_COOLDOWN_HOURS * 60 * 60 * 1000;

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

function rewardAmountCents(value, fallback = defaultRewardAmountCents()) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(0, Math.min(10000000, Math.round(number)));
}

function defaultRewardAmountCents() {
  return rewardAmountCents(process.env.REFERRAL_REWARD_DEFAULT_CENTS, 0);
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
  if (!base) return `/signup?ref=${encodeURIComponent(normalized)}`;
  try {
    const url = new URL('/signup', base);
    url.searchParams.set('ref', normalized);
    return url.toString();
  } catch (_err) {
    return `/signup?ref=${encodeURIComponent(normalized)}`;
  }
}

export function getReferralCodeForUser(database, userId) {
  if (!userId) return null;
  return database.prepare('SELECT * FROM streamer_referral_codes WHERE user_id = ? LIMIT 1').get(userId) || null;
}

export function getReferralSummary(database, user, options = {}) {
  if (!user?.id) throw referralError('Unauthorized', 401);
  const codeRow = getReferralCodeForUser(database, user.id);
  const code = codeRow?.code || '';
  const statusRows = database.prepare(`
    SELECT status, COUNT(*) AS count
    FROM referral_attributions
    WHERE referrer_user_id = ?
    GROUP BY status
  `).all(user.id);
  const rewardRows = database.prepare(`
    SELECT status, COUNT(*) AS count, COALESCE(SUM(amount_cents), 0) AS amount_cents
    FROM referral_rewards
    WHERE referrer_user_id = ?
    GROUP BY status
  `).all(user.id);
  const recent = database.prepare(`
    SELECT status, signup_method, code_snapshot, signup_at, qualified_at, created_at
    FROM referral_attributions
    WHERE referrer_user_id = ?
    ORDER BY created_at DESC
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
  };

  for (const row of statusRows) {
    const count = numberValue(row.count);
    stats.signups += count;
    if (String(row.status || '') === 'qualified') stats.qualified += count;
  }

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

  return {
    code,
    hasCode: Boolean(code),
    suggestedCode: suggestedReferralCode(user),
    shareUrl: buildReferralShareUrl(options.baseUrl, code),
    cooldownHours: REFERRAL_CODE_COOLDOWN_HOURS,
    resetAvailableAt: codeRow?.reset_available_at || null,
    resetCountdownSeconds: secondsUntilReferralReset(codeRow),
    canReset: codeRow ? canResetReferralCode(codeRow) : true,
    resetCount: numberValue(codeRow?.reset_count),
    stats,
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

export function recordReferralAttribution(database, { referralCode, referredUserId, signupMethod = 'unknown' } = {}) {
  const validation = validateReferralCode(referralCode);
  if (!validation.ok || !referredUserId) return { recorded: false, reason: validation.ok ? 'missing_user' : 'invalid_code' };

  const codeRow = database.prepare('SELECT * FROM streamer_referral_codes WHERE UPPER(code) = ? LIMIT 1').get(validation.code);
  if (!codeRow) return { recorded: false, reason: 'code_not_found' };
  if (Number(codeRow.user_id) === Number(referredUserId)) return { recorded: false, reason: 'self_referral' };

  const result = database.prepare(`
    INSERT INTO referral_attributions (
      referral_code_id, referrer_user_id, referred_user_id, code_snapshot, signup_method,
      status, signup_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'signup_pending', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(referred_user_id) DO NOTHING
    RETURNING id
  `).run(
    codeRow.id,
    codeRow.user_id,
    referredUserId,
    codeRow.code,
    String(signupMethod || 'unknown').slice(0, 40)
  );

  const inserted = firstRow(result);
  return inserted
    ? { recorded: true, attributionId: inserted.id, referrerUserId: codeRow.user_id }
    : { recorded: false, reason: 'already_attributed' };
}

export function qualifyReferralForUser(database, referredUserId, options = {}) {
  if (!referredUserId) return { qualified: false, reason: 'missing_user' };
  const attribution = database.prepare('SELECT * FROM referral_attributions WHERE referred_user_id = ? LIMIT 1').get(referredUserId);
  if (!attribution) return { qualified: false, reason: 'no_attribution' };

  const activePaidSubscription = database.prepare(`
    SELECT id
    FROM subscriptions
    WHERE user_id = ?
      AND LOWER(status) = 'active'
      AND COALESCE(admin_granted, 0) = 0
      AND paypal_subscription_id IS NOT NULL
    ORDER BY updated_at DESC, created_at DESC
    LIMIT 1
  `).get(referredUserId);
  if (!activePaidSubscription) return { qualified: false, reason: 'no_active_paid_subscription' };

  if (String(attribution.status || '') !== 'qualified') {
    database.prepare(`
      UPDATE referral_attributions
      SET status = 'qualified', qualified_at = COALESCE(qualified_at, CURRENT_TIMESTAMP), updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(attribution.id);
  }

  const notes = cleanNotes(options.notes || `Qualified by ${options.source || 'paid_subscription'}`);
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
    rewardAmountCents(options.amountCents),
    rewardCurrency(),
    notes
  );

  return {
    qualified: true,
    attributionId: attribution.id,
    rewardCreated: Boolean(firstRow(result)),
  };
}

export function listReferralAdminRows(database, limit = 200) {
  const safeLimit = Math.max(1, Math.min(500, Math.round(numberValue(limit, 200))));
  return database.prepare(`
    SELECT
      a.id AS attribution_id,
      a.status AS attribution_status,
      a.signup_method,
      a.code_snapshot,
      a.signup_at,
      a.qualified_at,
      a.created_at,
      r.id AS reward_id,
      r.status AS reward_status,
      r.amount_cents,
      r.currency,
      r.notes,
      r.approved_at,
      r.rejected_at,
      r.paid_at,
      referrer.id AS referrer_id,
      referrer.email AS referrer_email,
      referrer.name AS referrer_name,
      referrer.tiktok_username AS referrer_tiktok,
      referred.id AS referred_id,
      referred.email AS referred_email,
      referred.name AS referred_name,
      referred.tiktok_username AS referred_tiktok
    FROM referral_attributions a
    LEFT JOIN referral_rewards r ON r.attribution_id = a.id
    LEFT JOIN users referrer ON referrer.id = a.referrer_user_id
    LEFT JOIN users referred ON referred.id = a.referred_user_id
    ORDER BY a.created_at DESC
    LIMIT ?
  `).all(safeLimit);
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
