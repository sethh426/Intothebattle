export const PAYPAL_STATUS_MAP = new Map([
  ['ACTIVE', 'active'],
  ['APPROVED', 'pending'],
  ['APPROVAL_PENDING', 'pending'],
  ['CREATED', 'pending'],
  ['SUSPENDED', 'suspended'],
  ['CANCELLED', 'cancelled'],
  ['CANCELED', 'cancelled'],
  ['EXPIRED', 'expired'],
]);

export const SUBSCRIPTION_BLOCKING_STATUSES = new Set([
  'cancelled',
  'expired',
  'revoked',
  'suspended',
]);

function normalizeEventType(eventType) {
  return String(eventType || '').trim().toUpperCase();
}

export function normalizePayPalSubscriptionStatus(status) {
  const normalized = String(status || '').trim().toUpperCase();
  if (!normalized) return 'unknown';
  return PAYPAL_STATUS_MAP.get(normalized) || normalized.toLowerCase();
}

export function localStatusForPayPalWebhookEvent(eventType, resourceStatus) {
  const event = normalizeEventType(eventType);
  if (event === 'BILLING.SUBSCRIPTION.ACTIVATED') return 'active';
  if (event === 'BILLING.SUBSCRIPTION.SUSPENDED') return 'suspended';
  if (event === 'BILLING.SUBSCRIPTION.CANCELLED') return 'cancelled';
  if (event === 'BILLING.SUBSCRIPTION.CANCELED') return 'cancelled';
  if (event === 'BILLING.SUBSCRIPTION.EXPIRED') return 'expired';
  if (event === 'BILLING.SUBSCRIPTION.UPDATED') return normalizePayPalSubscriptionStatus(resourceStatus);
  return normalizePayPalSubscriptionStatus(resourceStatus);
}

export function isSubscriptionAccessActive(status) {
  return String(status || '').trim().toLowerCase() === 'active';
}

export function isSubscriptionAccessBlocked(status) {
  return SUBSCRIPTION_BLOCKING_STATUSES.has(String(status || '').trim().toLowerCase());
}
