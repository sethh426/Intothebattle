import express from 'express';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import bcrypt from 'bcryptjs';
import db from '../db/db.js';

const router = express.Router();
const COOKIE_NAME = 'admin_session_token';
const COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: 'strict',
  secure: process.env.NODE_ENV === 'production',
};

function escapeHtml(value) {
  return String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function getCookieOptions() {
  return { ...COOKIE_OPTIONS };
}

function timingSafeCompare(value, expected) {
  const a = Buffer.from(String(value));
  const b = Buffer.from(String(expected));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function compareAdminPassword(password) {
  const stored = process.env.ADMIN_PASSWORD || '';
  if (!stored) return false;
  if (stored.startsWith('$2a$') || stored.startsWith('$2b$') || stored.startsWith('$2y$')) {
    return bcrypt.compareSync(password, stored);
  }
  return timingSafeCompare(password, stored);
}

function requireAdminAuth(req, res, next) {
  const token = req.cookies[COOKIE_NAME];
  if (!token) return res.redirect('/admin/login');

  const row = db.prepare('SELECT * FROM admin_sessions WHERE session_token = ?').get(token);
  if (!row) return res.redirect('/admin/login');
  if (new Date(row.expires_at) < new Date()) return res.redirect('/admin/login');

  req.adminSession = row;
  next();
}

function renderAdminPage({ message = '', error = '', createdCode = '', codes = [], promos = [] } = {}) {
  const codeRows = codes.map((code) => {
    const status = code.is_revoked ? 'Revoked' : new Date(code.expires_at) < new Date() ? 'Expired' : 'Active';
    return `<tr>
      <td>${escapeHtml(code.code)}</td>
      <td>${escapeHtml(code.owner_name || code.email || '')}</td>
      <td>${escapeHtml(code.created_at)}</td>
      <td>${escapeHtml(code.expires_at)}</td>
      <td>${status}</td>
      <td>${code.is_promo ? 'Promo' : 'Paid'}</td>
      <td>${escapeHtml(code.last_seen || '')}</td>
    </tr>`;
  }).join('');

  const promoRows = promos.map((promo) => {
    return `<tr>
      <td>${escapeHtml(promo.code)}</td>
      <td>${escapeHtml(String(promo.uses_remaining))}</td>
      <td>${escapeHtml(String(promo.days_granted))}</td>
      <td>${escapeHtml(promo.expires_at || 'Never')}</td>
      <td>${escapeHtml(promo.created_at)}</td>
    </tr>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Admin Panel - TIKTOKBR</title>
  <style>
    body { font-family: Arial, sans-serif; background: #07101f; color: #ebf4ff; margin: 0; padding: 24px; }
    .wrapper { max-width: 1100px; margin: 0 auto; }
    h1 { margin-bottom: 14px; }
    .notice { margin-bottom: 16px; padding: 14px; border-radius: 12px; background: rgba(255,255,255,0.06); }
    .error { color: #ffb6b6; }
    .success { color: #c6ffc3; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 16px; }
    .card { background: rgba(255,255,255,0.05); border: 1px solid rgba(130,170,255,0.16); border-radius: 14px; padding: 18px; }
    label { display: block; margin: 10px 0 6px; color: #99b4ff; font-size: 14px; }
    input, select { width: 100%; padding: 10px 12px; border-radius: 10px; border: 1px solid rgba(255,255,255,0.12); background: rgba(255,255,255,0.04); color: #fff; }
    button { margin-top: 12px; width: 100%; padding: 12px; border: none; border-radius: 10px; background: #4b90ff; color: #fff; cursor: pointer; font-weight: 700; }
    table { width: 100%; border-collapse: collapse; margin-top: 12px; }
    th, td { border: 1px solid rgba(255,255,255,0.08); padding: 10px; font-size: 13px; }
    th { background: rgba(75,144,255,0.12); text-align: left; }
    .button-row { display: flex; gap: 12px; flex-wrap: wrap; }
    .button-row button { width: auto; flex: 1; }
    a { color: #8fb8ff; text-decoration: none; }
  </style>
</head>
<body>
  <div class="wrapper">
    <h1>Admin Panel</h1>
    ${message ? `<div class="notice success">${escapeHtml(message)}</div>` : ''}
    ${createdCode ? `<div class="notice success">New access code created: <strong>${escapeHtml(createdCode)}</strong> <button type="button" onclick="navigator.clipboard.writeText('${escapeHtml(createdCode)}')">Copy</button></div>` : ''}
    ${error ? `<div class="notice error">${escapeHtml(error)}</div>` : ''}
    <div class="grid">
      <div class="card">
        <h2>Issue access code</h2>
        <form method="POST" action="/admin/issue-code">
          <label>Name (optional, stored for tracking only)</label>
          <input name="name" type="text" placeholder="Customer or buyer name" />
          <label>Days</label>
          <input name="days" type="number" min="0" value="30" />
          <label><input name="permanent" type="checkbox" value="1" /> Permanent code (no expiry)</label>
          <button type="submit">Issue Code</button>
        </form>
      </div>
      <div class="card">
        <h2>Extend code</h2>
        <form method="POST" action="/admin/extend-code">
          <label>Access code</label>
          <input name="code" type="text" required />
          <label>Days to add</label>
          <input name="days" type="number" min="1" value="30" required />
          <button type="submit">Extend</button>
        </form>
      </div>
      <div class="card">
        <h2>Revoke / reset</h2>
        <form method="POST" action="/admin/revoke-code">
          <label>Access code</label>
          <input name="code" type="text" required />
          <button type="submit">Revoke</button>
        </form>
        <form method="POST" action="/admin/reset-device" style="margin-top: 14px;">
          <label>Access code</label>
          <input name="code" type="text" required />
          <button type="submit">Reset Device</button>
        </form>
      </div>
      <div class="card">
        <h2>Create promo code</h2>
        <form method="POST" action="/admin/create-promo">
          <label>Promo code</label>
          <input name="code" type="text" required />
          <label>Uses</label>
          <input name="uses" type="number" min="1" value="1" required />
          <label>Days granted</label>
          <input name="days" type="number" min="1" value="30" required />
          <label>Promo expiry (optional)</label>
          <input name="expires_at" type="date" />
          <button type="submit">Create Promo</button>
        </form>
      </div>
    </div>
    <div class="card" style="margin-top: 24px;">
      <h2>Access codes</h2>
      <table>
        <thead><tr><th>Code</th><th>Name / Email</th><th>Created</th><th>Expires</th><th>Status</th><th>Type</th><th>Last Seen</th></tr></thead>
        <tbody>${codeRows}</tbody>
      </table>
    </div>
    <div class="card" style="margin-top: 18px;">
      <h2>Promo codes</h2>
      <table>
        <thead><tr><th>Promo</th><th>Uses</th><th>Days</th><th>Expires</th><th>Created</th></tr></thead>
        <tbody>${promoRows}</tbody>
      </table>
    </div>
    <div style="margin-top: 18px;">
      <a href="/admin/logout">Logout</a>
    </div>
  </div>
</body>
</html>`;
}

router.get('/login', (_req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Admin Login - TIKTOKBR</title>
  <style>
    body { background: #070f1b; color: #eef2ff; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; font-family: Arial, sans-serif; }
    .form { width: min(420px, 90vw); padding: 24px; background: rgba(6, 14, 32, 0.96); border: 1px solid rgba(100, 150, 255, 0.18); border-radius: 16px; }
    h1 { margin-bottom: 18px; }
    label { display: block; margin-bottom: 8px; color: #9cb7ff; }
    input { width: 100%; padding: 12px 14px; border-radius: 12px; border: 1px solid rgba(255,255,255,0.12); background: rgba(255,255,255,0.05); color: #fff; }
    button { width: 100%; margin-top: 18px; padding: 12px; border: none; border-radius: 12px; background: #4b90ff; color: #fff; cursor: pointer; font-weight: 700; }
  </style>
</head>
<body>
  <div class="form">
    <h1>Admin Login</h1>
    <form method="POST" action="/admin/login">
      <label>Password</label>
      <input name="password" type="password" required />
      <button type="submit">Sign In</button>
    </form>
  </div>
</body>
</html>`);
});

router.post('/login', (req, res) => {
  const password = String(req.body.password || '');
  if (!compareAdminPassword(password)) {
    return res.status(401).send('<p>Invalid password. <a href="/admin/login">Back</a></p>');
  }

  const token = uuidv4();
  db.prepare("INSERT INTO admin_sessions (session_token, expires_at) VALUES (?, datetime('now', '+24 hours'))").run(token);
  res.cookie(COOKIE_NAME, token, getCookieOptions());
  res.redirect('/admin');
});

router.get('/logout', (req, res) => {
  const token = req.cookies[COOKIE_NAME];
  if (token) {
    db.prepare('DELETE FROM admin_sessions WHERE session_token = ?').run(token);
  }
  res.clearCookie(COOKIE_NAME, getCookieOptions());
  res.redirect('/admin/login');
});

router.get('/', requireAdminAuth, (req, res) => {
  const codes = db.prepare('SELECT * FROM access_codes ORDER BY expires_at DESC').all();
  const promos = db.prepare('SELECT * FROM promo_codes ORDER BY created_at DESC').all();
  res.send(renderAdminPage({ createdCode: String(req.query.createdCode || '').trim(), message: String(req.query.message || ''), error: String(req.query.error || ''), codes, promos }));
});

router.post('/issue-code', requireAdminAuth, (req, res) => {
  const ownerName = String(req.body.name || '').trim() || null;
  const days = Number(req.body.days);
  const permanent = req.body.permanent === '1';
  const code = uuidv4().replace(/-/g, '').toUpperCase();
  const expiresAt = permanent
    ? '2099-12-31 23:59:59'
    : new Date(Date.now() + Math.max(1, days || 30) * 24 * 60 * 60 * 1000)
      .toISOString().slice(0, 19).replace('T', ' ');

  db.prepare('INSERT INTO access_codes (code, owner_name, expires_at) VALUES (?, ?, ?)').run(code, ownerName, expiresAt);
  res.redirect(`/admin?message=${encodeURIComponent('Issued new access code')}&createdCode=${encodeURIComponent(code)}`);
});

router.post('/extend-code', requireAdminAuth, (req, res) => {
  const code = String(req.body.code || '').trim().toUpperCase();
  const days = Math.max(1, Number(req.body.days) || 30);
  const row = db.prepare('SELECT * FROM access_codes WHERE code = ?').get(code);
  if (!row) return res.redirect(`/admin?error=${encodeURIComponent('Code not found')}`);

  const now = new Date();
  const currentExpiry = new Date(row.expires_at);
  const base = currentExpiry > now ? currentExpiry : now;
  base.setDate(base.getDate() + days);
  const expiresAt = base.toISOString().slice(0, 19).replace('T', ' ');

  db.prepare('UPDATE access_codes SET expires_at = ? WHERE id = ?').run(expiresAt, row.id);
  res.redirect(`/admin?message=${encodeURIComponent(`Extended ${code} by ${days} days`)}`);
});

router.post('/revoke-code', requireAdminAuth, (req, res) => {
  const code = String(req.body.code || '').trim().toUpperCase();
  const row = db.prepare('SELECT * FROM access_codes WHERE code = ?').get(code);
  if (!row) return res.redirect(`/admin?error=${encodeURIComponent('Code not found')}`);
  db.prepare('UPDATE access_codes SET is_revoked = 1 WHERE id = ?').run(row.id);
  res.redirect(`/admin?message=${encodeURIComponent(`Revoked ${code}`)}`);
});

router.post('/reset-device', requireAdminAuth, (req, res) => {
  const code = String(req.body.code || '').trim().toUpperCase();
  const row = db.prepare('SELECT * FROM access_codes WHERE code = ?').get(code);
  if (!row) return res.redirect(`/admin?error=${encodeURIComponent('Code not found')}`);
  db.prepare('UPDATE access_codes SET fingerprint = NULL, session_token = NULL WHERE id = ?').run(row.id);
  res.redirect(`/admin?message=${encodeURIComponent(`Reset device for ${code}`)}`);
});

router.post('/create-promo', requireAdminAuth, (req, res) => {
  const code = String(req.body.code || '').trim().toUpperCase();
  const uses = Math.max(1, Number(req.body.uses) || 1);
  const days = Math.max(1, Number(req.body.days) || 30);
  const expiresAtInput = String(req.body.expires_at || '').trim();
  const expiresAt = expiresAtInput ? `${expiresAtInput} 23:59:59` : null;

  try {
    db.prepare('INSERT INTO promo_codes (code, uses_remaining, days_granted, expires_at) VALUES (?, ?, ?, ?)')
      .run(code, uses, days, expiresAt);
  } catch (err) {
    return res.redirect(`/admin?error=${encodeURIComponent('Promo code already exists')}`);
  }

  res.redirect(`/admin?message=${encodeURIComponent(`Promo ${code} created`)}`);
});

router.get('/codes', requireAdminAuth, (req, res) => {
  res.redirect('/admin');
});

export default router;
