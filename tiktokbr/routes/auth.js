import express from 'express';
import rateLimit from 'express-rate-limit';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import db from '../db/db.js';

const router = express.Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: 'Too many login attempts. Try again in 15 minutes.',
});

const promoLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: 'Too many promo code attempts. Try again in 15 minutes.',
});

const PAYPAL_LINK = process.env.PAYPAL_PAYMENT_LINK || 'https://www.paypal.com';
const COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: 'strict',
  secure: process.env.NODE_ENV === 'production',
};

function escapeHtml(value) {
  return String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderLoginPage({ error = '', message = '' } = {}) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Login - TIKTOKBR</title>
  <style>
    body { background: #040714; color: #f5f7ff; font-family: Arial, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
    .container { width: min(420px, 90vw); padding: 24px; background: rgba(10,16,36,0.95); border: 1px solid rgba(100, 180, 255, 0.2); border-radius: 14px; }
    h1 { margin-bottom: 18px; font-size: 22px; }
    label { display: block; margin-top: 12px; font-size: 13px; color: #a8b8ff; }
    input[type=text], input[type=password] { width: 100%; padding: 12px 14px; border-radius: 10px; border: 1px solid rgba(255,255,255,0.12); background: rgba(255,255,255,0.04); color: #fff; }
    button { margin-top: 18px; width: 100%; padding: 12px; border: none; border-radius: 10px; background: #4b90ff; color: white; font-weight: 700; cursor: pointer; }
    .links { margin-top: 16px; display: flex; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
    .links a { color: #8fb8ff; font-size: 13px; text-decoration: none; }
    .notice { margin-top: 16px; padding: 12px; border-radius: 10px; background: rgba(255,255,255,0.05); }
    .error { color: #ff9fa8; }
    .success { color: #b9ffb0; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Enter access code</h1>
    ${error ? `<div class="notice error">${escapeHtml(error)}</div>` : ''}
    ${message ? `<div class="notice success">${escapeHtml(message)}</div>` : ''}
    <form method="POST" action="/login">
      <label for="code">Access code</label>
      <input id="code" name="code" type="text" autocomplete="off" required />
      <input id="fp" name="fingerprint" type="hidden" />
      <button type="submit">Enter</button>
    </form>
    <div class="links">
      <a href="${PAYPAL_LINK}" target="_blank" rel="noopener">Don't have a code? Subscribe here</a>
      <a href="/redeem-promo">Have a promo code?</a>
    </div>
  </div>
  <script src="https://cdn.jsdelivr.net/npm/fingerprintjs2@2/dist/fingerprint2.min.js"></script>
  <script>
    function setFingerprint(fp) {
      const input = document.getElementById('fp');
      if (input) input.value = fp;
      document.cookie = `fp=${fp}; path=/; sameSite=strict;${location.protocol === 'https:' ? ' secure;' : ''}`;
    }
    if (window.Fingerprint2) {
      Fingerprint2.get(function(components) {
        var values = components.map(function(component) { return component.value; });
        setFingerprint(Fingerprint2.x64hash128(values.join(''), 31));
      });
    } else {
      document.addEventListener('DOMContentLoaded', function() {
        setFingerprint('unknown-device');
      });
    }
  </script>
</body>
</html>`;
}

function renderPromoPage({ error = '', message = '', code = '' } = {}) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Redeem Promo - TIKTOKBR</title>
  <style>
    body { background: #050a17; color: #eef2ff; font-family: Arial, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
    .container { width: min(520px, 92vw); padding: 24px; background: rgba(12, 18, 38, 0.96); border-radius: 14px; border: 1px solid rgba(115, 160, 255, 0.2); }
    h1 { margin-bottom: 18px; font-size: 22px; }
    label { display: block; margin-top: 12px; font-size: 13px; color: #a8b8ff; }
    input[type=text] { width: 100%; padding: 12px 14px; border-radius: 10px; border: 1px solid rgba(255,255,255,0.12); background: rgba(255,255,255,0.04); color: #fff; }
    button { margin-top: 18px; width: 100%; padding: 12px; border: none; border-radius: 10px; background: #4b90ff; color: white; font-weight: 700; cursor: pointer; }
    .notice { margin-top: 16px; padding: 12px; border-radius: 10px; background: rgba(255,255,255,0.05); }
    .error { color: #ff9fa8; }
    .success { color: #b9ffb0; }
    .code-box { margin-top: 18px; padding: 16px; border-radius: 12px; background: rgba(75,144,255,0.16); font-size: 18px; font-weight: 700; letter-spacing: 0.08em; text-align: center; }
    a { color: #8fb8ff; text-decoration: none; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Redeem a promo code</h1>
    ${error ? `<div class="notice error">${escapeHtml(error)}</div>` : ''}
    ${message ? `<div class="notice success">${escapeHtml(message)}</div>` : ''}
    ${code ? `<div class="code-box">${escapeHtml(code)}</div><p style="margin-top: 12px;">Save this access code now — you will not be able to recover it later.</p>` : ''}
    <form method="POST" action="/auth/redeem-promo">
      <label for="promo">Promo code</label>
      <input id="promo" name="promo" type="text" autocomplete="off" required />
      <button type="submit">Redeem</button>
    </form>
    <div style="margin-top: 18px; font-size: 13px; color: #b8c4e0;">
      Have an access code? <a href="/login">Login here</a>.
    </div>
  </div>
</body>
</html>`;
}

function getCookieOptions(httpOnly = true) {
  return {
    ...COOKIE_OPTIONS,
    httpOnly,
  };
}

function sanitizeCode(value) {
  return String(value || '').trim().toUpperCase();
}

function sessionIsActive(row, currentSessionToken) {
  return row.session_token && row.session_token !== '' && row.session_token !== currentSessionToken;
}

router.get('/login', (req, res) => {
  const token = req.cookies.session_token;
  const fp = req.cookies.fp;
  if (token) {
    const row = db.prepare('SELECT * FROM access_codes WHERE session_token = ?').get(token);
    if (row && !row.is_revoked && new Date(row.expires_at) > new Date()) {
      if (!row.fingerprint || (fp && row.fingerprint === fp)) {
        return res.redirect('/overlay');
      }
    }
  }
  res.send(renderLoginPage());
});

router.post('/login', loginLimiter, (req, res) => {
  const submittedCode = sanitizeCode(req.body.code);
  const fingerprint = String(req.body.fingerprint || '').trim();
  if (!submittedCode) return res.status(400).send(renderLoginPage({ error: 'Please enter a code.' }));
  if (!fingerprint) return res.status(400).send(renderLoginPage({ error: 'Device fingerprint is required.' }));

  const row = db.prepare('SELECT * FROM access_codes WHERE code = ?').get(submittedCode);
  if (!row) return res.status(400).send(renderLoginPage({ error: 'Invalid code' }));
  if (row.is_revoked) return res.status(400).send(renderLoginPage({ error: 'This code has been revoked' }));
  if (new Date(row.expires_at) < new Date()) return res.status(400).send(renderLoginPage({ error: 'This code has expired — please renew your subscription' }));

  const currentCookie = req.cookies.session_token;
  if (row.session_token && row.session_token !== '' && row.session_token !== currentCookie) {
    return res.status(400).send(renderLoginPage({ error: 'This code is already in use on another device' }));
  }

  if (row.fingerprint && row.fingerprint !== fingerprint) {
    return res.status(400).send(renderLoginPage({ error: 'This code is locked to another device — contact support' }));
  }

  const sessionToken = jwt.sign({ code: row.code, tokenId: uuidv4() }, process.env.JWT_SECRET);
  db.prepare('UPDATE access_codes SET session_token = ?, last_seen = CURRENT_TIMESTAMP, fingerprint = COALESCE(fingerprint, ?) WHERE id = ?')
    .run(sessionToken, fingerprint, row.id);

  res.cookie('session_token', sessionToken, getCookieOptions(true));
  res.cookie('fp', fingerprint, getCookieOptions(false));
  res.redirect('/overlay');
});

router.post('/logout', (req, res) => {
  const token = req.cookies.session_token;
  if (token) {
    const row = db.prepare('SELECT * FROM access_codes WHERE session_token = ?').get(token);
    if (row) db.prepare('UPDATE access_codes SET session_token = NULL WHERE id = ?').run(row.id);
  }
  res.clearCookie('session_token', getCookieOptions(true));
  res.clearCookie('fp', getCookieOptions(false));
  res.redirect('/login');
});

router.get('/redeem-promo', (_req, res) => {
  res.send(renderPromoPage());
});

router.post('/redeem-promo', promoLimiter, (req, res) => {
  const promo = String(req.body.promo || '').trim().toUpperCase();
  if (!promo) return res.status(400).send(renderPromoPage({ error: 'Please enter a promo code.' }));

  const promoRow = db.prepare('SELECT * FROM promo_codes WHERE code = ?').get(promo);
  if (!promoRow || promoRow.uses_remaining <= 0) {
    return res.status(400).send(renderPromoPage({ error: 'Invalid or expired promo code' }));
  }

  if (promoRow.expires_at && new Date(promoRow.expires_at) < new Date()) {
    return res.status(400).send(renderPromoPage({ error: 'This promo code has expired' }));
  }

  const accessCode = uuidv4().replace(/-/g, '').toUpperCase();
  const expiresAt = new Date(Date.now() + promoRow.days_granted * 24 * 60 * 60 * 1000);
  const expiresString = expiresAt.toISOString().slice(0, 19).replace('T', ' ');

  db.prepare('INSERT INTO access_codes (code, expires_at, is_promo) VALUES (?, ?, 1)').run(accessCode, expiresString);
  db.prepare('UPDATE promo_codes SET uses_remaining = uses_remaining - 1 WHERE id = ?').run(promoRow.id);

  res.send(renderPromoPage({ message: 'Promo code accepted. Save your access code below.', code: accessCode }));
});

export default router;
