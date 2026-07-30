import {
  isActiveSubscription,
  isFullAccessTrialSubscription,
} from './entitlements.js';

export const CREATOR_PRO_PLAN_TYPE = 'Creator Pro';
export const FREE_FOREVER_PLAN_TYPE = 'Free Forever';
export const COUNCIL_YEAR_PLAN_TYPE = 'Council Year Free';
export const ADMIN_GRANTED_SUBSCRIPTION_ORDER_SQL = `
  CASE
    WHEN COALESCE(admin_granted, 0) <> 0
     AND LOWER(TRIM(COALESCE(status, ''))) = 'active'
    THEN 0
    WHEN LOWER(TRIM(COALESCE(status, ''))) = 'active'
    THEN 1
    WHEN LOWER(TRIM(COALESCE(status, ''))) IN ('trial', 'trialing', 'free-trial', 'full-access-trial')
    THEN 2
    ELSE 3
  END,
  updated_at DESC NULLS LAST,
  created_at DESC NULLS LAST,
  id DESC
`;

function normalizeUserId(userId) {
  const id = Number(userId);
  return Number.isFinite(id) && id > 0 ? Math.floor(id) : null;
}

function normalizeEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  if (!email) return '';
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : '';
}

function timestampValue(value) {
  if (!value) return 0;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 0 : date.getTime();
}

function formatDateForSql(date = new Date()) {
  const parsed = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 19).replace('T', ' ');
}

function addUtcMonths(date = new Date(), months = 0) {
  const parsed = date instanceof Date ? date : new Date(date);
  const base = Number.isNaN(parsed.getTime()) ? new Date() : parsed;
  const next = new Date(base.getTime());
  next.setUTCMonth(next.getUTCMonth() + Math.max(0, Math.round(Number(months) || 0)));
  return next;
}

function truthyFlag(value) {
  if (value === true) return true;
  if (value === false || value == null) return false;
  if (typeof value === 'number') return value !== 0;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

export function isAdminGrantedSubscription(subscription) {
  return truthyFlag(subscription?.admin_granted);
}

export function isActiveAdminGrantedSubscription(subscription) {
  return isAdminGrantedSubscription(subscription) && isActiveSubscription(subscription);
}

export function compareEffectiveSubscriptions(a, b) {
  const aGrant = isActiveAdminGrantedSubscription(a);
  const bGrant = isActiveAdminGrantedSubscription(b);
  if (aGrant !== bGrant) return aGrant ? -1 : 1;

  const aActive = isActiveSubscription(a);
  const bActive = isActiveSubscription(b);
  if (aActive !== bActive) return aActive ? -1 : 1;

  const aTrial = isFullAccessTrialSubscription(a);
  const bTrial = isFullAccessTrialSubscription(b);
  if (aTrial !== bTrial) return aTrial ? -1 : 1;

  const aUpdated = timestampValue(a?.updated_at || a?.updatedAt);
  const bUpdated = timestampValue(b?.updated_at || b?.updatedAt);
  if (aUpdated !== bUpdated) return bUpdated - aUpdated;

  const aCreated = timestampValue(a?.created_at || a?.createdAt);
  const bCreated = timestampValue(b?.created_at || b?.createdAt);
  if (aCreated !== bCreated) return bCreated - aCreated;

  return (Number(b?.id) || 0) - (Number(a?.id) || 0);
}

export function selectEffectiveSubscription(subscriptions = []) {
  const rows = Array.isArray(subscriptions) ? subscriptions.filter(Boolean) : [];
  return rows.sort(compareEffectiveSubscriptions)[0] || null;
}

export function latestSubscriptionByUser(subscriptions = []) {
  const latest = new Map();
  subscriptions.forEach(subscription => {
    const userId = normalizeUserId(subscription?.user_id);
    if (!userId) return;
    const current = latest.get(userId);
    if (!current || compareEffectiveSubscriptions(subscription, current) < 0) {
      latest.set(userId, subscription);
    }
  });
  return latest;
}

export function getEffectiveUserSubscription(database, userId) {
  const id = normalizeUserId(userId);
  if (!id) return null;
  return database.prepare(`
    SELECT *
    FROM subscriptions
    WHERE user_id = ?
    ORDER BY ${ADMIN_GRANTED_SUBSCRIPTION_ORDER_SQL}
    LIMIT 1
  `).get(id) || null;
}

export function publicSubscriptionView(subscription) {
  if (!subscription) return null;
  const freeForever = (
    String(subscription.plan_type || '').trim().toLowerCase() === FREE_FOREVER_PLAN_TYPE.toLowerCase()
    && String(subscription.status || '').trim().toLowerCase() === 'active'
  );
  return {
    paypal_subscription_id: subscription.paypal_subscription_id || null,
    plan_type: subscription.plan_type || null,
    status: subscription.status || null,
    started_at: subscription.started_at || null,
    next_billing_date: subscription.next_billing_date || null,
    expires_at: subscription.expires_at || null,
    free_forever: freeForever,
    display_plan: freeForever ? 'Free forever' : (subscription.plan_type || null),
  };
}

export function findUserForCreatorProGrant(database, identifier) {
  const raw = String(identifier || '').trim();
  const numericId = /^\d+$/.test(raw) ? normalizeUserId(raw) : null;
  if (numericId) {
    return database.prepare('SELECT * FROM users WHERE id = ?').get(numericId) || null;
  }

  const email = normalizeEmail(raw);
  if (!email) return null;
  return database.prepare('SELECT * FROM users WHERE LOWER(email) = ?').get(email) || null;
}

function listActivePayPalSubscriptions(database, userId) {
  return database.prepare(`
    SELECT *
    FROM subscriptions
    WHERE user_id = ?
      AND paypal_subscription_id IS NOT NULL
      AND paypal_subscription_id <> ''
      AND COALESCE(admin_granted, 0) = 0
      AND LOWER(TRIM(COALESCE(status, ''))) = 'active'
    ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST, id DESC
  `).all(userId);
}

function findAdminGrantSubscription(database, userId) {
  return database.prepare(`
    SELECT *
    FROM subscriptions
    WHERE user_id = ?
      AND COALESCE(admin_granted, 0) <> 0
    ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST, id DESC
    LIMIT 1
  `).get(userId) || null;
}

function markPayPalSubscriptionCancelled(database, subscriptionId) {
  database.prepare(`
    UPDATE subscriptions
    SET status = 'cancelled',
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(subscriptionId);
}

function upsertAdminGrant(database, userId) {
  const existing = findAdminGrantSubscription(database, userId);
  if (existing) {
    database.prepare(`
      UPDATE subscriptions
      SET plan_type = ?,
          status = 'active',
          paypal_subscription_id = NULL,
          started_at = COALESCE(started_at, CURRENT_TIMESTAMP),
          next_billing_date = NULL,
          expires_at = NULL,
          admin_granted = 1,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(FREE_FOREVER_PLAN_TYPE, existing.id);
  } else {
    database.prepare(`
      INSERT INTO subscriptions (
        user_id, paypal_subscription_id, plan_type, status, started_at,
        next_billing_date, expires_at, admin_granted, created_at, updated_at
      ) VALUES (?, NULL, ?, 'active', CURRENT_TIMESTAMP, NULL, NULL, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).run(userId, FREE_FOREVER_PLAN_TYPE);
  }
  return getEffectiveUserSubscription(database, userId);
}

function findCouncilYearGrantSubscription(database, userId) {
  return database.prepare(`
    SELECT *
    FROM subscriptions
    WHERE user_id = ?
      AND COALESCE(admin_granted, 0) <> 0
      AND LOWER(TRIM(COALESCE(plan_type, ''))) = LOWER(TRIM(?))
    ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST, id DESC
    LIMIT 1
  `).get(userId, COUNCIL_YEAR_PLAN_TYPE) || null;
}

function upsertCouncilYearGrant(database, userId, months = 12, options = {}) {
  const now = options.now ? new Date(options.now) : new Date();
  const startedAt = formatDateForSql(now);
  const expiresAt = formatDateForSql(addUtcMonths(now, months));
  const existing = findCouncilYearGrantSubscription(database, userId);
  if (existing) {
    database.prepare(`
      UPDATE subscriptions
      SET plan_type = ?,
          status = 'trialing',
          paypal_subscription_id = NULL,
          started_at = ?,
          next_billing_date = NULL,
          expires_at = ?,
          admin_granted = 1,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(COUNCIL_YEAR_PLAN_TYPE, startedAt, expiresAt, existing.id);
  } else {
    database.prepare(`
      INSERT INTO subscriptions (
        user_id, paypal_subscription_id, plan_type, status, started_at,
        next_billing_date, expires_at, admin_granted, created_at, updated_at
      ) VALUES (?, NULL, ?, 'trialing', ?, NULL, ?, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).run(userId, COUNCIL_YEAR_PLAN_TYPE, startedAt, expiresAt);
  }
  return getEffectiveUserSubscription(database, userId);
}

export async function grantPermanentCreatorPro(database, user, options = {}) {
  const userId = normalizeUserId(user?.id);
  if (!userId) throw new Error('User not found');
  if (Number(user.is_active) === 0) throw new Error('Disabled users cannot receive Free Forever grants');

  const activePayPalSubscriptions = listActivePayPalSubscriptions(database, userId);
  if (activePayPalSubscriptions.length && typeof options.cancelPayPalSubscription !== 'function') {
    throw new Error('PayPal cancellation is required before granting Free Forever');
  }

  const cancelledPayPalSubscriptions = [];
  for (const subscription of activePayPalSubscriptions) {
    await options.cancelPayPalSubscription(subscription.paypal_subscription_id, {
      reason: options.reason || 'Free Forever granted by admin',
    });
    cancelledPayPalSubscriptions.push(subscription);
  }

  const applyGrant = database.transaction(() => {
    cancelledPayPalSubscriptions.forEach(subscription => {
      markPayPalSubscriptionCancelled(database, subscription.id);
    });
    return upsertAdminGrant(database, userId);
  });

  return {
    user,
    subscription: applyGrant(),
    cancelledPayPalSubscriptions: cancelledPayPalSubscriptions.map(subscription => subscription.paypal_subscription_id),
  };
}

export async function grantCouncilYearCreatorPro(database, user, options = {}) {
  const userId = normalizeUserId(user?.id);
  if (!userId) throw new Error('User not found');
  if (Number(user.is_active) === 0) throw new Error('Disabled users cannot receive Council Year grants');

  const months = Math.max(1, Math.min(36, Math.round(Number(options.months || 12) || 12)));
  const activePayPalSubscriptions = listActivePayPalSubscriptions(database, userId);
  if (activePayPalSubscriptions.length && typeof options.cancelPayPalSubscription !== 'function') {
    throw new Error('PayPal cancellation is required before granting a Council Year');
  }

  const cancelledPayPalSubscriptions = [];
  for (const subscription of activePayPalSubscriptions) {
    await options.cancelPayPalSubscription(subscription.paypal_subscription_id, {
      reason: options.reason || 'Council of Aetheris one-year bonus granted by admin',
    });
    cancelledPayPalSubscriptions.push(subscription);
  }

  const applyGrant = database.transaction(() => {
    cancelledPayPalSubscriptions.forEach(subscription => {
      markPayPalSubscriptionCancelled(database, subscription.id);
    });
    return upsertCouncilYearGrant(database, userId, months, options);
  });

  return {
    user,
    subscription: applyGrant(),
    cancelledPayPalSubscriptions: cancelledPayPalSubscriptions.map(subscription => subscription.paypal_subscription_id),
    grantMonths: months,
  };
}

export function removePermanentCreatorPro(database, user) {
  const userId = normalizeUserId(user?.id);
  if (!userId) throw new Error('User not found');

  const removeGrant = database.transaction(() => {
    database.prepare(`
      UPDATE subscriptions
      SET status = 'cancelled',
          updated_at = CURRENT_TIMESTAMP
      WHERE user_id = ?
        AND COALESCE(admin_granted, 0) <> 0
        AND LOWER(TRIM(COALESCE(status, ''))) = 'active'
    `).run(userId);
    return getEffectiveUserSubscription(database, userId);
  });

  return {
    user,
    subscription: removeGrant(),
  };
}
