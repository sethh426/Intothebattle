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

export const BETA_ACCESS_CODE_TYPES = new Set([
  'beta',
  'beta-tester',
  'betatester',
  'tester',
  'founder-beta',
]);

export const ACTIVE_SUBSCRIPTION_STATUSES = new Set(['active']);
export const TRIAL_SUBSCRIPTION_STATUSES = new Set(['trial', 'trialing', 'free-trial', 'full-access-trial']);

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

export function isBetaTesterAccessCode(row) {
  if (!row || isRevokedRecord(row) || isPromoAccessCode(row)) return false;

  const codeType = normalizeCodeType(row.code_type);
  const code = normalizeValue(row.code);
  const email = normalizeValue(row.email);

  return Boolean(
    BETA_ACCESS_CODE_TYPES.has(codeType) ||
    code.startsWith('betatester') ||
    email.startsWith('betatester')
  );
}

export function isActiveSubscription(subscription) {
  return ACTIVE_SUBSCRIPTION_STATUSES.has(normalizeSubscriptionStatus(subscription?.status));
}

function parseDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function isFullAccessTrialSubscription(subscription, now = new Date()) {
  if (!subscription) return false;
  const status = normalizeSubscriptionStatus(subscription.status);
  if (!TRIAL_SUBSCRIPTION_STATUSES.has(status)) return false;
  const expiresAt = parseDate(subscription.expires_at || subscription.expiresAt);
  return !expiresAt || expiresAt >= now;
}

export function isPaidAuthRecord(auth, options = {}) {
  if (!auth) return false;
  if (auth.type === 'code') return isPaidAccessCode(auth.record);

  const getLatestUserSubscription = options.getLatestUserSubscription;
  const subscription = typeof getLatestUserSubscription === 'function'
    ? getLatestUserSubscription(auth.record?.id)
    : auth.subscription;
  return isActiveSubscription(subscription) || isFullAccessTrialSubscription(subscription);
}

export function buildPlanEntitlements(auth, options = {}) {
  const getLatestUserSubscription = options.getLatestUserSubscription;
  const subscription = auth?.type === 'user'
    ? (typeof getLatestUserSubscription === 'function' ? getLatestUserSubscription(auth.record?.id) : auth.subscription)
    : null;
  const trial = isFullAccessTrialSubscription(subscription);
  const paid = auth?.type === 'code' ? isPaidAccessCode(auth.record) : isActiveSubscription(subscription);
  const beta = auth?.type === 'code' ? isBetaTesterAccessCode(auth.record) : false;
  const creatorSponsors = paid || trial || beta;
  return {
    tier: paid ? 'paid' : trial ? 'trial' : beta ? 'beta' : 'free',
    planName: paid ? 'Creator Pro' : trial ? '7-Day Full Access' : beta ? 'Beta Tester' : 'Free',
    canUseCreatorSponsors: creatorSponsors,
    platformSponsorManaged: !creatorSponsors,
    betaTester: beta,
  };
}
