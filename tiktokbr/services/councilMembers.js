import {
  COUNCIL_CASH_PAYOUT_MINIMUM_CENTS,
  buildCouncilProgramSummary,
  centsToUsd,
} from './councilOfAetheris.js';
import {
  claimOrResetReferralCode,
  getReferralCodeForUser,
  getReferralSummary,
  suggestedReferralCode,
} from './referrals.js';

const ACTIVE_MEMBER_STATUSES = new Set(['active', 'hold']);
const MEMBER_STATUS_VALUES = new Set(['active', 'hold', 'suspended']);
const W9_STATUS_VALUES = new Set(['needed', 'requested', 'received', 'not_required']);
const PAYPAL_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function numberValue(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function boolValue(value) {
  return value === true || value === 1 || value === '1' || String(value || '').toLowerCase() === 'true';
}

function firstRow(result) {
  if (Array.isArray(result?.rows)) return result.rows[0] || null;
  if (Array.isArray(result)) return result[0] || null;
  return null;
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function cleanText(value, max = 400) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function safeJson(value) {
  try {
    return JSON.stringify(value || {});
  } catch (_err) {
    return '{}';
  }
}

function payoutProfileComplete(member) {
  return Boolean(member?.paypal_payout_email && PAYPAL_EMAIL_RE.test(String(member.paypal_payout_email)));
}

function normalizeMemberRow(row = null) {
  if (!row) {
    return {
      isMember: false,
      status: 'not_joined',
      joinedAt: null,
      payoutEmail: '',
      payoutProfileComplete: false,
      w9Status: 'needed',
      ftcAcknowledged: false,
      finePrintAcknowledged: false,
      elite: false,
      payoutHoldReason: '',
    };
  }
  return {
    isMember: true,
    id: row.id,
    userId: row.user_id,
    status: row.status || 'active',
    joinedSource: row.joined_source || 'dashboard',
    joinedAt: row.created_at || null,
    payoutEmail: row.paypal_payout_email || '',
    payoutProfileComplete: payoutProfileComplete(row),
    w9Status: row.w9_status || 'needed',
    ftcAcknowledged: Boolean(row.ftc_acknowledged_at),
    finePrintAcknowledged: Boolean(row.fine_print_acknowledged_at),
    elite: Boolean(Number(row.elite || 0)),
    payoutHoldReason: row.payout_hold_reason || '',
    suspendedAt: row.suspended_at || null,
  };
}

export function getCouncilMember(database, userId) {
  if (!userId) return null;
  return database.prepare('SELECT * FROM council_members WHERE user_id = ? LIMIT 1').get(userId) || null;
}

export function recordCouncilAuditEvent(database, action, options = {}) {
  const cleanAction = cleanText(action, 80);
  if (!cleanAction) return null;
  const result = database.prepare(`
    INSERT INTO council_audit_events (action, target_user_id, actor_admin_session_id, details, created_at)
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    RETURNING id
  `).run(
    cleanAction,
    options.targetUserId || null,
    options.actorAdminSessionId ? String(options.actorAdminSessionId).slice(0, 120) : null,
    safeJson(options.details || {})
  );
  return firstRow(result);
}

export function ensureCouncilMember(database, user, options = {}) {
  if (!user?.id) {
    const err = new Error('Unauthorized');
    err.statusCode = 401;
    throw err;
  }
  const source = cleanText(options.source || 'dashboard', 80) || 'dashboard';
  const acknowledge = boolValue(options.acknowledge) || boolValue(options.acceptFinePrint);
  const ackSql = acknowledge ? 'CURRENT_TIMESTAMP' : 'NULL';
  const result = database.prepare(`
    INSERT INTO council_members (
      user_id, status, joined_source, ftc_acknowledged_at, fine_print_acknowledged_at, created_at, updated_at
    ) VALUES (?, 'active', ?, ${ackSql}, ${ackSql}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(user_id) DO UPDATE SET
      status = CASE
        WHEN council_members.status = 'suspended' THEN council_members.status
        ELSE 'active'
      END,
      joined_source = COALESCE(NULLIF(council_members.joined_source, ''), EXCLUDED.joined_source),
      ftc_acknowledged_at = COALESCE(council_members.ftc_acknowledged_at, EXCLUDED.ftc_acknowledged_at),
      fine_print_acknowledged_at = COALESCE(council_members.fine_print_acknowledged_at, EXCLUDED.fine_print_acknowledged_at),
      updated_at = CURRENT_TIMESTAMP
    RETURNING *
  `).run(user.id, source);
  return firstRow(result) || getCouncilMember(database, user.id);
}

function ensureReferralCodeForCouncilMember(database, user, requestedCode = '') {
  const existing = getReferralCodeForUser(database, user.id);
  if (existing?.code) return existing;

  const candidates = [
    requestedCode,
    suggestedReferralCode(user),
    `AETHER${user.id}`,
    `COUNCIL${user.id}`,
  ].filter(Boolean);

  let lastError = null;
  for (const candidate of candidates) {
    try {
      claimOrResetReferralCode(database, user, candidate);
      return getReferralCodeForUser(database, user.id);
    } catch (err) {
      lastError = err;
      if (err?.statusCode && err.statusCode !== 409) throw err;
    }
  }
  throw lastError || new Error('Unable to create Council referral code.');
}

export function joinCouncilMember(database, user, options = {}) {
  const member = ensureCouncilMember(database, user, options);
  if (String(member?.status || '').toLowerCase() !== 'suspended') {
    ensureReferralCodeForCouncilMember(database, user, options.code || '');
  }
  if (options.audit !== false) {
    recordCouncilAuditEvent(database, 'member_joined', {
      targetUserId: user.id,
      details: { source: options.source || 'dashboard' },
    });
  }
  return member;
}

export function updateCouncilPayoutProfile(database, user, input = {}) {
  if (!user?.id) {
    const err = new Error('Unauthorized');
    err.statusCode = 401;
    throw err;
  }
  const paypalEmail = normalizeEmail(input.paypalPayoutEmail || input.paypal_payout_email || input.paypalEmail);
  if (!paypalEmail || !PAYPAL_EMAIL_RE.test(paypalEmail)) {
    const err = new Error('Enter a valid PayPal payout email.');
    err.statusCode = 400;
    throw err;
  }
  return database.transaction(() => {
    ensureCouncilMember(database, user, {
      source: input.source || 'payout_profile',
      acknowledge: input.acknowledge !== false,
    });
    database.prepare(`
      UPDATE council_members
      SET paypal_payout_email = ?,
          ftc_acknowledged_at = COALESCE(ftc_acknowledged_at, CURRENT_TIMESTAMP),
          fine_print_acknowledged_at = COALESCE(fine_print_acknowledged_at, CURRENT_TIMESTAMP),
          updated_at = CURRENT_TIMESTAMP
      WHERE user_id = ?
    `).run(paypalEmail, user.id);
    recordCouncilAuditEvent(database, 'member_payout_profile_updated', {
      targetUserId: user.id,
      details: { payoutEmailSet: true },
    });
    return getCouncilMember(database, user.id);
  })();
}

export function getCouncilMemberSummary(database, user, options = {}) {
  const member = getCouncilMember(database, user?.id);
  const referral = getReferralSummary(database, user, {
    baseUrl: options.baseUrl,
    settleRewards: options.settleRewards,
    now: options.now,
  });
  const approvedAmount = numberValue(referral.stats?.approvedAmountCents);
  const payoutMinimum = COUNCIL_CASH_PAYOUT_MINIMUM_CENTS;
  const progressPercent = payoutMinimum > 0
    ? Math.max(0, Math.min(100, Math.round((approvedAmount / payoutMinimum) * 100)))
    : 100;
  const publicMember = normalizeMemberRow(member);
  const eligible = Boolean(
    publicMember.isMember &&
    publicMember.status === 'active' &&
    publicMember.payoutProfileComplete &&
    ['received', 'not_required'].includes(publicMember.w9Status) &&
    approvedAmount >= payoutMinimum
  );

  return {
    member: publicMember,
    referral,
    payout: {
      minimumCents: payoutMinimum,
      minimumLabel: centsToUsd(payoutMinimum),
      approvedUnpaidCents: approvedAmount,
      approvedUnpaidLabel: centsToUsd(approvedAmount),
      progressPercent,
      eligible,
      blockedReason: eligible ? '' : payoutBlockedReason(publicMember, approvedAmount),
    },
    program: buildCouncilProgramSummary(referral.stats || {}, {
      elite: Boolean(publicMember.elite),
      monthlyEarningsCents: referral.stats?.monthlyProjectedCents || 0,
    }),
  };
}

function payoutBlockedReason(member, approvedAmount) {
  if (!member.isMember) return 'Join the Council to unlock payout tracking.';
  if (member.status === 'suspended') return 'Council account is suspended.';
  if (member.status === 'hold') return member.payoutHoldReason || 'Payouts are on hold.';
  if (!member.payoutProfileComplete) return 'Add a PayPal payout email.';
  if (!['received', 'not_required'].includes(member.w9Status)) return 'W-9 review is required before the first payout.';
  if (approvedAmount < COUNCIL_CASH_PAYOUT_MINIMUM_CENTS) return `Approved rewards must reach ${centsToUsd(COUNCIL_CASH_PAYOUT_MINIMUM_CENTS)}.`;
  return '';
}

export function listCouncilMembersForAdmin(database, options = {}) {
  const safeLimit = Math.max(1, Math.min(500, Math.round(numberValue(options.limit, 200))));
  return database.prepare(`
    SELECT
      cm.*,
      u.email,
      u.name,
      u.tiktok_username,
      rc.code,
      (
        SELECT COUNT(*)
        FROM referral_attributions a
        WHERE a.referrer_user_id = cm.user_id
      ) AS signup_count,
      (
        SELECT COUNT(DISTINCT a.id)
        FROM referral_attributions a
        JOIN subscriptions s ON s.user_id = a.referred_user_id
          AND LOWER(s.status) = 'active'
          AND COALESCE(s.admin_granted, 0) = 0
          AND s.paypal_subscription_id IS NOT NULL
        WHERE a.referrer_user_id = cm.user_id
          AND a.status = 'qualified'
      ) AS active_paid_count,
      (
        SELECT COALESCE(SUM(rr.amount_cents), 0)
        FROM referral_recurring_rewards rr
        WHERE rr.referrer_user_id = cm.user_id
          AND rr.status = 'pending_review'
      ) AS pending_cents,
      (
        SELECT COALESCE(SUM(rr.amount_cents), 0)
        FROM referral_recurring_rewards rr
        WHERE rr.referrer_user_id = cm.user_id
          AND rr.status = 'approved'
          AND NOT EXISTS (SELECT 1 FROM council_payout_items cpi WHERE cpi.reward_id = rr.id)
      ) AS approved_unbatched_cents,
      (
        SELECT COALESCE(SUM(rr.amount_cents), 0)
        FROM referral_recurring_rewards rr
        WHERE rr.referrer_user_id = cm.user_id
          AND rr.status = 'paid'
      ) AS paid_cents
    FROM council_members cm
    JOIN users u ON u.id = cm.user_id
    LEFT JOIN streamer_referral_codes rc ON rc.user_id = cm.user_id
    ORDER BY cm.updated_at DESC, cm.created_at DESC
    LIMIT ?
  `).all(safeLimit);
}

export function updateCouncilMemberAdmin(database, userId, patch = {}, options = {}) {
  const id = Math.round(numberValue(userId));
  if (!id) throw new Error('Invalid Council member.');
  const status = String(patch.status || '').trim().toLowerCase();
  const w9Status = String(patch.w9Status || patch.w9_status || '').trim().toLowerCase();
  const holdReason = cleanText(patch.payoutHoldReason || patch.payout_hold_reason || '', 300);
  const elite = boolValue(patch.elite) ? 1 : 0;
  if (!MEMBER_STATUS_VALUES.has(status)) throw new Error('Invalid Council member status.');
  if (!W9_STATUS_VALUES.has(w9Status)) throw new Error('Invalid W-9 status.');

  const member = database.prepare('SELECT * FROM council_members WHERE user_id = ? LIMIT 1').get(id);
  if (!member) throw new Error('Council member not found.');

  database.prepare(`
    UPDATE council_members
    SET status = ?,
        w9_status = ?,
        elite = ?,
        payout_hold_reason = ?,
        suspended_at = CASE WHEN ? = 'suspended' AND suspended_at IS NULL THEN CURRENT_TIMESTAMP WHEN ? <> 'suspended' THEN NULL ELSE suspended_at END,
        updated_at = CURRENT_TIMESTAMP
    WHERE user_id = ?
  `).run(status, w9Status, elite, holdReason, status, status, id);
  recordCouncilAuditEvent(database, 'admin_member_updated', {
    targetUserId: id,
    actorAdminSessionId: options.actorAdminSessionId,
    details: { status, w9Status, elite: Boolean(elite), payoutHoldReason: holdReason },
  });
  return getCouncilMember(database, id);
}

export function listCouncilPayoutBatches(database, options = {}) {
  const safeLimit = Math.max(1, Math.min(100, Math.round(numberValue(options.limit, 20))));
  return database.prepare(`
    SELECT *
    FROM council_payout_batches
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `).all(safeLimit);
}

function eligiblePayoutRewardRows(database) {
  return database.prepare(`
    SELECT
      rr.id AS reward_id,
      rr.referrer_user_id AS member_user_id,
      rr.amount_cents,
      rr.currency,
      rr.period_start,
      rr.period_end,
      cm.paypal_payout_email
    FROM referral_recurring_rewards rr
    JOIN council_members cm ON cm.user_id = rr.referrer_user_id
    WHERE rr.status = 'approved'
      AND cm.status = 'active'
      AND cm.paypal_payout_email IS NOT NULL
      AND cm.paypal_payout_email <> ''
      AND cm.w9_status IN ('received', 'not_required')
      AND COALESCE(cm.payout_hold_reason, '') = ''
      AND NOT EXISTS (SELECT 1 FROM council_payout_items cpi WHERE cpi.reward_id = rr.id)
      AND rr.referrer_user_id IN (
        SELECT rr2.referrer_user_id
        FROM referral_recurring_rewards rr2
        JOIN council_members cm2 ON cm2.user_id = rr2.referrer_user_id
        WHERE rr2.status = 'approved'
          AND cm2.status = 'active'
          AND cm2.paypal_payout_email IS NOT NULL
          AND cm2.paypal_payout_email <> ''
          AND cm2.w9_status IN ('received', 'not_required')
          AND COALESCE(cm2.payout_hold_reason, '') = ''
          AND NOT EXISTS (SELECT 1 FROM council_payout_items cpi2 WHERE cpi2.reward_id = rr2.id)
        GROUP BY rr2.referrer_user_id
        HAVING COALESCE(SUM(rr2.amount_cents), 0) >= ?
      )
    ORDER BY rr.referrer_user_id ASC, rr.period_start ASC, rr.id ASC
  `).all(COUNCIL_CASH_PAYOUT_MINIMUM_CENTS);
}

export function createCouncilPayoutBatch(database, options = {}) {
  return database.transaction(() => {
    const rows = eligiblePayoutRewardRows(database);
    if (!rows.length) {
      return { created: false, reason: 'no_eligible_rewards', batch: null, items: [] };
    }
    const now = options.now instanceof Date ? options.now : new Date();
    const stamp = now.toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
    const batchKey = `COUNCIL-${stamp}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
    const periodStart = rows.reduce((min, row) => (!min || String(row.period_start) < String(min) ? row.period_start : min), rows[0].period_start);
    const periodEnd = rows.reduce((max, row) => (!max || String(row.period_end) > String(max) ? row.period_end : max), rows[0].period_end);
    const totalAmount = rows.reduce((sum, row) => sum + numberValue(row.amount_cents), 0);
    const memberCount = new Set(rows.map(row => Number(row.member_user_id))).size;
    const result = database.prepare(`
      INSERT INTO council_payout_batches (
        batch_key, status, payout_method, period_start, period_end, total_amount_cents,
        member_count, item_count, created_by_admin_session_id, notes, created_at, updated_at
      ) VALUES (?, 'created', 'paypal_csv', ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      RETURNING *
    `).run(
      batchKey,
      periodStart,
      periodEnd,
      totalAmount,
      memberCount,
      rows.length,
      options.actorAdminSessionId ? String(options.actorAdminSessionId).slice(0, 120) : null,
      cleanText(options.notes || 'Manual PayPal CSV payout batch.', 400)
    );
    const batch = firstRow(result);
    if (!batch?.id) throw new Error('Unable to create payout batch.');
    for (const row of rows) {
      database.prepare(`
        INSERT INTO council_payout_items (
          batch_id, member_user_id, reward_id, paypal_payout_email, amount_cents, currency, status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'included', CURRENT_TIMESTAMP)
        ON CONFLICT(reward_id) DO NOTHING
      `).run(
        batch.id,
        row.member_user_id,
        row.reward_id,
        row.paypal_payout_email,
        row.amount_cents,
        row.currency || 'USD'
      );
    }
    recordCouncilAuditEvent(database, 'admin_payout_batch_created', {
      actorAdminSessionId: options.actorAdminSessionId,
      details: { batchId: batch.id, batchKey, itemCount: rows.length, totalAmountCents: totalAmount },
    });
    return { created: true, batch, items: rows };
  })();
}

export function listCouncilPayoutBatchItems(database, batchId) {
  const id = Math.round(numberValue(batchId));
  if (!id) throw new Error('Invalid payout batch.');
  return database.prepare(`
    SELECT
      cpi.*,
      cpb.batch_key,
      u.email AS member_email,
      u.tiktok_username AS member_tiktok
    FROM council_payout_items cpi
    JOIN council_payout_batches cpb ON cpb.id = cpi.batch_id
    JOIN users u ON u.id = cpi.member_user_id
    WHERE cpi.batch_id = ?
    ORDER BY cpi.member_user_id ASC, cpi.id ASC
  `).all(id);
}

export function markCouncilPayoutBatchPaid(database, batchId, options = {}) {
  const id = Math.round(numberValue(batchId));
  if (!id) throw new Error('Invalid payout batch.');
  return database.transaction(() => {
    const batch = database.prepare('SELECT * FROM council_payout_batches WHERE id = ? LIMIT 1').get(id);
    if (!batch) throw new Error('Payout batch not found.');
    const items = listCouncilPayoutBatchItems(database, id);
    for (const item of items) {
      database.prepare(`
        UPDATE referral_recurring_rewards
        SET status = 'paid', paid_at = COALESCE(paid_at, CURRENT_TIMESTAMP), updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(item.reward_id);
    }
    database.prepare(`
      UPDATE council_payout_items
      SET status = 'paid', paid_at = COALESCE(paid_at, CURRENT_TIMESTAMP)
      WHERE batch_id = ?
    `).run(id);
    database.prepare(`
      UPDATE council_payout_batches
      SET status = 'paid', paid_at = COALESCE(paid_at, CURRENT_TIMESTAMP), updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(id);
    recordCouncilAuditEvent(database, 'admin_payout_batch_paid', {
      actorAdminSessionId: options.actorAdminSessionId,
      details: { batchId: id, itemCount: items.length },
    });
    return { paid: true, batchId: id, itemCount: items.length };
  })();
}

export function buildCouncilPayoutCsv(rows = []) {
  const headers = ['PayPal Email', 'Amount', 'Currency', 'Note'];
  const escapeCsv = value => `"${String(value ?? '').replace(/"/g, '""')}"`;
  const lines = [headers.map(escapeCsv).join(',')];
  const grouped = new Map();
  for (const row of rows) {
    const email = String(row.paypal_payout_email || '').trim();
    if (!email) continue;
    const currency = String(row.currency || 'USD').toUpperCase();
    const key = `${email}|${currency}`;
    const current = grouped.get(key) || {
      paypal_payout_email: email,
      currency,
      amount_cents: 0,
      batch_key: row.batch_key || 'Council',
      item_count: 0,
    };
    current.amount_cents += numberValue(row.amount_cents);
    current.item_count += 1;
    grouped.set(key, current);
  }
  for (const row of grouped.values()) {
    const amount = (numberValue(row.amount_cents) / 100).toFixed(2);
    const note = `${row.batch_key || 'Council'} referral payout (${row.item_count} reward${row.item_count === 1 ? '' : 's'})`;
    lines.push([
      row.paypal_payout_email,
      amount,
      row.currency || 'USD',
      note,
    ].map(escapeCsv).join(','));
  }
  return `${lines.join('\n')}\n`;
}

export function councilAdminSummary(members = [], batches = []) {
  return {
    members: members.length,
    active: members.filter(row => String(row.status || '') === 'active').length,
    onHold: members.filter(row => String(row.status || '') === 'hold').length,
    suspended: members.filter(row => String(row.status || '') === 'suspended').length,
    approvedUnbatchedCents: members.reduce((sum, row) => sum + numberValue(row.approved_unbatched_cents), 0),
    pendingReviewCents: members.reduce((sum, row) => sum + numberValue(row.pending_cents), 0),
    paidCents: members.reduce((sum, row) => sum + numberValue(row.paid_cents), 0),
    openBatches: batches.filter(row => String(row.status || '') !== 'paid').length,
  };
}

export function memberCanAccrueCouncilRewards(member) {
  const status = String(member?.status || '').toLowerCase();
  return ACTIVE_MEMBER_STATUSES.has(status);
}
