import express from 'express';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';
import bcrypt from 'bcryptjs';
import multer from 'multer';
import rateLimit from 'express-rate-limit';
import db from '../db/db.js';
import { triggerPlatformSponsorTest } from '../platformSponsorTestBus.js';
import { processSponsorUpload, getSponsorMediaToolStatus } from '../sponsorMediaProcessor.js';
import { buildUploadDecision, storageRiskSummary, uploadLimitBytes } from '../services/storagePolicy.js';
import {
  isActiveSubscription,
  isBetaTesterAccessCode,
  isFullAccessTrialSubscription,
  isPaidAccessCode,
} from '../services/entitlements.js';
import {
  ensureMarketingPostsForDate,
  listMarketingPublishEvents,
  listMarketingPosts,
  marketingAutomationDiagnostics,
  marketingPlatformCharacterLimit,
  publishApprovedMarketingPosts,
  updateMarketingPostDraft,
  updateMarketingPostStatus,
} from '../services/marketingAutomation.js';
import { growthIntegrationDiagnostics } from '../services/growthIntegrations.js';
import {
  addCreativeAsset,
  creativeTemplateOptions,
  generateCreativeVariants,
  listCreativeAssets,
  listCreativeTemplates,
  listCreativeVariants,
  queueCreativeVariantAsMarketingPost,
  updateCreativeAssetStatus,
  updateCreativeVariantStatus,
} from '../services/creativeTemplateEngine.js';
import { getAllRooms } from '../../roomManager.js';

const router = express.Router();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COOKIE_NAME = 'admin_session_token';
const COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: 'strict',
  secure: process.env.NODE_ENV === 'production',
};
const MAX_BCRYPT_ROUNDS = Number(process.env.MAX_BCRYPT_ROUNDS || 14);
const adminLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Too many admin login attempts. Try again in 15 minutes.',
});
const SPONSOR_MEDIA_EXTS = new Set(['.mp4', '.webm', '.m4v', '.mov']);
const SPONSOR_MEDIA_MIMES = new Set(['video/mp4', 'video/webm', 'video/quicktime', 'video/x-m4v']);
const PLATFORM_SPONSOR_DIR = path.join(process.env.DISK_PATH || path.resolve(__dirname, '..', '..'), 'platform-sponsors');
const PLATFORM_SPONSOR_UPLOAD_MAX_BYTES = uploadLimitBytes('PLATFORM_SPONSOR_UPLOAD_MAX_MB', 100 * 1024 * 1024);

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function isSafePath(baseDir, targetPath) {
  const relative = path.relative(path.resolve(baseDir), path.resolve(targetPath));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function deleteSponsorUploadFile(filepath) {
  try {
    if (filepath && isSafePath(PLATFORM_SPONSOR_DIR, filepath) && fs.existsSync(filepath)) fs.unlinkSync(filepath);
  } catch (_err) {}
}

function contentLengthBytes(req) {
  const value = Number(req.get('content-length'));
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function uploadCapacityRedirect(req) {
  try {
    ensureDir(PLATFORM_SPONSOR_DIR);
  } catch (err) {
    return `/admin/sponsors?error=${encodeURIComponent(err?.message || 'Platform sponsor storage is not writable.')}`;
  }
  const incomingBytes = contentLengthBytes(req);
  if (!incomingBytes) return '';
  const decision = buildUploadDecision(PLATFORM_SPONSOR_DIR, incomingBytes, { category: 'platform-sponsor' });
  if (decision.ok) return '';
  return `/admin/sponsors?error=${encodeURIComponent(decision.message || 'Storage capacity is too low for this upload.')}`;
}

function uploadedFileCapacityRedirect(filepath, size) {
  const decision = buildUploadDecision(PLATFORM_SPONSOR_DIR, Number(size || 0), { category: 'platform-sponsor', alreadyWritten: true });
  if (decision.ok) return '';
  deleteSponsorUploadFile(filepath);
  return `/admin/sponsors?error=${encodeURIComponent(decision.message || 'Storage capacity is too low for this upload.')}`;
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

function parseCooldownSeconds(value) {
  const seconds = Number(value);
  return Number.isFinite(seconds) ? Math.max(60, Math.min(86400, Math.round(seconds))) : 600;
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
  limits: { fileSize: PLATFORM_SPONSOR_UPLOAD_MAX_BYTES },
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

function parseAdminDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isActiveAccessCode(row, now = new Date()) {
  if (!row || Number(row.is_promo) === 1 || Number(row.is_revoked) === 1) return false;
  const expiresAt = parseAdminDate(row.expires_at);
  return !expiresAt || expiresAt >= now;
}

function latestSubscriptionByUser(subscriptions = []) {
  const latest = new Map();
  subscriptions.forEach(subscription => {
    if (!subscription?.user_id) return;
    const current = latest.get(subscription.user_id);
    const currentDate = parseAdminDate(current?.updated_at || current?.created_at)?.getTime() || 0;
    const nextDate = parseAdminDate(subscription.updated_at || subscription.created_at)?.getTime() || 0;
    if (!current || nextDate >= currentDate) latest.set(subscription.user_id, subscription);
  });
  return latest;
}

function classifySubscriptionTier(subscription, now = new Date()) {
  if (isActiveSubscription(subscription)) return 'paid';
  if (isFullAccessTrialSubscription(subscription, now)) return 'trialBeta';
  return 'free';
}

function classifyAccessCodeTier(code, now = new Date()) {
  if (!isActiveAccessCode(code, now)) return 'inactive';
  if (isPaidAccessCode(code)) return 'paid';
  if (isBetaTesterAccessCode(code)) return 'trialBeta';
  return 'free';
}

function incrementTier(target, tier) {
  if (tier === 'paid') target.paid += 1;
  else if (tier === 'trialBeta') target.trialBeta += 1;
  else if (tier === 'free') target.free += 1;
}

function strongerTier(current, next) {
  const rank = { free: 1, trialBeta: 2, paid: 3 };
  return (rank[next] || 0) > (rank[current] || 0) ? next : current;
}

function emptyAdminUserMetrics() {
  return {
    accounts: { free: 0, paid: 0, trialBeta: 0, total: 0 },
    live: { free: 0, paid: 0, trialBeta: 0, total: 0, overlays: 0 },
    updatedAt: new Date().toISOString(),
  };
}

function buildAdminUserMetrics() {
  const metrics = emptyAdminUserMetrics();
  try {
    const now = new Date();
    const users = db.prepare('SELECT id, is_active FROM users').all();
    const subscriptions = db.prepare('SELECT * FROM subscriptions ORDER BY updated_at DESC, id DESC').all();
    const codes = db.prepare('SELECT * FROM access_codes').all();
    const userRooms = db.prepare('SELECT room_id, user_id FROM user_rooms').all();
    const latestByUser = latestSubscriptionByUser(subscriptions);
    const userTierById = new Map();
    const roomTierById = new Map();

    users.forEach(user => {
      if (!user?.id || Number(user.is_active) === 0) return;
      const tier = classifySubscriptionTier(latestByUser.get(user.id), now);
      userTierById.set(user.id, tier);
      incrementTier(metrics.accounts, tier);
    });

    codes.forEach(code => {
      const tier = classifyAccessCodeTier(code, now);
      incrementTier(metrics.accounts, tier);
      if (code?.room_id && ['paid', 'trialBeta', 'free'].includes(tier)) {
        roomTierById.set(code.room_id, strongerTier(roomTierById.get(code.room_id) || 'free', tier));
      }
    });

    userRooms.forEach(row => {
      if (!row?.room_id || !row?.user_id) return;
      const tier = userTierById.get(row.user_id) || 'free';
      roomTierById.set(row.room_id, strongerTier(roomTierById.get(row.room_id) || 'free', tier));
    });

    metrics.accounts.total = metrics.accounts.free + metrics.accounts.paid + metrics.accounts.trialBeta;

    for (const room of getAllRooms().values()) {
      const overlayCount = Number(room?.overlayCount) || 0;
      if (!room?.roomId || overlayCount <= 0) continue;
      const tier = roomTierById.get(room.roomId) || 'free';
      incrementTier(metrics.live, tier);
      metrics.live.total += 1;
      metrics.live.overlays += overlayCount;
    }
    metrics.updatedAt = new Date().toISOString();
  } catch (err) {
    console.warn('Failed to build admin user metrics:', err?.message || err);
  }
  return metrics;
}

function adminMetricCard(label, key, value, note = '') {
  return `<div class="metric-card">
    <span>${escapeHtml(label)}</span>
    <strong data-count-key="${escapeAttr(key)}">${escapeHtml(String(value))}</strong>
    ${note ? `<small>${escapeHtml(note)}</small>` : ''}
  </div>`;
}

function listRecentAdminUsers(limit = 80) {
  try {
    return db.prepare(`
      SELECT
        u.id,
        u.email,
        u.name,
        u.tiktok_username,
        u.email_verified,
        u.is_active,
        u.created_at,
        u.last_login,
        s.plan_type,
        s.status AS subscription_status,
        s.expires_at
      FROM users u
      LEFT JOIN subscriptions s ON s.id = (
        SELECT id
        FROM subscriptions
        WHERE user_id = u.id
        ORDER BY updated_at DESC, id DESC
        LIMIT 1
      )
      ORDER BY u.created_at DESC, u.id DESC
      LIMIT ?
    `).all(Math.max(1, Math.min(200, Number(limit) || 80)));
  } catch (err) {
    console.warn('Failed to list recent admin users:', err?.message || err);
    return [];
  }
}

function listAdminCreatorComments(limit = 80) {
  try {
    return db.prepare(`
      SELECT id, name, email, role, comment, status, created_at
      FROM creator_comments
      WHERE deleted_at IS NULL
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all(Math.max(1, Math.min(200, Number(limit) || 80)));
  } catch (err) {
    console.warn('Failed to list creator comments:', err?.message || err);
    return [];
  }
}

function buildAdminLiveActivity() {
  const ownerByRoom = new Map();
  try {
    db.prepare(`
      SELECT
        ur.room_id,
        u.email,
        u.name,
        u.tiktok_username,
        s.plan_type,
        s.status AS subscription_status
      FROM user_rooms ur
      JOIN users u ON u.id = ur.user_id
      LEFT JOIN subscriptions s ON s.id = (
        SELECT id
        FROM subscriptions
        WHERE user_id = u.id
        ORDER BY updated_at DESC, id DESC
        LIMIT 1
      )
    `).all().forEach(row => {
      ownerByRoom.set(row.room_id, {
        accountType: 'User account',
        email: row.email || '',
        name: row.name || '',
        tiktok: row.tiktok_username || '',
        plan: row.plan_type || row.subscription_status || 'Free',
      });
    });
  } catch (err) {
    console.warn('Failed to map user room owners:', err?.message || err);
  }

  try {
    db.prepare(`
      SELECT room_id, code, email, owner_name, streamer_name, tiktok_username, code_type, subscription_status
      FROM access_codes
      WHERE room_id IS NOT NULL AND room_id != ''
    `).all().forEach(row => {
      if (ownerByRoom.has(row.room_id)) return;
      ownerByRoom.set(row.room_id, {
        accountType: 'Access code',
        email: row.email || '',
        name: row.owner_name || row.streamer_name || row.code || '',
        tiktok: row.tiktok_username || '',
        plan: row.code_type || row.subscription_status || 'Access code',
      });
    });
  } catch (err) {
    console.warn('Failed to map access-code room owners:', err?.message || err);
  }

  return Array.from(getAllRooms().values())
    .map(room => {
      const players = Object.values(room?.players || {})
        .filter(player => player && player.alive)
        .sort((a, b) => (Number(b.kills) || 0) - (Number(a.kills) || 0))
        .slice(0, 5)
        .map(player => ({
          id: player.uniqueId || '',
          name: player.nickname || player.uniqueId || 'Player',
          kills: Number(player.kills) || 0,
          hp: Math.round(Number(player.hp) || 0),
        }));
      const owner = ownerByRoom.get(room.roomId) || {
        accountType: 'Unclaimed room',
        email: '',
        name: '',
        tiktok: '',
        plan: 'Unknown',
      };
      return {
        roomId: room.roomId,
        owner,
        streamerUsername: room.streamerUsername || '',
        connected: Boolean(room.tiktokClient && room.tiktokClient.connected),
        streamStatus: room.tiktokConnection?.status || (room.tiktokClient?.connected ? 'connected' : 'disconnected'),
        streamConnectionId: room.tiktokConnection?.id || '',
        lastEventType: room.tiktokConnection?.lastEventType || '',
        lastEventAt: room.tiktokConnection?.lastEventAt || null,
        staleEventsDropped: Number(room.staleTikTokEventsDropped) || 0,
        overlayCount: Number(room.overlayCount) || 0,
        playerCount: Object.values(room?.players || {}).filter(player => player && player.alive).length,
        topPlayers: players,
      };
    })
    .filter(item => item.overlayCount > 0 || item.connected || item.playerCount > 0 || item.streamerUsername)
    .sort((a, b) => b.overlayCount - a.overlayCount || b.playerCount - a.playerCount || a.roomId.localeCompare(b.roomId));
}

function renderAdminPage({ message = '', error = '', createdCode = '', codes = [], promos = [], roomRequirementEnabled = true, userMetrics = buildAdminUserMetrics(), users = [], comments = [], liveActivity = buildAdminLiveActivity() } = {}) {
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
  const userRows = users.map((user) => {
    const verified = Number(user.email_verified) === 1 ? 'Verified' : 'Unverified';
    const active = Number(user.is_active) === 0 ? 'Disabled' : 'Active';
    const plan = user.plan_type || user.subscription_status || 'Free / pending';
    return `<tr>
      <td>${escapeHtml(String(user.id))}</td>
      <td><strong>${escapeHtml(user.email || '')}</strong><br><span class="muted">${escapeHtml(user.name || '')}</span></td>
      <td>${escapeHtml(user.tiktok_username ? `@${user.tiktok_username}` : '')}</td>
      <td>${escapeHtml(plan)}</td>
      <td>${escapeHtml(`${active} / ${verified}`)}</td>
      <td>${escapeHtml(formatSponsorDate(user.created_at))}</td>
      <td>${escapeHtml(formatSponsorDate(user.last_login))}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="7">No users found yet.</td></tr>';
  const commentRows = comments.map((comment) => {
    return `<tr>
      <td>${escapeHtml(formatSponsorDate(comment.created_at))}</td>
      <td><strong>${escapeHtml(comment.name || 'Creator')}</strong><br><span class="muted">${escapeHtml(comment.role || 'TikTok LIVE creator')}</span></td>
      <td>${escapeHtml(comment.email || '')}</td>
      <td>${escapeHtml(comment.comment || '')}</td>
      <td>
        <form method="POST" action="/admin/comments/${escapeAttr(comment.id)}/delete" onsubmit="return confirm('Delete this public comment?')">
          <button class="danger-button" type="submit">Delete</button>
        </form>
      </td>
    </tr>`;
  }).join('') || '<tr><td colspan="5">No comments yet.</td></tr>';
  const liveActivityRows = liveActivity.map((item) => {
    const owner = item.owner || {};
    const topPlayers = (item.topPlayers || [])
      .map(player => `${player.name}${player.kills ? ` (${player.kills}K)` : ''}`)
      .join(', ');
    const status = item.streamStatus || (item.connected ? 'connected' : item.streamerUsername ? 'pending' : 'disconnected');
    const lastEvent = item.lastEventAt
      ? `${item.lastEventType || 'event'} ${formatSponsorDate(item.lastEventAt)}`
      : (item.staleEventsDropped ? `${item.staleEventsDropped} stale event(s) dropped` : 'No live events yet');
    return `<tr data-live-room-row>
      <td><strong>${escapeHtml(item.roomId)}</strong><br><span class="muted">${escapeHtml(owner.accountType || 'Room')}</span></td>
      <td><strong>${escapeHtml(owner.email || owner.name || 'Unknown owner')}</strong><br><span class="muted">${escapeHtml(owner.tiktok ? `@${owner.tiktok}` : owner.plan || '')}</span></td>
      <td>${escapeHtml(item.streamerUsername ? `@${item.streamerUsername}` : '')}<br><span class="muted">${escapeHtml(status)} - ${escapeHtml(lastEvent)}</span></td>
      <td>${escapeHtml(String(item.overlayCount))}</td>
      <td>${escapeHtml(String(item.playerCount))}</td>
      <td>${escapeHtml(topPlayers || 'No active players')}</td>
    </tr>`;
  }).join('') || '<tr data-live-empty><td colspan="6">No live room activity right now.</td></tr>';
  const metrics = userMetrics || emptyAdminUserMetrics();
  const metricCards = [
    adminMetricCard('Free accounts', 'accounts.free', metrics.accounts.free, 'Active free creator accounts and free access-code rooms'),
    adminMetricCard('Paid accounts', 'accounts.paid', metrics.accounts.paid, 'Active Creator Pro users and paid access codes'),
    adminMetricCard('Trial / beta', 'accounts.trialBeta', metrics.accounts.trialBeta, 'Full-access trials and beta tester access'),
    adminMetricCard('Live free rooms', 'live.free', metrics.live.free, 'Connected overlay rooms on free access'),
    adminMetricCard('Live paid rooms', 'live.paid', metrics.live.paid, 'Connected overlay rooms on paid access'),
    adminMetricCard('Live overlays', 'live.overlays', metrics.live.overlays, 'Total connected overlay browser sources'),
  ].join('');

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
    .muted { color:#a8afbf; line-height:1.5; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 16px; }
    .metrics-grid { display:grid; grid-template-columns:repeat(6,minmax(0,1fr)); gap:12px; }
    .metric-card { min-width:0; padding:16px; border-radius:18px; border:1px solid rgba(255,255,255,.1); background:rgba(0,0,0,.22); box-shadow:inset 0 1px 0 rgba(255,255,255,.05); }
    .metric-card span { display:block; color:#a8afbf; font-size:11px; font-weight:900; text-transform:uppercase; letter-spacing:.08em; }
    .metric-card strong { display:block; margin-top:7px; color:#fff8e6; font-size:clamp(25px,3.2vw,40px); line-height:1; }
    .metric-card small { display:block; min-height:32px; margin-top:8px; color:#8590a4; font-size:11px; line-height:1.4; }
    .metrics-footnote { margin-top:-8px; color:#8590a4; font-size:12px; text-align:right; }
    .card { background: linear-gradient(180deg,rgba(255,255,255,.065),rgba(255,255,255,.025)); border: 1px solid rgba(255,255,255,.1); border-radius: 24px; padding: 20px; box-shadow:0 20px 60px rgba(0,0,0,.24); }
    .card h2 { margin:0 0 12px; font-size:20px; }
    label { display: block; margin: 10px 0 6px; color: #a8afbf; font-size: 12px; font-weight:900; letter-spacing:.08em; text-transform:uppercase; }
    input, select { width: 100%; min-height:46px; padding: 10px 12px; border-radius: 14px; border: 1px solid rgba(255,255,255,0.12); background: #111827; color: #fff8e6; }
    select option, select optgroup { background:#111827; color:#fff8e6; }
    input[type="checkbox"] { width:auto; min-height:0; margin-right:8px; }
    button { margin-top: 12px; width: 100%; min-height:44px; padding: 0 14px; border: none; border-radius: 14px; background: linear-gradient(135deg,#f6c95b,#fff0b9 52%,#ff6a3d); color: #170c02; cursor: pointer; font-weight: 900; }
    .danger-button { background: rgba(232,59,95,.16); color:#ffb7c1; border:1px solid rgba(232,59,95,.32); }
    table { width: 100%; border-collapse: collapse; margin-top: 12px; overflow:hidden; border-radius:16px; }
    th, td { border-bottom: 1px solid rgba(255,255,255,0.08); padding: 12px; font-size: 13px; vertical-align:top; }
    th { background: rgba(246,201,91,0.09); color:#ffdf8a; text-align: left; font-size:11px; text-transform:uppercase; letter-spacing:.08em; }
    .button-row { display: flex; gap: 12px; flex-wrap: wrap; }
    .button-row button { width: auto; flex: 1; }
    table button { min-height:36px; padding: 0 12px; border-radius: 12px; }
    a { color: #ffdf8a; text-decoration: none; font-weight:800; }
    .admin-nav { display:flex; gap:10px; flex-wrap:wrap; }
    .admin-nav a { display:inline-flex; align-items:center; justify-content:center; min-height:40px; padding:0 14px; border-radius:999px; border:1px solid rgba(255,255,255,.1); color:#fff8e6; background:rgba(255,255,255,.055); }
    @media(max-width:1100px){ .metrics-grid{grid-template-columns:repeat(3,minmax(0,1fr));} }
    @media(max-width:720px){ body{padding:12px}.admin-hero{align-items:flex-start;flex-direction:column}.metrics-grid{grid-template-columns:1fr}.metrics-footnote{text-align:left} table,thead,tbody,tr,th,td{display:block} thead{display:none} tr{border:1px solid rgba(255,255,255,.08); border-radius:16px; margin-bottom:12px; overflow:hidden} td{border-bottom:1px solid rgba(255,255,255,.06)} }
  </style>
</head>
<body>
  <div class="wrapper">
    <header class="admin-hero">
      <div class="admin-brand">
        <img src="/intothebattlelogo_logo_only.svg" alt="IntoTheBattle logo" />
        <div><h1>Admin Panel</h1><p>Access, promos, and room controls</p></div>
      </div>
      <div class="admin-nav"><a href="/admin">Access Codes</a><a href="/admin/sponsors">Video Platform</a><a href="/admin/marketing">Company Growth</a><a href="/admin/logout">Logout</a></div>
    </header>
    ${message ? `<div class="notice success">${escapeHtml(message)}</div>` : ''}
    ${createdCode ? `<div class="notice success">New access code created: <strong>${escapeHtml(createdCode)}</strong> <button type="button" onclick="navigator.clipboard.writeText('${escapeHtml(createdCode)}')">Copy</button></div>` : ''}
    ${error ? `<div class="notice error">${escapeHtml(error)}</div>` : ''}
    <section class="metrics-grid" aria-label="User and live room counts">
      ${metricCards}
    </section>
    <div class="metrics-footnote">Counts refresh every 15 seconds. Last updated <span data-count-key="updatedAt">${escapeHtml(formatSponsorDate(metrics.updatedAt))}</span>.</div>
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
    <div class="card" style="margin-top: 18px;">
      <h2>Recent user emails</h2>
      <p class="muted">Newest creator accounts, email status, TikTok handle, plan, and last login.</p>
      <table>
        <thead><tr><th>ID</th><th>Email / Name</th><th>TikTok</th><th>Plan</th><th>Status</th><th>Created</th><th>Last Login</th></tr></thead>
        <tbody>${userRows}</tbody>
      </table>
    </div>
    <div class="card" style="margin-top: 18px;">
      <h2>Live room activity</h2>
      <p class="muted">Room-scoped activity for spotting bad routing fast. Another creator's players should never appear in the wrong room.</p>
      <table>
        <thead><tr><th>Room</th><th>Owner</th><th>Stream</th><th>Overlays</th><th>Players</th><th>Top players</th></tr></thead>
        <tbody id="liveActivityRows">${liveActivityRows}</tbody>
      </table>
    </div>
    <div class="card" style="margin-top: 18px;">
      <h2>Homepage comments</h2>
      <p class="muted">Approved public comments shown in the homepage scroll. Delete removes the comment from public view.</p>
      <table>
        <thead><tr><th>Created</th><th>Name</th><th>Email</th><th>Comment</th><th>Action</th></tr></thead>
        <tbody>${commentRows}</tbody>
      </table>
    </div>
    <div style="margin-top: 18px;">
      <a href="/admin/logout">Logout</a>
    </div>
  </div>
  <script>
    const countKeys = {
      'accounts.free': data => data.accounts && data.accounts.free,
      'accounts.paid': data => data.accounts && data.accounts.paid,
      'accounts.trialBeta': data => data.accounts && data.accounts.trialBeta,
      'live.free': data => data.live && data.live.free,
      'live.paid': data => data.live && data.live.paid,
      'live.overlays': data => data.live && data.live.overlays,
      updatedAt: data => {
        const date = new Date(data.updatedAt);
        return Number.isNaN(date.getTime()) ? 'just now' : date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
      },
    };
    async function refreshAdminCounts() {
      try {
        const res = await fetch('/admin/user-counts.json', { credentials: 'same-origin' });
        if (!res.ok) return;
        const data = await res.json();
        Object.entries(countKeys).forEach(([key, getter]) => {
          const el = document.querySelector('[data-count-key="' + key + '"]');
          const value = getter(data);
          if (el && value !== undefined && value !== null) el.textContent = String(value);
        });
      } catch (_err) {}
    }
    function escapeCell(value) {
      return String(value || '').replace(/[&<>"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]));
    }
    function renderLiveActivityRows(items) {
      const body = document.getElementById('liveActivityRows');
      if (!body) return;
      if (!Array.isArray(items) || !items.length) {
        body.innerHTML = '<tr data-live-empty><td colspan="6">No live room activity right now.</td></tr>';
        return;
      }
      body.innerHTML = items.map(item => {
        const owner = item.owner || {};
        const players = (item.topPlayers || []).map(player => {
          const name = player.name || player.id || 'Player';
          return name + (player.kills ? ' (' + player.kills + 'K)' : '');
        }).join(', ') || 'No active players';
        const status = item.streamStatus || (item.connected ? 'connected' : item.streamerUsername ? 'pending' : 'disconnected');
        const lastEvent = item.lastEventAt
          ? ((item.lastEventType || 'event') + ' ' + new Date(item.lastEventAt).toLocaleString())
          : (item.staleEventsDropped ? item.staleEventsDropped + ' stale event(s) dropped' : 'No live events yet');
        return '<tr data-live-room-row>'
          + '<td><strong>' + escapeCell(item.roomId) + '</strong><br><span class="muted">' + escapeCell(owner.accountType || 'Room') + '</span></td>'
          + '<td><strong>' + escapeCell(owner.email || owner.name || 'Unknown owner') + '</strong><br><span class="muted">' + escapeCell(owner.tiktok ? '@' + owner.tiktok : owner.plan || '') + '</span></td>'
          + '<td>' + escapeCell(item.streamerUsername ? '@' + item.streamerUsername : '') + '<br><span class="muted">' + escapeCell(status + ' - ' + lastEvent) + '</span></td>'
          + '<td>' + escapeCell(item.overlayCount) + '</td>'
          + '<td>' + escapeCell(item.playerCount) + '</td>'
          + '<td>' + escapeCell(players) + '</td>'
          + '</tr>';
      }).join('');
    }
    async function refreshLiveActivity() {
      try {
        const res = await fetch('/admin/live-activity.json', { credentials: 'same-origin' });
        if (!res.ok) return;
        const data = await res.json();
        renderLiveActivityRows(data.rooms || []);
      } catch (_err) {}
    }
    setInterval(refreshAdminCounts, 15000);
    setInterval(refreshLiveActivity, 10000);
  </script>
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

router.post('/login', adminLoginLimiter, (req, res) => {
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

router.get('/user-counts.json', requireAdminAuth, (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(buildAdminUserMetrics());
});

router.get('/live-activity.json', requireAdminAuth, (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ rooms: buildAdminLiveActivity(), updatedAt: new Date().toISOString() });
});

router.get('/', requireAdminAuth, (req, res) => {
  const codes = db.prepare('SELECT * FROM access_codes ORDER BY expires_at DESC').all();
  const promos = db.prepare('SELECT * FROM promo_codes ORDER BY created_at DESC').all();
  const setting = db.prepare('SELECT value FROM app_settings WHERE key = ?').get('require_room_id');
  const roomRequirementEnabled = setting ? setting.value !== '0' : true;
  const userMetrics = buildAdminUserMetrics();
  const liveActivity = buildAdminLiveActivity();
  const users = listRecentAdminUsers();
  const comments = listAdminCreatorComments();
  res.send(renderAdminPage({
    createdCode: String(req.query.createdCode || '').trim(),
    message: String(req.query.message || ''),
    error: String(req.query.error || ''),
    codes,
    promos,
    roomRequirementEnabled,
    userMetrics,
    liveActivity,
    users,
    comments,
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

router.post('/comments/:id/delete', requireAdminAuth, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) {
    return res.redirect(`/admin?error=${encodeURIComponent('Comment not found')}`);
  }
  db.prepare("UPDATE creator_comments SET status = 'deleted', deleted_at = CURRENT_TIMESTAMP WHERE id = ?").run(id);
  res.redirect(`/admin?message=${encodeURIComponent('Comment removed from homepage')}`);
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
  return value === 'cover' ? 'cover' : 'contain';
}

function getAppSetting(key, fallback = '') {
  try {
    const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key);
    return row?.value ?? fallback;
  } catch (_err) {
    return fallback;
  }
}

function setAppSetting(key, value) {
  db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
}

function numberSetting(key, fallback, divisor = 1) {
  const value = Number(getAppSetting(key, fallback));
  return Number.isFinite(value) ? Math.round(value / divisor) : Math.round(fallback / divisor);
}

function platformSponsorTimerSettings() {
  return {
    initialDelayMinutes: numberSetting('platform_sponsor_initial_delay_ms', 8 * 60 * 1000, 60000),
    intervalMinutes: numberSetting('platform_sponsor_interval_ms', 12 * 60 * 1000, 60000),
    actionCooldownSeconds: numberSetting('platform_sponsor_action_cooldown_ms', 45000, 1000),
    retryDelaySeconds: numberSetting('platform_sponsor_retry_delay_ms', 60000, 1000),
    intenseWindowSeconds: numberSetting('platform_sponsor_intense_window_ms', 30000, 1000),
    intenseActionLimit: numberSetting('platform_sponsor_intense_action_limit', 10),
    intenseCooldownSeconds: numberSetting('platform_sponsor_intense_cooldown_ms', 75000, 1000),
    completionCooldownSeconds: numberSetting('platform_sponsor_completion_cooldown_ms', 3 * 60 * 1000, 1000),
    minPlayerCount: numberSetting('platform_sponsor_min_player_count', 1),
    jitterSeconds: numberSetting('platform_sponsor_jitter_ms', 90000, 1000),
    noRepeatCount: numberSetting('platform_sponsor_no_repeat_count', 3),
    activeHoursUtc: String(getAppSetting('platform_sponsor_active_hours_utc', '')).trim(),
  };
}

function sponsorPreviewHref(creative) {
  const params = new URLSearchParams({
    demo: '1',
    sponsor_preview: '1',
    sponsor_source: 'platform',
    sponsor_video: creative.filename || '',
    sponsor_partner: creative.partner || 'IntoTheBattle Partner',
    sponsor_title: creative.title || 'Power Moment',
    sponsor_subtitle: creative.subtitle || 'Stay locked in. The next fight is loading.',
    sponsor_duration: String(parseDurationMs(creative.duration_ms)),
    sponsor_muted: Number(creative.muted) === 0 ? '0' : '1',
    sponsor_fit: parseFit(creative.fit),
    sponsor_stats: parseStatsMode(creative.stats_mode),
  });
  return `/overlay-preview?${params.toString()}`;
}

function numberValue(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function formatSponsorDate(value) {
  if (!value) return 'Never';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function parseDateTimeLocal(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

function formatDateTimeInput(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const offsetMs = date.getTimezoneOffset() * 60000;
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16);
}

function readinessLabel(value) {
  const status = String(value || 'ready').toLowerCase();
  if (status === 'tested') return 'Tested';
  if (status === 'failed') return 'Failed';
  if (status === 'processing') return 'Processing';
  return 'Ready';
}

function formatCompletionRate(creative) {
  const impressions = numberValue(creative.impressions);
  if (!impressions) return '0%';
  return `${Math.round((numberValue(creative.completions) / impressions) * 100)}%`;
}

function renderSponsorAdminPage({ message = '', error = '', creatives = [], events = [], storageRisk = null, timerSettings = platformSponsorTimerSettings() } = {}) {
  const mediaTools = getSponsorMediaToolStatus();
  const risk = storageRisk || storageRiskSummary(PLATFORM_SPONSOR_DIR);
  const storageWarnings = [...(risk.warnings || []), ...(risk.failures || [])];
  const storageUsage = risk.usage || {};
  const timer = timerSettings || platformSponsorTimerSettings();
  const storagePanel = `<div class="card">
      <h2>Media storage</h2>
      <p>Used ${escapeHtml(storageUsage.humanBytes || 'unknown')}${storageUsage.capacity?.humanAvailable ? `, ${escapeHtml(storageUsage.capacity.humanAvailable)} available` : ''}${storageUsage.humanConfiguredLimit ? `, limit ${escapeHtml(storageUsage.humanConfiguredLimit)}` : ''}.</p>
      ${storageWarnings.length
        ? `<div class="warning-note">${storageWarnings.map(warning => escapeHtml(warning)).join('<br />')}</div>`
        : '<div class="media-probe ready">Storage looks ready for platform creative uploads.</div>'}
    </div>`;
  const totals = creatives.reduce((acc, creative) => {
    acc.active += creative.status === 'active' ? 1 : 0;
    acc.impressions += numberValue(creative.impressions);
    acc.completions += numberValue(creative.completions);
    acc.failures += numberValue(creative.failures);
    return acc;
  }, { active: 0, impressions: 0, completions: 0, failures: 0 });
  const completionRate = totals.impressions ? `${Math.round((totals.completions / totals.impressions) * 100)}%` : '0%';

  const rows = creatives.map((creative) => {
    const isActive = creative.status === 'active';
    const isNormalized = Number(creative.normalized) === 1 || creative.normalized === true;
    const processingStatus = String(creative.processing_status || '').toLowerCase();
    const processingLabel = isNormalized ? 'Normalized' : (processingStatus && processingStatus !== 'ready' ? creative.processing_status : 'Original');
    const previewHref = sponsorPreviewHref(creative);
    const readiness = String(creative.readiness_status || 'ready').toLowerCase();
    const warnings = String(creative.quality_warnings || '').trim();
    const qualityStatus = String(creative.quality_status || (warnings ? 'warn' : 'ready')).toLowerCase();
    const qualityScore = Number.isFinite(Number(creative.quality_score)) ? Number(creative.quality_score) : 100;
    const qualityBlockers = String(creative.quality_blockers || '').trim();
    const qualityRecommendations = String(creative.quality_recommendations || '').trim();
    const thumbnail = creative.thumbnail_data
      ? `<img class="creative-thumb" src="${escapeAttr(creative.thumbnail_data)}" alt="" />`
      : '<div class="creative-thumb empty">No thumbnail</div>';
    const metadata = [
      creative.duration_seconds ? `${Math.round(Number(creative.duration_seconds))}s` : '',
      creative.width && creative.height ? `${creative.width}x${creative.height}` : '',
      creative.mime_type || '',
      creative.video_codec ? `v:${creative.video_codec}` : '',
      creative.audio_codec ? `a:${creative.audio_codec}` : '',
      creative.file_size ? `${Math.round(Number(creative.file_size) / 1024 / 1024)}MB` : '',
      creative.aspect_ratio || '',
    ].filter(Boolean).join(' - ');
    const statsOptions = ['endcap', 'delayed', 'hidden', 'always']
      .map(mode => `<option value="${mode}" ${creative.stats_mode === mode ? 'selected' : ''}>${escapeHtml(mode)}</option>`)
      .join('');
    const fitOptions = ['contain', 'cover']
      .map(fit => `<option value="${fit}" ${creative.fit === fit ? 'selected' : ''}>${escapeHtml(fit)}</option>`)
      .join('');

    return `<tr>
      <td>
        <div class="creative-card-head">
          ${thumbnail}
          <div>
            <span class="campaign-name">${escapeHtml(creative.campaign_name || 'Default Campaign')}</span><br />
            <strong>${escapeHtml(creative.partner || 'Partner')}</strong><br />
            <span>${escapeHtml(creative.title || 'Power Moment')}</span><br />
            <small>${escapeHtml(metadata || creative.filename)}</small>
          </div>
        </div>
        ${qualityBlockers ? `<div class="warning-note failed">${escapeHtml(qualityBlockers)}</div>` : ''}
        ${warnings ? `<div class="warning-note">${escapeHtml(warnings)}</div>` : ''}
        ${qualityRecommendations ? `<div class="warning-note recommend">${escapeHtml(qualityRecommendations)}</div>` : ''}
      </td>
      <td>
        <span class="status-pill ${isActive ? 'active' : 'paused'}">${escapeHtml(creative.status || 'active')}</span>
        <span class="status-pill readiness ${escapeAttr(readiness)}">${escapeHtml(readinessLabel(readiness))}</span>
        <span class="status-pill processing">${escapeHtml(processingLabel)}</span>
        <span class="status-pill quality ${escapeAttr(qualityStatus)}">${escapeHtml(`Quality ${qualityScore}`)}</span>
        <div class="creative-metrics">
          <span><strong>${numberValue(creative.impressions)}</strong> shown</span>
          <span><strong>${numberValue(creative.completions)}</strong> complete</span>
          <span><strong>${numberValue(creative.failures)}</strong> failed</span>
          <span><strong>${formatCompletionRate(creative)}</strong> rate</span>
        </div>
        <small>Last shown: ${escapeHtml(formatSponsorDate(creative.last_shown_at))}</small>
        <small>Last tested: ${escapeHtml(formatSponsorDate(creative.last_tested_at))}</small>
        ${creative.processing_message ? `<small>${escapeHtml(creative.processing_message)}</small>` : ''}
      </td>
      <td>
        <form method="POST" action="/admin/sponsors/${creative.id}/update">
          <label>Campaign</label>
          <input name="campaign_name" value="${escapeAttr(creative.campaign_name || 'Default Campaign')}" />
          <label>Partner</label>
          <input name="partner" value="${escapeAttr(creative.partner || '')}" />
          <label>Headline</label>
          <input name="title" value="${escapeAttr(creative.title || '')}" />
          <label>Subtitle</label>
          <input name="subtitle" value="${escapeAttr(creative.subtitle || '')}" />
          <div class="inline-grid">
            <span><label>Duration</label><input name="duration_ms" type="number" min="5000" max="120000" step="1000" value="${escapeAttr(creative.duration_ms || 15000)}" /></span>
            <span><label>Weight</label><input name="weight" type="number" min="1" max="20" value="${escapeAttr(creative.weight || 1)}" /></span>
            <span><label>Cooldown</label><input name="cooldown_seconds" type="number" min="60" max="86400" step="60" value="${escapeAttr(creative.cooldown_seconds || 600)}" /></span>
            <span><label>Stats</label><select name="stats_mode">${statsOptions}</select></span>
            <span><label>Fit</label><select name="fit">${fitOptions}</select></span>
          </div>
          <div class="inline-grid two">
            <span><label>Starts</label><input name="active_starts_at" type="datetime-local" value="${escapeAttr(formatDateTimeInput(creative.active_starts_at))}" /></span>
            <span><label>Ends</label><input name="active_ends_at" type="datetime-local" value="${escapeAttr(formatDateTimeInput(creative.active_ends_at))}" /></span>
          </div>
          <label><input name="muted" type="checkbox" value="1" ${creative.muted ? 'checked' : ''} /> Muted autoplay</label>
          <button type="submit">Save Creative</button>
        </form>
      </td>
      <td>
        <a class="button-link preview" href="${escapeAttr(previewHref)}" target="_blank" rel="noopener">Preview</a>
        <form method="POST" action="/admin/sponsors/${creative.id}/test">
          <button type="submit" class="test">Run Live</button>
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
  const eventRows = events.map(event => `<tr>
    <td><strong>${escapeHtml(event.event_type)}</strong><br /><small>${escapeHtml(formatSponsorDate(event.created_at))}</small></td>
    <td>${escapeHtml(event.source || 'creator')}</td>
    <td>${escapeHtml(event.partner || event.title || event.filename || event.break_id)}</td>
    <td><small>${escapeHtml(event.detail || '')}</small></td>
  </tr>`).join('');

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
    .metrics-grid { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:12px; }
    .metric-card { min-width:0; padding:16px; border-radius:18px; border:1px solid rgba(255,255,255,.1); background:rgba(0,0,0,.2); }
    .metric-card span { display:block; color:#a8afbf; font-size:11px; font-weight:900; text-transform:uppercase; letter-spacing:.08em; }
    .metric-card strong { display:block; margin-top:6px; color:#fff8e6; font-size:clamp(26px,4vw,42px); line-height:1; }
    .status-pill { display:inline-flex; align-items:center; min-height:30px; padding:5px 10px; border-radius:999px; font-size:11px; font-weight:900; text-transform:uppercase; border:1px solid rgba(255,255,255,.12); }
    .status-pill.active { color:#c6ffc3; border-color:rgba(119,240,161,.34); background:rgba(119,240,161,.08); }
    .status-pill.paused { color:#ffdf8a; border-color:rgba(246,201,91,.34); background:rgba(246,201,91,.08); }
    .status-pill.readiness { margin-left:6px; color:#9fefff; border-color:rgba(85,231,255,.32); background:rgba(85,231,255,.08); }
    .status-pill.readiness.tested { color:#c6ffc3; border-color:rgba(119,240,161,.34); background:rgba(119,240,161,.08); }
    .status-pill.readiness.failed { color:#ffb6b6; border-color:rgba(232,59,95,.36); background:rgba(232,59,95,.1); }
    .status-pill.processing { margin-left:6px; color:#ffdf8a; border-color:rgba(246,201,91,.3); background:rgba(246,201,91,.08); }
    .status-pill.quality { margin-left:6px; color:#c6ffc3; border-color:rgba(119,240,161,.34); background:rgba(119,240,161,.08); }
    .status-pill.quality.warn { color:#ffdf8a; border-color:rgba(246,201,91,.34); background:rgba(246,201,91,.08); }
    .status-pill.quality.blocked { color:#ffb6b6; border-color:rgba(232,59,95,.36); background:rgba(232,59,95,.1); }
    .creative-card-head { display:grid; grid-template-columns:120px minmax(0,1fr); gap:14px; align-items:start; }
    .creative-thumb { width:120px; aspect-ratio:16/9; border-radius:12px; object-fit:cover; border:1px solid rgba(255,255,255,.12); background:#050810; }
    .creative-thumb.empty { display:grid; place-items:center; color:#677083; font-size:11px; font-weight:900; text-align:center; text-transform:uppercase; }
    .campaign-name { color:#ffdf8a; font-size:11px; font-weight:900; text-transform:uppercase; letter-spacing:.08em; }
    .warning-note { margin-top:10px; padding:9px 10px; border-radius:12px; color:#ffdf8a; background:rgba(246,201,91,.08); border:1px solid rgba(246,201,91,.18); font-size:12px; line-height:1.4; }
    .warning-note.failed { color:#ffb6b6; background:rgba(232,59,95,.1); border-color:rgba(232,59,95,.32); }
    .warning-note.recommend { color:#9fefff; background:rgba(85,231,255,.07); border-color:rgba(85,231,255,.22); }
    .creative-metrics { display:grid; grid-template-columns:1fr 1fr; gap:8px; margin:12px 0; }
    .creative-metrics span { padding:8px; border-radius:10px; background:rgba(255,255,255,.045); color:#a8afbf; font-size:11px; }
    .creative-metrics strong { color:#fff8e6; }
    .event-table td:first-child { min-width:140px; }
    label { display: block; margin: 10px 0 6px; color: #a8afbf; font-size: 12px; font-weight:900; letter-spacing:.08em; text-transform:uppercase; }
    input, select { width: 100%; min-height:46px; padding: 10px 12px; border-radius: 14px; border: 1px solid rgba(255,255,255,0.12); background: #111827; color: #fff8e6; }
    select option, select optgroup { background:#111827; color:#fff8e6; }
    input[type="checkbox"] { width:auto; min-height:0; margin-right:8px; }
    button { margin-top: 12px; width: 100%; min-height:44px; padding: 0 14px; border: none; border-radius: 14px; background: linear-gradient(135deg,#f6c95b,#fff0b9 52%,#ff6a3d); color: #170c02; cursor: pointer; font-weight: 900; }
    button.test { color:#041014; background: linear-gradient(135deg,#55e7ff,#b9fbff); }
    button.secondary { color:#fff8e6; background:rgba(255,255,255,.07); border:1px solid rgba(255,255,255,.12); }
    button.danger { color:#fff; background: #d9435f; }
    .button-link { margin-top:12px; width:100%; min-height:44px; padding:0 14px; border-radius:14px; display:inline-flex; align-items:center; justify-content:center; color:#170c02; background:linear-gradient(135deg,#f6c95b,#fff0b9 52%,#ff6a3d); font-weight:900; text-decoration:none; }
    .button-link.preview { color:#fff8e6; background:rgba(255,255,255,.07); border:1px solid rgba(255,255,255,.12); }
    table { width: 100%; border-collapse: collapse; margin-top: 12px; overflow:hidden; border-radius:16px; }
    th, td { vertical-align: top; border-bottom: 1px solid rgba(255,255,255,0.08); padding: 12px; font-size: 13px; }
    th { background: rgba(246,201,91,0.09); color:#ffdf8a; text-align: left; font-size:11px; text-transform:uppercase; letter-spacing:.08em; }
    small { color:#9fb2d7; word-break: break-all; }
    .inline-grid { display:grid; grid-template-columns: repeat(4, 1fr); gap: 10px; }
    .inline-grid.two { grid-template-columns: repeat(2, 1fr); margin-top:10px; }
    .media-probe { margin-top:10px; padding:12px; border-radius:14px; border:1px solid rgba(85,231,255,.18); background:rgba(85,231,255,.06); color:#a8afbf; font-size:13px; line-height:1.45; }
    .media-probe.ready { color:#c6ffc3; border-color:rgba(119,240,161,.28); background:rgba(119,240,161,.07); }
    .media-probe.warn { color:#ffdf8a; border-color:rgba(246,201,91,.28); background:rgba(246,201,91,.08); }
    .media-probe.failed { color:#ffb6b6; border-color:rgba(232,59,95,.36); background:rgba(232,59,95,.1); }
    .test-panel { display:flex; align-items:center; justify-content:space-between; gap:18px; }
    .test-panel p { margin:6px 0 0; color:#a8afbf; line-height:1.5; }
    .test-panel form { min-width:220px; }
    @media(max-width:900px){ body{padding:12px}.admin-hero{align-items:flex-start;flex-direction:column}.metrics-grid,.inline-grid,.inline-grid.two,.creative-card-head{grid-template-columns:1fr}.creative-thumb{width:100%;max-width:320px} table, thead, tbody, tr, th, td{display:block} th{display:none} td{border-bottom:0} tr{border:1px solid rgba(255,255,255,0.08); border-radius:16px; margin-bottom:14px; overflow:hidden} }
  </style>
</head>
<body>
  <div class="wrapper">
    <header class="admin-hero">
      <div class="admin-brand">
        <img src="/intothebattlelogo_logo_only.svg" alt="IntoTheBattle logo" />
        <div><h1>Video Platform</h1><p>Company-controlled creative inventory</p></div>
      </div>
      <div class="admin-nav"><a href="/admin">Access Codes</a><a href="/admin/sponsors">Video Platform</a><a href="/admin/marketing">Company Growth</a><a href="/admin/logout">Logout</a></div>
    </header>
    ${message ? `<div class="notice success">${escapeHtml(message)}</div>` : ''}
    ${error ? `<div class="notice error">${escapeHtml(error)}</div>` : ''}
    <div class="metrics-grid">
      <div class="metric-card"><span>Active creatives</span><strong>${totals.active}</strong></div>
      <div class="metric-card"><span>Times shown</span><strong>${totals.impressions}</strong></div>
      <div class="metric-card"><span>Completed</span><strong>${totals.completions}</strong></div>
      <div class="metric-card"><span>Completion rate</span><strong>${completionRate}</strong></div>
    </div>
    <div class="card test-panel">
      <div>
        <h2>Live overlay testing</h2>
        <p>Preview opens the selected creative in the actual overlay without needing a live room. Run Live sends that creative to every connected free-account overlay for a real broadcast test.</p>
        <p>Server media tools: FFmpeg ${mediaTools.ffmpegAvailable ? 'available' : 'missing'}, ffprobe ${mediaTools.ffprobeAvailable ? 'available' : 'missing'}. ${mediaTools.ffmpegAvailable ? 'Uploads will be normalized when processing is enabled.' : 'Uploads will keep their original file until FFmpeg is installed or configured.'}</p>
      </div>
      <form method="POST" action="/admin/sponsors/stop-test">
        <button type="submit" class="secondary">Stop Live Test</button>
      </form>
    </div>
    <div class="card">
      <h2>Automatic break timer</h2>
      <p class="muted">Controls company-managed platform breaks for free sessions. Changes apply to the next scheduled cycle; Run Live remains instant for testing.</p>
      <form method="POST" action="/admin/sponsors/timer">
        <div class="inline-grid">
          <span><label>First break minutes</label><input name="initial_delay_minutes" type="number" min="1" max="120" value="${escapeAttr(timer.initialDelayMinutes)}" /></span>
          <span><label>Every minutes</label><input name="interval_minutes" type="number" min="1" max="240" value="${escapeAttr(timer.intervalMinutes)}" /></span>
          <span><label>After battle seconds</label><input name="action_cooldown_seconds" type="number" min="0" max="600" value="${escapeAttr(timer.actionCooldownSeconds)}" /></span>
          <span><label>After break seconds</label><input name="completion_cooldown_seconds" type="number" min="0" max="1800" value="${escapeAttr(timer.completionCooldownSeconds)}" /></span>
          <span><label>Retry seconds</label><input name="retry_delay_seconds" type="number" min="5" max="900" value="${escapeAttr(timer.retryDelaySeconds)}" /></span>
          <span><label>Intensity window</label><input name="intense_window_seconds" type="number" min="5" max="300" value="${escapeAttr(timer.intenseWindowSeconds)}" /></span>
          <span><label>Action limit</label><input name="intense_action_limit" type="number" min="1" max="100" value="${escapeAttr(timer.intenseActionLimit)}" /></span>
          <span><label>Intensity cooldown</label><input name="intense_cooldown_seconds" type="number" min="0" max="1800" value="${escapeAttr(timer.intenseCooldownSeconds)}" /></span>
          <span><label>Minimum players</label><input name="min_player_count" type="number" min="0" max="100" value="${escapeAttr(timer.minPlayerCount)}" /></span>
          <span><label>Jitter seconds</label><input name="jitter_seconds" type="number" min="0" max="600" value="${escapeAttr(timer.jitterSeconds)}" /></span>
          <span><label>No-repeat count</label><input name="no_repeat_count" type="number" min="1" max="50" value="${escapeAttr(timer.noRepeatCount)}" /></span>
          <span><label>Active hours UTC</label><input name="active_hours_utc" placeholder="13-23 or 13-17,19-23" value="${escapeAttr(timer.activeHoursUtc)}" /></span>
        </div>
        <button type="submit">Save Timer</button>
      </form>
    </div>
    ${storagePanel}
    <div class="card">
      <h2>Upload platform creative</h2>
      <form method="POST" action="/admin/sponsors/upload" enctype="multipart/form-data">
        <label>Video file</label>
        <input id="creativeFileInput" name="creative" type="file" accept="video/mp4,video/webm,video/quicktime,video/x-m4v" required />
        <input id="creativeDurationSeconds" name="durationSeconds" type="hidden" />
        <input id="creativeWidth" name="width" type="hidden" />
        <input id="creativeHeight" name="height" type="hidden" />
        <input id="creativeThumbnailData" name="thumbnailData" type="hidden" />
        <div class="media-probe" id="creativeMediaProbe">Choose a video to inspect duration, resolution, and thumbnail before upload.</div>
        <small>Recommended: MP4 H.264/AAC, 1080p, 10-30 seconds. Large files can buffer in OBS.</small>
        <label>Campaign</label>
        <input name="campaign_name" placeholder="Launch week campaign" />
        <label>Partner</label>
        <input name="partner" placeholder="Brand name" />
        <label>Headline</label>
        <input name="title" placeholder="Power Moment" />
        <label>Subtitle</label>
        <input name="subtitle" placeholder="Stay locked in. The next fight is loading." />
        <div class="inline-grid">
          <span><label>Duration</label><input name="duration_ms" type="number" min="5000" max="120000" step="1000" value="15000" /></span>
          <span><label>Weight</label><input name="weight" type="number" min="1" max="20" value="1" /></span>
          <span><label>Cooldown</label><input name="cooldown_seconds" type="number" min="60" max="86400" step="60" value="600" /></span>
          <span><label>Stats</label><select name="stats_mode"><option value="endcap">endcap</option><option value="delayed">delayed</option><option value="hidden">hidden</option><option value="always">always</option></select></span>
          <span><label>Fit</label><select name="fit"><option value="contain">contain</option><option value="cover">cover</option></select></span>
        </div>
        <div class="inline-grid two">
          <span><label>Starts</label><input name="active_starts_at" type="datetime-local" /></span>
          <span><label>Ends</label><input name="active_ends_at" type="datetime-local" /></span>
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
    <div class="card">
      <h2>Recent playback events</h2>
      <table class="event-table">
        <thead><tr><th>Event</th><th>Source</th><th>Creative</th><th>Detail</th></tr></thead>
        <tbody>${eventRows || '<tr><td colspan="4">No sponsor playback events recorded yet.</td></tr>'}</tbody>
      </table>
    </div>
  </div>
  <script>
    const fileInput = document.getElementById('creativeFileInput');
    const probeBox = document.getElementById('creativeMediaProbe');
    const durationInput = document.getElementById('creativeDurationSeconds');
    const widthInput = document.getElementById('creativeWidth');
    const heightInput = document.getElementById('creativeHeight');
    const thumbnailInput = document.getElementById('creativeThumbnailData');
    function setProbe(message, className = '') {
      if (!probeBox) return;
      probeBox.className = 'media-probe' + (className ? ' ' + className : '');
      probeBox.textContent = message;
    }
    function clearProbeFields() {
      if (durationInput) durationInput.value = '';
      if (widthInput) widthInput.value = '';
      if (heightInput) heightInput.value = '';
      if (thumbnailInput) thumbnailInput.value = '';
    }
    function formatBytes(bytes) {
      if (!bytes) return '0 MB';
      return bytes >= 1024 * 1024 ? (bytes / 1024 / 1024).toFixed(1) + ' MB' : (bytes / 1024).toFixed(1) + ' KB';
    }
    function captureThumbnail(video) {
      try {
        const canvas = document.createElement('canvas');
        const ratio = video.videoWidth && video.videoHeight ? video.videoWidth / video.videoHeight : 16 / 9;
        canvas.width = 320;
        canvas.height = Math.round(canvas.width / ratio);
        const ctx = canvas.getContext('2d');
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        if (thumbnailInput) thumbnailInput.value = canvas.toDataURL('image/jpeg', 0.72);
      } catch (_err) {}
    }
    fileInput?.addEventListener('change', () => {
      clearProbeFields();
      const file = fileInput.files && fileInput.files[0];
      if (!file) return setProbe('Choose a video to inspect duration, resolution, and thumbnail before upload.');
      const objectUrl = URL.createObjectURL(file);
      const video = document.createElement('video');
      video.preload = 'metadata';
      video.muted = true;
      video.playsInline = true;
      setProbe('Processing local video metadata...', '');
      video.onloadedmetadata = () => {
        if (durationInput) durationInput.value = Number.isFinite(video.duration) ? String(video.duration) : '';
        if (widthInput) widthInput.value = video.videoWidth || '';
        if (heightInput) heightInput.value = video.videoHeight || '';
        const warnings = [];
        if (file.type && file.type !== 'video/mp4') warnings.push('MP4 H.264/AAC is safest for OBS.');
        if (video.duration > 30) warnings.push('10-30 seconds usually performs best.');
        if (video.videoWidth && video.videoHeight && Math.abs((video.videoWidth / video.videoHeight) - (16 / 9)) > 0.08) warnings.push('16:9 is recommended.');
        if (video.videoWidth < 1280 || video.videoHeight < 720) warnings.push('720p or 1080p is recommended.');
        const meta = Math.round(video.duration || 0) + 's - ' + (video.videoWidth || '?') + 'x' + (video.videoHeight || '?') + ' - ' + formatBytes(file.size);
        setProbe(meta + (warnings.length ? ' - ' + warnings.join(' ') : ' - Ready for upload.'), warnings.length ? 'warn' : 'ready');
        try {
          video.currentTime = Math.min(0.35, Math.max(0, (video.duration || 1) / 8));
        } catch (_err) {
          URL.revokeObjectURL(objectUrl);
        }
      };
      video.onseeked = () => {
        captureThumbnail(video);
        URL.revokeObjectURL(objectUrl);
      };
      video.onerror = () => {
        setProbe('Video metadata could not be read. MP4 H.264/AAC is recommended before this reaches OBS.', 'failed');
        URL.revokeObjectURL(objectUrl);
      };
      video.src = objectUrl;
    });
  </script>
</body>
</html>`;
}

function creativeAssetLabel(assetType, creativeOptions = creativeTemplateOptions()) {
  return creativeOptions.assetTypes.find(item => item.key === assetType)?.label || assetType || 'asset';
}

function renderCreativeTemplateCards(creativeTemplates = []) {
  return creativeTemplates.map(template => `<div class="template-card">
    <div class="template-topline">
      <span class="status-pill draft">${escapeHtml(template.goal || '')}</span>
      <small>${escapeHtml(template.audience || '')}</small>
    </div>
    <h3>${escapeHtml(template.label || template.key)}</h3>
    <p>${escapeHtml(template.hooks?.[0] || '')}</p>
    <small>Assets: ${escapeHtml((template.requiredAssetLabels || []).join(', '))}</small>
  </div>`).join('');
}

function countBy(items = [], field, fallback = 'unknown') {
  return items.reduce((acc, item) => {
    const key = String(item?.[field] || fallback).toLowerCase();
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}

function renderCreativeAssetRows(creativeAssets = [], creativeOptions = creativeTemplateOptions()) {
  return creativeAssets.map(asset => {
    const status = String(asset.approval_status || 'draft').toLowerCase();
    return `<tr>
      <td>
        <strong>${escapeHtml(asset.title || '')}</strong><br />
        <small>${escapeHtml(creativeAssetLabel(asset.asset_type, creativeOptions))}</small>
      </td>
      <td>
        <span class="status-pill ${escapeAttr(status)}">${escapeHtml(status)}</span><br />
        <small>${escapeHtml(asset.source || 'manual')}</small>
      </td>
      <td>
        <a href="${escapeAttr(asset.asset_url || '#')}" target="_blank" rel="noopener">${escapeHtml(asset.asset_url || '')}</a>
        ${asset.notes ? `<div class="warning-note">${escapeHtml(asset.notes)}</div>` : ''}
      </td>
      <td>
        <form method="POST" action="/admin/marketing/creative-assets/${escapeAttr(asset.id)}/status">
          <input type="hidden" name="status" value="approved" />
          <button type="submit" class="test" ${status === 'approved' ? 'disabled' : ''}>Approve</button>
        </form>
        <form method="POST" action="/admin/marketing/creative-assets/${escapeAttr(asset.id)}/status">
          <input type="hidden" name="status" value="draft" />
          <button type="submit" class="secondary" ${status === 'draft' ? 'disabled' : ''}>Draft</button>
        </form>
        <form method="POST" action="/admin/marketing/creative-assets/${escapeAttr(asset.id)}/status">
          <input type="hidden" name="status" value="blocked" />
          <button type="submit" class="danger" ${status === 'blocked' ? 'disabled' : ''}>Block</button>
        </form>
      </td>
    </tr>`;
  }).join('');
}

function parseCreativeBlocks(blockJson = '') {
  try {
    const blocks = JSON.parse(blockJson || '{}');
    return blocks && typeof blocks === 'object' ? blocks : {};
  } catch (_err) {
    return {};
  }
}

function renderCreativeVariantRows(creativeVariants = []) {
  return creativeVariants.map(variant => {
    const status = String(variant.status || 'draft').toLowerCase();
    const qualityStatus = String(variant.quality_status || 'draft').toLowerCase();
    const isBlocked = qualityStatus === 'blocked';
    const blocks = parseCreativeBlocks(variant.block_json);
    const visualDirection = blocks.visualDirection || {};
    const textBlocks = Array.isArray(blocks.textBlocks) ? blocks.textBlocks : [];
    const blockPreview = textBlocks.map(block => `<li><strong>${escapeHtml(block.time || '')}</strong> ${escapeHtml(block.slot || '')}: ${escapeHtml(block.text || '')}</li>`).join('');
    return `<tr>
      <td>
        <strong>${escapeHtml(variant.template_key || '')}</strong><br />
        <small>${escapeHtml(String(variant.platform || '').toUpperCase())} - ${escapeHtml(variant.format || '')}</small>
      </td>
      <td>
        <span class="status-pill ${escapeAttr(status)}">${escapeHtml(status)}</span><br />
        <span class="status-pill ${escapeAttr(qualityStatus)}">quality ${escapeHtml(qualityStatus)}</span><br />
        <small>Score ${numberValue(variant.quality_score)}/100</small>
      </td>
      <td>
        <strong>${escapeHtml(variant.asset_title || 'Asset')}</strong><br />
        <small>${escapeHtml(variant.asset_url || '')}</small>
        ${variant.quality_notes ? `<div class="warning-note ${isBlocked ? 'failed' : ''}">${escapeHtml(variant.quality_notes)}</div>` : ''}
      </td>
      <td>
        <div class="post-copy">${escapeHtml(variant.body || '')}</div>
        <a href="${escapeAttr(variant.utm_url || '#')}" target="_blank" rel="noopener">UTM landing page</a>
        ${visualDirection.primaryVisual ? `<details class="creative-brief"><summary>Creative blocks</summary><ul>${blockPreview}</ul><p><strong>Visual:</strong> ${escapeHtml(visualDirection.primaryVisual)}</p><p><strong>Prompt:</strong> ${escapeHtml(visualDirection.imagePrompt || '')}</p></details>` : ''}
      </td>
      <td>
        <form method="POST" action="/admin/marketing/creative-variants/${escapeAttr(variant.id)}/status">
          <input type="hidden" name="status" value="approved" />
          <button type="submit" class="test" ${status === 'approved' || isBlocked ? 'disabled' : ''}>Approve</button>
        </form>
        <form method="POST" action="/admin/marketing/creative-variants/${escapeAttr(variant.id)}/queue">
          <button type="submit" ${status !== 'approved' || isBlocked ? 'disabled' : ''}>Send to Queue</button>
        </form>
        <form method="POST" action="/admin/marketing/creative-variants/${escapeAttr(variant.id)}/status">
          <input type="hidden" name="status" value="skipped" />
          <button type="submit" class="danger" ${status === 'skipped' ? 'disabled' : ''}>Skip</button>
        </form>
      </td>
    </tr>`;
  }).join('');
}

function renderMarketingAdminPage({
  message = '',
  error = '',
  posts = [],
  events = [],
  diagnostics = marketingAutomationDiagnostics(),
  growthDiagnostics = growthIntegrationDiagnostics(),
  filters = {},
  creativeTemplates = listCreativeTemplates(),
  creativeAssets = [],
  creativeVariants = [],
  creativeOptions = creativeTemplateOptions(),
} = {}) {
  const nowDate = new Date().toISOString().slice(0, 10);
  const selectedStatus = String(filters.status || '').toLowerCase();
  const selectedDate = String(filters.date || '');
  const statusOptions = ['', 'draft', 'approved', 'published', 'failed', 'skipped']
    .map(status => `<option value="${escapeAttr(status)}" ${selectedStatus === status ? 'selected' : ''}>${escapeHtml(status || 'all')}</option>`)
    .join('');
  const statusCounts = posts.reduce((acc, post) => {
    const status = String(post.status || 'draft');
    acc[status] = (acc[status] || 0) + 1;
    return acc;
  }, {});
  const configuredWebhooks = diagnostics.configuredWebhooks || [];
  const growthProviders = growthDiagnostics.providers || [];
  const templateCards = renderCreativeTemplateCards(creativeTemplates);
  const creativeAssetCounts = countBy(creativeAssets, 'approval_status', 'draft');
  const creativeVariantCounts = countBy(creativeVariants, 'status', 'draft');
  const creativeQualityCounts = countBy(creativeVariants, 'quality_status', 'draft');
  const assetTypeOptions = creativeOptions.assetTypes
    .map(item => `<option value="${escapeAttr(item.key)}">${escapeHtml(item.label)}</option>`)
    .join('');
  const platformOptions = creativeOptions.platforms
    .map(item => `<option value="${escapeAttr(item.key)}">${escapeHtml(item.label)} - ${escapeHtml(item.format)}</option>`)
    .join('');
  const templateOptions = creativeTemplates
    .map(template => `<option value="${escapeAttr(template.key)}">${escapeHtml(template.label)}</option>`)
    .join('');
  const approvedAssetOptions = creativeAssets
    .filter(asset => String(asset.approval_status || '').toLowerCase() === 'approved')
    .map(asset => `<option value="${escapeAttr(asset.id)}">${escapeHtml(asset.title || `Asset ${asset.id}`)} - ${escapeHtml(creativeAssetLabel(asset.asset_type, creativeOptions))}</option>`)
    .join('');
  const creativeAssetRows = renderCreativeAssetRows(creativeAssets, creativeOptions);
  const creativeVariantRows = renderCreativeVariantRows(creativeVariants);
  const eventRows = events.map(event => `<tr>
    <td><strong>${escapeHtml(event.event_type || '')}</strong><br /><small>${escapeHtml(formatSponsorDate(event.created_at))}</small></td>
    <td>${escapeHtml(String(event.platform || '').toUpperCase())}</td>
    <td>${escapeHtml(event.topic_key || '')}</td>
    <td><small>${escapeHtml(event.detail || '')}</small></td>
  </tr>`).join('');
  const rows = posts.map((post) => {
    const status = String(post.status || 'draft').toLowerCase();
    const isPublished = status === 'published';
    const editDisabled = isPublished ? 'disabled' : '';
    const characterLimit = marketingPlatformCharacterLimit(post.platform);
    const bodyLength = String(post.body || '').length;
    const approveDisabled = status === 'approved' ? 'disabled' : '';
    const draftDisabled = status === 'draft' ? 'disabled' : '';
    const skipDisabled = status === 'skipped' ? 'disabled' : '';
    return `<tr>
      <td>
        <strong>${escapeHtml(String(post.platform || '').toUpperCase())}</strong><br />
        <small>${escapeHtml(post.campaign_date || '')} - ${escapeHtml(post.topic_key || '')}</small>
      </td>
      <td>
        <span class="status-pill ${escapeAttr(status)}">${escapeHtml(status)}</span><br />
        <small>Scheduled: ${escapeHtml(formatSponsorDate(post.scheduled_for))}</small>
        ${post.error_message ? `<div class="warning-note failed">${escapeHtml(post.error_message)}</div>` : ''}
      </td>
      <td>
        <form method="POST" action="/admin/marketing/${escapeAttr(post.id)}/update">
          <label>Outbound copy <small>${bodyLength}/${characterLimit}</small></label>
          <textarea name="body" maxlength="${escapeAttr(characterLimit)}" required ${editDisabled}>${escapeHtml(post.body || '')}</textarea>
          <div class="inline-grid compact">
            <span><label>Schedule</label><input name="scheduledFor" type="datetime-local" value="${escapeAttr(formatDateTimeInput(post.scheduled_for))}" ${editDisabled} /></span>
            <span><label>CTA</label><input name="cta" value="${escapeAttr(post.cta || '')}" ${editDisabled} /></span>
            <span><label>UTM link</label><input name="utmUrl" value="${escapeAttr(post.utm_url || post.url || '')}" ${editDisabled} /></span>
          </div>
          <label>Hashtags</label>
          <input name="hashtags" value="${escapeAttr(post.hashtags || '')}" ${editDisabled} />
          <label>SEO keywords</label>
          <input name="seoKeywords" value="${escapeAttr(post.seo_keywords || '')}" ${editDisabled} />
          <button type="submit" class="secondary" ${editDisabled}>Save as Draft</button>
        </form>
      </td>
      <td>
        <form method="POST" action="/admin/marketing/${escapeAttr(post.id)}/status">
          <input type="hidden" name="status" value="approved" />
          <button type="submit" class="test" ${approveDisabled}>Approve</button>
        </form>
        <form method="POST" action="/admin/marketing/${escapeAttr(post.id)}/status">
          <input type="hidden" name="status" value="draft" />
          <button type="submit" class="secondary" ${draftDisabled}>Back to Draft</button>
        </form>
        <form method="POST" action="/admin/marketing/${escapeAttr(post.id)}/status">
          <input type="hidden" name="status" value="skipped" />
          <button type="submit" class="danger" ${skipDisabled}>Skip</button>
        </form>
      </td>
    </tr>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Company Growth - Admin</title>
  <style>
    * { box-sizing:border-box; }
    body { min-height:100vh; font-family: Inter, Arial, sans-serif; background:radial-gradient(circle at 16% 0,rgba(246,201,91,.18),transparent 30%),radial-gradient(circle at 88% 12%,rgba(232,59,95,.14),transparent 28%),linear-gradient(180deg,#050608,#030406); color:#fff8e6; margin:0; padding:24px; }
    body::before { content:""; position:fixed; inset:0; pointer-events:none; background-image:linear-gradient(rgba(246,201,91,.035) 1px,transparent 1px),linear-gradient(90deg,rgba(246,201,91,.035) 1px,transparent 1px); background-size:58px 58px; mask-image:radial-gradient(circle at top,black,transparent 72%); z-index:-1; }
    .wrapper { max-width:1240px; margin:0 auto; display:grid; gap:18px; }
    .admin-hero { display:flex; align-items:center; justify-content:space-between; gap:18px; padding:18px; border:1px solid rgba(246,201,91,.24); border-radius:26px; background:rgba(5,7,11,.78); box-shadow:0 28px 80px rgba(0,0,0,.38); }
    .admin-brand { display:flex; align-items:center; gap:14px; min-width:0; }
    .admin-brand img { width:58px; height:58px; border-radius:18px; border:1px solid rgba(246,201,91,.34); background:rgba(246,201,91,.08); object-fit:cover; }
    h1 { margin:0; font-size:clamp(28px,4vw,48px); line-height:1; text-transform:uppercase; }
    h2 { margin:0 0 12px; font-size:22px; }
    p { color:#a8afbf; line-height:1.55; }
    .admin-brand p { margin:6px 0 0; color:#a8afbf; font-size:13px; font-weight:800; text-transform:uppercase; letter-spacing:.08em; }
    .admin-nav { display:flex; gap:10px; flex-wrap:wrap; }
    .admin-nav a { display:inline-flex; align-items:center; justify-content:center; min-height:40px; padding:0 14px; border-radius:999px; border:1px solid rgba(255,255,255,.1); color:#fff8e6; background:rgba(255,255,255,.055); }
    a { color:#ffdf8a; text-decoration:none; font-weight:800; word-break:break-word; }
    .notice { padding:14px 16px; border-radius:16px; border:1px solid rgba(255,255,255,.1); background:rgba(255,255,255,0.06); }
    .error { color:#ffb6b6; }
    .success { color:#c6ffc3; }
    .card { background:linear-gradient(180deg,rgba(255,255,255,.065),rgba(255,255,255,.025)); border:1px solid rgba(255,255,255,.1); border-radius:24px; padding:20px; box-shadow:0 20px 60px rgba(0,0,0,.24); }
    .metrics-grid { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:12px; }
    .metric-card { min-width:0; padding:16px; border-radius:18px; border:1px solid rgba(255,255,255,.1); background:rgba(0,0,0,.2); }
    .metric-card span { display:block; color:#a8afbf; font-size:11px; font-weight:900; text-transform:uppercase; letter-spacing:.08em; }
    .metric-card strong { display:block; margin-top:6px; color:#fff8e6; font-size:clamp(26px,4vw,42px); line-height:1; }
    .inline-grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:12px; align-items:end; }
    .inline-grid.compact { grid-template-columns:repeat(3,minmax(0,1fr)); align-items:end; }
    label { display:block; margin:10px 0 6px; color:#a8afbf; font-size:12px; font-weight:900; letter-spacing:.08em; text-transform:uppercase; }
    input, select, textarea { width:100%; min-height:46px; padding:10px 12px; border-radius:14px; border:1px solid rgba(255,255,255,0.12); background:#111827; color:#fff8e6; }
    textarea { min-height:180px; resize:vertical; line-height:1.45; }
    select option { background:#111827; color:#fff8e6; }
    input[type="checkbox"] { width:auto; min-height:0; margin-right:8px; }
    button { margin-top:12px; width:100%; min-height:44px; padding:0 14px; border:none; border-radius:14px; background:linear-gradient(135deg,#f6c95b,#fff0b9 52%,#ff6a3d); color:#170c02; cursor:pointer; font-weight:900; }
    button:disabled { opacity:.45; cursor:not-allowed; }
    button.test { color:#041014; background:linear-gradient(135deg,#55e7ff,#b9fbff); }
    button.secondary { color:#fff8e6; background:rgba(255,255,255,.07); border:1px solid rgba(255,255,255,.12); }
    button.danger { color:#fff; background:#d9435f; }
    .status-pill { display:inline-flex; align-items:center; min-height:30px; padding:5px 10px; border-radius:999px; font-size:11px; font-weight:900; text-transform:uppercase; border:1px solid rgba(255,255,255,.12); }
    .status-pill.draft { color:#ffdf8a; border-color:rgba(246,201,91,.34); background:rgba(246,201,91,.08); }
    .status-pill.approved { color:#9fefff; border-color:rgba(85,231,255,.32); background:rgba(85,231,255,.08); }
    .status-pill.published { color:#c6ffc3; border-color:rgba(119,240,161,.34); background:rgba(119,240,161,.08); }
    .status-pill.failed, .status-pill.skipped, .status-pill.blocked { color:#ffb6b6; border-color:rgba(232,59,95,.36); background:rgba(232,59,95,.1); }
    .status-pill.ready { color:#c6ffc3; border-color:rgba(119,240,161,.34); background:rgba(119,240,161,.08); }
    .status-pill.warn { color:#ffdf8a; border-color:rgba(246,201,91,.34); background:rgba(246,201,91,.08); }
    .status-pill.queued { color:#9fefff; border-color:rgba(85,231,255,.32); background:rgba(85,231,255,.08); }
    .warning-note { margin-top:10px; padding:9px 10px; border-radius:12px; color:#ffdf8a; background:rgba(246,201,91,.08); border:1px solid rgba(246,201,91,.18); font-size:12px; line-height:1.4; }
    .warning-note.failed { color:#ffb6b6; background:rgba(232,59,95,.1); border-color:rgba(232,59,95,.32); }
    .template-grid { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:12px; margin-top:14px; }
    .template-card { min-width:0; padding:14px; border-radius:18px; border:1px solid rgba(255,255,255,.1); background:rgba(0,0,0,.22); }
    .template-card h3 { margin:10px 0 8px; color:#fff8e6; font-size:17px; }
    .template-card p { margin:0 0 10px; font-size:13px; }
    .template-topline { display:flex; align-items:center; justify-content:space-between; gap:8px; }
    .creative-brief { margin-top:10px; padding:10px; border-radius:14px; border:1px solid rgba(255,255,255,.09); background:rgba(0,0,0,.18); }
    .creative-brief summary { cursor:pointer; color:#ffdf8a; font-weight:900; }
    .creative-brief ul { margin:10px 0; padding-left:18px; color:#dce7ff; }
    .creative-brief p { margin:8px 0 0; font-size:12px; }
    table { width:100%; border-collapse:collapse; margin-top:12px; overflow:hidden; border-radius:16px; }
    th, td { vertical-align:top; border-bottom:1px solid rgba(255,255,255,0.08); padding:12px; font-size:13px; }
    th { background:rgba(246,201,91,0.09); color:#ffdf8a; text-align:left; font-size:11px; text-transform:uppercase; letter-spacing:.08em; }
    small { color:#9fb2d7; }
    .post-copy { max-width:620px; white-space:pre-wrap; color:#fff8e6; line-height:1.45; }
    @media(max-width:1100px){ .template-grid{grid-template-columns:repeat(2,minmax(0,1fr));} }
    @media(max-width:900px){ body{padding:12px}.admin-hero{align-items:flex-start;flex-direction:column}.metrics-grid,.inline-grid,.template-grid{grid-template-columns:1fr} table,thead,tbody,tr,th,td{display:block} thead{display:none} tr{border:1px solid rgba(255,255,255,.08); border-radius:16px; margin-bottom:14px; overflow:hidden} td{border-bottom:0} }
  </style>
</head>
<body>
  <div class="wrapper">
    <header class="admin-hero">
      <div class="admin-brand">
        <img src="/intothebattlelogo_logo_only.svg" alt="IntoTheBattle logo" />
        <div><h1>Company Growth</h1><p>Admin-only sales workflow</p></div>
      </div>
      <div class="admin-nav"><a href="/admin">Access Codes</a><a href="/admin/sponsors">Video Platform</a><a href="/admin/marketing">Company Growth</a><a href="/admin/logout">Logout</a></div>
    </header>
    ${message ? `<div class="notice success">${escapeHtml(message)}</div>` : ''}
    ${error ? `<div class="notice error">${escapeHtml(error)}</div>` : ''}
    <div class="metrics-grid">
      <div class="metric-card"><span>Drafts</span><strong>${numberValue(statusCounts.draft)}</strong></div>
      <div class="metric-card"><span>Approved</span><strong>${numberValue(statusCounts.approved)}</strong></div>
      <div class="metric-card"><span>Published</span><strong>${numberValue(statusCounts.published)}</strong></div>
      <div class="metric-card"><span>Failed</span><strong>${numberValue(statusCounts.failed)}</strong></div>
    </div>
    <div class="metrics-grid">
      <div class="metric-card"><span>Approved Assets</span><strong>${numberValue(creativeAssetCounts.approved)}</strong></div>
      <div class="metric-card"><span>Ready Variants</span><strong>${numberValue(creativeQualityCounts.ready)}</strong></div>
      <div class="metric-card"><span>Queued Variants</span><strong>${numberValue(creativeVariantCounts.queued)}</strong></div>
      <div class="metric-card"><span>Blocked Variants</span><strong>${numberValue(creativeQualityCounts.blocked)}</strong></div>
    </div>
    <div class="card">
      <h2>Automation controls</h2>
      <p>Generate SEO and UTM-tagged daily drafts from the public site pages for company-owned growth. This is not a streamer-facing feature and is only available inside the admin panel.</p>
      <p>Publishing stays in dry-run mode unless <strong>MARKETING_AUTOMATION_ENABLED=true</strong>, <strong>MARKETING_DRY_RUN=false</strong>, and an authorized webhook is configured.</p>
      <p>Platforms: ${escapeHtml((diagnostics.platforms || []).join(', '))}. Webhooks configured: ${escapeHtml(configuredWebhooks.length ? configuredWebhooks.join(', ') : 'none')}.</p>
      <p>Lead APIs: sync ${growthDiagnostics.enabled ? 'enabled' : 'disabled'}; HubSpot ${growthDiagnostics.hubspotConfigured ? 'connected' : 'not configured'}; HubSpot custom fields ${growthDiagnostics.hubspotCustomPropertiesConfigured ? 'configured' : 'not configured'}; Segment ${growthDiagnostics.segmentConfigured ? 'connected' : 'not configured'}; providers ${escapeHtml(growthProviders.length ? growthProviders.join(', ') : 'none')}.</p>
      <div class="inline-grid">
        <form method="POST" action="/admin/marketing/generate">
          <label>Date</label>
          <input name="date" type="date" value="${escapeAttr(nowDate)}" />
          <label><input name="force" type="checkbox" value="1" /> Rebuild existing drafts</label>
          <button type="submit">Generate Daily Drafts</button>
        </form>
        <form method="POST" action="/admin/marketing/publish">
          <input type="hidden" name="dryRun" value="1" />
          <label>Dry-run approved posts</label>
          <input name="limit" type="number" min="1" max="50" value="10" />
          <button type="submit" class="secondary">Dry Run Publish</button>
        </form>
        <form method="POST" action="/admin/marketing/publish" onsubmit="return confirm('Publish approved due posts to configured outbound webhooks?')">
          <input type="hidden" name="dryRun" value="0" />
          <label>Live publish approved posts</label>
          <input name="limit" type="number" min="1" max="50" value="10" />
          <button type="submit" class="test">Publish Approved</button>
        </form>
      </div>
    </div>
    <div class="card">
      <h2>Creative template engine</h2>
      <p>Build repeatable posts from approved proof assets. The flow is deliberate: save an asset, generate variants from a template, approve the best one, then send it into the daily queue. Duplicate variants are skipped and every queued variant is rechecked against the latest asset approval.</p>
      <div class="template-grid">${templateCards || '<p>No templates configured.</p>'}</div>
    </div>
    <div class="card">
      <h2>Asset vault</h2>
      <form method="POST" action="/admin/marketing/creative-assets">
        <div class="inline-grid compact">
          <span><label>Title</label><input name="title" maxlength="120" placeholder="Real overlay 12-second clip" required /></span>
          <span><label>Asset type</label><select name="assetType" required>${assetTypeOptions}</select></span>
          <span><label>Status</label><select name="approvalStatus"><option value="approved">Approved</option><option value="draft">Draft</option><option value="blocked">Blocked</option></select></span>
        </div>
        <label>Asset URL</label>
        <input name="assetUrl" maxlength="700" placeholder="/assets/battle-demo.mp4 or https://..." required />
        <div class="inline-grid compact">
          <span><label>Source</label><input name="source" maxlength="80" value="manual" /></span>
          <span><label>Notes</label><input name="notes" maxlength="500" placeholder="Where this came from and why it is approved" /></span>
          <span><button type="submit">Save Asset</button></span>
        </div>
      </form>
      <table>
        <thead><tr><th>Asset</th><th>Status</th><th>URL</th><th>Actions</th></tr></thead>
        <tbody>${creativeAssetRows || '<tr><td colspan="4">No creative assets saved yet.</td></tr>'}</tbody>
      </table>
    </div>
    <div class="card">
      <h2>Variant builder</h2>
      <p>Generated variants are structured as hook, proof, CTA, UTM URL, frame script, and safe-zone guidance. Blocked variants cannot be approved or queued.</p>
      <form method="POST" action="/admin/marketing/creative-variants/generate">
        <div class="inline-grid compact">
          <span><label>Template</label><select name="templateKey" required>${templateOptions}</select></span>
          <span><label>Platform</label><select name="platform" required>${platformOptions}</select></span>
          <span><label>Approved asset</label><select name="assetId" required>${approvedAssetOptions || '<option value="">No approved assets</option>'}</select></span>
        </div>
        <div class="inline-grid compact">
          <span><label>Variant count</label><input name="count" type="number" min="1" max="5" value="3" /></span>
          <span><button type="submit" ${approvedAssetOptions ? '' : 'disabled'}>Generate Variants</button></span>
        </div>
      </form>
      <table>
        <thead><tr><th>Template</th><th>Status</th><th>Asset</th><th>Copy</th><th>Actions</th></tr></thead>
        <tbody>${creativeVariantRows || '<tr><td colspan="5">No creative variants generated yet.</td></tr>'}</tbody>
      </table>
    </div>
    <div class="card">
      <h2>Queue filters</h2>
      <form method="GET" action="/admin/marketing">
        <div class="inline-grid compact">
          <span><label>Status</label><select name="status">${statusOptions}</select></span>
          <span><label>Date</label><input name="date" type="date" value="${escapeAttr(selectedDate)}" /></span>
          <span><button type="submit">Filter Queue</button></span>
        </div>
      </form>
    </div>
    <div class="card">
      <h2>Daily content queue</h2>
      <table>
        <thead><tr><th>Platform</th><th>Status</th><th>Draft</th><th>Actions</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="4">No marketing posts generated yet.</td></tr>'}</tbody>
      </table>
    </div>
    <div class="card">
      <h2>Recent publish events</h2>
      <table>
        <thead><tr><th>Event</th><th>Platform</th><th>Topic</th><th>Detail</th></tr></thead>
        <tbody>${eventRows || '<tr><td colspan="4">No publish events recorded yet.</td></tr>'}</tbody>
      </table>
    </div>
  </div>
</body>
</html>`;
}

function listPlatformSponsorCreatives() {
  return db.prepare('SELECT * FROM platform_sponsor_creatives ORDER BY uploaded_at DESC, id DESC').all();
}

function listRecentSponsorPlaybackEvents() {
  try {
    return db.prepare(`
      SELECT events.*, creatives.partner, creatives.title
      FROM sponsor_playback_events events
      LEFT JOIN platform_sponsor_creatives creatives ON events.creative_id = creatives.id
      ORDER BY events.created_at DESC, events.id DESC
      LIMIT 30
    `).all();
  } catch (_err) {
    return [];
  }
}

router.get('/sponsors', requireAdminAuth, (req, res) => {
  try { ensureDir(PLATFORM_SPONSOR_DIR); } catch (_err) {}
  res.send(renderSponsorAdminPage({
    message: String(req.query.message || ''),
    error: String(req.query.error || ''),
    creatives: listPlatformSponsorCreatives(),
    events: listRecentSponsorPlaybackEvents(),
    storageRisk: storageRiskSummary(PLATFORM_SPONSOR_DIR),
    timerSettings: platformSponsorTimerSettings(),
  }));
});

function timerNumber(body, name, fallback, min, max) {
  const value = Number(body?.[name]);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.round(value)));
}

router.post('/sponsors/timer', requireAdminAuth, (req, res) => {
  const body = req.body || {};
  const pairs = [
    ['platform_sponsor_initial_delay_ms', timerNumber(body, 'initial_delay_minutes', 8, 1, 120) * 60000],
    ['platform_sponsor_interval_ms', timerNumber(body, 'interval_minutes', 12, 1, 240) * 60000],
    ['platform_sponsor_action_cooldown_ms', timerNumber(body, 'action_cooldown_seconds', 45, 0, 600) * 1000],
    ['platform_sponsor_completion_cooldown_ms', timerNumber(body, 'completion_cooldown_seconds', 180, 0, 1800) * 1000],
    ['platform_sponsor_retry_delay_ms', timerNumber(body, 'retry_delay_seconds', 60, 5, 900) * 1000],
    ['platform_sponsor_intense_window_ms', timerNumber(body, 'intense_window_seconds', 30, 5, 300) * 1000],
    ['platform_sponsor_intense_action_limit', timerNumber(body, 'intense_action_limit', 10, 1, 100)],
    ['platform_sponsor_intense_cooldown_ms', timerNumber(body, 'intense_cooldown_seconds', 75, 0, 1800) * 1000],
    ['platform_sponsor_min_player_count', timerNumber(body, 'min_player_count', 1, 0, 100)],
    ['platform_sponsor_jitter_ms', timerNumber(body, 'jitter_seconds', 90, 0, 600) * 1000],
    ['platform_sponsor_no_repeat_count', timerNumber(body, 'no_repeat_count', 3, 1, 50)],
    ['platform_sponsor_active_hours_utc', String(body.active_hours_utc || '').replace(/[^0-9,.\-\s]/g, '').trim()],
  ];
  pairs.forEach(([key, value]) => setAppSetting(key, value));
  res.redirect('/admin/sponsors?message=Sponsor%20timer%20saved');
});

router.post('/sponsors/upload', requireAdminAuth, (req, res) => {
  const capacityRedirect = uploadCapacityRedirect(req);
  if (capacityRedirect) return res.redirect(capacityRedirect);
  sponsorUpload.single('creative')(req, res, async (err) => {
    if (err) {
      const message = err?.code === 'LIMIT_FILE_SIZE'
        ? `Creative is too large. Maximum platform upload size is ${Math.round(PLATFORM_SPONSOR_UPLOAD_MAX_BYTES / 1024 / 1024)}MB.`
        : err.message || 'Upload failed';
      return res.redirect(`/admin/sponsors?error=${encodeURIComponent(message)}`);
    }
    if (!req.file) return res.redirect(`/admin/sponsors?error=${encodeURIComponent('Choose a video file')}`);

    let mediaMeta;
    try {
      mediaMeta = await processSponsorUpload({ file: req.file, body: req.body || {}, targetDir: PLATFORM_SPONSOR_DIR });
      const postWriteCapacityRedirect = uploadedFileCapacityRedirect(mediaMeta.filepath, mediaMeta.fileSize);
      if (postWriteCapacityRedirect) return res.redirect(postWriteCapacityRedirect);
      db.prepare(`
        INSERT INTO platform_sponsor_creatives
          (
            filename, original_name, campaign_name, partner, title, subtitle,
            duration_ms, duration_seconds, width, height, file_size, mime_type,
            video_codec, audio_codec, aspect_ratio, thumbnail_data, quality_warnings,
            quality_status, quality_score, quality_blockers, quality_recommendations,
            normalized, processing_status, processing_message, stats_mode, fit,
            muted, weight, cooldown_seconds, status, readiness_status, processed_at,
            active_starts_at, active_ends_at, uploaded_at, updated_at
          )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 'ready', ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `).run(
        mediaMeta.filename,
        req.file.originalname,
        sanitizeSponsorText(req.body.campaign_name, 'Default Campaign', 90),
        sanitizeSponsorText(req.body.partner, 'Partner', 70),
        sanitizeSponsorText(req.body.title, 'Power Moment', 90),
        sanitizeSponsorText(req.body.subtitle, 'Stay locked in. The next fight is loading.', 140),
        parseDurationMs(req.body.duration_ms),
        mediaMeta.durationSeconds,
        mediaMeta.width,
        mediaMeta.height,
        mediaMeta.fileSize,
        mediaMeta.mimeType,
        mediaMeta.videoCodec,
        mediaMeta.audioCodec,
        mediaMeta.aspectRatio,
        mediaMeta.thumbnailData,
        mediaMeta.qualityWarnings.join(' '),
        mediaMeta.qualityGateStatus,
        mediaMeta.qualityGateScore,
        (mediaMeta.qualityGateBlockers || []).join(' '),
        (mediaMeta.qualityRecommendations || []).join(' '),
        mediaMeta.normalized ? 1 : 0,
        mediaMeta.processingStatus,
        mediaMeta.processingMessage,
        parseStatsMode(req.body.stats_mode),
        parseFit(req.body.fit),
        req.body.muted === '1' ? 1 : 0,
        parseWeight(req.body.weight),
        parseCooldownSeconds(req.body.cooldown_seconds),
        mediaMeta.processedAt ? mediaMeta.processedAt.slice(0, 19).replace('T', ' ') : null,
        parseDateTimeLocal(req.body.active_starts_at),
        parseDateTimeLocal(req.body.active_ends_at)
      );
      return res.redirect('/admin/sponsors?message=Creative%20uploaded');
    } catch (insertErr) {
      deleteSponsorUploadFile(req.file.path);
      deleteSponsorUploadFile(mediaMeta?.filepath);
      return res.redirect(`/admin/sponsors?error=${encodeURIComponent(insertErr.message || 'Creative save failed')}`);
    }
  });
});

router.post('/sponsors/:id/update', requireAdminAuth, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.redirect('/admin/sponsors?error=Invalid%20creative');

  db.prepare(`
    UPDATE platform_sponsor_creatives
    SET campaign_name = ?,
        partner = ?,
        title = ?,
        subtitle = ?,
        duration_ms = ?,
        stats_mode = ?,
        fit = ?,
        muted = ?,
        weight = ?,
        cooldown_seconds = ?,
        active_starts_at = ?,
        active_ends_at = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(
    sanitizeSponsorText(req.body.campaign_name, 'Default Campaign', 90),
    sanitizeSponsorText(req.body.partner, 'Partner', 70),
    sanitizeSponsorText(req.body.title, 'Power Moment', 90),
    sanitizeSponsorText(req.body.subtitle, 'Stay locked in. The next fight is loading.', 140),
    parseDurationMs(req.body.duration_ms),
    parseStatsMode(req.body.stats_mode),
    parseFit(req.body.fit),
    req.body.muted === '1' ? 1 : 0,
    parseWeight(req.body.weight),
    parseCooldownSeconds(req.body.cooldown_seconds),
    parseDateTimeLocal(req.body.active_starts_at),
    parseDateTimeLocal(req.body.active_ends_at),
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
    res.redirect(`/admin/sponsors?message=${encodeURIComponent(`Creative sent to ${result.roomCount} platform-managed live ${noun}`)}`);
  } catch (err) {
    res.redirect(`/admin/sponsors?error=${encodeURIComponent(err.message || 'Test failed')}`);
  }
});

router.post('/sponsors/stop-test', requireAdminAuth, (_req, res) => {
  try {
    const result = triggerPlatformSponsorTest({ action: 'hide' });
    const noun = result.roomCount === 1 ? 'overlay' : 'overlays';
    res.redirect(`/admin/sponsors?message=${encodeURIComponent(`Stopped platform creative on ${result.roomCount} live ${noun}`)}`);
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

router.get('/marketing', requireAdminAuth, (req, res) => {
  const status = String(req.query.status || '').trim().toLowerCase();
  const date = String(req.query.date || '').trim();
  try {
    res.send(renderMarketingAdminPage({
      message: String(req.query.message || ''),
      error: String(req.query.error || ''),
      posts: listMarketingPosts({ limit: 80, status, date }),
      events: listMarketingPublishEvents({ limit: 30 }),
      diagnostics: marketingAutomationDiagnostics(),
      growthDiagnostics: growthIntegrationDiagnostics(),
      filters: { status, date },
      creativeTemplates: listCreativeTemplates(),
      creativeAssets: listCreativeAssets({ limit: 60 }),
      creativeVariants: listCreativeVariants({ limit: 60 }),
      creativeOptions: creativeTemplateOptions(),
    }));
  } catch (err) {
    res.status(500).send(renderMarketingAdminPage({
      error: err?.message || 'Marketing page failed to load',
      posts: [],
      events: [],
      diagnostics: marketingAutomationDiagnostics(),
      growthDiagnostics: growthIntegrationDiagnostics(),
      filters: { status, date },
      creativeTemplates: listCreativeTemplates(),
      creativeAssets: [],
      creativeVariants: [],
      creativeOptions: creativeTemplateOptions(),
    }));
  }
});

router.post('/marketing/generate', requireAdminAuth, (req, res) => {
  const dateValue = String(req.body.date || '').trim();
  const date = dateValue || new Date();
  const force = req.body.force === '1';
  try {
    const result = ensureMarketingPostsForDate({ date, force });
    res.redirect(`/admin/marketing?message=${encodeURIComponent(`Generated ${result.count} marketing drafts for ${result.date}`)}`);
  } catch (err) {
    res.redirect(`/admin/marketing?error=${encodeURIComponent(err?.message || 'Marketing draft generation failed')}`);
  }
});

router.post('/marketing/creative-assets', requireAdminAuth, (req, res) => {
  try {
    addCreativeAsset({
      title: req.body.title,
      assetType: req.body.assetType,
      assetUrl: req.body.assetUrl,
      source: req.body.source,
      approvalStatus: req.body.approvalStatus,
      notes: req.body.notes,
    });
    res.redirect('/admin/marketing?message=Creative%20asset%20saved');
  } catch (err) {
    res.redirect(`/admin/marketing?error=${encodeURIComponent(err?.message || 'Creative asset save failed')}`);
  }
});

router.post('/marketing/creative-assets/:id/status', requireAdminAuth, (req, res) => {
  try {
    updateCreativeAssetStatus(req.params.id, String(req.body.status || '').trim().toLowerCase());
    res.redirect('/admin/marketing?message=Creative%20asset%20status%20updated');
  } catch (err) {
    res.redirect(`/admin/marketing?error=${encodeURIComponent(err?.message || 'Creative asset status update failed')}`);
  }
});

router.post('/marketing/creative-variants/generate', requireAdminAuth, (req, res) => {
  try {
    const result = generateCreativeVariants({
      templateKey: req.body.templateKey,
      platform: req.body.platform,
      assetId: req.body.assetId,
      count: req.body.count,
    });
    const skippedMessage = result.skipped ? `, skipped ${result.skipped} duplicates` : '';
    res.redirect(`/admin/marketing?message=${encodeURIComponent(`Generated ${result.count} creative variants${skippedMessage}`)}`);
  } catch (err) {
    res.redirect(`/admin/marketing?error=${encodeURIComponent(err?.message || 'Creative variant generation failed')}`);
  }
});

router.post('/marketing/creative-variants/:id/status', requireAdminAuth, (req, res) => {
  try {
    const status = String(req.body.status || '').trim().toLowerCase();
    updateCreativeVariantStatus(req.params.id, status);
    res.redirect(`/admin/marketing?message=${encodeURIComponent(`Creative variant ${status}`)}`);
  } catch (err) {
    res.redirect(`/admin/marketing?error=${encodeURIComponent(err?.message || 'Creative variant status update failed')}`);
  }
});

router.post('/marketing/creative-variants/:id/queue', requireAdminAuth, (req, res) => {
  try {
    queueCreativeVariantAsMarketingPost(req.params.id);
    res.redirect('/admin/marketing?message=Creative%20variant%20sent%20to%20marketing%20queue');
  } catch (err) {
    res.redirect(`/admin/marketing?error=${encodeURIComponent(err?.message || 'Creative variant queue failed')}`);
  }
});

router.post('/marketing/:id/update', requireAdminAuth, (req, res) => {
  const id = Number(req.params.id);
  try {
    updateMarketingPostDraft(id, {
      body: req.body.body,
      cta: req.body.cta,
      utmUrl: req.body.utmUrl,
      hashtags: req.body.hashtags,
      seoKeywords: req.body.seoKeywords,
      scheduledFor: req.body.scheduledFor,
    });
    res.redirect('/admin/marketing?message=Marketing%20draft%20saved%20for%20review');
  } catch (err) {
    res.redirect(`/admin/marketing?error=${encodeURIComponent(err?.message || 'Marketing draft update failed')}`);
  }
});

router.post('/marketing/:id/status', requireAdminAuth, (req, res) => {
  const id = Number(req.params.id);
  const status = String(req.body.status || '').trim().toLowerCase();
  try {
    updateMarketingPostStatus(id, status);
    res.redirect(`/admin/marketing?message=${encodeURIComponent(`Marketing post ${status}`)}`);
  } catch (err) {
    res.redirect(`/admin/marketing?error=${encodeURIComponent(err?.message || 'Marketing status update failed')}`);
  }
});

router.post('/marketing/publish', requireAdminAuth, async (req, res) => {
  const limit = Math.max(1, Math.min(50, Number(req.body.limit) || 10));
  const dryRun = req.body.dryRun !== '0';
  try {
    const result = await publishApprovedMarketingPosts({ limit, dryRun });
    const message = dryRun
      ? `Dry run checked ${result.attempted} approved posts`
      : `Published ${result.published}, failed ${result.failed}, skipped ${result.skipped}`;
    res.redirect(`/admin/marketing?message=${encodeURIComponent(message)}`);
  } catch (err) {
    res.redirect(`/admin/marketing?error=${encodeURIComponent(err?.message || 'Marketing publish failed')}`);
  }
});

router.get('/codes', requireAdminAuth, (req, res) => {
  res.redirect('/admin');
});

export default router;
