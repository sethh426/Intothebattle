import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import db from '../db/db.js';
import jwt from 'jsonwebtoken';

const router = express.Router();

function escapeHtml(value) {
  return String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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
      user_id, paypal_subscription_id, plan_type, status, started_at, next_billing_date, expires_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(paypal_subscription_id) DO UPDATE SET
      status = excluded.status,
      next_billing_date = excluded.next_billing_date,
      expires_at = excluded.expires_at,
      updated_at = CURRENT_TIMESTAMP
  `);
  insert.run(userId, paypalId, planType, status, startedAt, nextBillingDate, expiresAt);
}

// (Previously had email-sending helpers here; removed — codes will be shown on a claim page)

async function getPayPalAccessToken() {
  const clientId     = process.env.PAYPAL_CLIENT_ID;
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET;
  const credentials  = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  const response = await fetch('https://api-m.paypal.com/v1/oauth2/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });

  const data = await response.json();
  return data.access_token;
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

    const response = await fetch('https://api-m.paypal.com/v1/notifications/verify-webhook-signature', {
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
      const startedAt = formatDateForSql(subscription?.create_time);
      const nextBilling = formatDateForSql(subscription?.billing_info?.next_billing_time || subscription?.billing_info?.next_billing_time);
      const planType = subscription?.billing_info?.last_payment?.amount?.currency_code || 'paypal';

      if (user) {
        createOrUpdateSubscription(user.id, subId, planType, 'active', startedAt, nextBilling, null);
        const existingRoom = db.prepare('SELECT room_id FROM user_rooms WHERE user_id = ? ORDER BY id LIMIT 1').get(user.id);
        if (!existingRoom) {
          const roomId = uuidv4().replace(/-/g, '').slice(0, 10);
          db.prepare(
            'INSERT INTO user_rooms (user_id, room_id, room_name, created_at, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)'
          ).run(user.id, roomId, `${user.name || 'Creator'}'s room`);
          db.prepare('INSERT INTO room_settings (room_id) VALUES (?) ON CONFLICT (room_id) DO NOTHING').run(roomId);
        }
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
        const subscription = db.prepare('SELECT * FROM subscriptions WHERE paypal_subscription_id = ?').get(subId);
        if (subscription) {
          db.prepare('UPDATE subscriptions SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run('cancelled', subscription.id);
          console.log(`🚫 Suspended/Cancelled user subscription ${subId}`);
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

export default router;

// ─── PayPal return handler: create a short-lived token and redirect to /claim ─
router.get('/paypal-return', (req, res) => {
  const sub = String(req.query.subscription_id || req.query.sub || '').trim();
  if (!sub) return res.status(400).send('<p>Missing subscription id in return URL.</p>');
  const secret = process.env.CLAIM_JWT_SECRET || process.env.JWT_SECRET;
  if (!secret) return res.status(500).send('<p>Server not configured with claim token secret.</p>');
  const ttl = Number(process.env.CLAIM_TOKEN_TTL || 3600); // seconds
  try {
    const token = jwt.sign({ sub }, secret, { expiresIn: ttl });
    // Redirect buyer to the claim page with token
    return res.redirect(302, `/claim?sub=${encodeURIComponent(sub)}&t=${encodeURIComponent(token)}`);
  } catch (err) {
    console.error('Failed to create claim token:', err);
    return res.status(500).send('<p>Unable to create claim link.</p>');
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