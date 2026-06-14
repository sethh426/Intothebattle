import express from 'express';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';
import bcrypt from 'bcryptjs';
import multer from 'multer';
import db from '../db/db.js';
import { triggerPlatformSponsorTest } from '../platformSponsorTestBus.js';

const router = express.Router();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COOKIE_NAME = 'admin_session_token';
const COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: 'strict',
  secure: process.env.NODE_ENV === 'production',
};
const MAX_BCRYPT_ROUNDS = Number(process.env.MAX_BCRYPT_ROUNDS || 14);
const SPONSOR_MEDIA_EXTS = new Set(['.mp4', '.webm', '.m4v', '.mov']);
const SPONSOR_MEDIA_MIMES = new Set(['video/mp4', 'video/webm', 'video/quicktime', 'video/x-m4v']);
const PLATFORM_SPONSOR_DIR = path.join(process.env.DISK_PATH || path.resolve(__dirname, '..', '..'), 'platform-sponsors');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function isSafePath(baseDir, targetPath) {
  const relative = path.relative(path.resolve(baseDir), path.resolve(targetPath));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function sanitizeSponsorText(value, fallback = '', maxLength = 140) {
  const cleaned = String(value || '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  return (cleaned || fallback).slice(0, maxLength);
}

function parseDurationMs(value) {
  const duration = Number(value);
  return Number.isFinite(duration) ? Math.max(5000, Math.min(120000, Math.round(duration))) : 15000;
}

function parseWeight(value) {
  const weight = Number(value);
  return Number.isFinite(weight) ? Math.max(1, Math.min(20, Math.round(weight))) : 1;
}

const sponsorUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      ensureDir(PLATFORM_SPONSOR_DIR);
      cb(null, PLATFORM_SPONSOR_DIR);
    },
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname || '').toLowerCase();
      const safeExt = SPONSOR_MEDIA_EXTS.has(ext) ? ext : '.mp4';
      cb(null, `platform-sponsor-${Date.now()}-${Math.random().toString(36).slice(2)}${safeExt}`);
    },
  }),
  limits: { fileSize: 250 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    const ok = SPONSOR_MEDIA_EXTS.has(ext) && SPONSOR_MEDIA_MIMES.has(file.mimetype);
    cb(ok ? null : new Error('Upload MP4, WebM, M4V, or MOV video.'), ok);
  },
});

function getCookieOptions() {
  return { ...COOKIE_OPTIONS };
}

function timingSafeCompare(value, expected) {
  const a = Buffer.from(String(value));
  const b = Buffer.from(String(expected));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function getBcryptRounds(hash) {
  const match = String(hash || '').match(/^\$2[aby]\$(\d{2})\$/);
  return match ? Number(match[1]) : null;
}

function isBcryptHashSafe(hash) {
  const rounds = getBcryptRounds(hash);
  return rounds !== null && rounds >= 4 && rounds <= MAX_BCRYPT_ROUNDS;
}

function compareAdminPassword(password) {
  const stored = process.env.ADMIN_PASSWORD || '';
  if (!stored) return false;
  if (stored.startsWith('$2a$') || stored.startsWith('$2b$') || stored.startsWith('$2y$')) {
    if (!isBcryptHashSafe(stored)) {
      console.warn('Admin bcrypt hash has unsupported cost; rejecting compare');
      return false;
    }
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

function renderAdminPage({ message = '', error = '', createdCode = '', codes = [], promos = [], roomRequirementEnabled = true } = {}) {
  const codeRows = codes.map((code) => {
    const status = code.is_revoked ? 'Revoked' : new Date(code.expires_at) < new Date() ? 'Expired' : 'Active';
    const actionLabel = code.is_revoked ? 'Enable' : 'Disable';
    return `<tr>
      <td>${escapeHtml(code.code)}</td>
      <td>${escapeHtml(code.owner_name || code.email || '')}</td>
      <td>${escapeHtml(code.created_at)}</td>
      <td>${escapeHtml(code.expires_at)}</td>
      <td>${status}</td>
      <td>${code.is_promo ? 'Promo' : 'Paid'}</td>
      <td>${escapeHtml(code.last_seen || '')}</td>
      <td>
        <form method="POST" action="/admin/toggle-code" style="display:inline">
          <input type="hidden" name="code" value="${escapeHtml(code.code)}" />
          <button type="submit">${actionLabel}</button>
        </form>
      </td>
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
    * { box-sizing: border-box; }
    body { min-height:100vh; font-family: Inter, Arial, sans-serif; background:radial-gradient(circle at 16% 0,rgba(246,201,91,.18),transparent 30%),radial-gradient(circle at 88% 12%,rgba(232,59,95,.14),transparent 28%),linear-gradient(180deg,#050608,#030406); color:#fff8e6; margin:0; padding:24px; }
    body::before { content:""; position:fixed; inset:0; pointer-events:none; background-image:linear-gradient(rgba(246,201,91,.035) 1px,transparent 1px),linear-gradient(90deg,rgba(246,201,91,.035) 1px,transparent 1px); background-size:58px 58px; mask-image:radial-gradient(circle at top,black,transparent 72%); z-index:-1; }
    .wrapper { max-width: 1220px; margin: 0 auto; display:grid; gap:18px; }
    .admin-hero { display:flex; align-items:center; justify-content:space-between; gap:18px; padding:18px; border:1px solid rgba(246,201,91,.24); border-radius:26px; background:rgba(5,7,11,.78); box-shadow:0 28px 80px rgba(0,0,0,.38); }
    .admin-brand { display:flex; align-items:center; gap:14px; min-width:0; }
    .admin-brand img { width:58px; height:58px; border-radius:18px; border:1px solid rgba(246,201,91,.34); background:rgba(246,201,91,.08); object-fit:cover; }
    h1 { margin:0; font-size:clamp(28px,4vw,48px); line-height:1; text-transform:uppercase; }
    .admin-brand p { margin:6px 0 0; color:#a8afbf; font-size:13px; font-weight:800; text-transform:uppercase; letter-spacing:.08em; }
    .notice { padding: 14px 16px; border-radius: 16px; border:1px solid rgba(255,255,255,.1); background: rgba(255,255,255,0.06); }
    .error { color: #ffb6b6; }
    .success { color: #c6ffc3; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 16px; }
    .card { background: linear-gradient(180deg,rgba(255,255,255,.065),rgba(255,255,255,.025)); border: 1px solid rgba(255,255,255,.1); border-radius: 24px; padding: 20px; box-shadow:0 20px 60px rgba(0,0,0,.24); }
    .card h2 { margin:0 0 12px; font-size:20px; }
    label { display: block; margin: 10px 0 6px; color: #a8afbf; font-size: 12px; font-weight:900; letter-spacing:.08em; text-transform:uppercase; }
    input, select { width: 100%; min-height:46px; padding: 10px 12px; border-radius: 14px; border: 1px solid rgba(255,255,255,0.12); background: rgba(255,255,255,0.055); color: #fff; }
    input[type="checkbox"] { width:auto; min-height:0; margin-right:8px; }
    button { margin-top: 12px; width: 100%; min-height:44px; padding: 0 14px; border: none; border-radius: 14px; background: linear-gradient(135deg,#f6c95b,#fff0b9 52%,#ff6a3d); color: #170c02; cursor: pointer; font-weight: 900; }
    table { width: 100%; border-collapse: collapse; margin-top: 12px; overflow:hidden; border-radius:16px; }
    th, td { border-bottom: 1px solid rgba(255,255,255,0.08); padding: 12px; font-size: 13px; vertical-align:top; }
    th { background: rgba(246,201,91,0.09); color:#ffdf8a; text-align: left; font-size:11px; text-transform:uppercase; letter-spacing:.08em; }
    .button-row { display: flex; gap: 12px; flex-wrap: wrap; }
    .button-row button { width: auto; flex: 1; }
    table button { min-height:36px; padding: 0 12px; border-radius: 12px; }
    a { color: #ffdf8a; text-decoration: none; font-weight:800; }
    .admin-nav { display:flex; gap:10px; flex-wrap:wrap; }
    .admin-nav a { display:inline-flex; align-items:center; justify-content:center; min-height:40px; padding:0 14px; border-radius:999px; border:1px solid rgba(255,255,255,.1); color:#fff8e6; background:rgba(255,255,255,.055); }
    @media(max-width:720px){ body{padding:12px}.admin-hero{align-items:flex-start;flex-direction:column} table,thead,tbody,tr,th,td{display:block} thead{display:none} tr{border:1px solid rgba(255,255,255,.08); border-radius:16px; margin-bottom:12px; overflow:hidden} td{border-bottom:1px solid rgba(255,255,255,.06)} }
  </style>
</head>
<body>
  <div class="wrapper">
    <header class="admin-hero">
      <div class="admin-brand">
        <img src="/intothebattlelogo_logo_only.svg" alt="IntoTheBattle logo" />
        <div><h1>Admin Panel</h1><p>Access, promos, and room controls</p></div>
      </div>
      <div class="admin-nav"><a href="/admin">Access Codes</a><a href="/admin/sponsors">Video Platform</a><a href="/admin/logout">Logout</a></div>
    </header>
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
        <h2>Room ID requirement</h2>
        <p>Current behavior: <strong>${roomRequirementEnabled ? 'Room ID required' : 'Room ID not required'}</strong></p>
        <form method="POST" action="/admin/toggle-room-requirement">
          <button type="submit">${roomRequirementEnabled ? 'Disable room ID requirement' : 'Enable room ID requirement'}</button>
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
        <thead><tr><th>Code</th><th>Name / Email</th><th>Created</th><th>Expires</th><th>Status</th><th>Type</th><th>Last Seen</th><th>Action</th></tr></thead>
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
  db.prepare("INSERT INTO admin_sessions (session_token, expires_at) VALUES (?, now() + interval '24 hours')").run(token);
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
  const setting = db.prepare('SELECT value FROM app_settings WHERE key = ?').get('require_room_id');
  const roomRequirementEnabled = setting ? setting.value !== '0' : true;
  res.send(renderAdminPage({
    createdCode: String(req.query.createdCode || '').trim(),
    message: String(req.query.message || ''),
    error: String(req.query.error || ''),
    codes,
    promos,
    roomRequirementEnabled,
  }));
});

router.post('/toggle-room-requirement', requireAdminAuth, (req, res) => {
  const setting = db.prepare('SELECT value FROM app_settings WHERE key = ?').get('require_room_id');
  const currentValue = setting ? setting.value !== '0' : true;
  const newValue = currentValue ? '0' : '1';
  db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run('require_room_id', newValue);
  const action = newValue === '1' ? 'enabled' : 'disabled';
  res.redirect(`/admin?message=${encodeURIComponent(`Room ID requirement ${action}`)}`);
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

  const roomId = Math.random().toString(36).slice(2, 10);
  db.prepare('INSERT INTO access_codes (code, owner_name, expires_at, room_id) VALUES (?, ?, ?, ?)').run(code, ownerName, expiresAt, roomId);
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

router.post('/toggle-code', requireAdminAuth, (req, res) => {
  const code = String(req.body.code || '').trim().toUpperCase();
  const row = db.prepare('SELECT * FROM access_codes WHERE code = ?').get(code);
  if (!row) return res.redirect(`/admin?error=${encodeURIComponent('Code not found')}`);
  const newValue = row.is_revoked ? 0 : 1;
  db.prepare('UPDATE access_codes SET is_revoked = ? WHERE id = ?').run(newValue, row.id);
  const action = newValue ? 'Disabled' : 'Enabled';
  res.redirect(`/admin?message=${encodeURIComponent(`${action} ${code}`)}`);
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

function parseStatsMode(value) {
  return ['endcap', 'delayed', 'hidden', 'always'].includes(value) ? value : 'endcap';
}

function parseFit(value) {
  return value === 'contain' ? 'contain' : 'cover';
}

function renderSponsorAdminPage({ message = '', error = '', creatives = [] } = {}) {
  const rows = creatives.map((creative) => {
    const isActive = creative.status === 'active';
    const statsOptions = ['endcap', 'delayed', 'hidden', 'always']
      .map(mode => `<option value="${mode}" ${creative.stats_mode === mode ? 'selected' : ''}>${escapeHtml(mode)}</option>`)
      .join('');
    const fitOptions = ['cover', 'contain']
      .map(fit => `<option value="${fit}" ${creative.fit === fit ? 'selected' : ''}>${escapeHtml(fit)}</option>`)
      .join('');

    return `<tr>
      <td>
        <strong>${escapeHtml(creative.partner || 'Partner')}</strong><br />
        <span>${escapeHtml(creative.title || 'Sponsor Spotlight')}</span><br />
        <small>${escapeHtml(creative.filename)}</small>
      </td>
      <td>${escapeHtml(creative.status || 'active')}</td>
      <td>
        <form method="POST" action="/admin/sponsors/${creative.id}/update">
          <label>Partner</label>
          <input name="partner" value="${escapeAttr(creative.partner || '')}" />
          <label>Headline</label>
          <input name="title" value="${escapeAttr(creative.title || '')}" />
          <label>Subtitle</label>
          <input name="subtitle" value="${escapeAttr(creative.subtitle || '')}" />
          <div class="inline-grid">
            <span><label>Duration</label><input name="duration_ms" type="number" min="5000" max="120000" step="1000" value="${escapeAttr(creative.duration_ms || 15000)}" /></span>
            <span><label>Weight</label><input name="weight" type="number" min="1" max="20" value="${escapeAttr(creative.weight || 1)}" /></span>
            <span><label>Stats</label><select name="stats_mode">${statsOptions}</select></span>
            <span><label>Fit</label><select name="fit">${fitOptions}</select></span>
          </div>
          <label><input name="muted" type="checkbox" value="1" ${creative.muted ? 'checked' : ''} /> Muted autoplay</label>
          <button type="submit">Save Creative</button>
        </form>
      </td>
      <td>
        <form method="POST" action="/admin/sponsors/${creative.id}/test">
          <button type="submit" class="test">Test Live</button>
        </form>
        <form method="POST" action="/admin/sponsors/${creative.id}/toggle">
          <button type="submit">${isActive ? 'Pause' : 'Activate'}</button>
        </form>
        <form method="POST" action="/admin/sponsors/${creative.id}/delete" onsubmit="return confirm('Delete this creative?')" style="margin-top:10px;">
          <button type="submit" class="danger">Delete</button>
        </form>
      </td>
    </tr>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Sponsor Platform - Admin</title>
  <style>
    * { box-sizing:border-box; }
    body { min-height:100vh; font-family: Inter, Arial, sans-serif; background:radial-gradient(circle at 16% 0,rgba(246,201,91,.18),transparent 30%),radial-gradient(circle at 88% 12%,rgba(232,59,95,.14),transparent 28%),linear-gradient(180deg,#050608,#030406); color:#fff8e6; margin:0; padding:24px; }
    body::before { content:""; position:fixed; inset:0; pointer-events:none; background-image:linear-gradient(rgba(246,201,91,.035) 1px,transparent 1px),linear-gradient(90deg,rgba(246,201,91,.035) 1px,transparent 1px); background-size:58px 58px; mask-image:radial-gradient(circle at top,black,transparent 72%); z-index:-1; }
    .wrapper { max-width: 1240px; margin: 0 auto; display:grid; gap:18px; }
    .admin-hero { display:flex; align-items:center; justify-content:space-between; gap:18px; padding:18px; border:1px solid rgba(246,201,91,.24); border-radius:26px; background:rgba(5,7,11,.78); box-shadow:0 28px 80px rgba(0,0,0,.38); }
    .admin-brand { display:flex; align-items:center; gap:14px; min-width:0; }
    .admin-brand img { width:58px; height:58px; border-radius:18px; border:1px solid rgba(246,201,91,.34); background:rgba(246,201,91,.08); object-fit:cover; }
    h1 { margin:0; font-size:clamp(28px,4vw,48px); line-height:1; text-transform:uppercase; }
    .admin-brand p { margin:6px 0 0; color:#a8afbf; font-size:13px; font-weight:800; text-transform:uppercase; letter-spacing:.08em; }
    .admin-nav { display:flex; gap:10px; flex-wrap:wrap; }
    .admin-nav a { display:inline-flex; align-items:center; justify-content:center; min-height:40px; padding:0 14px; border-radius:999px; border:1px solid rgba(255,255,255,.1); color:#fff8e6; background:rgba(255,255,255,.055); }
    a { color:#ffdf8a; text-decoration:none; font-weight:800; }
    .notice { padding: 14px 16px; border-radius: 16px; border:1px solid rgba(255,255,255,.1); background: rgba(255,255,255,0.06); }
    .error { color: #ffb6b6; }
    .success { color: #c6ffc3; }
    .card { background: linear-gradient(180deg,rgba(255,255,255,.065),rgba(255,255,255,.025)); border: 1px solid rgba(255,255,255,.1); border-radius: 24px; padding: 20px; box-shadow:0 20px 60px rgba(0,0,0,.24); }
    .card h2 { margin:0 0 12px; font-size:22px; }
    label { display: block; margin: 10px 0 6px; color: #a8afbf; font-size: 12px; font-weight:900; letter-spacing:.08em; text-transform:uppercase; }
    input, select { width: 100%; min-height:46px; padding: 10px 12px; border-radius: 14px; border: 1px solid rgba(255,255,255,0.12); background: rgba(255,255,255,0.055); color: #fff; }
    input[type="checkbox"] { width:auto; min-height:0; margin-right:8px; }
    button { margin-top: 12px; width: 100%; min-height:44px; padding: 0 14px; border: none; border-radius: 14px; background: linear-gradient(135deg,#f6c95b,#fff0b9 52%,#ff6a3d); color: #170c02; cursor: pointer; font-weight: 900; }
    button.test { color:#041014; background: linear-gradient(135deg,#55e7ff,#b9fbff); }
    button.secondary { color:#fff8e6; background:rgba(255,255,255,.07); border:1px solid rgba(255,255,255,.12); }
    button.danger { color:#fff; background: #d9435f; }
    table { width: 100%; border-collapse: collapse; margin-top: 12px; overflow:hidden; border-radius:16px; }
    th, td { vertical-align: top; border-bottom: 1px solid rgba(255,255,255,0.08); padding: 12px; font-size: 13px; }
    th { background: rgba(246,201,91,0.09); color:#ffdf8a; text-align: left; font-size:11px; text-transform:uppercase; letter-spacing:.08em; }
    small { color:#9fb2d7; word-break: break-all; }
    .inline-grid { display:grid; grid-template-columns: repeat(4, 1fr); gap: 10px; }
    .test-panel { display:flex; align-items:center; justify-content:space-between; gap:18px; }
    .test-panel p { margin:6px 0 0; color:#a8afbf; line-height:1.5; }
    .test-panel form { min-width:220px; }
    @media(max-width:900px){ body{padding:12px}.admin-hero{align-items:flex-start;flex-direction:column}.inline-grid{grid-template-columns:1fr} table, thead, tbody, tr, th, td{display:block} th{display:none} td{border-bottom:0} tr{border:1px solid rgba(255,255,255,0.08); border-radius:16px; margin-bottom:14px; overflow:hidden} }
  </style>
</head>
<body>
  <div class="wrapper">
    <header class="admin-hero">
      <div class="admin-brand">
        <img src="/intothebattlelogo_logo_only.svg" alt="IntoTheBattle logo" />
        <div><h1>Video Platform</h1><p>Company-controlled creative inventory</p></div>
      </div>
      <div class="admin-nav"><a href="/admin">Access Codes</a><a href="/admin/sponsors">Video Platform</a><a href="/admin/logout">Logout</a></div>
    </header>
    ${message ? `<div class="notice success">${escapeHtml(message)}</div>` : ''}
    ${error ? `<div class="notice error">${escapeHtml(error)}</div>` : ''}
    <div class="card test-panel">
      <div>
        <h2>Live overlay testing</h2>
        <p>Use each row's Test Live button to send that saved creative to connected overlay rooms. Stop clears the current test screen everywhere.</p>
      </div>
      <form method="POST" action="/admin/sponsors/stop-test">
        <button type="submit" class="secondary">Stop Live Test</button>
      </form>
    </div>
    <div class="card">
      <h2>Upload platform creative</h2>
      <form method="POST" action="/admin/sponsors/upload" enctype="multipart/form-data">
        <label>Video file</label>
        <input name="creative" type="file" accept="video/mp4,video/webm,video/quicktime,video/x-m4v" required />
        <label>Partner</label>
        <input name="partner" placeholder="Brand name" />
        <label>Headline</label>
        <input name="title" placeholder="Sponsor Spotlight" />
        <label>Subtitle</label>
        <input name="subtitle" placeholder="We will be right back to the battle." />
        <div class="inline-grid">
          <span><label>Duration</label><input name="duration_ms" type="number" min="5000" max="120000" step="1000" value="15000" /></span>
          <span><label>Weight</label><input name="weight" type="number" min="1" max="20" value="1" /></span>
          <span><label>Stats</label><select name="stats_mode"><option value="endcap">endcap</option><option value="delayed">delayed</option><option value="hidden">hidden</option><option value="always">always</option></select></span>
          <span><label>Fit</label><select name="fit"><option value="cover">cover</option><option value="contain">contain</option></select></span>
        </div>
        <label><input name="muted" type="checkbox" value="1" checked /> Muted autoplay</label>
        <button type="submit">Upload Creative</button>
      </form>
    </div>
    <div class="card">
      <h2>Creative inventory</h2>
      <table>
        <thead><tr><th>Creative</th><th>Status</th><th>Configuration</th><th>Actions</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="4">No platform creatives uploaded yet.</td></tr>'}</tbody>
      </table>
    </div>
  </div>
</body>
</html>`;
}

function listPlatformSponsorCreatives() {
  return db.prepare('SELECT * FROM platform_sponsor_creatives ORDER BY uploaded_at DESC, id DESC').all();
}

router.get('/sponsors', requireAdminAuth, (req, res) => {
  res.send(renderSponsorAdminPage({
    message: String(req.query.message || ''),
    error: String(req.query.error || ''),
    creatives: listPlatformSponsorCreatives(),
  }));
});

router.post('/sponsors/upload', requireAdminAuth, (req, res) => {
  sponsorUpload.single('creative')(req, res, (err) => {
    if (err) return res.redirect(`/admin/sponsors?error=${encodeURIComponent(err.message || 'Upload failed')}`);
    if (!req.file) return res.redirect(`/admin/sponsors?error=${encodeURIComponent('Choose a video file')}`);

    try {
      db.prepare(`
        INSERT INTO platform_sponsor_creatives
          (filename, original_name, partner, title, subtitle, duration_ms, stats_mode, fit, muted, weight, status, uploaded_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `).run(
        req.file.filename,
        req.file.originalname,
        sanitizeSponsorText(req.body.partner, 'Partner', 70),
        sanitizeSponsorText(req.body.title, 'Sponsor Spotlight', 90),
        sanitizeSponsorText(req.body.subtitle, 'We will be right back to the battle.', 140),
        parseDurationMs(req.body.duration_ms),
        parseStatsMode(req.body.stats_mode),
        parseFit(req.body.fit),
        req.body.muted === '1' ? 1 : 0,
        parseWeight(req.body.weight)
      );
      return res.redirect('/admin/sponsors?message=Creative%20uploaded');
    } catch (insertErr) {
      try {
        const filepath = path.join(PLATFORM_SPONSOR_DIR, req.file.filename);
        if (isSafePath(PLATFORM_SPONSOR_DIR, filepath) && fs.existsSync(filepath)) fs.unlinkSync(filepath);
      } catch (_) {}
      return res.redirect(`/admin/sponsors?error=${encodeURIComponent(insertErr.message || 'Creative save failed')}`);
    }
  });
});

router.post('/sponsors/:id/update', requireAdminAuth, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.redirect('/admin/sponsors?error=Invalid%20creative');

  db.prepare(`
    UPDATE platform_sponsor_creatives
    SET partner = ?, title = ?, subtitle = ?, duration_ms = ?, stats_mode = ?, fit = ?, muted = ?, weight = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(
    sanitizeSponsorText(req.body.partner, 'Partner', 70),
    sanitizeSponsorText(req.body.title, 'Sponsor Spotlight', 90),
    sanitizeSponsorText(req.body.subtitle, 'We will be right back to the battle.', 140),
    parseDurationMs(req.body.duration_ms),
    parseStatsMode(req.body.stats_mode),
    parseFit(req.body.fit),
    req.body.muted === '1' ? 1 : 0,
    parseWeight(req.body.weight),
    id
  );
  res.redirect('/admin/sponsors?message=Creative%20saved');
});

router.post('/sponsors/:id/test', requireAdminAuth, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.redirect('/admin/sponsors?error=Invalid%20creative');
  try {
    const result = triggerPlatformSponsorTest({ creativeId: id, action: 'show' });
    const noun = result.roomCount === 1 ? 'overlay' : 'overlays';
    res.redirect(`/admin/sponsors?message=${encodeURIComponent(`Test sent to ${result.roomCount} live ${noun}`)}`);
  } catch (err) {
    res.redirect(`/admin/sponsors?error=${encodeURIComponent(err.message || 'Test failed')}`);
  }
});

router.post('/sponsors/stop-test', requireAdminAuth, (_req, res) => {
  try {
    const result = triggerPlatformSponsorTest({ action: 'hide' });
    const noun = result.roomCount === 1 ? 'overlay' : 'overlays';
    res.redirect(`/admin/sponsors?message=${encodeURIComponent(`Stopped live test on ${result.roomCount} ${noun}`)}`);
  } catch (err) {
    res.redirect(`/admin/sponsors?error=${encodeURIComponent(err.message || 'Stop failed')}`);
  }
});

router.post('/sponsors/:id/toggle', requireAdminAuth, (req, res) => {
  const id = Number(req.params.id);
  const creative = Number.isFinite(id)
    ? db.prepare('SELECT * FROM platform_sponsor_creatives WHERE id = ?').get(id)
    : null;
  if (!creative) return res.redirect('/admin/sponsors?error=Creative%20not%20found');

  const nextStatus = creative.status === 'active' ? 'paused' : 'active';
  db.prepare('UPDATE platform_sponsor_creatives SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(nextStatus, id);
  res.redirect(`/admin/sponsors?message=${encodeURIComponent(`Creative ${nextStatus}`)}`);
});

router.post('/sponsors/:id/delete', requireAdminAuth, (req, res) => {
  const id = Number(req.params.id);
  const creative = Number.isFinite(id)
    ? db.prepare('SELECT * FROM platform_sponsor_creatives WHERE id = ?').get(id)
    : null;
  if (!creative) return res.redirect('/admin/sponsors?error=Creative%20not%20found');

  db.prepare('DELETE FROM platform_sponsor_creatives WHERE id = ?').run(id);
  try {
    const filepath = path.join(PLATFORM_SPONSOR_DIR, creative.filename);
    if (isSafePath(PLATFORM_SPONSOR_DIR, filepath) && fs.existsSync(filepath)) fs.unlinkSync(filepath);
  } catch (_) {}
  res.redirect('/admin/sponsors?message=Creative%20deleted');
});

router.get('/codes', requireAdminAuth, (req, res) => {
  res.redirect('/admin');
});

export default router;
