function cleanText(value, maxLength = 300) {
  return String(value || '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

export function getActiveCouncilMembership(database, userId) {
  if (!userId) return null;
  return database.prepare(`
    SELECT cm.*
    FROM council_memberships cm
    JOIN users u ON u.id = cm.user_id
    WHERE cm.user_id = ?
      AND cm.status = 'active'
      AND COALESCE(u.is_active, 0) = 1
      AND u.banned_at IS NULL
    ORDER BY cm.appointed_at DESC, cm.id DESC
    LIMIT 1
  `).get(userId) || null;
}

export function getCouncilMembershipStatus(database, userId) {
  if (!userId) return { status: 'regular', eligible: false };
  const row = database.prepare(`
    SELECT cm.*
    FROM council_memberships cm
    WHERE cm.user_id = ?
    ORDER BY cm.appointed_at DESC, cm.id DESC
    LIMIT 1
  `).get(userId) || null;
  const active = getActiveCouncilMembership(database, userId);
  return {
    status: active ? 'active' : 'regular',
    eligible: Boolean(active),
    appointedAt: active?.appointed_at || row?.appointed_at || null,
    removedAt: active ? null : row?.removed_at || null,
  };
}

export function appointCouncilMember(database, userId, options = {}) {
  const user = database.prepare('SELECT * FROM users WHERE id = ? LIMIT 1').get(userId);
  if (!user) throw new Error('Account not found');
  if (Number(user.is_active) !== 1 || user.banned_at) throw new Error('Only active, non-banned accounts can join the Council');

  return database.transaction(() => {
    const existing = getActiveCouncilMembership(database, user.id);
    if (existing) return { created: false, membership: existing, user };
    const result = database.prepare(`
      INSERT INTO council_memberships (
        user_id, status, appointed_by, appointment_note, appointed_at, created_at, updated_at
      ) VALUES (?, 'active', ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      RETURNING *
    `).run(user.id, cleanText(options.appointedBy || 'shared_admin'), cleanText(options.note));
    database.prepare(`
      UPDATE streamer_referral_codes
      SET is_active = 1, activated_at = CURRENT_TIMESTAMP, disabled_at = NULL,
          disabled_reason = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE user_id = ?
    `).run(user.id);
    return { created: true, membership: result?.rows?.[0] || null, user };
  })();
}

export function removeCouncilMember(database, userId, options = {}) {
  const reason = cleanText(options.reason);
  if (!reason) throw new Error('A removal reason is required');
  const user = database.prepare('SELECT * FROM users WHERE id = ? LIMIT 1').get(userId);
  if (!user) throw new Error('Account not found');

  return database.transaction(() => {
    const active = getActiveCouncilMembership(database, user.id);
    if (!active) return { removed: false, user };
    database.prepare(`
      UPDATE council_memberships
      SET status = 'removed', removed_at = CURRENT_TIMESTAMP, removed_by = ?,
          removal_reason = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(cleanText(options.removedBy || 'shared_admin'), reason, active.id);
    database.prepare(`
      UPDATE streamer_referral_codes
      SET is_active = 0, disabled_at = CURRENT_TIMESTAMP, disabled_reason = ?, updated_at = CURRENT_TIMESTAMP
      WHERE user_id = ?
    `).run(reason, user.id);
    return { removed: true, user };
  })();
}

export function listCouncilMembers(database, limit = 200) {
  return database.prepare(`
    SELECT
      cm.id AS membership_id, cm.status AS membership_status, cm.appointed_at, cm.removed_at,
      cm.appointment_note, cm.removal_reason, u.id AS user_id, u.email, u.name, u.tiktok_username,
      u.is_active, u.banned_at, src.code, src.is_active AS code_is_active,
      (SELECT COUNT(*) FROM referral_attributions a WHERE a.referrer_user_id = u.id) AS referral_count,
      (SELECT COALESCE(SUM(rr.amount_cents), 0) FROM referral_recurring_rewards rr WHERE rr.referrer_user_id = u.id) AS reward_cents
    FROM council_memberships cm
    JOIN users u ON u.id = cm.user_id
    LEFT JOIN streamer_referral_codes src ON src.user_id = u.id
    WHERE cm.id = (
      SELECT cm2.id FROM council_memberships cm2
      WHERE cm2.user_id = cm.user_id
      ORDER BY cm2.appointed_at DESC, cm2.id DESC LIMIT 1
    )
    ORDER BY CASE WHEN cm.status = 'active' THEN 0 ELSE 1 END, cm.appointed_at DESC
    LIMIT ?
  `).all(Math.max(1, Math.min(500, Number(limit) || 200)));
}
