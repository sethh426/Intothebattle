import express from 'express';
import rateLimit from 'express-rate-limit';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import postmark from 'postmark';
import { v4 as uuidv4 } from 'uuid';
import db from '../db/db.js';

function getPostmarkClient() {
  const token = process.env.POSTMARK_API_TOKEN;
  if (!token) return null;
  return new postmark.ServerClient(token);
}

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
  sameSite: 'lax',
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
  <title>Login - Battle Royale LIVE</title>
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
      <div class="card-title"> Battle Royale- An Interactive tool for TikTok LIVE. </div>
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
  <div class="page-footer">Battle Royale- An Interactive tool for TikTok LIVE.&nbsp;·&nbsp; Beta</div>
  <script src="https://cdn.jsdelivr.net/npm/fingerprintjs2@2/dist/fingerprint2.min.js"></script>
  <script>
    function setFingerprint(fp) {
      const input = document.getElementById('fp');
      if (input) input.value = fp;
      document.cookie = 'fp=' + fp + '; path=/; sameSite=lax;' + (location.protocol === 'https:' ? ' secure;' : '');
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
  <title>Redeem Promo - Battle Royale- An Interactive tool for TikTok LIVE.</title>
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
  <div class="page-footer">Battle Royale- An Interactive tool for TikTok LIVE. &nbsp;·&nbsp; Beta</div>
</body>
</html>`;
}

function sanitizeCode(value) {
  return String(value || '').trim().toUpperCase();
}

const registrationChallengeOptions = [
  { id: 'shield', label: 'Shield', fill: '#4D96FF', icon: '🔰' },
  { id: 'lock', label: 'Lock', fill: '#6BCB77', icon: '🔒' },
  { id: 'key', label: 'Key', fill: '#FFD166', icon: '🔑' },
  { id: 'star', label: 'Star', fill: '#FF9F43', icon: '⭐' },
  { id: 'diamond', label: 'Diamond', fill: '#8D4DFF', icon: '💎' },
];

function shuffleArray(array) {
  const copy = array.slice();
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function createSvgDataUri(option) {
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 120">
  <defs>
    <linearGradient id="grad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.22" />
      <stop offset="100%" stop-color="${option.fill}" stop-opacity="0.82" />
    </linearGradient>
  </defs>
  <rect x="0" y="0" width="160" height="120" rx="18" fill="${option.fill}" />
  <rect x="0" y="0" width="160" height="120" rx="18" fill="url(#grad)" />
  <circle cx="80" cy="60" r="36" fill="rgba(255,255,255,0.12)" />
  <text x="80" y="72" text-anchor="middle" dominant-baseline="middle" font-family="Arial, Helvetica, sans-serif" font-size="44" fill="#ffffff">${option.icon}</text>
  <text x="80" y="108" text-anchor="middle" dominant-baseline="middle" font-family="Arial, Helvetica, sans-serif" font-size="14" fill="#ffffff">${option.label}</text>
</svg>`;
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

function buildRegistrationChallenge() {
  const options = shuffleArray(registrationChallengeOptions).slice(0, 3).map((option) => ({
    id: option.id,
    label: option.label,
    image: createSvgDataUri(option),
  }));
  const selected = options[Math.floor(Math.random() * options.length)];
  return {
    options,
    prompt: `Select the photo of the ${selected.label.toLowerCase()}`,
    correct: selected.id,
  };
}

function verifyRegistrationChallenge(token, answer) {
  if (!token || !answer) return false;
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    return payload?.purpose === 'registration_challenge' && payload.correct === answer;
  } catch (_err) {
    return false;
  }
}

function getCookieOptions(httpOnly = true) {
  return { ...COOKIE_OPTIONS, httpOnly };
}

function createSessionToken(payload) {
  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '90d' });
}

function setSessionCookie(res, token) {
  res.cookie('session_token', token, getCookieOptions(true));
}

function clearSessionCookie(res) {
  res.clearCookie('session_token', getCookieOptions(true));
}

function getUserFromToken(token) {
  if (!token) return null;
  try {
    jwt.verify(token, process.env.JWT_SECRET);
  } catch (_err) {
    return null;
  }
  return db.prepare('SELECT * FROM users WHERE session_token = ?').get(token);
}

async function sendVerificationEmail(user, token) {
  const client = getPostmarkClient();
  if (!client) {
    console.warn('POSTMARK_API_TOKEN not configured; verification email will not be sent.');
    return null;
  }

  const baseUrl = process.env.APP_BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
  const verifyUrl = `${baseUrl.replace(/\/$/, '')}/verify-email?token=${encodeURIComponent(token)}&email=${encodeURIComponent(user.email)}`;
  const emailFrom = process.env.EMAIL_FROM || `Battle Royale <no-reply@${new URL(baseUrl).hostname}>`;

  await client.sendEmail({
    From: emailFrom,
    To: user.email,
    Subject: 'Verify your Battle Royale Live email',
    HtmlBody: `<p>Hello ${escapeHtml(user.name || user.email)},</p>
               <p>Click the link below to verify your email address for Battle Royale Live:</p>
               <p><a href="${escapeHtml(verifyUrl)}">Verify your email</a></p>
               <p>If you did not create an account, you can ignore this message.</p>
               <p>This link expires in 24 hours.</p>`,
    MessageStream: 'outbound',
  });
  return verifyUrl;
}

async function sendPasswordResetEmail(user, token) {
  const client = getPostmarkClient();
  if (!client) {
    console.warn('POSTMARK_API_TOKEN not configured; password reset email will not be sent.');
    return null;
  }

  const baseUrl = process.env.APP_BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
  const resetUrl = `${baseUrl.replace(/\/$/, '')}/reset-password?token=${encodeURIComponent(token)}&email=${encodeURIComponent(user.email)}`;
  const emailFrom = process.env.EMAIL_FROM || `Battle Royale <no-reply@${new URL(baseUrl).hostname}>`;

  await client.sendEmail({
    From: emailFrom,
    To: user.email,
    Subject: 'Reset your Battle Royale Live password',
    HtmlBody: `<p>Hello ${escapeHtml(user.name || user.email)},</p>
               <p>Click the link below to reset your password:</p>
               <p><a href="${escapeHtml(resetUrl)}">Reset Password</a></p>
               <p>This link expires in 1 hour.</p>`,
    MessageStream: 'outbound',
  });
  return resetUrl;
}

router.post('/auth/user/verify-email', express.json(), async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const token = String(req.body.token || '').trim();
  if (!email || !token) {
    return res.status(400).json({ success: false, error: 'Email and verification token are required.' });
  }

  const user = db.prepare(
    'SELECT * FROM users WHERE email = ? AND email_verification_token = ? AND email_verification_expires > CURRENT_TIMESTAMP'
  ).get(email, token);
  if (!user) {
    return res.status(400).json({ success: false, error: 'Invalid or expired verification link.' });
  }

  db.prepare(
    'UPDATE users SET email_verified = 1, email_verification_token = NULL, email_verification_expires = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
  ).run(user.id);

  return res.json({ success: true, message: 'Email verified successfully.' });
});

router.post('/auth/user/resend-verification', express.json(), async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  if (!email) {
    return res.status(400).json({ success: false, error: 'Email is required.' });
  }

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user) {
    return res.json({ success: true, message: 'If that email exists, a verification message has been sent.' });
  }

  if (user.email_verified) {
    return res.json({ success: true, message: 'Email is already verified.' });
  }

  const verificationToken = uuidv4();
  const verificationExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');
  db.prepare(
    'UPDATE users SET email_verification_token = ?, email_verification_expires = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
  ).run(verificationToken, verificationExpiresAt, user.id);

  await sendVerificationEmail(user, verificationToken).catch((err) => {
    console.error('Resend verification email failed:', err);
  });

  return res.json({ success: true, message: 'Verification email resent.' });
});

router.post('/auth/user/update-profile', express.json(), async (req, res) => {
  const token = req.cookies?.session_token;
  const user = getUserFromToken(token);
  if (!user) return res.status(401).json({ success: false, error: 'Unauthorized' });

  const name = String(req.body.name || '').trim();
  const tiktokUsername = String(req.body.tiktokUsername || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();

  if (!name || !tiktokUsername || !email) {
    return res.status(400).json({ success: false, error: 'Name, TikTok username, and email are required.' });
  }

  if (email !== user.email) {
    const existing = db.prepare('SELECT id FROM users WHERE email = ? AND id != ?').get(email, user.id);
    if (existing) {
      return res.status(409).json({ success: false, error: 'This email is already in use.' });
    }

    const verificationToken = uuidv4();
    const verificationExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');
    db.prepare(
      'UPDATE users SET name = ?, tiktok_username = ?, email = ?, email_verified = 0, email_verification_token = ?, email_verification_expires = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
    ).run(name, tiktokUsername, email, verificationToken, verificationExpiresAt, user.id);

    sendVerificationEmail({ id: user.id, email, name }, verificationToken).catch((err) => {
      console.error('Verification email failed after profile update:', err);
    });

    return res.json({ success: true, message: 'Profile updated. Please verify your new email address.' });
  }

  db.prepare(
    'UPDATE users SET name = ?, tiktok_username = ?, email = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
  ).run(name, tiktokUsername, email, user.id);

  return res.json({ success: true, message: 'Profile updated successfully.' });
});

router.post('/auth/user/change-password', express.json(), async (req, res) => {
  const token = req.cookies?.session_token;
  const user = getUserFromToken(token);
  if (!user) return res.status(401).json({ success: false, error: 'Unauthorized' });

  const currentPassword = String(req.body.currentPassword || '');
  const newPassword = String(req.body.newPassword || '');
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ success: false, error: 'Current and new passwords are required.' });
  }

  const validPassword = await bcrypt.compare(currentPassword, user.password_hash || '');
  if (!validPassword) {
    return res.status(401).json({ success: false, error: 'Current password is incorrect.' });
  }

  const passwordHash = await bcrypt.hash(newPassword, 10);
  db.prepare('UPDATE users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(passwordHash, user.id);
  return res.json({ success: true, message: 'Password changed successfully.' });
});

router.post('/auth/user/rooms', express.json(), (req, res) => {
  const token = req.cookies?.session_token;
  const user = getUserFromToken(token);
  if (!user) return res.status(401).json({ success: false, error: 'Unauthorized' });

  const roomName = String(req.body.roomName || '').trim();
  if (!roomName) return res.status(400).json({ success: false, error: 'Room name is required.' });

  const roomId = uuidv4().replace(/-/g, '').slice(0, 10);
  db.prepare(
    'INSERT INTO user_rooms (user_id, room_id, room_name, created_at, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)'
  ).run(user.id, roomId, roomName);
  db.prepare('INSERT OR IGNORE INTO room_settings (room_id) VALUES (?)').run(roomId);

  return res.json({ success: true, room: { room_id: roomId, room_name: roomName } });
});

router.post('/auth/user/request-password-reset', express.json(), async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  if (!email) return res.status(400).json({ success: false, error: 'Email is required.' });

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user) {
    return res.json({ success: true, message: 'If an account exists, a reset email will be sent.' });
  }

  const token = uuidv4();
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');
  db.prepare('UPDATE users SET password_reset_token = ?, password_reset_expires = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run(token, expiresAt, user.id);

  const resetLink = `${process.env.APP_BASE_URL || `http://localhost:${process.env.PORT || 3000}`}/reset-password?token=${encodeURIComponent(token)}&email=${encodeURIComponent(user.email)}`;
  let returnedLink = null;
  try {
    const sentUrl = await sendPasswordResetEmail(user, token);
    if (sentUrl) returnedLink = sentUrl;
  } catch (err) {
    console.warn('Password reset email failed', err);
  }

  const response = { success: true, message: 'If an account exists, reset instructions have been sent.' };
  if (!returnedLink && process.env.NODE_ENV !== 'production') {
    response.devResetLink = resetLink;
  }
  return res.json(response);
});

router.post('/auth/user/reset-password', express.json(), async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const token = String(req.body.token || '').trim();
  const newPassword = String(req.body.newPassword || '');

  if (!email || !token || !newPassword) {
    return res.status(400).json({ success: false, error: 'Email, token, and new password are required.' });
  }

  const user = db.prepare(
    'SELECT * FROM users WHERE email = ? AND password_reset_token = ? AND password_reset_expires > CURRENT_TIMESTAMP'
  ).get(email, token);
  if (!user) {
    return res.status(400).json({ success: false, error: 'Invalid or expired password reset token.' });
  }

  const passwordHash = await bcrypt.hash(newPassword, 10);
  const sessionToken = createSessionToken({ userId: user.id, email: user.email });
  db.prepare(
    'UPDATE users SET password_hash = ?, password_reset_token = NULL, password_reset_expires = NULL, session_token = ?, last_login = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
  ).run(passwordHash, sessionToken, user.id);

  setSessionCookie(res, sessionToken);
  return res.json({ success: true, message: 'Password reset successfully.' });
});

router.get('/auth/user/register-challenge', (req, res) => {
  const challenge = buildRegistrationChallenge();
  const token = jwt.sign(
    { purpose: 'registration_challenge', correct: challenge.correct },
    process.env.JWT_SECRET,
    { expiresIn: '10m' }
  );
  res.json({ success: true, challenge: { prompt: challenge.prompt, options: challenge.options }, token });
});

router.post('/auth/user/register', express.json(), async (req, res) => {
  const captchaToken = String(req.body.captchaToken || '').trim();
  const captchaAnswer = String(req.body.captchaAnswer || '').trim();
  if (!verifyRegistrationChallenge(captchaToken, captchaAnswer)) {
    return res.status(400).json({ success: false, error: 'Please complete the registration security check correctly.' });
  }

  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const name = String(req.body.name || '').trim();
  const tiktokUsername = String(req.body.tiktokUsername || '').trim();

  if (!email || !password || !name || !tiktokUsername) {
    return res.status(400).json({ success: false, error: 'Email, password, name, and TikTok username are required.' });
  }

  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) {
    return res.status(409).json({ success: false, error: 'An account with this email already exists.' });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const verificationToken = uuidv4();
  const verificationExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');
  const result = db.prepare(
    'INSERT INTO users (email, password_hash, name, tiktok_username, is_active, session_token, email_verified, email_verification_token, email_verification_expires, created_at, updated_at) VALUES (?, ?, ?, ?, 1, NULL, 0, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)'
  ).run(email, passwordHash, name, tiktokUsername, verificationToken, verificationExpiresAt);

  const userId = result.lastInsertRowid;
  const sessionToken = createSessionToken({ userId, email });
  db.prepare('UPDATE users SET session_token = ?, last_login = CURRENT_TIMESTAMP WHERE id = ?').run(sessionToken, userId);
  const user = { id: userId, email, name };
  setSessionCookie(res, sessionToken);

  const roomId = uuidv4().replace(/-/g, '').slice(0, 10);
  db.prepare('INSERT INTO user_rooms (user_id, room_id, room_name, created_at, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)').run(
    userId,
    roomId,
    `${name}'s room`
  );
  db.prepare('INSERT OR IGNORE INTO room_settings (room_id) VALUES (?)').run(roomId);

  sendVerificationEmail(user, verificationToken).catch((err) => {
    console.error('Verification email failed:', err);
  });

  const accountId = `ACC-${String(userId).padStart(6, '0')}`;
  return res.json({
    success: true,
    message: 'Account created. Check your inbox to verify your email.',
    roomId,
    accountId,
  });
});

router.post('/auth/user/login', express.json(), async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');

  if (!email || !password) {
    return res.status(400).json({ success: false, error: 'Email and password are required.' });
  }

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || !user.password_hash) {
    return res.status(401).json({ success: false, error: 'Invalid email or password.' });
  }

  const validPassword = await bcrypt.compare(password, user.password_hash);
  if (!validPassword) {
    return res.status(401).json({ success: false, error: 'Invalid email or password.' });
  }

  if (!user.is_active) {
    return res.status(403).json({ success: false, error: 'This account is disabled.' });
  }

  const sessionToken = createSessionToken({ userId: user.id, email });
  db.prepare('UPDATE users SET session_token = ?, last_login = CURRENT_TIMESTAMP WHERE id = ?').run(sessionToken, user.id);
  setSessionCookie(res, sessionToken);

  return res.json({ success: true, message: 'Logged in successfully.' });
});

router.post('/auth/user/logout', (req, res) => {
  const token = req.cookies?.session_token;
  if (token) {
    db.prepare('UPDATE users SET session_token = NULL WHERE session_token = ?').run(token);
  }
  clearSessionCookie(res);
  return res.json({ success: true, message: 'Logged out.' });
});

router.get('/auth/user/me', (req, res) => {
  const token = req.cookies?.session_token;
  if (!token) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }

  const user = getUserFromToken(token);
  if (!user) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }

  const rooms = db.prepare('SELECT room_id, room_name, created_at FROM user_rooms WHERE user_id = ? ORDER BY created_at DESC').all(user.id);
  const subscription = db.prepare('SELECT paypal_subscription_id, plan_type, status, started_at, next_billing_date, expires_at FROM subscriptions WHERE user_id = ? ORDER BY updated_at DESC LIMIT 1').get(user.id);
  return res.json({ success: true, user: {
    id: user.id,
    email: user.email,
    name: user.name,
    tiktok_username: user.tiktok_username,
    is_active: user.is_active,
    email_verified: !!user.email_verified,
    created_at: user.created_at,
    last_login: user.last_login,
  }, rooms, subscription });
});

router.get('/legacy-login', (req, res) => {
  const token = req.cookies.session_token;
  const fp = req.cookies.fp;
  if (token) {
    const row = db.prepare('SELECT * FROM access_codes WHERE session_token = ?').get(token);
    if (row && !row.is_revoked && new Date(row.expires_at) > new Date()) {
      if (!row.fingerprint || (fp && row.fingerprint === fp)) {
        return res.redirect('/dashboard');
      }
    }
    const user = db.prepare('SELECT * FROM users WHERE session_token = ?').get(token);
    if (user && user.is_active) {
      return res.redirect('/dashboard');
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