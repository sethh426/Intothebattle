export function paypalMode(env = process.env) {
  const mode = String(env.PAYPAL_MODE || env.PAYPAL_ENV || '').toLowerCase();
  return mode === 'sandbox' ? 'sandbox' : 'live';
}

export function paypalApiBaseUrl(env = process.env) {
  return paypalMode(env) === 'sandbox'
    ? 'https://api-m.sandbox.paypal.com'
    : 'https://api-m.paypal.com';
}

export function paypalSdkBaseUrl(env = process.env) {
  return paypalMode(env) === 'sandbox'
    ? 'https://www.sandbox.paypal.com/sdk/js'
    : 'https://www.paypal.com/sdk/js';
}

export function paypalPlanId(env = process.env) {
  return env.PAYPAL_PLAN_ID || env.PAYPAL_SUBSCRIPTION_PLAN_ID || '';
}

export function paypalClientId(env = process.env) {
  return env.PAYPAL_CLIENT_ID || '';
}

export function normalizePayPalSubscriptionId(value) {
  const id = String(value || '').trim();
  return /^[A-Za-z0-9_-]{6,80}$/.test(id) ? id : '';
}

export async function getPayPalAccessToken({ env = process.env, fetchImpl = fetch } = {}) {
  const clientId = env.PAYPAL_CLIENT_ID;
  const clientSecret = env.PAYPAL_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('PayPal client credentials are not configured');
  }
  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  const response = await fetchImpl(`${paypalApiBaseUrl(env)}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) {
    throw new Error(`PayPal token request failed (${response.status})`);
  }
  return data.access_token;
}

export async function getPayPalSubscription(subscriptionId, options = {}) {
  const id = normalizePayPalSubscriptionId(subscriptionId);
  if (!id) throw new Error('Invalid PayPal subscription id');

  const fetchImpl = options.fetchImpl || fetch;
  const accessToken = await getPayPalAccessToken({ ...options, fetchImpl });
  const response = await fetchImpl(`${paypalApiBaseUrl(options.env)}/v1/billing/subscriptions/${encodeURIComponent(id)}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data?.message || data?.details?.[0]?.description || `PayPal subscription lookup failed (${response.status})`;
    throw new Error(message);
  }
  return data;
}

export async function cancelPayPalSubscription(subscriptionId, options = {}) {
  const id = normalizePayPalSubscriptionId(subscriptionId);
  if (!id) throw new Error('Invalid PayPal subscription id');

  const fetchImpl = options.fetchImpl || fetch;
  const accessToken = await getPayPalAccessToken({ ...options, fetchImpl });
  const response = await fetchImpl(`${paypalApiBaseUrl(options.env)}/v1/billing/subscriptions/${encodeURIComponent(id)}/cancel`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      reason: String(options.reason || 'Free Forever granted by admin').slice(0, 128),
    }),
  });

  if (response.status === 204) return { success: true, subscriptionId: id };

  const data = await response.json().catch(() => ({}));
  const message = data?.message || data?.details?.[0]?.description || `PayPal subscription cancel failed (${response.status})`;
  throw new Error(message);
}
