import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import db from '../db/db.js';
import jwt from 'jsonwebtoken';
import {
  localStatusForPayPalWebhookEvent,
  normalizePayPalSubscriptionStatus,
} from '../services/billingPolicy.js';
import { recordServerGrowthEvent } from '../services/growthEvents.js';
import { qualifyReferralForUser } from '../services/referrals.js';
import {
  getPayPalAccessToken,
  getPayPalSubscription,
  normalizePayPalSubscriptionId,
  paypalApiBaseUrl,
  paypalClientId,
  paypalMode,
  paypalPlanId,
  paypalSdkBaseUrl,
} from '../services/paypalSubscriptions.js';

const router = express.Router();

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function issueCode(email, days = 30) {
  const code = uuidv4().replace(/-/g, '').toUpperCase();
  const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000)
    .toISOString().slice(0, 19).replace('T', ' ');
  db.prepare('INSERT INTO access_codes (code, email, expires_at) VALUES (?, ?, ?)')
    .run(code, email.toLowerCase().trim(), expiresAt);
  return { code, expiresAt };
}

function findUserByEmail(email) {
  if (!email) return null;
  return db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase().trim());
}

function formatDateForSql(dateString) {
  if (!dateString) return null;
  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

function createOrUpdateSubscription(userId, paypalId, planType, status, startedAt, nextBillingDate, expiresAt = null) {
  const insert = db.prepare(`
    INSERT INTO subscriptions (
      user_id, paypal_subscription_id, plan_type, status, started_at, next_billing_date, expires_at, admin_granted, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(paypal_subscription_id) DO UPDATE SET
      user_id = excluded.user_id,
      plan_type = excluded.plan_type,
      status = excluded.status,
      started_at = COALESCE(subscriptions.started_at, excluded.started_at),
      next_billing_date = excluded.next_billing_date,
      expires_at = excluded.expires_at,
      admin_granted = 0,
      updated_at = CURRENT_TIMESTAMP
  `);
  insert.run(userId, paypalId, planType, status, startedAt, nextBillingDate, expiresAt);
}

// (Previously had email-sending helpers here; removed — codes will be shown on a claim page)

function getSessionUser(req) {
  const token = req.cookies?.session_token;
  if (!token || !process.env.JWT_SECRET) return null;
  try {
    jwt.verify(token, process.env.JWT_SECRET);
  } catch (_err) {
    return null;
  }
  const user = db.prepare('SELECT * FROM users WHERE session_token = ?').get(token);
  return user && user.is_active ? user : null;
}

function ensureUserRoom(user) {
  const existingRoom = db.prepare('SELECT room_id FROM user_rooms WHERE user_id = ? ORDER BY id LIMIT 1').get(user.id);
  if (existingRoom) return existingRoom.room_id;

  const roomId = uuidv4().replace(/-/g, '').slice(0, 10);
  db.prepare(
    'INSERT INTO user_rooms (user_id, room_id, room_name, created_at, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)'
  ).run(user.id, roomId, `${user.name || 'Creator'}'s room`);
  db.prepare('INSERT INTO room_settings (room_id) VALUES (?) ON CONFLICT (room_id) DO NOTHING').run(roomId);
  return roomId;
}

function mapPayPalStatus(status) {
  return normalizePayPalSubscriptionStatus(status);
}

function subscriptionDates(subscription) {
  return {
    startedAt: formatDateForSql(subscription?.start_time || subscription?.create_time || subscription?.status_update_time),
    nextBilling: formatDateForSql(subscription?.billing_info?.next_billing_time),
    expiresAt: formatDateForSql(subscription?.billing_info?.final_payment_time),
  };
}

function activateUserSubscription(user, subscription) {
  const subscriptionId = normalizePayPalSubscriptionId(subscription?.id);
  if (!subscriptionId) throw new Error('PayPal did not return a subscription id');

  const expectedPlanId = paypalPlanId();
  if (expectedPlanId && subscription.plan_id && subscription.plan_id !== expectedPlanId) {
    throw new Error('PayPal subscription plan does not match this app');
  }

  const existing = db.prepare('SELECT * FROM subscriptions WHERE paypal_subscription_id = ?').get(subscriptionId);
  if (existing && Number(existing.user_id) !== Number(user.id)) {
    throw new Error('This PayPal subscription is already linked to another account');
  }

  const localStatus = mapPayPalStatus(subscription.status);
  const dates = subscriptionDates(subscription);
  createOrUpdateSubscription(
    user.id,
    subscriptionId,
    'Creator Pro',
    localStatus,
    dates.startedAt,
    dates.nextBilling,
    dates.expiresAt
  );
  ensureUserRoom(user);
  if (localStatus === 'active') {
    try {
      qualifyReferralForUser(db, user.id, {
        source: 'paypal_activation',
        notes: `Qualified by PayPal subscription ${subscriptionId}`,
      });
    } catch (err) {
      console.warn('Referral qualification failed:', err?.message || err);
    }
  }

  return {
    subscriptionId,
    status: localStatus,
    paypalStatus: String(subscription.status || '').toUpperCase(),
    nextBillingDate: dates.nextBilling,
  };
}

function trackSubscriptionStarted(req, user, activation) {
  if (!user || activation?.status !== 'active') return;
  recordServerGrowthEvent(req, 'subscription_started', {
    stableKey: `subscription_started:${user.id}:${activation.subscriptionId}`,
    user: {
      id: user.id,
      email: user.email,
      name: user.name || '',
    },
    properties: {
      plan: 'Creator Pro',
      subscriptionId: activation.subscriptionId,
      paypalStatus: activation.paypalStatus,
    },
  }).catch(err => console.warn('Growth subscription_started event failed:', err?.message || err));
}

async function verifyPayPalWebhook(req) {
  try {
    const accessToken = await getPayPalAccessToken();
    const webhookId   = process.env.PAYPAL_WEBHOOK_ID;

    const verifyBody = {
      auth_algo:         req.headers['paypal-auth-algo'],
      cert_url:          req.headers['paypal-cert-url'],
      transmission_id:   req.headers['paypal-transmission-id'],
      transmission_sig:  req.headers['paypal-transmission-sig'],
      transmission_time: req.headers['paypal-transmission-time'],
      webhook_id:        webhookId,
      webhook_event:     req.body,
    };

    const response = await fetch(`${paypalApiBaseUrl()}/v1/notifications/verify-webhook-signature`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(verifyBody),
    });

    const result = await response.json();
    return result.verification_status === 'SUCCESS';
  } catch (err) {
    console.error('PayPal webhook verification error:', err);
    return false;
  }
}

router.post('/api/paypal/webhook', express.json(), async (req, res) => {
  try {
    const eventType = req.body?.event_type;
    console.log(`📦 PayPal webhook received: ${eventType}`);

    const isValid = await verifyPayPalWebhook(req);
    if (!isValid) {
      console.warn('⚠️ PayPal webhook signature invalid');
      return res.status(400).json({ error: 'Invalid webhook signature' });
    }

    if (eventType === 'BILLING.SUBSCRIPTION.ACTIVATED') {
      const subscription = req.body.resource;
      const email        = subscription?.subscriber?.email_address;
      const subId        = subscription?.id;

      if (!email) {
        console.warn('⚠️ No email in PayPal webhook payload');
        return res.status(400).json({ error: 'No email found' });
      }

      const existingCode = db.prepare('SELECT * FROM access_codes WHERE paypal_subscription_id = ?').get(subId);
      if (existingCode) {
        console.log(`ℹ️ Code already issued for subscription ${subId}`);
        return res.json({ success: true, message: 'Already issued' });
      }

      const user = findUserByEmail(email);
      if (user) {
        const activation = activateUserSubscription(user, subscription);
        trackSubscriptionStarted(req, user, activation);
        console.log(`✅ Linked PayPal subscription ${subId} to existing user ${email}`);
        return res.json({ success: true });
      }

      const { code, expiresAt } = issueCode(email, 30);
      db.prepare('UPDATE access_codes SET paypal_subscription_id = ? WHERE code = ?').run(subId, code);
      console.log(`✅ Issued code ${code} to ${email} (sub: ${subId})`);
      return res.json({ success: true });
    }

    if (
      eventType === 'BILLING.SUBSCRIPTION.CANCELLED' ||
      eventType === 'BILLING.SUBSCRIPTION.SUSPENDED' ||
      eventType === 'BILLING.SUBSCRIPTION.EXPIRED'
    ) {
      const subId = req.body.resource?.id;
      if (subId) {
        const localStatus = localStatusForPayPalWebhookEvent(eventType, req.body.resource?.status);
        const subscription = db.prepare('SELECT * FROM subscriptions WHERE paypal_subscription_id = ?').get(subId);
        if (subscription) {
          db.prepare('UPDATE subscriptions SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(localStatus, subscription.id);
          console.log(`🚫 Updated user subscription ${subId} to ${localStatus}`);
        }
        db.prepare('UPDATE access_codes SET is_revoked = 1 WHERE paypal_subscription_id = ?').run(subId);
        console.log(`🚫 Revoked code for subscription ${subId}`);
      }
      return res.json({ success: true });
    }

    if (eventType === 'PAYMENT.SALE.COMPLETED') {
      const subId = req.body.resource?.billing_agreement_id;
      if (subId) {
        const userSub = db.prepare('SELECT * FROM subscriptions WHERE paypal_subscription_id = ?').get(subId);
        if (userSub) {
          const nextBilling = formatDateForSql(req.body.resource?.billing_agreement?.next_billing_time || req.body.resource?.billing_agreement?.next_billing_date || userSub.next_billing_date);
          db.prepare('UPDATE subscriptions SET status = ?, next_billing_date = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
            .run('active', nextBilling || userSub.next_billing_date, userSub.id);
          console.log(`🔄 Renewed user subscription ${subId}`);
        }

        const row = db.prepare('SELECT * FROM access_codes WHERE paypal_subscription_id = ?').get(subId);
        if (row) {
          const now        = new Date();
          const currentExp = new Date(row.expires_at);
          const base       = currentExp > now ? currentExp : now;
          base.setDate(base.getDate() + 30);
          const newExpiry  = base.toISOString().slice(0, 19).replace('T', ' ');
          db.prepare('UPDATE access_codes SET expires_at = ?, is_revoked = 0 WHERE paypal_subscription_id = ?')
            .run(newExpiry, subId);
          console.log(`🔄 Renewed code for subscription ${subId} → expires ${newExpiry}`);
        }
      }
      return res.json({ success: true });
    }

    res.json({ success: true, message: 'Event not handled' });

  } catch (err) {
    console.error('PayPal webhook error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

router.get('/api/paypal/config', (req, res) => {
  const user = getSessionUser(req);
  if (!user) {
    return res.json({
      success: false,
      authenticated: false,
      configured: false,
      error: 'Log in before upgrading to Creator Pro.',
      loginUrl: '/login?next=/paywall',
    });
  }

  const clientId = paypalClientId();
  const planId = paypalPlanId();
  const configured = Boolean(clientId && planId);
  return res.json({
    success: true,
    authenticated: true,
    configured,
    mode: paypalMode(),
    sdkUrl: paypalSdkBaseUrl(),
    currency: process.env.PAYPAL_CURRENCY || 'USD',
    clientId: configured ? clientId : null,
    planId: configured ? planId : null,
    fallbackUrl: process.env.PAYPAL_PAYMENT_LINK ? '/paywall-link?fallback=1' : null,
    user: {
      id: user.id,
      email: user.email,
      name: user.name || '',
    },
  });
});

router.post('/api/paypal/subscription/activate', express.json(), async (req, res) => {
  const user = getSessionUser(req);
  if (!user) {
    return res.status(401).json({
      success: false,
      error: 'Log in before finishing checkout.',
      loginUrl: '/login?next=/paywall',
    });
  }

  const subscriptionId = normalizePayPalSubscriptionId(req.body?.subscriptionID || req.body?.subscriptionId || req.body?.id);
  if (!subscriptionId) {
    return res.status(400).json({ success: false, error: 'Missing PayPal subscription id.' });
  }

  try {
    const subscription = await getPayPalSubscription(subscriptionId);
    const activation = activateUserSubscription(user, subscription);
    trackSubscriptionStarted(req, user, activation);
    const isActive = activation.status === 'active';
    return res.json({
      success: true,
      ...activation,
      redirectUrl: `/billing/success?subscription_id=${encodeURIComponent(subscriptionId)}${isActive ? '' : '&pending=1'}`,
    });
  } catch (err) {
    console.error('PayPal subscription activation failed:', err);
    return res.status(502).json({
      success: false,
      error: err.message || 'Unable to verify PayPal subscription.',
      recoverUrl: `/billing/error?reason=${encodeURIComponent(err.message || 'paypal_verification_failed')}`,
    });
  }
});

router.get('/api/paypal/subscription/status', async (req, res) => {
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ success: false, error: 'Unauthorized' });

  const subscriptionId = normalizePayPalSubscriptionId(req.query.subscription_id || req.query.subscriptionId || req.query.id);
  if (!subscriptionId) return res.status(400).json({ success: false, error: 'Missing PayPal subscription id.' });

  try {
    const subscription = await getPayPalSubscription(subscriptionId);
    const activation = activateUserSubscription(user, subscription);
    trackSubscriptionStarted(req, user, activation);
    return res.json({
      success: true,
      ...activation,
      active: activation.status === 'active',
    });
  } catch (err) {
    console.error('PayPal subscription status check failed:', err);
    return res.status(502).json({ success: false, error: err.message || 'Unable to verify PayPal subscription.' });
  }
});

router.get('/billing/success', (req, res) => {
  const subscriptionId = normalizePayPalSubscriptionId(req.query.subscription_id || req.query.subscriptionId || req.query.sub);
  const pending = req.query.pending === '1' || req.query.status === 'pending';
  return res.send(renderBillingResult({
    state: pending ? 'pending' : 'success',
    title: pending ? 'Thank You' : 'Congratulations',
    message: pending
      ? 'Thank you for your purchase. PayPal approved the subscription, and we are waiting for PayPal to mark it active. This page will keep checking for you.'
      : 'Thank you for your purchase. Your Creator Pro access is ready, and your dashboard is waiting.',
    subscriptionId,
  }));
});

router.get('/billing/cancel', (_req, res) => {
  return res.send(renderBillingResult({
    state: 'cancel',
    title: 'Checkout Cancelled',
    message: 'No charge was completed. You can return to the upgrade page whenever you are ready.',
  }));
});

router.get('/billing/error', (req, res) => {
  return res.status(502).send(renderBillingResult({
    state: 'error',
    title: 'Checkout Needs Attention',
    message: `We could not finish verifying the PayPal subscription. ${req.query.reason ? `Reason: ${String(req.query.reason).slice(0, 180)}` : 'Please try again or contact support.'}`,
  }));
});

router.get('/my-code', (_req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Get Your Code - TIKTOKBR</title>
  <style>
    body { background: #040714; color: #f5f7ff; font-family: Arial, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
    .container { width: min(460px, 90vw); padding: 28px; background: rgba(10,16,36,0.95); border: 1px solid rgba(100,180,255,0.2); border-radius: 14px; }
    h1 { margin-bottom: 8px; font-size: 22px; }
    p { color: #a8b8ff; font-size: 14px; margin-bottom: 20px; }
    label { display: block; margin-bottom: 6px; font-size: 13px; color: #a8b8ff; }
    input { width: 100%; padding: 12px 14px; border-radius: 10px; border: 1px solid rgba(255,255,255,0.12); background: rgba(255,255,255,0.04); color: #fff; box-sizing: border-box; }
    button { margin-top: 16px; width: 100%; padding: 12px; border: none; border-radius: 10px; background: #4b90ff; color: white; font-weight: 700; cursor: pointer; }
    .links { margin-top: 20px; font-size: 13px; text-align: center; }
    .links a { color: #8fb8ff; text-decoration: none; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Get your access code</h1>
    <p>Enter the email address you used to subscribe on PayPal.</p>
    <form method="POST" action="/my-code">
      <label for="email">PayPal email</label>
      <input id="email" name="email" type="email" required autocomplete="email" />
      <button type="submit">Find my code</button>
    </form>
    <div class="links">
      <a href="/login">Already have a code? Login here</a>
    </div>
  </div>
</body>
</html>`);
});

router.post('/my-code', express.urlencoded({ extended: false }), (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();

  if (!email) {
    return res.status(400).send(renderMyCodeResult({ error: 'Please enter your email.' }));
  }

  const row = db.prepare(
    'SELECT * FROM access_codes WHERE email = ? AND is_revoked = 0 ORDER BY expires_at DESC LIMIT 1'
  ).get(email);

  if (!row) {
    return res.status(404).send(renderMyCodeResult({
      error: 'No active code found for that email. Make sure you use the same email as your PayPal account.',
    }));
  }

  if (new Date(row.expires_at) < new Date()) {
    return res.status(400).send(renderMyCodeResult({
      error: 'Your subscription has expired. Please renew via PayPal.',
    }));
  }

  return res.send(renderMyCodeResult({ code: row.code, expiresAt: row.expires_at }));
});

function renderMyCodeResult({ error = '', code = '', expiresAt = '' } = {}) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Your Code - TIKTOKBR</title>
  <style>
    body { background: #040714; color: #f5f7ff; font-family: Arial, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
    .container { width: min(460px, 90vw); padding: 28px; background: rgba(10,16,36,0.95); border: 1px solid rgba(100,180,255,0.2); border-radius: 14px; }
    h1 { margin-bottom: 16px; font-size: 22px; }
    .notice { padding: 14px; border-radius: 10px; background: rgba(255,255,255,0.05); }
    .error { color: #ff9fa8; }
    .code-box { margin-top: 20px; padding: 20px; border-radius: 12px; background: rgba(75,144,255,0.16); font-size: 20px; font-weight: 700; letter-spacing: 0.1em; text-align: center; word-break: break-all; }
    .expires { margin-top: 10px; font-size: 13px; color: #a8b8ff; text-align: center; }
    .links { margin-top: 20px; font-size: 13px; text-align: center; }
    .links a { color: #8fb8ff; text-decoration: none; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Your access code</h1>
    ${error ? `<div class="notice error">${escapeHtml(error)}</div><div class="links"><a href="/my-code">← Try again</a></div>` : ''}
    ${code ? `
      <div class="code-box">${escapeHtml(code)}</div>
      <div class="expires">Active until ${escapeHtml(expiresAt.slice(0, 10))}</div>
      <div class="links"><a href="/login">Go to login →</a></div>
    ` : ''}
  </div>
</body>
</html>`;
}

// ─── PayPal return handler: create a short-lived token and redirect to /claim ─
function renderBillingResult({ state = 'success', title = '', message = '', subscriptionId = '' } = {}) {
  const safeState = ['success', 'pending', 'cancel', 'error'].includes(state) ? state : 'success';
  const isPending = safeState === 'pending' && subscriptionId;
  const accent = safeState === 'error' ? '#e83b5f' : safeState === 'cancel' ? '#a8afbf' : '#f6c95b';
  const stateLabel = safeState === 'success'
    ? 'Purchase Complete'
    : safeState === 'pending'
      ? 'Activation Pending'
      : safeState;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(title || 'Billing Status')} - IntoTheBattle</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { min-height: 100vh; display: grid; place-items: center; padding: 24px; font-family: Arial, Helvetica, sans-serif; color: #fff8e6; background: radial-gradient(circle at 18% 8%, rgba(246,201,91,.18), transparent 30%), radial-gradient(circle at 82% 88%, rgba(255,106,61,.12), transparent 34%), linear-gradient(180deg, #050608, #030406); }
    .card { width: min(620px, 100%); padding: clamp(28px, 6vw, 44px); border-radius: 28px; border: 1px solid rgba(246,201,91,.26); background: rgba(5,7,11,.9); box-shadow: 0 30px 90px rgba(0,0,0,.48); text-align: center; }
    .logo { width: 104px; height: 104px; object-fit: contain; display: block; margin: 0 auto 18px; filter: drop-shadow(0 12px 28px rgba(246,201,91,.2)); }
    .kicker { display: inline-flex; margin-bottom: 18px; padding: 8px 12px; border-radius: 999px; color: ${accent}; border: 1px solid rgba(255,255,255,.12); background: rgba(255,255,255,.05); font-size: 12px; font-weight: 900; letter-spacing: .12em; text-transform: uppercase; }
    h1 { font-size: clamp(38px, 8vw, 68px); line-height: .95; margin-bottom: 16px; text-transform: uppercase; }
    p { color: #d4d9e7; line-height: 1.7; font-size: 18px; max-width: 500px; margin: 0 auto; }
    .meta { margin-top: 18px; padding: 14px; border-radius: 16px; background: rgba(255,255,255,.055); color: #a8afbf; word-break: break-word; }
    .actions { display: flex; gap: 12px; flex-wrap: wrap; justify-content: center; margin-top: 30px; }
    a { display: inline-flex; align-items: center; justify-content: center; min-height: 48px; padding: 0 18px; border-radius: 15px; color: #170c02; background: linear-gradient(135deg,#f6c95b,#fff0b9 52%,#ff6a3d); font-weight: 900; text-decoration: none; }
    a.secondary { color: #fff; background: rgba(255,255,255,.07); border: 1px solid rgba(255,255,255,.12); }
    #pollStatus { margin-top: 16px; color: #ffdf8a; font-size: 14px; }
  </style>
</head>
<body>
  <main class="card">
    <img class="logo" src="/logo.svg" alt="Into The Battle" />
    <div class="kicker">${escapeHtml(stateLabel)}</div>
    <h1>${escapeHtml(title || 'Billing Status')}</h1>
    <p>${escapeHtml(message || 'Your billing status has been updated.')}</p>
    ${subscriptionId ? `<div class="meta">PayPal subscription: ${escapeHtml(subscriptionId)}</div>` : ''}
    <div id="pollStatus">${isPending ? 'Checking PayPal activation...' : ''}</div>
    <div class="actions">
      <a href="/dashboard">Go to dashboard</a>
      <a class="secondary" href="/paywall">Back to upgrade</a>
    </div>
  </main>
  ${isPending ? `<script>
    let attempts = 0;
    const statusEl = document.getElementById('pollStatus');
    async function pollActivation() {
      attempts += 1;
      try {
        const res = await fetch('/api/paypal/subscription/status?subscription_id=${encodeURIComponent(subscriptionId)}', { credentials: 'same-origin' });
        const json = await res.json();
        if (json.success && json.active) {
          statusEl.textContent = 'Creator Pro is active. Redirecting...';
          window.location.href = '/dashboard';
          return;
        }
        statusEl.textContent = 'Still waiting for PayPal activation...';
      } catch (_err) {
        statusEl.textContent = 'Still checking PayPal activation...';
      }
      if (attempts < 10) setTimeout(pollActivation, 3000);
      else statusEl.textContent = 'PayPal is still processing this subscription. Refresh this page or check your profile in a moment.';
    }
    setTimeout(pollActivation, 1600);
  </script>` : ''}
</body>
</html>`;
}

router.get('/paypal-return', async (req, res) => {
  const sub = normalizePayPalSubscriptionId(req.query.subscription_id || req.query.subscriptionId || req.query.sub || req.query.ba_token || req.query.token);
  if (!sub) {
    return res.status(400).send(renderBillingResult({
      state: 'error',
      title: 'Checkout Return Incomplete',
      message: 'PayPal returned to IntoTheBattle without a subscription id. No charge was confirmed in the app. Please try the upgrade again.',
    }));
  }

  const user = getSessionUser(req);
  if (user) {
    try {
      const subscription = await getPayPalSubscription(sub);
      const activation = activateUserSubscription(user, subscription);
      trackSubscriptionStarted(req, user, activation);
      const pending = activation.status !== 'active';
      return res.redirect(302, `/billing/success?subscription_id=${encodeURIComponent(sub)}${pending ? '&pending=1' : ''}`);
    } catch (err) {
      console.error('PayPal return activation failed:', err);
      return res.status(502).send(renderBillingResult({
        state: 'error',
        title: 'Checkout Needs Attention',
        message: `PayPal returned a subscription id, but the app could not verify it yet. ${err.message || 'Please try again from the upgrade page.'}`,
        subscriptionId: sub,
      }));
    }
  }

  const secret = process.env.CLAIM_JWT_SECRET || process.env.JWT_SECRET;
  if (!secret) return res.status(500).send(renderBillingResult({
    state: 'error',
    title: 'Checkout Needs Attention',
    message: 'Server is not configured with a claim token secret.',
  }));
  const ttl = Number(process.env.CLAIM_TOKEN_TTL || 3600); // seconds
  try {
    const token = jwt.sign({ sub }, secret, { expiresIn: ttl });
    // Redirect buyer to the claim page with token
    return res.redirect(302, `/claim?sub=${encodeURIComponent(sub)}&t=${encodeURIComponent(token)}`);
  } catch (err) {
    console.error('Failed to create claim token:', err);
    return res.status(500).send(renderBillingResult({
      state: 'error',
      title: 'Checkout Needs Attention',
      message: 'Unable to create the claim link for this PayPal return.',
    }));
  }
});

// ─── Public claim page: show issued code for a subscription id ───────────────
router.get('/claim', (req, res) => {
  const sub = String(req.query.sub || '').trim();
  const token = String(req.query.t || req.query.token || '').trim();
  // If a short-lived claim token is provided, validate it and allow access
  if (token) {
    try {
      const secret = process.env.CLAIM_JWT_SECRET || process.env.JWT_SECRET;
      const payload = jwt.verify(token, secret);
      if (payload && payload.sub === sub) {
        const row = db.prepare('SELECT * FROM access_codes WHERE paypal_subscription_id = ? LIMIT 1').get(sub);
        if (!row) return res.status(404).send('<p>No code found for that subscription id.</p>');
        if (row.is_revoked) return res.status(400).send('<p>This subscription/code has been revoked or expired.</p>');
        return res.send(`<!doctype html><html><head><meta charset="utf-8"><title>Your Access Code</title><style>body{font-family:Arial,Helvetica,sans-serif;background:#041023;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;margin:0} .card{background:#071224;padding:28px;border-radius:12px;border:1px solid rgba(255,255,255,0.06);max-width:560px;width:90%} .code{font-weight:800;letter-spacing:0.12em;font-size:20px;background:linear-gradient(90deg,#fff,#e8f6ff);-webkit-background-clip:text;background-clip:text;color:transparent;padding:12px;border-radius:8px;text-align:center} .note{color:#cfe6ff;margin-top:12px;font-size:13px}</style></head><body><div class="card"><h2>Your Access Code</h2><div class="code">${escapeHtml(row.code)}</div><div class="note">Active until ${escapeHtml(String(row.expires_at).slice(0,10))}. Save this code now — it will not be emailed.</div></div></body></html>`);
      }
    } catch (err) {
      console.warn('Invalid claim token:', err && err.message);
      // fall through to normal checks
    }
  }
  const email = String(req.query.email || '').trim().toLowerCase();
  if (!sub) {
    return res.status(400).send(`<p>Missing subscription id. Use the link provided after subscribing or use <a href="/my-code">/my-code</a> to retrieve by email.</p>`);
  }
  const row = db.prepare('SELECT * FROM access_codes WHERE paypal_subscription_id = ? LIMIT 1').get(sub);
  if (!row) {
    return res.status(404).send(`<p>No code found for that subscription id. If you paid via PayPal, try <a href="/my-code">retrieving by email</a>.</p>`);
  }
  if (row.is_revoked) {
    return res.status(400).send(`<p>This subscription/code has been revoked or expired.</p>`);
  }
  if (email && row.email && email !== row.email.toLowerCase()) {
    return res.status(403).send(`<p>Email does not match subscription. Use the PayPal email used for purchase or visit <a href="/my-code">/my-code</a>.</p>`);
  }
  // Render simple page with the code
  return res.send(`<!doctype html><html><head><meta charset="utf-8"><title>Your Access Code</title><style>body{font-family:Arial,Helvetica,sans-serif;background:#041023;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;margin:0} .card{background:#071224;padding:28px;border-radius:12px;border:1px solid rgba(255,255,255,0.06);max-width:560px;width:90%} .code{font-weight:800;letter-spacing:0.12em;font-size:20px;background:linear-gradient(90deg,#fff,#e8f6ff);-webkit-background-clip:text;background-clip:text;color:transparent;padding:12px;border-radius:8px;text-align:center} .note{color:#cfe6ff;margin-top:12px;font-size:13px}</style></head><body><div class="card"><h2>Your Access Code</h2><div class="code">${escapeHtml(row.code)}</div><div class="note">Active until ${escapeHtml(String(row.expires_at).slice(0,10))}. Save this code now — it will not be emailed. If you lose it, visit <a href="/my-code">/my-code</a> to retrieve by PayPal email.</div></div></body></html>`);
});

export default router;
