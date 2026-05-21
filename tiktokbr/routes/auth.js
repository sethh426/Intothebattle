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
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function renderLoginPage({ error = '', message = '' } = {}) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Login - PvP Stream Commander</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Rajdhani:wght@600;700&family=DM+Sans:wght@400;500;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --green: #6BCB77;
      --blue:  #4D96FF;
      --bg:    #050d1a;
    }
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'DM Sans', sans-serif;
      background: var(--bg);
      color: #e8eef8;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 24px;
      position: relative;
      overflow: hidden;
    }
    body::before {
      content: '';
      position: fixed; inset: 0; z-index: 0;
      background-image:
        linear-gradient(rgba(77,150,255,0.04) 1px, transparent 1px),
        linear-gradient(90deg, rgba(77,150,255,0.04) 1px, transparent 1px);
      background-size: 48px 48px;
      animation: gridShift 20s linear infinite;
    }
    @keyframes gridShift { from { background-position: 0 0; } to { background-position: 48px 48px; } }
    .orb {
      position: fixed; border-radius: 50%;
      filter: blur(90px); pointer-events: none; z-index: 0;
    }
    .orb-1 { width: 420px; height: 420px; background: rgba(77,150,255,0.1);  top: -140px; right: -80px; }
    .orb-2 { width: 360px; height: 360px; background: rgba(107,203,119,0.07); bottom: -80px; left: -100px; }
    .card {
      position: relative; z-index: 1;
      width: min(420px, 100%);
      background: rgba(8,18,40,0.92);
      border: 1px solid rgba(77,150,255,0.15);
      border-radius: 20px;
      padding: 44px 36px;
      box-shadow: 0 0 60px rgba(77,150,255,0.08), 0 24px 48px rgba(0,0,0,0.5);
      backdrop-filter: blur(20px);
      animation: fadeUp 0.5s ease both;
    }
    @keyframes fadeUp { from { opacity:0; transform: translateY(18px); } to { opacity:1; transform: translateY(0); } }
    .card-header { text-align: center; margin-bottom: 32px; }
    .card-icon { font-size: 40px; margin-bottom: 14px; display: block; }
    .card-title {
      font-family: 'Rajdhani', sans-serif;
      font-size: 30px; font-weight: 700; color: #fff; letter-spacing: 0.5px;
    }
    .card-sub { font-size: 14px; color: #5a7a9e; margin-top: 6px; }
    .form-group { margin-bottom: 20px; }
    .form-group label {
      display: block; font-size: 11px; font-weight: 600;
      letter-spacing: 1px; text-transform: uppercase;
      color: #5a7a9e; margin-bottom: 8px;
    }
    input[type=text], input[type=password] {
      width: 100%; padding: 14px 16px;
      background: rgba(255,255,255,0.05);
      border: 1px solid rgba(77,150,255,0.2);
      border-radius: 10px;
      color: #e8eef8; font-size: 16px; font-family: 'DM Sans', sans-serif;
      letter-spacing: 2px; outline: none;
      transition: border-color 0.2s, background 0.2s, box-shadow 0.2s;
    }
    input[type=text]:focus, input[type=password]:focus {
      border-color: var(--blue);
      background: rgba(77,150,255,0.06);
      box-shadow: 0 0 0 3px rgba(77,150,255,0.1);
    }
    input::placeholder { color: rgba(255,255,255,0.18); letter-spacing: 0; }
    .btn-enter {
      width: 100%; padding: 15px; border-radius: 10px;
      background: linear-gradient(135deg, var(--blue), #6ab0ff);
      border: none; color: #fff;
      font-size: 16px; font-weight: 700; font-family: 'DM Sans', sans-serif;
      cursor: pointer; letter-spacing: 0.5px;
      box-shadow: 0 0 24px rgba(77,150,255,0.3);
      transition: filter 0.15s, transform 0.15s, box-shadow 0.15s;
      position: relative; overflow: hidden;
    }
    .btn-enter::before {
      content: ''; position: absolute; inset: 0;
      background: linear-gradient(120deg, rgba(255,255,255,0.15), transparent 60%);
      pointer-events: none;
    }
    .btn-enter:hover { filter: brightness(1.1); transform: translateY(-1px); box-shadow: 0 0 36px rgba(77,150,255,0.45); }
    .btn-enter:active { transform: translateY(0); }
    .links { margin-top: 24px; display: flex; flex-direction: column; gap: 10px; }
    .link-item {
      display: flex; align-items: center; gap: 10px;
      padding: 12px 16px; border-radius: 10px;
      border: 1px solid rgba(255,255,255,0.06);
      background: rgba(255,255,255,0.02);
      text-decoration: none; color: #7a9abf;
      font-size: 14px; font-weight: 500;
      transition: background 0.2s, border-color 0.2s, color 0.2s;
    }
    .link-item:hover { background: rgba(77,150,255,0.08); border-color: rgba(77,150,255,0.25); color: #e8eef8; }
    .link-item .link-icon { font-size: 16px; flex-shrink: 0; }
    .link-item .link-arrow { margin-left: auto; opacity: 0.4; font-size: 12px; }
    .link-item.highlight {
      border-color: rgba(107,203,119,0.25);
      background: rgba(107,203,119,0.05);
      color: #9adba4;
    }
    .link-item.highlight:hover { background: rgba(107,203,119,0.1); border-color: rgba(107,203,119,0.4); color: var(--green); }
    .notice {
      padding: 12px 14px; border-radius: 10px;
      font-size: 13px; margin-bottom: 20px;
    }
    .error  { background: rgba(255,107,107,0.1); border: 1px solid rgba(255,107,107,0.25); color: #ff8f8f; }
    .success { background: rgba(107,203,119,0.1); border: 1px solid rgba(107,203,119,0.25); color: #9adba4; }
    .page-footer {
      position: relative; z-index: 1;
      margin-top: 24px; text-align: center;
      font-size: 12px; color: #2a4060;
    }
  </style>
</head>
<body>
  <div class="orb orb-1"></div>
  <div class="orb orb-2"></div>
  <div class="card">
    <div class="card-header">
      <span class="card-icon">🎮</span>
      <div class="card-title">PvP Stream Commander</div>
      <div class="card-sub">Enter your access code to get started</div>
    </div>
    ${error   ? `<div class="notice error">${escapeHtml(error)}</div>`     : ''}
    ${message ? `<div class="notice success">${escapeHtml(message)}</div>` : ''}
    <form method="POST" action="/login">
      <div class="form-group">
        <label for="code">Access Code</label>
        <input id="code" name="code" type="text" autocomplete="off" required placeholder="XXXX-XXXX-XXXX" />
        <input id="fp" name="fingerprint" type="hidden" />
      </div>
      <button type="submit" class="btn-enter">Enter →</button>
    </form>
    <div class="links">
      <a href="${PAYPAL_LINK}" target="_blank" rel="noopener" class="link-item highlight">
        <span class="link-icon">💳</span>
        Purchase for only $8.50/month
        <span class="link-arrow">↗</span>
      </a>
      <a href="/my-code" class="link-item">
        <span class="link-icon">📬</span>
        Already subscribed? Get your code here
        <span class="link-arrow">→</span>
      </a>
      <a href="/redeem-promo" class="link-item">
        <span class="link-icon">🎟️</span>
        Have a promo code?
        <span class="link-arrow">→</span>
      </a>
    </div>
  </div>
  <div class="page-footer">PvP Stream Commander &nbsp;·&nbsp; Beta</div>
  <script src="https://cdn.jsdelivr.net/npm/fingerprintjs2@2/dist/fingerprint2.min.js"></script>
  <script>
    function setFingerprint(fp) {
      const input = document.getElementById('fp');
      if (input) input.value = fp;
      document.cookie = 'fp=' + fp + '; path=/; sameSite=strict;' + (location.protocol === 'https:' ? ' secure;' : '');
    }
    if (window.Fingerprint2) {
      Fingerprint2.get(function(components) {
        var values = components.map(function(c) { return c.value; });
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
  <title>Redeem Promo - PvP Stream Commander</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Rajdhani:wght@600;700&family=DM+Sans:wght@400;500;700&display=swap" rel="stylesheet">
  <style>
    :root { --green: #6BCB77; --blue: #4D96FF; --bg: #050d1a; }
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'DM Sans', sans-serif;
      background: var(--bg); color: #e8eef8;
      min-height: 100vh; display: flex;
      flex-direction: column; align-items: center; justify-content: center;
      padding: 24px; position: relative; overflow: hidden;
    }
    body::before {
      content: ''; position: fixed; inset: 0; z-index: 0;
      background-image:
        linear-gradient(rgba(77,150,255,0.04) 1px, transparent 1px),
        linear-gradient(90deg, rgba(77,150,255,0.04) 1px, transparent 1px);
      background-size: 48px 48px;
      animation: gridShift 20s linear infinite;
    }
    @keyframes gridShift { from { background-position: 0 0; } to { background-position: 48px 48px; } }
    .orb { position: fixed; border-radius: 50%; filter: blur(90px); pointer-events: none; z-index: 0; }
    .orb-1 { width: 420px; height: 420px; background: rgba(77,150,255,0.1);  top: -140px; right: -80px; }
    .orb-2 { width: 360px; height: 360px; background: rgba(107,203,119,0.07); bottom: -80px; left: -100px; }
    .card {
      position: relative; z-index: 1;
      width: min(480px, 100%);
      background: rgba(8,18,40,0.92);
      border: 1px solid rgba(77,150,255,0.15); border-radius: 20px;
      padding: 44px 36px;
      box-shadow: 0 0 60px rgba(77,150,255,0.08), 0 24px 48px rgba(0,0,0,0.5);
      backdrop-filter: blur(20px);
      animation: fadeUp 0.5s ease both;
    }
    @keyframes fadeUp { from { opacity:0; transform: translateY(18px); } to { opacity:1; transform: translateY(0); } }
    .card-header { text-align: center; margin-bottom: 32px; }
    .card-icon { font-size: 40px; margin-bottom: 14px; display: block; }
    .card-title { font-family: 'Rajdhani', sans-serif; font-size: 28px; font-weight: 700; color: #fff; }
    .card-sub { font-size: 14px; color: #5a7a9e; margin-top: 6px; }
    .form-group { margin-bottom: 20px; }
    .form-group label {
      display: block; font-size: 11px; font-weight: 600;
      letter-spacing: 1px; text-transform: uppercase; color: #5a7a9e; margin-bottom: 8px;
    }
    input[type=text] {
      width: 100%; padding: 14px 16px;
      background: rgba(255,255,255,0.05);
      border: 1px solid rgba(77,150,255,0.2); border-radius: 10px;
      color: #e8eef8; font-size: 16px; font-family: 'DM Sans', sans-serif;
      letter-spacing: 2px; outline: none;
      transition: border-color 0.2s, background 0.2s, box-shadow 0.2s;
    }
    input[type=text]:focus {
      border-color: var(--blue); background: rgba(77,150,255,0.06);
      box-shadow: 0 0 0 3px rgba(77,150,255,0.1);
    }
    input::placeholder { color: rgba(255,255,255,0.18); letter-spacing: 0; }
    .btn-redeem {
      width: 100%; padding: 15px; border-radius: 10px;
      background: linear-gradient(135deg, var(--green), #4ade80);
      border: none; color: #000;
      font-size: 16px; font-weight: 700; font-family: 'DM Sans', sans-serif;
      cursor: pointer; letter-spacing: 0.5px;
      box-shadow: 0 0 24px rgba(107,203,119,0.25);
      transition: filter 0.15s, transform 0.15s;
    }
    .btn-redeem:hover { filter: brightness(1.08); transform: translateY(-1px); }
    .notice {
      padding: 12px 14px; border-radius: 10px;
      font-size: 13px; margin-bottom: 20px;
    }
    .error   { background: rgba(255,107,107,0.1); border: 1px solid rgba(255,107,107,0.25); color: #ff8f8f; }
    .success { background: rgba(107,203,119,0.1); border: 1px solid rgba(107,203,119,0.25); color: #9adba4; }
    .code-box {
      margin: 20px 0; padding: 20px;
      border-radius: 12px;
      background: rgba(77,150,255,0.1); border: 1px solid rgba(77,150,255,0.25);
      font-family: 'Rajdhani', sans-serif;
      font-size: 24px; font-weight: 700; letter-spacing: 4px;
      text-align: center; color: #fff;
    }
    .code-warning {
      font-size: 13px; color: #ff9f40; text-align: center;
      margin-bottom: 20px; padding: 10px 14px;
      background: rgba(255,159,64,0.08); border: 1px solid rgba(255,159,64,0.2);
      border-radius: 8px;
    }
    .back-link {
      display: block; text-align: center; margin-top: 24px;
      font-size: 14px; color: #5a7a9e; text-decoration: none;
      transition: color 0.2s;
    }
    .back-link:hover { color: #e8eef8; }
    .page-footer {
      position: relative; z-index: 1;
      margin-top: 24px; text-align: center;
      font-size: 12px; color: #2a4060;
    }
  </style>
</head>
<body>
  <div class="orb orb-1"></div>
  <div class="orb orb-2"></div>
  <div class="card">
    <div class="card-header">
      <span class="card-icon">🎟️</span>
      <div class="card-title">Redeem a Promo Code</div>
      <div class="card-sub">Enter your promo code to receive access</div>
    </div>
    ${error   ? `<div class="notice error">${escapeHtml(error)}</div>`     : ''}
    ${message ? `<div class="notice success">${escapeHtml(message)}</div>` : ''}
    ${code    ? `
      <div class="code-box">${escapeHtml(code)}</div>
      <div class="code-warning">⚠️ Save this access code now — you will not be able to recover it later.</div>
    ` : ''}
    <form method="POST" action="/redeem-promo">
      <div class="form-group">
        <label for="promo">Promo Code</label>
        <input id="promo" name="promo" type="text" autocomplete="off" required placeholder="Enter promo code" />
      </div>
      <button type="submit" class="btn-redeem">Redeem →</button>
    </form>
    <a href="/login" class="back-link">← Back to login</a>
  </div>
  <div class="page-footer">PvP Stream Commander &nbsp;·&nbsp; Beta</div>
</body>
</html>`;
}

function getCookieOptions(httpOnly = true) {
  return { ...COOKIE_OPTIONS, httpOnly };
}

function sanitizeCode(value) {
  return String(value || '').trim().toUpperCase();
}

router.get('/login', (req, res) => {
  const token = req.cookies.session_token;
  const fp = req.cookies.fp;
  if (token) {
    const row = db.prepare('SELECT * FROM access_codes WHERE session_token = ?').get(token);
    if (row && !row.is_revoked && new Date(row.expires_at) > new Date()) {
      if (!row.fingerprint || (fp && row.fingerprint === fp)) {
        return res.redirect('/dashboard');
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

  const row = db.prepare('SELECT * FROM access_codes WHERE UPPER(code) = ?').get(submittedCode);
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
  res.redirect('/dashboard');
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