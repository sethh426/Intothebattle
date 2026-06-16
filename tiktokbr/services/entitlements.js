export const PAID_ACCESS_CODE_TYPES = new Set([
  'paid',
  'pro',
  'creator-pro',
  'creator-pro-plus',
  'creator',
  'subscriber',
  'lifetime',
  'founder',
  'beta-paid',
]);

export const PAID_ACCESS_CODE_STATUSES = new Set([
  'paid',
  'pro',
  'creator-pro',
  'subscriber',
]);

export const ACTIVE_SUBSCRIPTION_STATUSES = new Set(['active']);

function normalizeValue(value, fallback = '') {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!normalized) return fallback;
  return normalized.replace(/\s+/g, '-').replace(/_/g, '-');
}

function flagEnabled(value) {
  if (value === true) return true;
  if (value === false || value == null) return false;
  if (typeof value === 'number') return value !== 0;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

export function isRevokedRecord(record) {
  return flagEnabled(record?.is_revoked);
}

export function isPromoAccessCode(record) {
  return flagEnabled(record?.is_promo);
}

export function normalizeSubscriptionStatus(status, fallback = 'unknown') {
  return normalizeValue(status, fallback);
}

export function normalizeCodeType(codeType, fallback = 'trial') {
  return normalizeValue(codeType, fallback);
}

export function isPaidAccessCode(row) {
  if (!row || isRevokedRecord(row) || isPromoAccessCode(row)) return false;

  const codeType = normalizeCodeType(row.code_type);
  const subscriptionStatus = normalizeSubscriptionStatus(row.subscription_status, 'free');
  const hasPayPalSubscription = Boolean(String(row.paypal_subscription_id || '').trim());

  return Boolean(
    hasPayPalSubscription ||
    PAID_ACCESS_CODE_TYPES.has(codeType) ||
    PAID_ACCESS_CODE_STATUSES.has(subscriptionStatus)
  );
}

export function isActiveSubscription(subscription) {
  return ACTIVE_SUBSCRIPTION_STATUSES.has(normalizeSubscriptionStatus(subscription?.status));
}

export function isPaidAuthRecord(auth, options = {}) {
  if (!auth) return false;
  if (auth.type === 'code') return isPaidAccessCode(auth.record);

  const getLatestUserSubscription = options.getLatestUserSubscription;
  const subscription = typeof getLatestUserSubscription === 'function'
    ? getLatestUserSubscription(auth.record?.id)
    : auth.subscription;
  return isActiveSubscription(subscription);
}

export function buildPlanEntitlements(auth, options = {}) {
  const paid = isPaidAuthRecord(auth, options);
  return {
    tier: paid ? 'paid' : 'free',
    planName: paid ? 'Creator Pro' : 'Free',
    canUseCreatorSponsors: paid,
    platformSponsorManaged: !paid,
  };
}
