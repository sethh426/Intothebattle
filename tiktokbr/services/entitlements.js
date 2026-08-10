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
export const DEFAULT_FREE_TRIAL_DAYS = 7;

const BLOCKING_SUBSCRIPTION_STATUSES = new Set([
  'cancelled',
  'canceled',
  'suspended',
  'revoked',
  'payment_failed',
  'failed',
]);
const PENDING_SUBSCRIPTION_STATUSES = new Set([
  'pending',
  'approval-pending',
  'pending-approval',
]);

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

export function parseDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function trialDaysFromValue(value, fallback = DEFAULT_FREE_TRIAL_DAYS) {
  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed > 0) return Math.round(parsed);
  const parsedFallback = Number(fallback);
  return Number.isFinite(parsedFallback) && parsedFallback > 0
    ? Math.round(parsedFallback)
    : DEFAULT_FREE_TRIAL_DAYS;
}

export function accountTrialStartedAt(user) {
  return parseDate(user?.created_at || user?.createdAt);
}

export function accountTrialExpiresAt(user, options = {}) {
  const startedAt = accountTrialStartedAt(user);
  if (!startedAt) return null;
  const trialDays = trialDaysFromValue(
    options.trialDays ?? options.freeTrialDays,
    DEFAULT_FREE_TRIAL_DAYS
  );
  return new Date(startedAt.getTime() + trialDays * 24 * 60 * 60 * 1000);
}

export function effectiveUserTrialExpiresAt(user, subscription = null, options = {}) {
  const accountExpiresAt = accountTrialExpiresAt(user, options);
  const subscriptionExpiresAt = parseDate(subscription?.expires_at || subscription?.expiresAt);
  if (accountExpiresAt && subscriptionExpiresAt) {
    return accountExpiresAt < subscriptionExpiresAt ? accountExpiresAt : subscriptionExpiresAt;
  }
  return accountExpiresAt || subscriptionExpiresAt;
}

export function isFullAccessTrialSubscription(subscription, now = new Date()) {
  if (!subscription) return false;
  const status = normalizeSubscriptionStatus(subscription.status);
  if (!TRIAL_SUBSCRIPTION_STATUSES.has(status)) return false;
  const expiresAt = parseDate(subscription.expires_at || subscription.expiresAt);
  return !expiresAt || expiresAt > now;
}

function isUserActive(user) {
  if (!user) return false;
  if (user.is_active == null) return true;
  return flagEnabled(user.is_active);
}

function normalizeBlockingReason(status) {
  if (status === 'canceled') return 'cancelled';
  return status || 'subscription_required';
}

function isTrialLikeSubscription(subscription) {
  const status = normalizeSubscriptionStatus(subscription?.status);
  const planType = normalizeValue(subscription?.plan_type || subscription?.planType);
  return TRIAL_SUBSCRIPTION_STATUSES.has(status) || planType.includes('trial') || planType.includes('full-access');
}

function baseUserAccessPayload(patch) {
  return {
    type: 'user',
    status: patch.status || 'free',
    tier: patch.tier || 'free',
    planName: patch.planName || 'Free',
    canUseCreatorSponsors: Boolean(patch.canUseCreatorSponsors),
    platformSponsorManaged: !patch.canUseCreatorSponsors,
    betaTester: false,
    reason: patch.reason || null,
    accessAllowed: Boolean(patch.accessAllowed),
    actionRequired: !patch.accessAllowed,
    trialStartedAt: patch.trialStartedAt || null,
    effectiveTrialExpiresAt: patch.effectiveTrialExpiresAt || null,
    subscriptionStatus: patch.subscriptionStatus || null,
  };
}

export function buildUserAccessStatus(user, subscription = null, options = {}) {
  const now = parseDate(options.now) || new Date();
  const trialOptions = {
    trialDays: trialDaysFromValue(
      options.trialDays ?? options.freeTrialDays,
      DEFAULT_FREE_TRIAL_DAYS
    ),
  };

  const blocked = (reason, status = reason) => baseUserAccessPayload({
    status,
    reason,
    accessAllowed: false,
    subscriptionStatus: subscription ? normalizeSubscriptionStatus(subscription.status) : null,
  });

  if (!user) return blocked('unauthorized', 'unauthorized');
  if (!isUserActive(user)) return blocked('revoked', 'revoked');

  const rawStatus = subscription
    ? normalizeSubscriptionStatus(subscription.status)
    : null;
  const adminGranted = flagEnabled(subscription?.admin_granted || subscription?.adminGranted);
  const subscriptionExpiresAt = parseDate(subscription?.expires_at || subscription?.expiresAt);

  if (
    adminGranted &&
    subscriptionExpiresAt &&
    subscriptionExpiresAt > now &&
    TRIAL_SUBSCRIPTION_STATUSES.has(rawStatus)
  ) {
    return baseUserAccessPayload({
      status: 'active',
      tier: 'paid',
      planName: subscription?.plan_type || subscription?.planType || 'Creator Pro',
      canUseCreatorSponsors: true,
      accessAllowed: true,
      trialStartedAt: parseDate(subscription?.started_at || subscription?.startedAt),
      effectiveTrialExpiresAt: subscriptionExpiresAt,
      subscriptionStatus: rawStatus,
    });
  }

  if (isActiveSubscription(subscription)) {
    return baseUserAccessPayload({
      status: 'active',
      tier: 'paid',
      planName: subscription?.plan_type || subscription?.planType || 'Creator Pro',
      canUseCreatorSponsors: true,
      accessAllowed: true,
      subscriptionStatus: rawStatus,
    });
  }

  if (subscription && BLOCKING_SUBSCRIPTION_STATUSES.has(rawStatus)) {
    const reason = normalizeBlockingReason(rawStatus);
    return blocked(reason, reason);
  }

  if (subscription && rawStatus === 'expired') {
    return blocked(isTrialLikeSubscription(subscription) ? 'trial_expired' : 'expired', 'expired');
  }

  if (subscription && PENDING_SUBSCRIPTION_STATUSES.has(rawStatus)) {
    return blocked('subscription_pending', rawStatus);
  }

  const trialStartedAt = accountTrialStartedAt(user) || parseDate(subscription?.started_at || subscription?.startedAt);
  const effectiveTrialExpiresAt = effectiveUserTrialExpiresAt(user, subscription, trialOptions);
  const trialActive = effectiveTrialExpiresAt && effectiveTrialExpiresAt > now;
  const trialish = !subscription || TRIAL_SUBSCRIPTION_STATUSES.has(rawStatus) || rawStatus === 'free' || rawStatus === 'unknown';

  if (trialish && trialActive) {
    return baseUserAccessPayload({
      status: 'trialing',
      tier: 'trial',
      planName: subscription?.plan_type || subscription?.planType || '7-Day Full Access',
      canUseCreatorSponsors: true,
      accessAllowed: true,
      trialStartedAt,
      effectiveTrialExpiresAt,
      subscriptionStatus: rawStatus || 'trialing',
    });
  }

  if (trialish) {
    return baseUserAccessPayload({
      status: 'expired',
      tier: 'free',
      planName: 'Free',
      canUseCreatorSponsors: false,
      accessAllowed: false,
      reason: 'trial_expired',
      trialStartedAt,
      effectiveTrialExpiresAt,
      subscriptionStatus: rawStatus || 'trialing',
    });
  }

  return blocked('subscription_required', rawStatus || 'subscription_required');
}

export function isPaidAuthRecord(auth, options = {}) {
  if (!auth) return false;
  if (auth.type === 'code') return isPaidAccessCode(auth.record);

  const getLatestUserSubscription = options.getLatestUserSubscription;
  const subscription = auth.subscription || (typeof getLatestUserSubscription === 'function'
    ? getLatestUserSubscription(auth.record?.id)
    : null);
  return buildUserAccessStatus(auth.record, subscription, options).canUseCreatorSponsors;
}

export function buildPlanEntitlements(auth, options = {}) {
  const getLatestUserSubscription = options.getLatestUserSubscription;
  const subscription = auth?.type === 'user'
    ? (auth.subscription || (typeof getLatestUserSubscription === 'function' ? getLatestUserSubscription(auth.record?.id) : null))
    : null;
  const userAccess = auth?.type === 'user'
    ? buildUserAccessStatus(auth.record, subscription, options)
    : null;
  const trial = userAccess?.tier === 'trial';
  const paid = auth?.type === 'code' ? isPaidAccessCode(auth.record) : userAccess?.tier === 'paid';
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
