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
  listRecentMarketingVisits,
  listMarketingPublishEvents,
  listMarketingPosts,
  marketingAutomationDiagnostics,
  marketingPerformanceSummary,
  marketingPlatformCharacterLimit,
  publishApprovedMarketingPosts,
  recoverFailedMarketingPosts,
  updateMarketingPostDraft,
  updateMarketingPostStatus,
} from '../services/marketingAutomation.js';
import { growthIntegrationDiagnostics, syncLeadToGrowthApis } from '../services/growthIntegrations.js';
import {
  addCreativeAsset,
  buildCreativeProductionPackage,
  buildBlankDesignBrief,
  creativeTemplateOptions,
  generateCreativeContentPack,
  generateCreativeVariants,
  listBattleDemoContentAssets,
  listBlankDesignTemplates,
  listContentGenerationPacks,
  listCreativeAssets,
  listCreativeTemplates,
  listCreativeVariants,
  queueCreativeVariantAsMarketingPost,
  renderBlankDesignSvg,
  renderCreativeVariantSvg,
  saveBattleDemoContentAssets,
  updateCreativeAssetStatus,
  updateCreativeVariantStatus,
} from '../services/creativeTemplateEngine.js';
import {
  createBlogPost,
  deleteBlogPost,
  generateBlogDraftsFromSiteContext,
  getBlogPostById,
  listBlogPosts,
  pushBlogPostToWritefreely,
  setBlogPostStatus,
  updateBlogPost,
  writefreelyPublishConfig,
} from '../services/blogEngine.js';
import {
  getActiveUserCounts,
  injectActiveUserMetrics,
} from '../services/adminUserCounts.js';
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
const GROWTH_ASSET_DIR = path.join(process.env.DISK_PATH || path.resolve(__dirname, '..', '..'), 'growth-assets');
const GROWTH_CREATIVE_UPLOAD_MAX_BYTES = uploadLimitBytes('GROWTH_CREATIVE_UPLOAD_MAX_MB', 25 * 1024 * 1024);
const GROWTH_ASSET_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.mp4', '.webm', '.m4v', '.mov']);
const GROWTH_ASSET_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'video/mp4', 'video/webm', 'video/quicktime', 'video/x-m4v']);

router.use((req, res, next) => {
  if (req.method !== 'GET' || req.path !== '/') return next();

  const send = res.send.bind(res);
  res.send = body => {
    if (typeof body !== 'string') return send(body);
    return send(injectActiveUserMetrics(body, getActiveUserCounts(db)));
  };
  next();
});

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

function deleteGrowthUploadFile(filepath) {
  try {
    if (filepath && isSafePath(GROWTH_ASSET_DIR, filepath) && fs.existsSync(filepath)) fs.unlinkSync(filepath);
  } catch (_err) {}
}

function growthUploadCapacityRedirect(req) {
  try {
    ensureDir(GROWTH_ASSET_DIR);
  } catch (err) {
    return `/admin/marketing?error=${encodeURIComponent(err?.message || 'Growth creative storage is not writable.')}`;
  }
  const incomingBytes = contentLengthBytes(req);
  if (!incomingBytes) return '';
  const decision = buildUploadDecision(GROWTH_ASSET_DIR, incomingBytes, { category: 'growth-creative' });
  if (decision.ok) return '';
  return `/admin/marketing?error=${encodeURIComponent(decision.message || 'Storage capacity is too low for this upload.')}`;
}

function uploadedGrowthFileCapacityRedirect(filepath, size) {
  const decision = buildUploadDecision(GROWTH_ASSET_DIR, Number(size || 0), { category: 'growth-creative', alreadyWritten: true });
  if (decision.ok) return '';
  deleteGrowthUploadFile(filepath);
  return `/admin/marketing?error=${encodeURIComponent(decision.message || 'Storage capacity is too low for this upload.')}`;
}

function inferGrowthAssetType(file) {
  const mime = String(file?.mimetype || '').toLowerCase();
  if (mime.startsWith('video/')) return 'real_overlay_clip';
  return 'real_overlay_screenshot';
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

function normalizeTikTokUsername(value = '') {
  return String(value || '')
    .replace(/^@+/, '')
    .replace(/[^A-Za-z0-9._-]/g, '')
    .trim()
    .slice(0, 80);
}

function normalizeAdminEmail(value = '') {
  const email = String(value || '').trim().toLowerCase().slice(0, 220);
  if (!email) return '';
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
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

const growthAssetUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      ensureDir(GROWTH_ASSET_DIR);
      cb(null, GROWTH_ASSET_DIR);
    },
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname || '').toLowerCase();
      const safeExt = GROWTH_ASSET_EXTS.has(ext) ? ext : '.png';
      cb(null, `growth-creative-${Date.now()}-${crypto.randomBytes(6).toString('hex')}${safeExt}`);
    },
  }),
  limits: { fileSize: GROWTH_CREATIVE_UPLOAD_MAX_BYTES },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    const ok = GROWTH_ASSET_EXTS.has(ext) && GROWTH_ASSET_MIMES.has(file.mimetype);
    cb(ok ? null : new Error('Upload a PNG, JPG, WebP, GIF, MP4, WebM, M4V, or MOV creative asset.'), ok);
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

function safeOrigin(value) {
  try {
    return value ? new URL(value).origin : '';
  } catch (_err) {
    return '';
  }
}

function adminRequestOrigin(req) {
  const host = req.get('host');
  return host ? `${req.protocol}://${host}` : '';
}

function isAllowedAdminMutationOrigin(req, value) {
  const origin = safeOrigin(value);
  if (!origin) return false;
  const allowed = new Set([
    adminRequestOrigin(req),
    safeOrigin(process.env.APP_BASE_URL),
  ].filter(Boolean));
  return allowed.has(origin);
}

function requireAdminMutationOrigin(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || req.path === '/login') return next();

  const origin = req.get('origin');
  const referer = req.get('referer');
  if (
    (origin && isAllowedAdminMutationOrigin(req, origin)) ||
    (!origin && referer && isAllowedAdminMutationOrigin(req, referer))
  ) {
    return next();
  }

  if (!origin && !referer && process.env.NODE_ENV !== 'production') return next();
  return res.status(403).send('Admin mutation blocked by same-origin protection.');
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

router.use(requireAdminMutationOrigin);

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
  if (isBetaSubscription(subscription)) return 'beta';
  if (isActiveSubscription(subscription)) return 'paid';
  if (isFullAccessTrialSubscription(subscription, now)) return 'trialBeta';
  return 'free';
}

function classifyAccessCodeTier(code, now = new Date()) {
  if (!isActiveAccessCode(code, now)) return 'inactive';
  if (isPaidAccessCode(code)) return 'paid';
  if (isBetaTesterAccessCode(code)) return 'beta';
  return 'free';
}

function incrementTier(target, tier) {
  if (tier === 'paid') target.paid += 1;
  else if (tier === 'trialBeta') target.trialBeta += 1;
  else if (tier === 'beta' && typeof target.beta === 'number') target.beta += 1;
  else if (tier === 'free') target.free += 1;
}

function strongerTier(current, next) {
  const rank = { free: 1, trialBeta: 2, beta: 2, paid: 3 };
  return (rank[next] || 0) > (rank[current] || 0) ? next : current;
}

function emptyAdminUserMetrics() {
  return {
    accounts: { free: 0, paid: 0, trialBeta: 0, beta: 0, total: 0 },
    live: { free: 0, paid: 0, trialBeta: 0, beta: 0, total: 0, overlays: 0 },
    updatedAt: new Date().toISOString(),
  };
}

function isBetaSubscription(subscription = {}) {
  const text = `${subscription?.plan_type || ''} ${subscription?.status || ''}`.toLowerCase();
  return text.includes('beta');
}

function buildAdminUserMetrics() {
  const metrics = emptyAdminUserMetrics();
  try {
    const now = new Date();
    const users = db.prepare('SELECT id, email, is_active FROM users').all();
    const subscriptions = db.prepare('SELECT * FROM subscriptions ORDER BY updated_at DESC, id DESC').all();
    const codes = db.prepare('SELECT * FROM access_codes').all();
    const userRooms = db.prepare('SELECT room_id, user_id FROM user_rooms').all();
    const latestByUser = latestSubscriptionByUser(subscriptions);
    const userTierById = new Map();
    const roomTierById = new Map();
    const betaUserIds = new Set();
    const betaEmails = new Set();

    codes.forEach(code => {
      if (!isBetaTesterAccessCode(code)) return;
      const userId = Number(code.user_id);
      if (Number.isFinite(userId) && userId > 0) betaUserIds.add(userId);
      const email = String(code.email || '').trim().toLowerCase();
      if (email) betaEmails.add(email);
    });

    users.forEach(user => {
      if (!user?.id || Number(user.is_active) === 0) return;
      const email = String(user.email || '').trim().toLowerCase();
      const isBetaUser = betaUserIds.has(Number(user.id)) || (email && betaEmails.has(email));
      const tier = isBetaUser ? 'beta' : classifySubscriptionTier(latestByUser.get(user.id), now);
      userTierById.set(user.id, tier);
      incrementTier(metrics.accounts, tier);
    });

    codes.forEach(code => {
      const tier = classifyAccessCodeTier(code, now);
      incrementTier(metrics.accounts, tier);
      if (code?.room_id && ['paid', 'trialBeta', 'beta', 'free'].includes(tier)) {
        roomTierById.set(code.room_id, strongerTier(roomTierById.get(code.room_id) || 'free', tier));
      }
    });

    userRooms.forEach(row => {
      if (!row?.room_id || !row?.user_id) return;
      const tier = userTierById.get(row.user_id) || 'free';
      roomTierById.set(row.room_id, strongerTier(roomTierById.get(row.room_id) || 'free', tier));
    });

    metrics.accounts.total = metrics.accounts.free + metrics.accounts.paid + metrics.accounts.trialBeta + metrics.accounts.beta;

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
        s.expires_at,
        ac.code AS access_code,
        ac.code_type AS access_code_type,
        ac.subscription_status AS access_subscription_status,
        ac.tiktok_username AS access_tiktok_username,
        ac.is_revoked AS access_is_revoked,
        ac.is_promo AS access_is_promo
      FROM users u
      LEFT JOIN subscriptions s ON s.id = (
        SELECT id
        FROM subscriptions
        WHERE user_id = u.id
        ORDER BY updated_at DESC, id DESC
        LIMIT 1
      )
      LEFT JOIN access_codes ac ON ac.id = (
        SELECT ac2.id
        FROM access_codes ac2
        WHERE ac2.user_id = u.id
           OR (ac2.email IS NOT NULL AND LOWER(ac2.email) = LOWER(u.email))
        ORDER BY ac2.created_at DESC, ac2.id DESC
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

function adminAccessCodeStatus(code) {
  if (Number(code?.is_revoked) === 1) return 'Revoked';
  const expiresAt = parseAdminDate(code?.expires_at);
  if (expiresAt && expiresAt < new Date()) return 'Expired';
  return 'Active';
}

function adminAccessCodeTypeLabel(code) {
  if (Number(code?.is_promo) === 1) return 'Promo';
  if (isBetaTesterAccessCode(code)) return 'Beta Tester';
  if (isPaidAccessCode(code)) return 'Paid';
  return code?.code_type || code?.subscription_status || 'Free / Trial';
}

function accountTikTokUsername(account = {}) {
  return normalizeTikTokUsername(account.tiktok_username || account.access_tiktok_username || '');
}

function isAdminBetaUser(user = {}) {
  if (!user) return false;
  if (String(user.plan_type || '').toLowerCase().includes('beta')) return true;
  if (String(user.subscription_status || '').toLowerCase().includes('beta')) return true;
  return isBetaTesterAccessCode({
    code: user.access_code,
    email: user.email,
    code_type: user.access_code_type,
    subscription_status: user.access_subscription_status,
    tiktok_username: user.access_tiktok_username,
    is_revoked: user.access_is_revoked,
    is_promo: user.access_is_promo,
  });
}

function renderAccessCodeRows(codes = [], emptyMessage = 'No access codes found.') {
  return codes.map((code) => {
    const status = adminAccessCodeStatus(code);
    const actionLabel = Number(code.is_revoked) === 1 ? 'Enable' : 'Disable';
    const tiktokUsername = normalizeTikTokUsername(code.tiktok_username || '');
    return `<tr>
      <td data-label="Code / Room"><strong>${escapeHtml(code.code)}</strong><br><span class="muted">${escapeHtml(code.room_id ? `Room ${code.room_id}` : 'No room')}</span></td>
      <td data-label="Owner / Email">${escapeHtml(code.owner_name || code.streamer_name || code.email || '')}<br><span class="muted">${escapeHtml(code.email || '')}</span></td>
      <td data-label="TikTok">${escapeHtml(tiktokUsername ? `@${tiktokUsername}` : '')}</td>
      <td data-label="Type">${escapeHtml(adminAccessCodeTypeLabel(code))}<br><span class="muted">${escapeHtml(code.subscription_status || '')}</span></td>
      <td data-label="Status">${escapeHtml(status)}</td>
      <td data-label="Expires">${escapeHtml(formatSponsorDate(code.expires_at))}</td>
      <td data-label="Last Seen">${escapeHtml(formatSponsorDate(code.last_seen))}</td>
      <td data-label="Profile">
        <form method="POST" action="/admin/update-code-profile" class="mini-form">
          <input type="hidden" name="code" value="${escapeAttr(code.code)}" />
          <input name="ownerName" value="${escapeAttr(code.owner_name || '')}" placeholder="Owner" />
          <input name="email" value="${escapeAttr(code.email || '')}" placeholder="Email" />
          <input name="tiktokUsername" value="${escapeAttr(tiktokUsername)}" placeholder="TikTok username" />
          <button type="submit" class="secondary-button">Save Profile</button>
        </form>
      </td>
      <td data-label="Actions">
        <form method="POST" action="/admin/toggle-code">
          <input type="hidden" name="code" value="${escapeAttr(code.code)}" />
          <button type="submit">${actionLabel}</button>
        </form>
        <form method="POST" action="/admin/reset-device">
          <input type="hidden" name="code" value="${escapeAttr(code.code)}" />
          <button type="submit" class="secondary-button">Reset Device</button>
        </form>
      </td>
    </tr>`;
  }).join('') || `<tr><td colspan="9">${escapeHtml(emptyMessage)}</td></tr>`;
}

function renderUserRows(users = [], emptyMessage = 'No users found yet.') {
  return users.map((user) => {
    const verified = Number(user.email_verified) === 1 ? 'Verified' : 'Unverified';
    const active = Number(user.is_active) === 0 ? 'Disabled' : 'Active';
    const plan = user.plan_type || user.subscription_status || user.access_code_type || 'Free / pending';
    const tiktokUsername = accountTikTokUsername(user);
    const beta = isAdminBetaUser(user);
    return `<tr>
      <td data-label="ID">${escapeHtml(String(user.id))}<br><span class="muted">${beta ? 'Beta tester' : 'Standard'}</span></td>
      <td data-label="Email / Name"><strong>${escapeHtml(user.email || '')}</strong><br><span class="muted">${escapeHtml(user.name || '')}</span></td>
      <td data-label="TikTok">${escapeHtml(tiktokUsername ? `@${tiktokUsername}` : '')}</td>
      <td data-label="Plan">${escapeHtml(plan)}${user.access_code ? `<br><span class="muted">Code ${escapeHtml(user.access_code)}</span>` : ''}</td>
      <td data-label="Status">${escapeHtml(`${active} / ${verified}`)}</td>
      <td data-label="Created">${escapeHtml(formatSponsorDate(user.created_at))}</td>
      <td data-label="Last Login">${escapeHtml(formatSponsorDate(user.last_login))}</td>
    </tr>`;
  }).join('') || `<tr><td colspan="7">${escapeHtml(emptyMessage)}</td></tr>`;
}

function renderAdminPage({ message = '', error = '', createdCode = '', codes = [], promos = [], roomRequirementEnabled = true, userMetrics = buildAdminUserMetrics(), users = [], comments = [], liveActivity = buildAdminLiveActivity() } = {}) {
  const betaCodes = codes.filter(code => isBetaTesterAccessCode(code));
  const standardCodes = codes.filter(code => !isBetaTesterAccessCode(code));
  const betaUsers = users.filter(isAdminBetaUser);
  const standardUsers = users.filter(user => !isAdminBetaUser(user));
  const codeRows = renderAccessCodeRows(standardCodes, 'No standard access codes found.');
  const betaCodeRows = renderAccessCodeRows(betaCodes, 'No beta tester access codes found.');

  const promoRows = promos.map((promo) => {
    return `<tr>
      <td data-label="Promo">${escapeHtml(promo.code)}</td>
      <td data-label="Uses">${escapeHtml(String(promo.uses_remaining))}</td>
      <td data-label="Days">${escapeHtml(String(promo.days_granted))}</td>
      <td data-label="Expires">${escapeHtml(promo.expires_at || 'Never')}</td>
      <td data-label="Created">${escapeHtml(promo.created_at)}</td>
    </tr>`;
  }).join('');
  const userRows = renderUserRows(standardUsers, 'No standard user accounts found yet.');
  const betaUserRows = renderUserRows(betaUsers, 'No beta tester user accounts found yet.');
  const commentRows = comments.map((comment) => {
    return `<tr>
      <td data-label="Created">${escapeHtml(formatSponsorDate(comment.created_at))}</td>
      <td data-label="Name"><strong>${escapeHtml(comment.name || 'Creator')}</strong><br><span class="muted">${escapeHtml(comment.role || 'TikTok LIVE creator')}</span></td>
      <td data-label="Email">${escapeHtml(comment.email || '')}</td>
      <td data-label="Comment">${escapeHtml(comment.comment || '')}</td>
      <td data-label="Action">
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
      <td data-label="Room"><strong>${escapeHtml(item.roomId)}</strong><br><span class="muted">${escapeHtml(owner.accountType || 'Room')}</span></td>
      <td data-label="Owner"><strong>${escapeHtml(owner.email || owner.name || 'Unknown owner')}</strong><br><span class="muted">${escapeHtml(owner.tiktok ? `@${owner.tiktok}` : owner.plan || '')}</span></td>
      <td data-label="Stream">${escapeHtml(item.streamerUsername ? `@${item.streamerUsername}` : '')}<br><span class="muted">${escapeHtml(status)} - ${escapeHtml(lastEvent)}</span></td>
      <td data-label="Overlays">${escapeHtml(String(item.overlayCount))}</td>
      <td data-label="Players">${escapeHtml(String(item.playerCount))}</td>
      <td data-label="Top players">${escapeHtml(topPlayers || 'No active players')}</td>
    </tr>`;
  }).join('') || '<tr data-live-empty><td colspan="6">No live room activity right now.</td></tr>';
  const metrics = userMetrics || emptyAdminUserMetrics();
  const metricCards = [
    adminMetricCard('Free accounts', 'accounts.free', metrics.accounts.free, 'Active free creator accounts and free access-code rooms'),
    adminMetricCard('Paid accounts', 'accounts.paid', metrics.accounts.paid, 'Active Creator Pro users and paid access codes'),
    adminMetricCard('Trial accounts', 'accounts.trialBeta', metrics.accounts.trialBeta, 'Real 7-day full-access trial accounts only'),
    adminMetricCard('Beta testers', 'accounts.beta', metrics.accounts.beta || betaCodes.length + betaUsers.length, 'Dedicated beta tester access codes and accounts, separated from trials'),
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
    .control-panel { min-width:0; padding:16px; border-radius:18px; border:1px solid rgba(255,255,255,.1); background:rgba(0,0,0,.2); }
    .control-panel h2 { margin:0 0 12px; font-size:18px; }
    .section-grid { display:grid; gap:14px; }
    .admin-section { padding:0; overflow:hidden; }
    .admin-section summary { list-style:none; display:flex; align-items:center; justify-content:space-between; gap:12px; padding:18px 20px; cursor:pointer; }
    .admin-section summary::-webkit-details-marker { display:none; }
    .admin-section summary span { color:#fff8e6; font-size:20px; font-weight:900; }
    .admin-section summary small { color:#a8afbf; font-size:12px; font-weight:800; line-height:1.4; text-align:right; }
    .admin-section summary::after { content:"Open"; min-width:58px; min-height:28px; display:inline-flex; align-items:center; justify-content:center; border-radius:999px; color:#ffdf8a; background:rgba(246,201,91,.08); border:1px solid rgba(246,201,91,.22); font-size:11px; font-weight:900; text-transform:uppercase; }
    .admin-section[open] summary::after { content:"Hide"; }
    .section-body { padding:0 20px 20px; }
    label { display: block; margin: 10px 0 6px; color: #a8afbf; font-size: 12px; font-weight:900; letter-spacing:.08em; text-transform:uppercase; }
    input, select { width: 100%; min-height:46px; padding: 10px 12px; border-radius: 14px; border: 1px solid rgba(255,255,255,0.12); background: #111827; color: #fff8e6; }
    select option, select optgroup { background:#111827; color:#fff8e6; }
    input[type="checkbox"] { width:auto; min-height:0; margin-right:8px; }
    button { margin-top: 12px; width: 100%; min-height:44px; padding: 0 14px; border: none; border-radius: 14px; background: linear-gradient(135deg,#f6c95b,#fff0b9 52%,#ff6a3d); color: #170c02; cursor: pointer; font-weight: 900; }
    .danger-button { background: rgba(232,59,95,.16); color:#ffb7c1; border:1px solid rgba(232,59,95,.32); }
    .secondary-button { background: rgba(255,255,255,.07); color:#fff8e6; border:1px solid rgba(255,255,255,.12); }
    .mini-form { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:8px; min-width:260px; }
    .mini-form input { min-height:38px; padding:8px 10px; border-radius:10px; font-size:12px; }
    .mini-form button { grid-column:1 / -1; min-height:36px; margin-top:0; }
    .table-shell { width:100%; overflow-x:auto; }
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
    @media(max-width:720px){ body{padding:12px}.admin-hero{align-items:flex-start;flex-direction:column}.admin-brand img{width:46px;height:46px}.admin-nav{width:100%;display:grid;grid-template-columns:1fr 1fr}.admin-nav a{padding:0 10px}.metrics-grid{grid-template-columns:1fr 1fr}.metrics-footnote{text-align:left}.mini-form{grid-template-columns:1fr;min-width:0}.admin-section summary{align-items:flex-start;flex-direction:column}.admin-section summary small{text-align:left}.admin-section summary::after{align-self:flex-start}.section-body{padding:0 12px 14px}.grid{grid-template-columns:1fr} table,thead,tbody,tr,th,td{display:block} thead{display:none} tr{border:1px solid rgba(255,255,255,.08); border-radius:16px; margin-bottom:12px; overflow:hidden} td{border-bottom:1px solid rgba(255,255,255,.06)} td::before{content:attr(data-label);display:block;margin-bottom:4px;color:#ffdf8a;font-size:10px;font-weight:900;text-transform:uppercase;letter-spacing:.08em} }
    @media(max-width:420px){ .metrics-grid{grid-template-columns:1fr}.admin-nav{grid-template-columns:1fr} }
  </style>
</head>
<body>
  <div class="wrapper">
    <header class="admin-hero">
      <div class="admin-brand">
        <img src="/intothebattlelogo_logo_only.svg" alt="IntoTheBattle logo" />
        <div><h1>Admin Panel</h1><p>Access, promos, and room controls</p></div>
      </div>
      <div class="admin-nav"><a href="/admin">Access Codes</a><a href="/admin/sponsors">Video Platform</a><a href="/admin/marketing">Company Growth</a><a href="/admin/blog">Blog Posts</a><a href="/admin/logout">Logout</a></div>
    </header>
    ${message ? `<div class="notice success">${escapeHtml(message)}</div>` : ''}
    ${createdCode ? `<div class="notice success">New access code created: <strong>${escapeHtml(createdCode)}</strong> <button type="button" onclick="navigator.clipboard.writeText('${escapeHtml(createdCode)}')">Copy</button></div>` : ''}
    ${error ? `<div class="notice error">${escapeHtml(error)}</div>` : ''}
    <section class="metrics-grid" aria-label="User and live room counts">
      ${metricCards}
    </section>
    <div class="metrics-footnote">Counts refresh every 15 seconds. Last updated <span data-count-key="updatedAt">${escapeHtml(formatSponsorDate(metrics.updatedAt))}</span>.</div>
    <details class="card admin-section">
      <summary><span>Account controls</span><small>Issue access, extend users, revoke or reset devices, change room mode, and create promo codes.</small></summary>
      <div class="section-body">
        <div class="grid">
          <div class="control-panel">
        <h2>Issue access code</h2>
        <form method="POST" action="/admin/issue-code">
          <label>Name (optional, stored for tracking only)</label>
          <input name="name" type="text" placeholder="Customer or buyer name" />
          <label>Email (optional)</label>
          <input name="email" type="email" placeholder="creator@example.com" />
          <label>TikTok username (optional)</label>
          <input name="tiktokUsername" type="text" placeholder="creatorhandle" />
          <label>Days</label>
          <input name="days" type="number" min="0" value="30" />
          <label><input name="permanent" type="checkbox" value="1" /> Permanent code (no expiry)</label>
          <button type="submit">Issue Code</button>
        </form>
          </div>
          <div class="control-panel">
        <h2>Extend code</h2>
        <form method="POST" action="/admin/extend-code">
          <label>Access code</label>
          <input name="code" type="text" required />
          <label>Days to add</label>
          <input name="days" type="number" min="1" value="30" required />
          <button type="submit">Extend</button>
        </form>
          </div>
          <div class="control-panel">
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
          <div class="control-panel">
        <h2>Room ID requirement</h2>
        <p>Current behavior: <strong>${roomRequirementEnabled ? 'Room ID required' : 'Room ID not required'}</strong></p>
        <form method="POST" action="/admin/toggle-room-requirement">
          <button type="submit">${roomRequirementEnabled ? 'Disable room ID requirement' : 'Enable room ID requirement'}</button>
        </form>
          </div>
          <div class="control-panel">
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
      </div>
    </details>
    <section class="section-grid" aria-label="Admin data sections">
      <details class="card admin-section" open>
        <summary><span>Live room activity</span><small>Fast room-scoped audit for active overlays and player leakage.</small></summary>
        <div class="section-body table-shell">
          <table>
            <thead><tr><th>Room</th><th>Owner</th><th>Stream</th><th>Overlays</th><th>Players</th><th>Top players</th></tr></thead>
            <tbody id="liveActivityRows">${liveActivityRows}</tbody>
          </table>
        </div>
      </details>
      <details class="card admin-section">
        <summary><span>Standard access codes</span><small>Paid, trial, promo, and standard creator access.</small></summary>
        <div class="section-body table-shell">
          <table>
            <thead><tr><th>Code / Room</th><th>Owner / Email</th><th>TikTok</th><th>Type</th><th>Status</th><th>Expires</th><th>Last Seen</th><th>Profile</th><th>Actions</th></tr></thead>
            <tbody>${codeRows}</tbody>
          </table>
        </div>
      </details>
      <details class="card admin-section">
        <summary><span>Beta tester access codes</span><small>Dedicated beta access separated from paid operations.</small></summary>
        <div class="section-body table-shell">
          <table>
            <thead><tr><th>Code / Room</th><th>Owner / Email</th><th>TikTok</th><th>Type</th><th>Status</th><th>Expires</th><th>Last Seen</th><th>Profile</th><th>Actions</th></tr></thead>
            <tbody>${betaCodeRows}</tbody>
          </table>
        </div>
      </details>
      <details class="card admin-section">
        <summary><span>Creator accounts</span><small>Newest non-beta accounts with email, TikTok handle, plan, and login status.</small></summary>
        <div class="section-body table-shell">
          <table>
            <thead><tr><th>ID</th><th>Email / Name</th><th>TikTok</th><th>Plan</th><th>Status</th><th>Created</th><th>Last Login</th></tr></thead>
            <tbody>${userRows}</tbody>
          </table>
        </div>
      </details>
      <details class="card admin-section">
        <summary><span>Beta tester accounts</span><small>Registered users linked to beta tester codes or beta status.</small></summary>
        <div class="section-body table-shell">
          <table>
            <thead><tr><th>ID</th><th>Email / Name</th><th>TikTok</th><th>Plan</th><th>Status</th><th>Created</th><th>Last Login</th></tr></thead>
            <tbody>${betaUserRows}</tbody>
          </table>
        </div>
      </details>
      <details class="card admin-section">
        <summary><span>Promo codes</span><small>Reusable offer codes and remaining redemptions.</small></summary>
        <div class="section-body table-shell">
          <table>
            <thead><tr><th>Promo</th><th>Uses</th><th>Days</th><th>Expires</th><th>Created</th></tr></thead>
            <tbody>${promoRows}</tbody>
          </table>
        </div>
      </details>
      <details class="card admin-section">
        <summary><span>Homepage comments</span><small>Public comments shown in the homepage scroll.</small></summary>
        <div class="section-body table-shell">
          <table>
            <thead><tr><th>Created</th><th>Name</th><th>Email</th><th>Comment</th><th>Action</th></tr></thead>
            <tbody>${commentRows}</tbody>
          </table>
        </div>
      </details>
    </section>
    <div style="margin-top: 18px;">
      <a href="/admin/logout">Logout</a>
    </div>
  </div>
  <script>
    const countKeys = {
      'accounts.free': data => data.accounts && data.accounts.free,
      'accounts.paid': data => data.accounts && data.accounts.paid,
      'accounts.trialBeta': data => data.accounts && data.accounts.trialBeta,
      'accounts.beta': data => data.accounts && data.accounts.beta,
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
          + '<td data-label="Room"><strong>' + escapeCell(item.roomId) + '</strong><br><span class="muted">' + escapeCell(owner.accountType || 'Room') + '</span></td>'
          + '<td data-label="Owner"><strong>' + escapeCell(owner.email || owner.name || 'Unknown owner') + '</strong><br><span class="muted">' + escapeCell(owner.tiktok ? '@' + owner.tiktok : owner.plan || '') + '</span></td>'
          + '<td data-label="Stream">' + escapeCell(item.streamerUsername ? '@' + item.streamerUsername : '') + '<br><span class="muted">' + escapeCell(status + ' - ' + lastEvent) + '</span></td>'
          + '<td data-label="Overlays">' + escapeCell(item.overlayCount) + '</td>'
          + '<td data-label="Players">' + escapeCell(item.playerCount) + '</td>'
          + '<td data-label="Top players">' + escapeCell(players) + '</td>'
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
  const email = normalizeAdminEmail(req.body.email || '');
  if (email === null) return res.redirect(`/admin?error=${encodeURIComponent('Enter a valid email address')}`);
  const tiktokUsername = normalizeTikTokUsername(req.body.tiktokUsername || '') || null;
  const days = Number(req.body.days);
  const permanent = req.body.permanent === '1';
  const code = uuidv4().replace(/-/g, '').toUpperCase();
  const expiresAt = permanent
    ? '2099-12-31 23:59:59'
    : new Date(Date.now() + Math.max(1, days || 30) * 24 * 60 * 60 * 1000)
      .toISOString().slice(0, 19).replace('T', ' ');

  const roomId = Math.random().toString(36).slice(2, 10);
  db.prepare('INSERT INTO access_codes (code, owner_name, email, tiktok_username, expires_at, room_id) VALUES (?, ?, ?, ?, ?, ?)')
    .run(code, ownerName, email || null, tiktokUsername, expiresAt, roomId);
  res.redirect(`/admin?message=${encodeURIComponent('Issued new access code')}&createdCode=${encodeURIComponent(code)}`);
});

router.post('/update-code-profile', requireAdminAuth, (req, res) => {
  const code = String(req.body.code || '').trim().toUpperCase();
  const row = db.prepare('SELECT * FROM access_codes WHERE code = ?').get(code);
  if (!row) return res.redirect(`/admin?error=${encodeURIComponent('Code not found')}`);

  const ownerName = String(req.body.ownerName || '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 140) || null;
  const email = normalizeAdminEmail(req.body.email || '');
  if (email === null) return res.redirect(`/admin?error=${encodeURIComponent('Enter a valid email address')}`);
  const tiktokUsername = normalizeTikTokUsername(req.body.tiktokUsername || '') || null;
  db.prepare(`
    UPDATE access_codes
    SET owner_name = ?,
        email = ?,
        streamer_name = COALESCE(NULLIF(streamer_name, ''), ?),
        tiktok_username = ?
    WHERE id = ?
  `).run(ownerName, email || null, ownerName, tiktokUsername, row.id);
  res.redirect(`/admin?message=${encodeURIComponent(`Updated profile for ${code}`)}`);
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

function buildBlogPayload(body = {}) {
  return {
    title: String(body.title || '').trim(),
    slug: String(body.slug || '').trim(),
    summary: String(body.summary || '').trim(),
    contentHtml: String(body.contentHtml || '').trim(),
    status: String(body.status || 'draft').trim(),
    publishedAt: normalizePostDateInput(body.publishedAt),
    seoTitle: String(body.seoTitle || '').trim(),
    seoDescription: String(body.seoDescription || '').trim(),
    seoKeywords: String(body.seoKeywords || '').trim(),
  };
}

function buildBlogListMessage(summary = {}) {
  const created = Number(summary.created?.length || 0);
  const updated = Number(summary.updated?.length || 0);
  const skipped = Number(summary.skipped?.length || 0);
  const messageParts = [];
  if (created) messageParts.push(`created ${created}`);
  if (updated) messageParts.push(`updated ${updated}`);
  if (skipped) messageParts.push(`skipped ${skipped}`);
  if (!messageParts.length) return 'No draft changes were needed.';
  return `Blog generation complete: ${messageParts.join(', ')}.`;
}

function buildBlogPushMessage(summary = {}) {
  const attempted = Number(summary.attempted || 0);
  const posted = Number(summary.posted || 0);
  const failed = Number(summary.failed || 0);
  const skipped = Number(summary.skipped || 0);
  if (!attempted && !skipped) return 'No site-context drafts are waiting to post.';
  return `Site-context posting complete: posted ${posted}, failed ${failed}, skipped ${skipped}.`;
}

async function pushSiteContextBlogDrafts({ limit = 10 } = {}) {
  const safeLimit = Math.max(1, Math.min(25, Number(limit) || 10));
  const posts = listBlogPosts({ source: 'site-context', sort: 'updated', limit: 120 })
    .filter(post => ['draft', 'queued'].includes(String(post.status || '').toLowerCase()))
    .slice(0, safeLimit);
  const summary = { attempted: posts.length, posted: 0, failed: 0, skipped: 0, errors: [] };

  for (const post of posts) {
    try {
      const result = await pushBlogPostToWritefreely(post.id);
      if (result.ok) summary.posted += 1;
      else {
        summary.failed += 1;
        summary.errors.push(`${post.title || post.slug}: ${result.error || 'WriteFreely push failed'}`);
      }
    } catch (err) {
      summary.failed += 1;
      summary.errors.push(`${post.title || post.slug}: ${err?.message || 'WriteFreely push failed'}`);
    }
  }

  return summary;
}

router.get('/blog', requireAdminAuth, (req, res) => {
  const status = String(req.query.status || '').trim().toLowerCase();
  const source = String(req.query.source || '').trim().toLowerCase();
  const sort = String(req.query.sort || 'updated').trim().toLowerCase() === 'published' ? 'published' : 'updated';
  try {
    res.send(renderBlogAdminPage({
      message: String(req.query.message || ''),
      error: String(req.query.error || ''),
      posts: listBlogPosts({ status, source, sort, limit: 120 }),
    }));
  } catch (err) {
    res.status(500).send(renderBlogAdminPage({
      error: err?.message || 'Blog admin page failed to load',
      posts: [],
    }));
  }
});

router.get('/blog/manual', requireAdminAuth, (req, res) => {
  res.send(renderWritefreelyPosterPage({
    message: String(req.query.message || ''),
    error: String(req.query.error || ''),
  }));
});

router.post('/blog/manual', requireAdminAuth, async (req, res) => {
  const payload = buildBlogPayload(req.body);
  try {
    const created = createBlogPost({
      ...payload,
      source: 'manual',
      sourceKey: req.body.sourceKey || '',
    });
    if (req.body.push === '1') {
      const pushResult = await pushBlogPostToWritefreely(created.id);
      if (!pushResult.ok) {
        return res.send(renderWritefreelyPosterPage({
          message: `Created ${created.title || 'post'} but push failed.`,
          error: pushResult.error || 'Failed to push post.',
          post: created,
        }));
      }
      return res.redirect(`/admin/blog/manual?message=${encodeURIComponent(`${created.title || 'Post'} created and pushed to WriteFreely`)}`);
    }
    return res.redirect(`/admin/blog?message=${encodeURIComponent(`${created.title || 'Post'} created`)}`);
  } catch (err) {
    res.send(renderWritefreelyPosterPage({
      error: err?.message || 'Failed to create post',
      post: payload.slug ? { ...payload } : null,
    }));
  }
});

router.post('/blog/site-context/push', requireAdminAuth, async (req, res) => {
  const cfg = writefreelyPublishConfig();
  if (!cfg.enabled) {
    return res.redirect(`/admin/blog?error=${encodeURIComponent('WriteFreely is not configured. Set WRITEFREELY_API_TOKEN or WRITEFREELY_USERNAME/WRITEFREELY_PASSWORD.')}`);
  }
  try {
    const summary = await pushSiteContextBlogDrafts({ limit: req.body.limit });
    const message = buildBlogPushMessage(summary);
    const errorSuffix = summary.errors.length ? ` First error: ${summary.errors[0]}` : '';
    return res.redirect(`/admin/blog?${summary.failed ? 'error' : 'message'}=${encodeURIComponent(`${message}${errorSuffix}`)}`);
  } catch (err) {
    return res.redirect(`/admin/blog?error=${encodeURIComponent(err?.message || 'Failed to post site-context drafts')}`);
  }
});

router.post('/blog/site-context/generate-and-push', requireAdminAuth, async (req, res) => {
  const cfg = writefreelyPublishConfig();
  if (!cfg.enabled) {
    return res.redirect(`/admin/blog?error=${encodeURIComponent('WriteFreely is not configured. Set WRITEFREELY_API_TOKEN or WRITEFREELY_USERNAME/WRITEFREELY_PASSWORD.')}`);
  }
  try {
    const generation = generateBlogDraftsFromSiteContext({ force: String(req.body.force || '0') === '1' });
    const pushSummary = await pushSiteContextBlogDrafts({ limit: req.body.limit });
    const message = `${buildBlogListMessage(generation)} ${buildBlogPushMessage(pushSummary)}`;
    const errorSuffix = pushSummary.errors.length ? ` First error: ${pushSummary.errors[0]}` : '';
    return res.redirect(`/admin/blog?${pushSummary.failed ? 'error' : 'message'}=${encodeURIComponent(`${message}${errorSuffix}`)}`);
  } catch (err) {
    return res.redirect(`/admin/blog?error=${encodeURIComponent(err?.message || 'Failed to generate and post site-context drafts')}`);
  }
});

router.get('/blog/:id/edit', requireAdminAuth, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) {
    return res.redirect('/admin/blog?error=Invalid%20post%20id');
  }
  const post = getBlogPostById(id);
  if (!post) {
    return res.redirect('/admin/blog?error=Post%20not%20found');
  }
  res.send(renderWritefreelyPosterPage({
    message: String(req.query.message || ''),
    error: String(req.query.error || ''),
    post,
  }));
});

router.post('/blog/:id/update', requireAdminAuth, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) {
    return res.redirect('/admin/blog?error=Invalid%20post%20id');
  }
  try {
    const payload = buildBlogPayload(req.body);
    const updated = updateBlogPost(id, payload);
    const title = updated?.title || `Post #${id}`;
    return res.redirect(`/admin/blog/${encodeURIComponent(id)}/edit?message=${encodeURIComponent(`${title} updated`)}`);
  } catch (err) {
    return res.redirect(`/admin/blog/${encodeURIComponent(id)}/edit?error=${encodeURIComponent(err?.message || 'Failed to update post')}`);
  }
});

router.post('/blog/:id/push', requireAdminAuth, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) {
    return res.redirect('/admin/blog?error=Invalid%20post%20id');
  }
  try {
    const result = await pushBlogPostToWritefreely(id);
    const post = getBlogPostById(id);
    const postTitle = (post && post.title) || `Post #${id}`;
    if (!result.ok) {
      return res.redirect(`/admin/blog?error=${encodeURIComponent(`Failed to push ${postTitle}: ${result.error || 'WriteFreely push failed'}`)}`);
    }
    return res.redirect(`/admin/blog?message=${encodeURIComponent(`${postTitle} pushed to WriteFreely`)}`);
  } catch (err) {
    return res.redirect(`/admin/blog?error=${encodeURIComponent(err?.message || 'Failed to push post')}`);
  }
});

router.post('/blog/:id/status', requireAdminAuth, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) {
    return res.redirect('/admin/blog?error=Invalid%20post%20id');
  }
  const status = String(req.body.status || '').trim();
  try {
    const updated = setBlogPostStatus(id, status);
    const postTitle = (updated && updated.title) || `Post #${id}`;
    return res.redirect(`/admin/blog?message=${encodeURIComponent(`${postTitle} status set to ${updated?.status || status}`)}`);
  } catch (err) {
    return res.redirect(`/admin/blog?error=${encodeURIComponent(err?.message || 'Failed to update post status')}`);
  }
});

router.post('/blog/:id/delete', requireAdminAuth, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) {
    return res.redirect('/admin/blog?error=Invalid%20post%20id');
  }
  try {
    const deleted = deleteBlogPost(id);
    return res.redirect(`/admin/blog?message=${encodeURIComponent(`Deleted ${deleted?.title || 'post'}`)}`);
  } catch (err) {
    return res.redirect(`/admin/blog?error=${encodeURIComponent(err?.message || 'Failed to delete post')}`);
  }
});

router.post('/blog/generate', requireAdminAuth, (req, res) => {
  const force = String(req.body.force || '0') === '1';
  try {
    const summary = generateBlogDraftsFromSiteContext({ force });
    const message = buildBlogListMessage(summary);
    return res.redirect(`/admin/blog?message=${encodeURIComponent(message)}`);
  } catch (err) {
    return res.redirect(`/admin/blog?error=${encodeURIComponent(err?.message || 'Failed to generate blog drafts')}`);
  }
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

function normalizePostDateInput(value) {
  const date = parseDateTimeLocal(value);
  return date || null;
}

function renderBlogPostRows(posts = []) {
  return posts.map((post) => {
    const status = String(post.status || 'draft');
    const source = String(post.source || 'manual');
    const statusClass = status === 'published' ? 'published' : status === 'queued' ? 'queued' : status === 'archived' ? 'archived' : 'draft';
    const summary = String(post.summary || '').slice(0, 220);
    const pushState = post.writefreelyLastPushError ? `Failed: ${post.writefreelyLastPushError}` : (post.writefreelyLastPushAt ? `Posted ${formatSponsorDate(post.writefreelyLastPushAt)}` : 'Not posted');
    const writefreelyLink = post.writefreelyPostUrl
      ? `<br /><a class="mini-link" href="${escapeAttr(post.writefreelyPostUrl)}" target="_blank" rel="noopener noreferrer">Open WriteFreely post</a>`
      : '';
    return `<tr>
      <td data-label="Title"><strong>${escapeHtml(post.title || 'Untitled')}</strong><br /><small>${escapeHtml(post.slug || '')}</small></td>
      <td data-label="Source">
        <strong>${escapeHtml(source)}</strong><br />
        <small>Created: ${escapeHtml(formatSponsorDate(post.createdAt))}</small><br />
        <small>Updated: ${escapeHtml(formatSponsorDate(post.updatedAt))}</small>
      </td>
      <td data-label="Status"><span class="status-pill ${escapeAttr(statusClass)}">${escapeHtml(status)}</span></td>
      <td data-label="Summary">${escapeHtml(summary)}</td>
      <td data-label="Publish">${escapeHtml(post.publishedAt ? formatSponsorDate(post.publishedAt) : 'Draft')}</td>
      <td data-label="Writer">${escapeHtml(pushState)}${writefreelyLink}</td>
      <td data-label="Actions">
        <div class="actions-grid">
          <a class="text-link" href="/admin/blog/${escapeAttr(post.id)}/edit">Open editor</a>
          <form method="POST" action="/admin/blog/${escapeAttr(post.id)}/push"><button type="submit">Post WriteFreely</button></form>
          <form method="POST" action="/admin/blog/${escapeAttr(post.id)}/status">
            <input type="hidden" name="status" value="${status === 'published' ? 'archived' : 'published'}" />
            <button type="submit">${status === 'published' ? 'Archive' : 'Publish locally'}</button>
          </form>
          <form method="POST" action="/admin/blog/${escapeAttr(post.id)}/status">
            <input type="hidden" name="status" value="${status === 'draft' ? 'queued' : 'draft'}" />
            <button type="submit">${status === 'draft' ? 'Queue' : 'Move to draft'}</button>
          </form>
          <form method="POST" action="/admin/blog/${escapeAttr(post.id)}/delete" onsubmit="return confirm('Delete this post permanently?')">
            <button class="danger" type="submit">Delete</button>
          </form>
        </div>
      </td>
    </tr>`;
  }).join('') || '<tr><td colspan="7">No blog posts yet.</td></tr>';
}

function renderBlogPostForm(post = null) {
  const editing = Boolean(post && post.id);
  const safePost = post || {};
  const status = String(safePost.status || 'draft');
  const options = ['draft', 'queued', 'published', 'archived']
    .map(value => `<option value="${escapeAttr(value)}" ${status === value ? 'selected' : ''}>${escapeHtml(value)}</option>`)
    .join('');
  const action = editing ? `/admin/blog/${safePost.id}/update` : '/admin/blog/manual';
  const heading = editing ? `Edit ${escapeHtml(safePost.slug || 'post')}` : 'Create draft post';
  return `
      <section class="card admin-section">
        <h3>${escapeHtml(heading)}</h3>
        <div class="section-body">
          <form method="POST" action="${action}" class="edit-form">
            <label>Title</label>
            <input name="title" value="${escapeAttr(safePost.title || '')}" required />
            <label>Slug</label>
            <input name="slug" value="${escapeAttr(safePost.slug || '')}" required />
            <label>Summary</label>
            <textarea name="summary" maxlength="260" required>${escapeHtml(safePost.summary || '')}</textarea>
            <label>Content HTML</label>
            <textarea name="contentHtml" required>${escapeHtml(safePost.contentHtml || '')}</textarea>
            <div class="inline-grid compact">
              <span><label>Status</label><select name="status">${options}</select></span>
              <span><label>Published at</label><input name="publishedAt" type="datetime-local" value="${escapeAttr(formatDateTimeInput(safePost.publishedAt))}" /></span>
            </div>
            <label>SEO title</label>
            <input name="seoTitle" value="${escapeAttr(safePost.seoTitle || safePost.title || '')}" />
            <label>SEO description</label>
            <textarea name="seoDescription" maxlength="240">${escapeHtml(safePost.seoDescription || '')}</textarea>
            <label>SEO keywords</label>
            <input name="seoKeywords" value="${escapeAttr(safePost.seoKeywords || '')}" />
            <button type="submit">${editing ? 'Save changes' : 'Create draft'}</button>
            ${editing ? '' : '<button type="submit" name="push" value="1" class="secondary">Create and post to WriteFreely</button>'}
          </form>
          ${editing ? `<form method="POST" action="/admin/blog/${escapeAttr(safePost.id)}/push" class="edit-form"><button type="submit" class="secondary">Post saved version to WriteFreely</button></form>` : ''}
        </div>
      </section>
  `;
}

function renderWritefreelyPosterPage({
  message = '',
  error = '',
  post = null,
} = {}) {
  const writefreelyCfg = writefreelyPublishConfig();
  const canPush = writefreelyCfg.enabled;
  const dashboardLink = writefreelyCfg.dashboardUrl || '';
  const methodLabel = writefreelyCfg.publishMethod === 'direct-api'
    ? `Direct API (${writefreelyCfg.collectionAlias})`
    : writefreelyCfg.publishMethod === 'webhook'
      ? 'Legacy webhook'
      : 'Not configured';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Manual Blog Poster - Admin</title>
  <style>
    * { box-sizing: border-box; }
    body { min-height:100vh; font-family:Inter,Arial,sans-serif; color:#fff8e6; background:radial-gradient(circle at 16% 0,rgba(246,201,91,.18),transparent 30%),radial-gradient(circle at 88% 12%,rgba(232,59,95,.14),transparent 28%),linear-gradient(180deg,#050608,#030406); margin:0; padding:24px; }
    body::before { content:""; position:fixed; inset:0; pointer-events:none; background-image:linear-gradient(rgba(246,201,91,.035) 1px,transparent 1px),linear-gradient(90deg,rgba(246,201,91,.035) 1px,transparent 1px); background-size:58px 58px; mask-image:radial-gradient(circle at top,black,transparent 72%); z-index:-1; }
    .wrapper { max-width: 1080px; margin: 0 auto; display:grid; gap:18px; }
    .admin-hero { display:flex; align-items:center; justify-content:space-between; gap:18px; padding:16px; border:1px solid rgba(246,201,91,.24); border-radius:18px; background:rgba(5,7,11,.78); }
    .admin-hero h1 { margin:0; font-size:clamp(28px,4vw,44px); line-height:1; text-transform:uppercase; }
    .admin-nav { display:flex; gap:10px; flex-wrap:wrap; }
    .admin-nav a { min-height:38px; display:inline-flex; align-items:center; justify-content:center; padding:0 12px; border-radius:999px; border:1px solid rgba(255,255,255,.1); background:rgba(255,255,255,.055); color:#fff8e6; }
    .notice { padding:12px 14px; border-radius:12px; border:1px solid rgba(255,255,255,.12); }
    .error { color:#ffb6b6; }
    .success { color:#c6ffc3; }
    .admin-section, .panel { background:linear-gradient(180deg,rgba(255,255,255,.065),rgba(255,255,255,.025)); border:1px solid rgba(255,255,255,.1); border-radius:20px; padding:18px; }
    h2 { margin:0 0 12px; font-size:20px; }
    label { display:block; margin:10px 0 6px; color:#a8afbf; font-size:12px; font-weight:900; text-transform:uppercase; }
    input, textarea, select { width:100%; min-height:44px; padding:10px 12px; border-radius:12px; border:1px solid rgba(255,255,255,0.12); background:#111827; color:#fff8e6; }
    textarea { min-height:140px; resize:vertical; }
    .edit-form .inline-grid { display:grid; grid-template-columns:1fr 1fr; gap:12px; }
    button { margin-top:12px; width:100%; min-height:40px; border:none; border-radius:12px; background:linear-gradient(135deg,#f6c95b,#fff0b9 52%,#ff6a3d); color:#170c02; cursor:pointer; font-weight:800; }
    button.secondary { background:rgba(255,255,255,.07); color:#fff8e6; border:1px solid rgba(255,255,255,.12); }
    .muted { color:#a8afbf; }
    .field-note { color:#9ec7ff; margin:8px 0 0; font-size:12px; }
    .status { margin-top: 8px; display:flex; gap:10px; flex-wrap:wrap; }
    .status span { display:inline-flex; min-height:30px; align-items:center; padding:0 10px; border-radius:999px; border:1px solid rgba(255,255,255,.12); background:rgba(255,255,255,.06); font-size:12px; text-transform:uppercase; color:#9fefff; }
  </style>
</head>
<body>
  <div class="wrapper">
    <header class="admin-hero">
      <h1>Manual WriteFreely Poster</h1>
      <div class="admin-nav">
        <a href="/admin">Access Codes</a>
        <a href="/admin/sponsors">Video Platform</a>
        <a href="/admin/marketing">Company Growth</a>
        <a href="/admin/blog">Blog Posts</a>
        <a href="/admin/logout">Logout</a>
      </div>
    </header>
    ${message ? `<div class="notice success">${escapeHtml(message)} </div>` : ''}
    ${error ? `<div class="notice error">${escapeHtml(error)} </div>` : ''}
    <section class="panel">
      <h2>WriteFreely bridge</h2>
      <p class="muted">Create a local blog post, then send the same post to WriteFreely when API credentials or a webhook are configured.</p>
      <p class="status">
        <span>${canPush ? 'Enabled' : 'Disabled'}</span>
        <span>${escapeHtml(methodLabel)}</span>
      </p>
      <p class="field-note">API: ${escapeHtml(writefreelyCfg.apiUrl || 'Missing API URL')}</p>
      ${dashboardLink ? `<p class="field-note">Dashboard: <a class="text-link" href="${escapeAttr(dashboardLink)}" target="_blank" rel="noopener noreferrer">${escapeHtml(dashboardLink)}</a></p>` : ''}
      <p class="field-note">Webhook fallback: ${escapeHtml(writefreelyCfg.webhookUrl || 'Not configured')}</p>
      ${renderBlogPostForm(post || null)}
    </section>
  </div>
</body>
</html>`;
}

function renderBlogAdminPage({ message = '', error = '', posts = [] } = {}) {
  const sourceRows = renderBlogPostRows(posts);
  const writefreelyCfg = writefreelyPublishConfig();
  const methodLabel = writefreelyCfg.publishMethod === 'direct-api'
    ? `direct API: ${writefreelyCfg.apiUrl} / ${writefreelyCfg.collectionAlias}`
    : writefreelyCfg.publishMethod === 'webhook'
      ? `webhook: ${writefreelyCfg.webhookUrl}`
      : 'disabled';
  const postCounts = posts.reduce((acc, post) => {
    const source = String(post.source || 'manual');
    acc[source] = (acc[source] || 0) + 1;
    return acc;
  }, {});
  const statusRows = posts.reduce((acc, post) => {
    const status = String(post.status || 'draft');
    acc[status] = (acc[status] || 0) + 1;
    return acc;
  }, {});
  const counts = `<p class="muted">Posts by source: ${Object.entries(postCounts).map(([key, value]) => `${key}: ${value}`).join(' | ') || 'none'}. Status: ${Object.entries(statusRows).map(([key, value]) => `${key}: ${value}`).join(' | ') || 'none'}.</p>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Blog Posts - Admin</title>
  <style>
    * { box-sizing: border-box; }
    body { min-height:100vh; font-family:Inter,Arial,sans-serif; color:#fff8e6; background:radial-gradient(circle at 16% 0,rgba(246,201,91,.18),transparent 30%),radial-gradient(circle at 88% 12%,rgba(232,59,95,.14),transparent 28%),linear-gradient(180deg,#050608,#030406); margin:0; padding:24px; }
    body::before { content:""; position:fixed; inset:0; pointer-events:none; background-image:linear-gradient(rgba(246,201,91,.035) 1px,transparent 1px),linear-gradient(90deg,rgba(246,201,91,.035) 1px,transparent 1px); background-size:58px 58px; mask-image:radial-gradient(circle at top,black,transparent 72%); z-index:-1; }
    .wrapper { max-width: 1240px; margin: 0 auto; display:grid; gap:18px; }
    .admin-hero { display:flex; align-items:center; justify-content:space-between; gap:18px; padding:18px; border:1px solid rgba(246,201,91,.24); border-radius:26px; background:rgba(5,7,11,.78); box-shadow:0 28px 80px rgba(0,0,0,.38); }
    .admin-brand { display:flex; align-items:center; gap:14px; min-width:0; }
    .admin-brand h1 { margin:0; font-size:clamp(28px,4vw,48px); line-height:1; text-transform:uppercase; }
    .admin-nav { display:flex; gap:10px; flex-wrap:wrap; }
    .admin-nav a { display:inline-flex; align-items:center; justify-content:center; min-height:40px; padding:0 14px; border-radius:999px; border:1px solid rgba(255,255,255,.1); background:rgba(255,255,255,.055); color:#fff8e6; }
    .card { background:linear-gradient(180deg,rgba(255,255,255,.065),rgba(255,255,255,.025)); border:1px solid rgba(255,255,255,.1); border-radius:24px; padding:20px; box-shadow:0 20px 60px rgba(0,0,0,.24); }
    .notice { padding: 14px 16px; border-radius: 16px; border:1px solid rgba(255,255,255,.1); background:rgba(255,255,255,0.06); }
    .notice.error { color:#ffb6b6; }
    .notice.success { color:#c6ffc3; }
    .muted { color:#a8afbf; line-height:1.55; }
    .top-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:12px; align-items:start; }
    .section { display:grid; gap:12px; }
    .toolbar { display:flex; flex-wrap:wrap; gap:12px; }
    .toolbar a, .toolbar button, .text-link { display:inline-flex; min-height:40px; align-items:center; justify-content:center; border-radius:12px; width:100%; }
    .toolbar a, .text-link { text-decoration:none; padding:0 14px; color:#ffdf8a; border:1px solid rgba(255,255,255,.12); background:rgba(255,255,255,.07); }
    .mini-link { display:inline-flex; margin-top:6px; color:#9fefff; font-size:12px; font-weight:800; text-decoration:none; }
    button, .toolbar button, .text-link { cursor:pointer; border:0; font-weight:900; }
    .toolbar button, form button { width:100%; min-height:34px; border-radius:10px; border:1px solid rgba(255,255,255,.12); background:rgba(255,255,255,.07); color:#fff8e6; }
    .toolbar form { margin:0; }
    table { width:100%; border-collapse: collapse; margin-top:10px; }
    th, td { border-bottom:1px solid rgba(255,255,255,.08); padding:12px; font-size:13px; vertical-align:top; }
    th { color:#ffdf8a; background:rgba(246,201,91,.09); text-align:left; font-size:11px; text-transform:uppercase; letter-spacing:.08em; }
    .status-pill { display:inline-flex; min-height:26px; align-items:center; padding:4px 10px; border-radius:999px; font-size:11px; border:1px solid rgba(255,255,255,.14); text-transform:uppercase; }
    .status-pill.draft { color:#ffdf8a; background:rgba(246,201,91,.08); }
    .status-pill.queued { color:#9fefff; background:rgba(85,231,255,.08); }
    .status-pill.published { color:#c6ffc3; background:rgba(119,240,161,.08); }
    .status-pill.archived { color:#ffb6b6; background:rgba(232,59,95,.08); }
    .actions-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:6px; }
    .actions-grid form { margin:0; }
    .danger { background:rgba(232,59,95,.16) !important; color:#ffb6b6 !important; border-color:rgba(232,59,95,.38) !important; }
    @media (max-width: 1000px) { .top-grid{grid-template-columns:1fr} .admin-hero{flex-direction:column; align-items:flex-start;} }
    @media (max-width: 720px) {
      body { padding:12px; }
      .admin-nav { display:grid; width:100%; grid-template-columns:1fr; }
      .toolbar { width:100%; }
      table, thead, tbody, tr, th, td { display:block; }
      thead { display:none; }
      tr { border:1px solid rgba(255,255,255,.08); border-radius:14px; margin-bottom:10px; overflow:hidden; }
      td { border-bottom:1px solid rgba(255,255,255,.06); }
      td::before { content: attr(data-label); display:block; color:#ffdf8a; margin-bottom:3px; font-size:10px; font-weight:900; text-transform:uppercase; letter-spacing:.08em; }
    }
  </style>
</head>
<body>
  <div class="wrapper">
    <header class="admin-hero">
      <div class="admin-brand">
        <img src="/intothebattlelogo_logo_only.svg" alt="IntoTheBattle logo" style="width:50px;height:50px;border-radius:16px;" />
        <h1>Blog Posts</h1>
      </div>
      <div class="admin-nav">
        <a href="/admin">Access Codes</a>
        <a href="/admin/sponsors">Video Platform</a>
        <a href="/admin/marketing">Company Growth</a>
        <a href="/admin/blog/manual">Manual poster</a>
        <a href="/admin/logout">Logout</a>
      </div>
    </header>
    ${message ? `<div class="notice success">${escapeHtml(message)}</div>` : ''}
    ${error ? `<div class="notice error">${escapeHtml(error)}</div>` : ''}
    <section class="card section">
      <div class="top-grid">
        <div>
          <h2>Blog engine controls</h2>
          <p class="muted">Generate SEO-ready draft posts from your public pages, then review status and push selected posts to WriteFreely.</p>
          <p class="muted">WriteFreely: ${escapeHtml(methodLabel)}</p>
          <div class="toolbar">
            <form method="POST" action="/admin/blog/generate" style="margin:0;">
              <button type="submit" title="Regenerate daily drafts from current site pages">Generate from site context</button>
            </form>
            <form method="POST" action="/admin/blog/generate" style="margin:0;">
              <input type="hidden" name="force" value="1" />
              <button type="submit">Generate and overwrite drafts</button>
            </form>
            <form method="POST" action="/admin/blog/site-context/push" style="margin:0;">
              <input type="hidden" name="limit" value="10" />
              <button type="submit">Post site drafts to WriteFreely</button>
            </form>
            <form method="POST" action="/admin/blog/site-context/generate-and-push" style="margin:0;">
              <input type="hidden" name="limit" value="10" />
              <button type="submit">Generate and post site content</button>
            </form>
            <a href="/admin/blog/manual">Create post manually</a>
            <a href="/api/public/blog-posts?limit=1" target="_blank" rel="noopener">Test public API</a>
          </div>
        </div>
        <div class="muted">
          ${counts}
        </div>
      </div>
    </section>
    <section class="card section">
      <h2>All posts</h2>
      <div class="section-body table-shell">
        <table>
          <thead><tr><th>Post</th><th>Source / lifecycle</th><th>Status</th><th>Summary</th><th>Publish date</th><th>WriteFreely</th><th>Actions</th></tr></thead>
          <tbody>${sourceRows}</tbody>
        </table>
      </div>
    </section>
  </div>
</body>
</html>`;
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
      <div class="admin-nav"><a href="/admin">Access Codes</a><a href="/admin/sponsors">Video Platform</a><a href="/admin/marketing">Company Growth</a><a href="/admin/blog">Blog Posts</a><a href="/admin/logout">Logout</a></div>
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
  return [...creativeTemplates].sort((a, b) => Number(Boolean(b.featured)) - Number(Boolean(a.featured))).map(template => `<div class="template-card">
    <div class="template-topline">
      <span class="status-pill ${template.featured ? 'ready' : 'draft'}">${escapeHtml(template.featured ? 'featured' : template.goal || '')}</span>
      <small>${escapeHtml(template.audience || '')}</small>
    </div>
    <h3>${escapeHtml(template.label || template.key)}</h3>
    <p>${escapeHtml(template.hooks?.[0] || '')}</p>
    <small>Assets: ${escapeHtml((template.requiredAssetLabels || []).join(', '))}</small>
    ${template.demoUrl ? `<a class="button-link" href="${escapeAttr(template.demoUrl)}" target="_blank" rel="noopener">Open Demo</a>` : ''}
  </div>`).join('');
}

function renderBlankDesignCards(blankDesigns = []) {
  return blankDesigns.map(design => {
    const typeLabel = design.templateType === 'blank' ? 'Blank starter' : design.templateType === 'branded-video' ? 'Branded video' : 'Branded';
    const demoLink = design.demoHref
      ? `<a class="button-link" href="${escapeAttr(design.demoHref)}" target="_blank" rel="noopener">Open Demo</a>`
      : '';
    return `<div class="blank-design-card">
    <div class="blank-design-preview" style="--accent:${escapeAttr(design.accent)};--secondary:${escapeAttr(design.secondary)};">
      <span></span><i></i><em></em><strong></strong><b></b>
    </div>
    <div class="template-topline">
      <span class="status-pill ready">${escapeHtml(typeLabel)}</span>
      <small>${escapeHtml(design.bestFor || '')}</small>
    </div>
    <h3>${escapeHtml(design.label || design.key)}</h3>
    <p>${escapeHtml(design.description || '')}</p>
    <small>${escapeHtml(design.format || '')}${design.recommendedAssetType ? ` - ${escapeHtml(creativeAssetLabel(design.recommendedAssetType))}` : ''}</small>
    <div class="inline-actions">
      <a class="button-link download" href="${escapeAttr(design.downloadSvg)}">Download SVG</a>
      <a class="button-link" href="${escapeAttr(design.downloadBrief)}">Brief</a>
    </div>
    ${demoLink}
  </div>`;
  }).join('');
}

function renderContentPackCards(contentPacks = [], creativeAssets = [], creativeOptions = creativeTemplateOptions()) {
  const approvedAssets = creativeAssets.filter(asset => String(asset.approval_status || '').toLowerCase() === 'approved');
  return contentPacks.map(pack => {
    const acceptedAssetTypes = new Set(pack.acceptedAssetTypes || []);
    const matchingAssets = approvedAssets.filter(asset => acceptedAssetTypes.has(asset.asset_type));
    const assetOptions = matchingAssets
      .map(asset => `<option value="${escapeAttr(asset.id)}">${escapeHtml(asset.title || `Asset ${asset.id}`)} - ${escapeHtml(creativeAssetLabel(asset.asset_type, creativeOptions))}</option>`)
      .join('');
    const recipes = (pack.recipes || []).map(recipe => `<li>${escapeHtml(recipe.platformLabel || recipe.platform)} - ${escapeHtml(recipe.templateLabel || recipe.templateKey)}</li>`).join('');
    return `<div class="content-pack-card">
      <div class="template-topline">
        <span class="status-pill ready">${escapeHtml(pack.goal || 'growth')}</span>
        <small>${escapeHtml((pack.platforms || []).join(', '))}</small>
      </div>
      <h3>${escapeHtml(pack.label || pack.key)}</h3>
      <p>${escapeHtml(pack.description || '')}</p>
      <details class="creative-brief">
        <summary>Pack outputs</summary>
        <ul>${recipes}</ul>
        <p><strong>Best asset:</strong> ${escapeHtml((pack.recommendedAssetLabels || []).join(', '))}</p>
      </details>
      <form method="POST" action="/admin/marketing/content-packs/generate">
        <input type="hidden" name="packKey" value="${escapeAttr(pack.key)}" />
        <label>Approved asset</label>
        <select name="assetId" required>${assetOptions || '<option value="">No matching approved assets</option>'}</select>
        <label>Variants per output</label>
        <input name="countPerItem" type="number" min="1" max="3" value="1" />
        <button type="submit" ${assetOptions ? '' : 'disabled'}>Generate Pack</button>
      </form>
    </div>`;
  }).join('');
}

function renderBattleDemoAssetFolder(demoAssets = [], creativeAssets = [], creativeOptions = creativeTemplateOptions()) {
  const savedUrls = new Set(creativeAssets.map(asset => String(asset.asset_url || '').trim()));
  const savedCount = demoAssets.filter(asset => savedUrls.has(asset.assetUrl)).length;
  const cards = demoAssets.map(asset => {
    const isSaved = savedUrls.has(asset.assetUrl);
    const status = isSaved ? 'ready' : 'draft';
    return `<div class="demo-asset-card ${escapeAttr(status)}">
      <div class="template-topline">
        <span class="status-pill ${escapeAttr(status)}">${escapeHtml(isSaved ? 'saved' : 'not saved')}</span>
        <small>${escapeHtml(asset.timing || '')}</small>
      </div>
      <h3>${escapeHtml(asset.title || asset.key)}</h3>
      <p>${escapeHtml(asset.useCase || '')}</p>
      <small>${escapeHtml(asset.phase || '')} - ${escapeHtml(asset.assetTypeLabel || creativeAssetLabel(asset.assetType, creativeOptions))}</small>
      <div class="inline-actions">
        <a class="button-link" href="${escapeAttr(asset.assetUrl || '#')}" target="_blank" rel="noopener">Open Frame</a>
        <form method="POST" action="/admin/marketing/demo-assets/save">
          <input type="hidden" name="assetKey" value="${escapeAttr(asset.key)}" />
          <button type="submit" class="secondary" ${isSaved ? 'disabled' : ''}>${isSaved ? 'Saved' : 'Save Asset'}</button>
        </form>
      </div>
      <div class="warning-note">${escapeHtml(asset.notes || '')}</div>
    </div>`;
  }).join('');

  return `<div class="demo-asset-folder">
    <div class="folder-head">
      <div>
        <span class="status-pill ${savedCount === demoAssets.length ? 'ready' : 'warn'}">content folder</span>
        <h2>18-second battle demo assets</h2>
        <p>Each slide and clip is saved as its own content asset so posts, templates, and smoke checks can point to the exact proof frame instead of the whole demo.</p>
      </div>
      <form method="POST" action="/admin/marketing/demo-assets/save">
        <input type="hidden" name="assetKey" value="all" />
        <button type="submit" class="test">${savedCount === demoAssets.length ? 'Refresh Folder' : 'Save Missing Assets'}</button>
      </form>
    </div>
    <div class="folder-status">
      <span>${numberValue(savedCount)} / ${numberValue(demoAssets.length)} saved</span>
      <span>Folder: 18-second-battle-demo</span>
      <span>Canonical source: /battle-clip</span>
    </div>
    <div class="demo-asset-grid">${cards}</div>
  </div>`;
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
      <td data-label="Asset">
        <strong>${escapeHtml(asset.title || '')}</strong><br />
        <small>${escapeHtml(creativeAssetLabel(asset.asset_type, creativeOptions))}</small>
      </td>
      <td data-label="Status">
        <span class="status-pill ${escapeAttr(status)}">${escapeHtml(status)}</span><br />
        <small>${escapeHtml(asset.source || 'manual')}</small>
      </td>
      <td data-label="URL">
        <a href="${escapeAttr(asset.asset_url || '#')}" target="_blank" rel="noopener">${escapeHtml(asset.asset_url || '')}</a>
        ${asset.notes ? `<div class="warning-note">${escapeHtml(asset.notes)}</div>` : ''}
      </td>
      <td data-label="Actions">
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
    const layoutSpec = blocks.layoutSpec || {};
    const seo = blocks.seo || {};
    const imageGeneration = blocks.imageGeneration || {};
    const textBlocks = Array.isArray(blocks.textBlocks) ? blocks.textBlocks : [];
    const blockPreview = textBlocks.map(block => `<li><strong>${escapeHtml(block.time || '')}</strong> ${escapeHtml(block.slot || '')}: ${escapeHtml(block.text || '')}</li>`).join('');
    const canvas = layoutSpec.canvas ? `${layoutSpec.canvas.width}x${layoutSpec.canvas.height} ${layoutSpec.canvas.format}` : variant.format;
    return `<tr>
      <td data-label="Template">
        <strong>${escapeHtml(variant.template_key || '')}</strong><br />
        <small>${escapeHtml(String(variant.platform || '').toUpperCase())} - ${escapeHtml(canvas || '')}</small>
      </td>
      <td data-label="Status">
        <span class="status-pill ${escapeAttr(status)}">${escapeHtml(status)}</span><br />
        <span class="status-pill ${escapeAttr(qualityStatus)}">quality ${escapeHtml(qualityStatus)}</span><br />
        <small>Score ${numberValue(variant.quality_score)}/100</small>
      </td>
      <td data-label="Asset">
        <strong>${escapeHtml(variant.asset_title || 'Asset')}</strong><br />
        <small>${escapeHtml(variant.asset_url || '')}</small>
        ${variant.quality_notes ? `<div class="warning-note ${isBlocked ? 'failed' : ''}">${escapeHtml(variant.quality_notes)}</div>` : ''}
      </td>
      <td data-label="Copy">
        <div class="post-copy">${escapeHtml(variant.body || '')}</div>
        <a href="${escapeAttr(variant.utm_url || '#')}" target="_blank" rel="noopener">UTM landing page</a>
        ${visualDirection.primaryVisual ? `<details class="creative-brief"><summary>Creative production package</summary>
          <ul>${blockPreview}</ul>
          <p><strong>Visual:</strong> ${escapeHtml(visualDirection.primaryVisual)}</p>
          <p><strong>Image prompt:</strong> ${escapeHtml(imageGeneration.prompt || visualDirection.imagePrompt || '')}</p>
          <p><strong>Negative prompt:</strong> ${escapeHtml(imageGeneration.negativePrompt || '')}</p>
          <p><strong>SEO title:</strong> ${escapeHtml(seo.title || '')}</p>
          <p><strong>SEO description:</strong> ${escapeHtml(seo.description || '')}</p>
          <p><strong>Alt text:</strong> ${escapeHtml(seo.altText || '')}</p>
        </details>` : ''}
      </td>
      <td data-label="Actions">
        <a class="button-link download" href="/admin/marketing/creative-variants/${escapeAttr(variant.id)}/download.svg">Download SVG</a>
        <a class="button-link download" href="/admin/marketing/creative-variants/${escapeAttr(variant.id)}/brief.json">Download Brief</a>
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

function dateKey(value) {
  if (!value) return '';
  if (/^\d{4}-\d{2}-\d{2}/.test(String(value))) return String(value).slice(0, 10);
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10);
}

function dayLabel(key) {
  const date = new Date(`${key}T12:00:00`);
  if (Number.isNaN(date.getTime())) return key || 'Unscheduled';
  return date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

function renderAutopilotModes(diagnostics = {}, statusCounts = {}) {
  const modeCards = [
    {
      key: 'off',
      title: 'Off',
      active: !diagnostics.autoPostEnabled,
      copy: 'Nothing posts automatically. Use manual draft, approve, and publish controls.',
    },
    {
      key: 'draft',
      title: 'Draft only',
      active: diagnostics.autoPostEnabled && diagnostics.dryRun,
      copy: 'Generate and dry-run safely while webhooks, copy, and scheduling are being tuned.',
    },
    {
      key: 'auto',
      title: 'Approved auto-post',
      active: diagnostics.autoPostReady,
      copy: 'Only approved posts whose scheduled time has passed can publish through configured webhooks.',
    },
    {
      key: 'recovery',
      title: 'Recovery',
      active: numberValue(statusCounts.failed) > 0,
      copy: 'Failed posts are held for review and can be moved back to draft after the issue is fixed.',
    },
  ];
  return modeCards.map(mode => `<div class="mode-card ${mode.active ? 'active' : ''}">
    <span class="status-pill ${mode.active ? 'ready' : 'draft'}">${mode.active ? 'active' : 'available'}</span>
    <h3>${escapeHtml(mode.title)}</h3>
    <p>${escapeHtml(mode.copy)}</p>
  </div>`).join('');
}

function renderCampaignCalendar(posts = []) {
  const today = new Date();
  const days = Array.from({ length: 7 }, (_, index) => {
    const date = new Date(today);
    date.setDate(today.getDate() + index);
    return date.toISOString().slice(0, 10);
  });
  const grouped = posts.reduce((acc, post) => {
    const key = dateKey(post.scheduled_for || post.campaign_date) || 'unscheduled';
    if (!acc[key]) acc[key] = [];
    acc[key].push(post);
    return acc;
  }, {});
  return days.map(key => {
    const dayPosts = (grouped[key] || []).slice(0, 9);
    const chips = dayPosts.map(post => {
      const status = String(post.status || 'draft').toLowerCase();
      return `<span class="calendar-chip ${escapeAttr(status)}"><b>${escapeHtml(String(post.platform || '').toUpperCase())}</b>${escapeHtml(status)}</span>`;
    }).join('');
    return `<div class="calendar-day">
      <strong>${escapeHtml(dayLabel(key))}</strong>
      <span>${numberValue((grouped[key] || []).length)} post${(grouped[key] || []).length === 1 ? '' : 's'}</span>
      <div class="calendar-chips">${chips || '<small>No posts scheduled.</small>'}</div>
    </div>`;
  }).join('');
}

function renderPerformanceSummary(summary = {}) {
  const sourceRows = (summary.topSources || []).slice(0, 5).map(row => `<div class="rank-row"><b>${escapeHtml(row.key || 'unknown')}</b><span>${numberValue(row.visits)} visits</span></div>`).join('');
  const campaignRows = (summary.topCampaigns || []).slice(0, 5).map(row => `<div class="rank-row"><b>${escapeHtml(row.key || 'unknown')}</b><span>${numberValue(row.visits)} visits</span></div>`).join('');
  const contentRows = (summary.topContent || []).slice(0, 5).map(row => `<div class="rank-row"><b>${escapeHtml(row.key || 'unknown')}</b><span>${numberValue(row.visits)} visits</span></div>`).join('');
  return `<div class="performance-grid">
    <div class="performance-panel"><h3>Top sources</h3>${sourceRows || '<p>No UTM visits yet.</p>'}</div>
    <div class="performance-panel"><h3>Top campaigns</h3>${campaignRows || '<p>No campaigns tracked yet.</p>'}</div>
    <div class="performance-panel"><h3>Top content</h3>${contentRows || '<p>No content winners yet.</p>'}</div>
  </div>`;
}

function renderRecentVisitRows(visits = []) {
  return visits.map(visit => `<tr>
    <td data-label="Source"><strong>${escapeHtml(visit.utm_source || 'unknown')}</strong><br /><small>${escapeHtml(formatSponsorDate(visit.created_at))}</small></td>
    <td data-label="Campaign">${escapeHtml(visit.utm_campaign || '')}<br /><small>${escapeHtml(visit.utm_content || '')}</small></td>
    <td data-label="Landing path"><small>${escapeHtml(visit.path || '')}</small></td>
  </tr>`).join('');
}

function renderPostPreviewCards(posts = []) {
  const previewPosts = posts
    .filter(post => !['published', 'skipped'].includes(String(post.status || '').toLowerCase()))
    .slice(0, 6);
  return previewPosts.map(post => {
    const platform = String(post.platform || '').toUpperCase();
    const status = String(post.status || 'draft').toLowerCase();
    return `<div class="preview-card">
      <div class="preview-top"><span>${escapeHtml(platform)}</span><span class="status-pill ${escapeAttr(status)}">${escapeHtml(status)}</span></div>
      <div class="preview-body">${escapeHtml(post.body || '')}</div>
      <a href="${escapeAttr(post.utm_url || post.url || '#')}" target="_blank" rel="noopener">Landing URL</a>
    </div>`;
  }).join('');
}

function renderQueueCardActions(post = {}) {
  const status = String(post.status || 'draft').toLowerCase();
  if (status === 'published') {
    return '<div class="queue-card-actions muted">Published posts are locked.</div>';
  }
  return `<div class="queue-card-actions">
    <form method="POST" action="/admin/marketing/${escapeAttr(post.id)}/status">
      <input type="hidden" name="status" value="approved" />
      <button type="submit" class="test" ${status === 'approved' ? 'disabled' : ''}>Approve</button>
    </form>
    <form method="POST" action="/admin/marketing/${escapeAttr(post.id)}/status">
      <input type="hidden" name="status" value="draft" />
      <button type="submit" class="secondary" ${status === 'draft' ? 'disabled' : ''}>Draft</button>
    </form>
    <form method="POST" action="/admin/marketing/${escapeAttr(post.id)}/status">
      <input type="hidden" name="status" value="skipped" />
      <button type="submit" class="danger" ${status === 'skipped' ? 'disabled' : ''}>Skip</button>
    </form>
  </div>`;
}

function renderGrowthQueueBoard(posts = []) {
  const lanes = [
    ['draft', 'Draft', 'Needs review before it can move.'],
    ['approved', 'Approved', 'Ready for schedule or publishing gate.'],
    ['failed', 'Failed', 'Fix setup, then recover.'],
    ['published', 'Published', 'Already sent and recorded.'],
  ];
  const grouped = posts.reduce((acc, post) => {
    const key = String(post.status || 'draft').toLowerCase();
    if (!acc[key]) acc[key] = [];
    acc[key].push(post);
    return acc;
  }, {});
  return `<div class="queue-board">
    ${lanes.map(([key, title, copy]) => {
      const lanePosts = (grouped[key] || []).slice(0, 8);
      const cards = lanePosts.map(post => {
        const characterLimit = marketingPlatformCharacterLimit(post.platform);
        const body = String(post.body || '');
        const bodyPreview = body.length > 220 ? `${body.slice(0, 217).replace(/\s+\S*$/, '')}...` : body;
        return `<article class="queue-card ${escapeAttr(key)}">
          <div class="queue-card-top">
            <strong>${escapeHtml(String(post.platform || '').toUpperCase())}</strong>
            <span>${escapeHtml(formatSponsorDate(post.scheduled_for))}</span>
          </div>
          <p>${escapeHtml(bodyPreview || 'No post body saved yet.')}</p>
          <div class="queue-card-meta">
            <span>${numberValue(body.length)}/${numberValue(characterLimit)} chars</span>
            <span>${escapeHtml(post.topic_key || 'growth')}</span>
          </div>
          ${post.error_message ? `<div class="warning-note failed">${escapeHtml(post.error_message)}</div>` : ''}
          ${renderQueueCardActions(post)}
        </article>`;
      }).join('');
      return `<section class="queue-lane ${escapeAttr(key)}">
        <div class="queue-lane-head">
          <h3>${escapeHtml(title)}</h3>
          <span>${numberValue((grouped[key] || []).length)}</span>
        </div>
        <p>${escapeHtml(copy)}</p>
        <div class="queue-lane-cards">${cards || '<div class="empty-state">Nothing in this lane.</div>'}</div>
      </section>`;
    }).join('')}
  </div>`;
}

function renderAssetPreview(asset = {}) {
  const url = String(asset.asset_url || '').trim();
  const title = asset.title || 'Growth asset';
  if (/\.(png|jpe?g|webp|gif|svg)(\?|#|$)/i.test(url)) {
    return `<img src="${escapeAttr(url)}" alt="${escapeAttr(title)}" loading="lazy" />`;
  }
  if (/\.(mp4|webm|mov|m4v)(\?|#|$)/i.test(url)) {
    return `<video src="${escapeAttr(url)}" muted playsinline preload="metadata" controls></video>`;
  }
  return `<div class="asset-preview-fallback"><span>${escapeHtml(creativeAssetLabel(asset.asset_type))}</span></div>`;
}

function renderCreativeAssetGallery(creativeAssets = [], creativeOptions = creativeTemplateOptions()) {
  const assets = creativeAssets.slice(0, 12);
  if (!assets.length) return '<div class="empty-state">No proof assets saved yet. Save the demo folder or upload one real product frame.</div>';
  return `<div class="asset-gallery">
    ${assets.map(asset => {
      const status = String(asset.approval_status || 'draft').toLowerCase();
      return `<article class="asset-card ${escapeAttr(status)}">
        <div class="asset-preview">${renderAssetPreview(asset)}</div>
        <div class="asset-card-body">
          <div class="template-topline">
            <span class="status-pill ${escapeAttr(status)}">${escapeHtml(status)}</span>
            <small>${escapeHtml(creativeAssetLabel(asset.asset_type, creativeOptions))}</small>
          </div>
          <h3>${escapeHtml(asset.title || 'Growth asset')}</h3>
          <p>${escapeHtml(asset.notes || asset.source || 'Proof asset available for campaign creative.')}</p>
          <a href="${escapeAttr(asset.asset_url || '#')}" target="_blank" rel="noopener">Open asset</a>
          <div class="queue-card-actions">
            <form method="POST" action="/admin/marketing/creative-assets/${escapeAttr(asset.id)}/status">
              <input type="hidden" name="status" value="approved" />
              <button type="submit" class="test" ${status === 'approved' ? 'disabled' : ''}>Approve</button>
            </form>
            <form method="POST" action="/admin/marketing/creative-assets/${escapeAttr(asset.id)}/status">
              <input type="hidden" name="status" value="blocked" />
              <button type="submit" class="danger" ${status === 'blocked' ? 'disabled' : ''}>Block</button>
            </form>
          </div>
        </div>
      </article>`;
    }).join('')}
  </div>`;
}

function renderGrowthContentIdeaCards(creativeTemplates = []) {
  return creativeTemplates.slice(0, 8).map(template => `<div class="idea-card">
    <span class="status-pill draft">${escapeHtml(template.goal || 'growth')}</span>
    <h3>${escapeHtml(template.label || template.key)}</h3>
    <p>${escapeHtml(template.hooks?.[0] || '')}</p>
    <small>Path: ${escapeHtml(template.path || '/')} - Assets: ${escapeHtml((template.requiredAssetLabels || []).join(', '))}</small>
    <a href="#variant-builder">Build variants</a>
  </div>`).join('');
}

function renderGrowthGuardrails(posts = [], diagnostics = {}, performance = {}) {
  const duplicateBodies = new Set();
  const seenBodies = new Set();
  let missingUtm = 0;
  let overLimit = 0;
  posts.forEach(post => {
    const body = String(post.body || '').trim();
    if (body) {
      if (seenBodies.has(body)) duplicateBodies.add(body);
      seenBodies.add(body);
    }
    if (!String(post.utm_url || post.body || '').includes('utm_source=')) missingUtm++;
    if (body.length > marketingPlatformCharacterLimit(post.platform)) overLimit++;
  });
  const checks = [
    {
      label: 'Outbound gate',
      status: diagnostics.autoPostReady ? 'ready' : 'warn',
      detail: diagnostics.autoPostReady ? 'Auto-post can publish approved due posts.' : 'Live auto-post is blocked until env/webhook gates are complete.',
    },
    {
      label: 'Duplicate copy',
      status: duplicateBodies.size ? 'warn' : 'ready',
      detail: duplicateBodies.size ? `${duplicateBodies.size} duplicate post bod${duplicateBodies.size === 1 ? 'y' : 'ies'} found.` : 'No duplicate post bodies in the loaded queue.',
    },
    {
      label: 'UTM links',
      status: missingUtm ? 'warn' : 'ready',
      detail: missingUtm ? `${missingUtm} loaded posts are missing UTM tracking.` : 'Loaded posts include UTM tracking.',
    },
    {
      label: 'Character limits',
      status: overLimit ? 'blocked' : 'ready',
      detail: overLimit ? `${overLimit} loaded posts exceed platform character limits.` : 'Loaded posts fit platform character limits.',
    },
    {
      label: 'Learning loop',
      status: numberValue(performance.visits) > 0 ? 'ready' : 'warn',
      detail: numberValue(performance.visits) > 0 ? `${numberValue(performance.visits)} tracked visits in ${numberValue(performance.days)} days.` : 'No UTM visits tracked yet.',
    },
  ];
  return checks.map(check => `<div class="guardrail-card ${escapeAttr(check.status)}">
    <span class="status-pill ${escapeAttr(check.status)}">${escapeHtml(check.status)}</span>
    <h3>${escapeHtml(check.label)}</h3>
    <p>${escapeHtml(check.detail)}</p>
  </div>`).join('');
}

function renderGrowthCommandDeck({
  posts = [],
  calendarPosts = [],
  diagnostics = {},
  growthDiagnostics = {},
  performanceSummary = {},
  creativeAssets = [],
  creativeVariants = [],
  contentPacks = [],
  autoPostBlockers = [],
} = {}) {
  const queue = calendarPosts.length ? calendarPosts : posts;
  const counts = countBy(queue, 'status', 'draft');
  const approvedAssets = creativeAssets.filter(asset => String(asset.approval_status || '').toLowerCase() === 'approved');
  const proofAssets = approvedAssets.filter(asset => ['real_overlay_clip', 'real_overlay_screenshot', 'sponsor_break_clip', 'dashboard_screenshot'].includes(String(asset.asset_type || '').toLowerCase()));
  const readyVariants = creativeVariants.filter(variant => String(variant.quality_status || '').toLowerCase() === 'ready');
  const queuedVariants = creativeVariants.filter(variant => String(variant.status || '').toLowerCase() === 'queued');
  const draftCount = numberValue(counts.draft);
  const approvedCount = numberValue(counts.approved);
  const dueApproved = numberValue(diagnostics.dueApprovedCount);
  const failedCount = numberValue(counts.failed);
  const visits = numberValue(performanceSummary.visits);
  const battlePack = contentPacks.find(pack => pack.key === 'battle_clip_launch') || contentPacks[0];
  const mission = autoPostBlockers.length
    ? {
      status: 'blocked',
      eyebrow: 'setup blocked',
      title: 'Fix publishing setup',
      copy: 'The engine can still create and approve content, but live auto-posting is blocked until the setup gate is clean.',
      cta: 'Open settings',
      href: '#settings',
    }
    : failedCount
      ? {
        status: 'blocked',
        eyebrow: 'recovery needed',
        title: 'Recover failed posts',
        copy: `${failedCount} failed post${failedCount === 1 ? '' : 's'} need review before the queue can be trusted.`,
        cta: 'Review queue',
        href: '#queue',
      }
      : dueApproved
        ? {
          status: 'ready',
          eyebrow: 'ready now',
          title: 'Publish approved posts',
          copy: `${dueApproved} approved post${dueApproved === 1 ? '' : 's'} are due now. Dry-run first if any connection changed.`,
          cta: 'Publish queue',
          href: '#queue',
        }
        : draftCount
          ? {
            status: 'warn',
            eyebrow: 'review needed',
            title: 'Approve the best drafts',
            copy: `${draftCount} draft${draftCount === 1 ? '' : 's'} are waiting. Approve only the posts that clearly show the game promise and send tracked traffic.`,
            cta: 'Review drafts',
            href: '#queue',
          }
          : proofAssets.length === 0
            ? {
              status: 'warn',
              eyebrow: 'proof missing',
              title: 'Add real product proof',
              copy: 'Growth creative should start from a real battle clip, overlay frame, sponsor break, or dashboard proof asset.',
              cta: 'Open assets',
              href: '#assets',
            }
            : {
              status: 'ready',
              eyebrow: 'build campaign',
              title: 'Create the next campaign',
              copy: 'Use an approved proof asset, generate a coordinated pack, approve the winners, and let the queue publish.',
              cta: 'Create campaign',
              href: '#create-campaign',
            };
  const cards = [
    ['Traffic', visits ? `${visits} tracked visits in ${numberValue(performanceSummary.days)} days.` : 'No tracked UTM visits yet.', visits ? 'ready' : 'warn'],
    ['Queue', `${draftCount} draft, ${approvedCount} approved, ${dueApproved} due now.`, failedCount ? 'blocked' : approvedCount || dueApproved ? 'ready' : draftCount ? 'warn' : 'draft'],
    ['Proof assets', `${proofAssets.length} approved proof asset${proofAssets.length === 1 ? '' : 's'} ready.`, proofAssets.length ? 'ready' : 'warn'],
    ['Lead sync', growthDiagnostics.enabled ? `Enabled for ${(growthDiagnostics.providers || []).join(', ') || 'configured providers'}.` : 'Disabled until HubSpot/Segment keys are connected.', growthDiagnostics.enabled ? 'ready' : 'warn'],
  ];
  const cardHtml = cards.map(([title, detail, status]) => `<div class="command-card ${escapeAttr(status)}">
    <span class="status-pill ${escapeAttr(status)}">${escapeHtml(status)}</span>
    <h3>${escapeHtml(title)}</h3>
    <p>${escapeHtml(detail)}</p>
  </div>`).join('');
  const battlePackRecipe = (battlePack?.recipes || []).slice(0, 3).map(recipe => `<li>${escapeHtml(recipe.platformLabel || recipe.platform)}: ${escapeHtml(recipe.templateLabel || recipe.templateKey)}</li>`).join('');
  const blockerHtml = autoPostBlockers.length
    ? `<div class="growth-blockers">${autoPostBlockers.map(blocker => `<span>${escapeHtml(blocker)}</span>`).join('')}</div>`
    : '<div class="growth-blockers ready"><span>Automation gate is clean. Approved due posts can publish through configured webhooks.</span></div>';
  return `<section class="growth-command-center" id="command-center">
    <div class="mission-panel ${escapeAttr(mission.status)}">
      <span class="status-pill ${escapeAttr(mission.status)}">${escapeHtml(mission.eyebrow)}</span>
      <h2>${escapeHtml(mission.title)}</h2>
      <p>${escapeHtml(mission.copy)}</p>
      <div class="mission-actions">
        <a class="primary-action" href="${escapeAttr(mission.href)}">${escapeHtml(mission.cta)}</a>
        <a href="/battle-clip" target="_blank" rel="noopener">View proof demo</a>
      </div>
    </div>
    <div class="proof-brief">
      <span class="status-pill ready">campaign promise</span>
      <h3>Sell the moment: chat becomes visible action.</h3>
      <p>Every growth post should show the same clean story: a viewer comments, the overlay reacts, the battle produces a result, and the creator has a reason to launch.</p>
      <ul>
        <li>Hook: Turn TikTok LIVE comments into a playable battle arena.</li>
        <li>Proof: command, attack, KO, sponsored break, and stats recap.</li>
        <li>CTA: Start a battle room and let viewers play from chat.</li>
      </ul>
      <small>${battlePack ? `Recommended pack: ${escapeHtml(battlePack.label || battlePack.key)}.` : 'Approve one real proof asset before building a campaign pack.'}</small>
      ${battlePackRecipe ? `<ol>${battlePackRecipe}</ol>` : ''}
    </div>
    ${blockerHtml}
    <div class="command-grid">${cardHtml}</div>
    <div class="mission-steps">
      <a href="#create-campaign"><strong>1</strong><span>Create campaign</span></a>
      <a href="#queue"><strong>2</strong><span>Approve queue</span></a>
      <a href="#assets"><strong>3</strong><span>Use proof assets</span></a>
      <a href="#results"><strong>4</strong><span>Read results</span></a>
      <a href="#settings"><strong>5</strong><span>Fix setup</span></a>
    </div>
  </section>`;
}

function renderMarketingAdminPage({
  message = '',
  error = '',
  posts = [],
  calendarPosts = [],
  events = [],
  performanceSummary = marketingPerformanceSummary(),
  recentVisits = [],
  diagnostics = marketingAutomationDiagnostics(),
  growthDiagnostics = growthIntegrationDiagnostics(),
  filters = {},
  creativeTemplates = listCreativeTemplates(),
  blankDesigns = listBlankDesignTemplates(),
  contentPacks = listContentGenerationPacks(),
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
  const calendarQueuePosts = calendarPosts.length ? calendarPosts : posts;
  const overallStatusCounts = calendarQueuePosts.reduce((acc, post) => {
    const status = String(post.status || 'draft');
    acc[status] = (acc[status] || 0) + 1;
    return acc;
  }, {});
  const configuredWebhooks = diagnostics.configuredWebhooks || [];
  const growthProviders = growthDiagnostics.providers || [];
  const autoPostStatus = diagnostics.autoPostReady ? 'ready' : (diagnostics.autoPostEnabled ? 'warn' : 'draft');
  const autoPostLabel = diagnostics.autoPostReady ? 'Auto-post live' : (diagnostics.autoPostEnabled ? 'Auto-post waiting' : 'Manual only');
  const autoPostBlockers = [
    diagnostics.autoPostEnabled ? '' : 'Set MARKETING_AUTO_POST_ENABLED=true, or remove the explicit false value, to let the scheduler run.',
    diagnostics.enabled ? '' : 'Set MARKETING_AUTOMATION_ENABLED=true to allow outbound publishing.',
    diagnostics.dryRun ? 'Set MARKETING_DRY_RUN=false for live outbound publishing.' : '',
    configuredWebhooks.length ? '' : 'Configure MARKETING_WEBHOOK_<PLATFORM> or MARKETING_OUTBOUND_WEBHOOK_URL.',
  ].filter(Boolean);
  const commandDeck = renderGrowthCommandDeck({
    posts,
    calendarPosts: calendarQueuePosts,
    diagnostics,
    growthDiagnostics,
    performanceSummary,
    creativeAssets,
    creativeVariants,
    contentPacks,
    autoPostBlockers,
  });
  const engineSteps = [
    ['1', 'Draft', 'Generate daily posts from the public pages or build variants from approved proof assets.'],
    ['2', 'Approve', 'Review copy, UTM links, schedule, asset status, and quality score before anything can publish.'],
    ['3', 'Auto-post', 'The server publishes only approved posts whose scheduled time has passed, then records an event.'],
    ['4', 'Learn', 'UTM links, publish history, HubSpot, and Segment close the loop for growth tracking.'],
  ].map(([step, title, copy]) => `<div class="engine-step"><strong>${escapeHtml(step)}</strong><b>${escapeHtml(title)}</b><span>${escapeHtml(copy)}</span></div>`).join('');
  const templateCards = renderCreativeTemplateCards(creativeTemplates);
  const blankDesignCards = renderBlankDesignCards(blankDesigns);
  const contentPackCards = renderContentPackCards(contentPacks, creativeAssets, creativeOptions);
  const battleDemoAssets = listBattleDemoContentAssets();
  const battleDemoAssetFolder = renderBattleDemoAssetFolder(battleDemoAssets, creativeAssets, creativeOptions);
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
  const autopilotModes = renderAutopilotModes(diagnostics, overallStatusCounts);
  const campaignCalendar = renderCampaignCalendar(calendarQueuePosts);
  const performancePanels = renderPerformanceSummary(performanceSummary);
  const recentVisitRows = renderRecentVisitRows(recentVisits);
  const postPreviewCards = renderPostPreviewCards(posts);
  const queueBoard = renderGrowthQueueBoard(calendarQueuePosts);
  const assetGallery = renderCreativeAssetGallery(creativeAssets, creativeOptions);
  const ideaCards = renderGrowthContentIdeaCards(creativeTemplates);
  const guardrailCards = renderGrowthGuardrails(posts, diagnostics, performanceSummary);
  const campaignGoalCards = [
    ['Creator signups', 'Lead with the battle demo and route traffic to /signup.', 'Proof clip + launch CTA'],
    ['Sponsor sales', 'Show branded breaks, dashboard control, and measurable live moments.', 'Sponsor page + proof asset'],
    ['SEO demand', 'Turn high-intent topics into tracked social posts and page ideas.', 'Keyword + landing page'],
    ['Product proof', 'Use real overlay frames so people understand what happens on screen.', 'Asset pack + queue'],
  ].map(([title, copy, tag]) => `<div class="goal-card">
    <span class="status-pill draft">${escapeHtml(tag)}</span>
    <h3>${escapeHtml(title)}</h3>
    <p>${escapeHtml(copy)}</p>
  </div>`).join('');
  const setupChecklist = [
    ['Scheduler', diagnostics.autoPostEnabled ? 'ready' : 'warn', diagnostics.autoPostEnabled ? 'Auto-post scheduler is enabled.' : 'Auto-post scheduler is off.'],
    ['Automation', diagnostics.enabled ? 'ready' : 'warn', diagnostics.enabled ? 'Outbound publishing is enabled.' : 'Outbound publishing is disabled.'],
    ['Live mode', diagnostics.dryRun ? 'warn' : 'ready', diagnostics.dryRun ? 'Dry-run is on, so no live posts will be sent.' : 'Live publishing mode is available.'],
    ['Webhooks', configuredWebhooks.length ? 'ready' : 'warn', configuredWebhooks.length ? `${configuredWebhooks.length} publishing webhook${configuredWebhooks.length === 1 ? '' : 's'} configured.` : 'No publishing webhook is configured.'],
    ['Lead APIs', growthDiagnostics.enabled ? 'ready' : 'warn', growthDiagnostics.enabled ? `Lead sync connected: ${growthProviders.join(', ') || 'provider ready'}.` : 'HubSpot/Segment lead sync is disabled.'],
  ].map(([title, status, copy]) => `<div class="setup-check ${escapeAttr(status)}">
    <span class="status-pill ${escapeAttr(status)}">${escapeHtml(status)}</span>
    <h3>${escapeHtml(title)}</h3>
    <p>${escapeHtml(copy)}</p>
  </div>`).join('');
  const eventRows = events.map(event => `<tr>
    <td data-label="Event"><strong>${escapeHtml(event.event_type || '')}</strong><br /><small>${escapeHtml(formatSponsorDate(event.created_at))}</small></td>
    <td data-label="Platform">${escapeHtml(String(event.platform || '').toUpperCase())}</td>
    <td data-label="Topic">${escapeHtml(event.topic_key || '')}</td>
    <td data-label="Detail"><small>${escapeHtml(event.detail || '')}</small></td>
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
      <td data-label="Platform">
        <strong>${escapeHtml(String(post.platform || '').toUpperCase())}</strong><br />
        <small>${escapeHtml(post.campaign_date || '')} - ${escapeHtml(post.topic_key || '')}</small>
      </td>
      <td data-label="Status">
        <span class="status-pill ${escapeAttr(status)}">${escapeHtml(status)}</span><br />
        <small>Scheduled: ${escapeHtml(formatSponsorDate(post.scheduled_for))}</small>
        ${post.error_message ? `<div class="warning-note failed">${escapeHtml(post.error_message)}</div>` : ''}
      </td>
      <td data-label="Draft">
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
      <td data-label="Actions">
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
    .growth-tabs { position:sticky; top:12px; z-index:20; display:grid; grid-template-columns:repeat(5,minmax(0,1fr)); gap:8px; padding:8px; border:1px solid rgba(255,255,255,.1); border-radius:18px; background:rgba(5,7,11,.92); backdrop-filter:blur(16px); box-shadow:0 18px 50px rgba(0,0,0,.28); }
    .growth-tabs a { min-height:40px; display:flex; align-items:center; justify-content:center; padding:0 10px; border-radius:12px; color:#dce7ff; background:rgba(255,255,255,.045); font-size:12px; text-align:center; }
    .growth-tabs a:hover { color:#041014; background:linear-gradient(135deg,#55e7ff,#fff0b9); }
    .growth-command-center { display:grid; grid-template-columns:minmax(0,1.05fr) minmax(320px,.95fr); gap:16px; padding:20px; border:1px solid rgba(85,231,255,.24); border-radius:28px; background:linear-gradient(180deg,rgba(85,231,255,.09),rgba(255,255,255,.026)); box-shadow:0 30px 90px rgba(0,0,0,.34), inset 0 1px 0 rgba(255,255,255,.08); scroll-margin-top:84px; }
    .mission-panel,.proof-brief { min-width:0; padding:18px; border-radius:22px; border:1px solid rgba(255,255,255,.1); background:rgba(0,0,0,.2); }
    .mission-panel.ready { border-color:rgba(119,240,161,.3); }
    .mission-panel.warn { border-color:rgba(246,201,91,.32); }
    .mission-panel.blocked { border-color:rgba(232,59,95,.36); }
    .mission-panel h2 { margin:12px 0 8px; font-size:clamp(34px,5vw,62px); line-height:.94; text-transform:uppercase; max-width:740px; }
    .mission-panel p,.proof-brief p { margin:0; color:#dce7ff; font-size:16px; line-height:1.55; }
    .mission-actions { display:flex; flex-wrap:wrap; gap:10px; margin-top:18px; }
    .mission-actions a { min-height:44px; display:inline-flex; align-items:center; justify-content:center; padding:0 15px; border-radius:14px; color:#fff8e6; border:1px solid rgba(255,255,255,.12); background:rgba(255,255,255,.07); }
    .mission-actions .primary-action { color:#041014; border:0; background:linear-gradient(135deg,#55e7ff,#fff0b9 62%,#ff6a3d); }
    .mission-steps { grid-column:1 / -1; display:grid; grid-template-columns:repeat(5,minmax(0,1fr)); gap:10px; }
    .mission-steps a { min-height:58px; display:flex; align-items:center; gap:10px; padding:10px; border-radius:16px; border:1px solid rgba(255,255,255,.1); background:rgba(0,0,0,.18); color:#fff8e6; }
    .mission-steps strong { width:32px; height:32px; flex:0 0 auto; display:inline-flex; align-items:center; justify-content:center; border-radius:10px; color:#041014; background:#55e7ff; }
    .mission-steps span { min-width:0; font-size:12px; font-weight:900; text-transform:uppercase; letter-spacing:.06em; }
    .growth-section { scroll-margin-top:86px; display:grid; gap:16px; }
    .section-head { display:flex; align-items:flex-end; justify-content:space-between; gap:16px; }
    .section-head h2 { margin:0; font-size:clamp(26px,3.5vw,42px); line-height:1; text-transform:uppercase; }
    .section-head p { max-width:680px; margin:8px 0 0; }
    .section-head .status-pill { flex:0 0 auto; }
    .goal-grid,.setup-grid { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:12px; }
    .goal-card,.setup-check,.campaign-card,.publish-card,.queue-lane,.asset-card,.result-panel { min-width:0; border:1px solid rgba(255,255,255,.1); border-radius:18px; background:rgba(0,0,0,.2); }
    .goal-card,.setup-check,.campaign-card,.publish-card,.result-panel { padding:14px; }
    .goal-card h3,.setup-check h3,.campaign-card h3,.publish-card h3,.queue-lane h3,.asset-card h3,.result-panel h3 { margin:10px 0 8px; color:#fff8e6; font-size:17px; }
    .goal-card p,.setup-check p,.campaign-card p,.publish-card p,.queue-lane p,.asset-card p,.result-panel p { margin:0; font-size:13px; }
    .campaign-layout { display:grid; grid-template-columns:minmax(0,.95fr) minmax(320px,1.05fr); gap:16px; align-items:start; }
    .campaign-actions { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:12px; }
    .campaign-actions form,.publish-card form { min-width:0; padding:14px; border-radius:16px; border:1px solid rgba(255,255,255,.1); background:rgba(255,255,255,.04); }
    .campaign-card .content-pack-grid { grid-template-columns:repeat(2,minmax(0,1fr)); }
    .publish-grid { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:12px; }
    .publish-card .calendar-grid { grid-template-columns:1fr; }
    .queue-board { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:12px; align-items:start; }
    .queue-lane { padding:12px; }
    .queue-lane-head,.queue-card-top,.queue-card-meta { display:flex; align-items:center; justify-content:space-between; gap:8px; }
    .queue-lane-head span { min-width:34px; height:30px; display:inline-flex; align-items:center; justify-content:center; border-radius:999px; color:#041014; background:#ffdf8a; font-weight:950; }
    .queue-lane > p { margin:0 0 12px; color:#9fb2d7; }
    .queue-lane-cards { display:grid; gap:10px; }
    .queue-card { display:grid; gap:10px; padding:12px; border-radius:15px; border:1px solid rgba(255,255,255,.09); background:rgba(255,255,255,.04); }
    .queue-card.approved { border-color:rgba(85,231,255,.24); }
    .queue-card.failed { border-color:rgba(232,59,95,.32); }
    .queue-card.published { border-color:rgba(119,240,161,.24); }
    .queue-card-top strong { color:#ffdf8a; letter-spacing:.08em; }
    .queue-card-top span,.queue-card-meta span { color:#9fb2d7; font-size:11px; font-weight:900; }
    .queue-card p { color:#fff8e6; line-height:1.45; }
    .queue-card-actions { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:6px; align-items:end; color:#9fb2d7; font-size:12px; font-weight:900; }
    .queue-card-actions form { margin:0; }
    .queue-card-actions button { min-height:34px; margin:0; padding:0 8px; border-radius:10px; font-size:11px; }
    .queue-card-actions.muted { display:block; padding:9px; border-radius:10px; background:rgba(255,255,255,.05); }
    .asset-gallery { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:12px; }
    .asset-card { overflow:hidden; display:grid; grid-template-rows:auto 1fr; }
    .asset-preview { aspect-ratio:16/9; background:#070b12; border-bottom:1px solid rgba(255,255,255,.08); }
    .asset-preview img,.asset-preview video { width:100%; height:100%; display:block; object-fit:cover; }
    .asset-preview-fallback { width:100%; height:100%; display:flex; align-items:center; justify-content:center; padding:12px; color:#9fefff; font-weight:900; text-align:center; background:linear-gradient(135deg,rgba(85,231,255,.12),rgba(246,201,91,.08)); }
    .asset-card-body { display:grid; gap:8px; padding:14px; }
    .asset-card-body a { font-size:12px; }
    .results-grid { display:grid; grid-template-columns:minmax(0,1fr) minmax(320px,.82fr); gap:16px; align-items:start; }
    .results-stack { display:grid; gap:12px; }
    .results-stack .preview-grid,.results-stack .idea-grid { grid-template-columns:1fr; }
    .empty-state { min-height:86px; display:flex; align-items:center; justify-content:center; padding:14px; border:1px dashed rgba(255,255,255,.16); border-radius:14px; color:#9fb2d7; background:rgba(255,255,255,.035); text-align:center; font-weight:800; line-height:1.35; }
    .growth-command-deck { display:grid; grid-template-columns:minmax(0,1.08fr) minmax(320px,.92fr); gap:16px; padding:20px; border:1px solid rgba(85,231,255,.24); border-radius:28px; background:radial-gradient(circle at 10% 0,rgba(85,231,255,.14),transparent 38%),radial-gradient(circle at 88% 8%,rgba(246,201,91,.12),transparent 36%),linear-gradient(180deg,rgba(255,255,255,.075),rgba(255,255,255,.026)); box-shadow:0 30px 90px rgba(0,0,0,.34), inset 0 1px 0 rgba(255,255,255,.08); }
    .command-hero,.proof-brief { min-width:0; padding:18px; border-radius:22px; border:1px solid rgba(255,255,255,.1); background:rgba(0,0,0,.18); }
    .command-hero h2 { margin:10px 0 8px; font-size:clamp(30px,4.8vw,58px); line-height:.94; text-transform:uppercase; }
    .command-hero p,.proof-brief p { margin:0; color:#dce7ff; font-size:16px; line-height:1.55; }
    .command-links { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:10px; margin-top:16px; }
    .command-links a { min-height:42px; display:inline-flex; align-items:center; justify-content:center; padding:0 12px; border-radius:14px; color:#041014; background:linear-gradient(135deg,#55e7ff,#fff0b9 62%,#ff6a3d); font-size:12px; text-align:center; }
    .proof-brief h3 { margin:10px 0 8px; color:#fff8e6; font-size:24px; line-height:1.05; }
    .proof-brief ul,.proof-brief ol { margin:12px 0 0; padding-left:20px; color:#dce7ff; line-height:1.5; }
    .proof-brief li { margin:5px 0; }
    .proof-brief small { display:block; margin-top:12px; color:#9fefff; font-weight:900; }
    .growth-blockers { grid-column:1 / -1; display:grid; gap:8px; padding:14px; border-radius:18px; border:1px solid rgba(246,201,91,.22); background:rgba(246,201,91,.075); }
    .growth-blockers.ready { border-color:rgba(119,240,161,.28); background:rgba(119,240,161,.075); }
    .growth-blockers span { color:#fff8e6; font-size:13px; font-weight:800; line-height:1.4; }
    .command-grid { grid-column:1 / -1; display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:12px; }
    .command-card { min-width:0; padding:14px; border-radius:18px; border:1px solid rgba(255,255,255,.1); background:rgba(0,0,0,.2); }
    .command-card.ready { border-color:rgba(119,240,161,.28); background:rgba(119,240,161,.06); }
    .command-card.warn { border-color:rgba(246,201,91,.28); background:rgba(246,201,91,.06); }
    .command-card.blocked { border-color:rgba(232,59,95,.32); background:rgba(232,59,95,.08); }
    .command-card h3 { margin:10px 0 8px; color:#fff8e6; font-size:17px; }
    .command-card p { margin:0; font-size:13px; }
    .growth-shell { display:grid; grid-template-columns:minmax(0,1.05fr) minmax(320px,.95fr); gap:18px; align-items:start; }
    .focus-card { border-color:rgba(85,231,255,.2); background:linear-gradient(180deg,rgba(85,231,255,.09),rgba(255,255,255,.025)); }
    .focus-actions { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:12px; margin-top:14px; }
    .focus-actions form { min-width:0; padding:14px; border-radius:18px; border:1px solid rgba(255,255,255,.1); background:rgba(0,0,0,.2); }
    .page-section { padding:0; overflow:hidden; }
    .page-section summary { list-style:none; display:flex; align-items:center; justify-content:space-between; gap:12px; padding:18px 20px; cursor:pointer; }
    .page-section summary::-webkit-details-marker { display:none; }
    .page-section summary span { color:#fff8e6; font-size:21px; font-weight:900; }
    .page-section summary small { color:#a8afbf; font-size:12px; font-weight:800; line-height:1.4; text-align:right; }
    .page-section summary::after { content:"Open"; min-width:58px; min-height:28px; display:inline-flex; align-items:center; justify-content:center; border-radius:999px; color:#ffdf8a; background:rgba(246,201,91,.08); border:1px solid rgba(246,201,91,.22); font-size:11px; font-weight:900; text-transform:uppercase; }
    .page-section[open] summary::after { content:"Hide"; }
    .section-body { padding:0 20px 20px; }
    .metrics-grid { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:12px; }
    .metric-card { min-width:0; padding:16px; border-radius:18px; border:1px solid rgba(255,255,255,.1); background:rgba(0,0,0,.2); }
    .metric-card span { display:block; color:#a8afbf; font-size:11px; font-weight:900; text-transform:uppercase; letter-spacing:.08em; }
    .metric-card strong { display:block; margin-top:6px; color:#fff8e6; font-size:clamp(26px,4vw,42px); line-height:1; }
    .engine-grid { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:12px; margin-top:14px; }
    .engine-step { min-width:0; display:grid; gap:8px; align-content:start; padding:14px; border-radius:18px; border:1px solid rgba(255,255,255,.1); background:rgba(0,0,0,.22); }
    .engine-step strong { width:34px; height:34px; display:inline-flex; align-items:center; justify-content:center; border-radius:999px; color:#041014; background:linear-gradient(135deg,#55e7ff,#b9fbff); }
    .engine-step b { color:#fff8e6; }
    .engine-step span { color:#a8afbf; line-height:1.45; font-size:13px; }
    .mode-grid,.calendar-grid,.preview-grid,.idea-grid,.guardrail-grid,.performance-grid { display:grid; gap:12px; }
    .mode-grid { grid-template-columns:repeat(4,minmax(0,1fr)); }
    .calendar-grid { grid-template-columns:repeat(7,minmax(0,1fr)); }
    .preview-grid,.idea-grid,.guardrail-grid,.performance-grid { grid-template-columns:repeat(3,minmax(0,1fr)); }
    .mode-card,.calendar-day,.preview-card,.idea-card,.guardrail-card,.performance-panel { min-width:0; padding:14px; border-radius:18px; border:1px solid rgba(255,255,255,.1); background:rgba(0,0,0,.2); }
    .mode-card.active,.guardrail-card.ready { border-color:rgba(119,240,161,.3); background:rgba(119,240,161,.065); }
    .guardrail-card.warn { border-color:rgba(246,201,91,.28); background:rgba(246,201,91,.065); }
    .guardrail-card.blocked { border-color:rgba(232,59,95,.34); background:rgba(232,59,95,.08); }
    .mode-card h3,.idea-card h3,.guardrail-card h3,.performance-panel h3 { margin:10px 0 8px; color:#fff8e6; font-size:17px; }
    .mode-card p,.idea-card p,.guardrail-card p,.performance-panel p { margin:0; font-size:13px; }
    .calendar-day strong { display:block; color:#fff8e6; }
    .calendar-day > span { display:block; margin:4px 0 10px; color:#a8afbf; font-size:12px; font-weight:900; }
    .calendar-chips { display:flex; flex-direction:column; gap:6px; }
    .calendar-chip { display:flex; justify-content:space-between; gap:8px; min-height:28px; padding:6px 8px; border-radius:10px; color:#fff8e6; background:rgba(255,255,255,.06); font-size:11px; text-transform:uppercase; }
    .calendar-chip.approved { color:#9fefff; background:rgba(85,231,255,.09); }
    .calendar-chip.published { color:#c6ffc3; background:rgba(119,240,161,.08); }
    .calendar-chip.failed { color:#ffb6b6; background:rgba(232,59,95,.1); }
    .preview-top,.rank-row { display:flex; align-items:center; justify-content:space-between; gap:10px; }
    .preview-top span:first-child { color:#ffdf8a; font-size:12px; font-weight:950; letter-spacing:.08em; }
    .preview-body { margin:12px 0; white-space:pre-wrap; color:#fff8e6; line-height:1.45; font-size:13px; }
    .rank-row { padding:9px 0; border-bottom:1px solid rgba(255,255,255,.07); }
    .rank-row b { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .rank-row span { color:#9fb2d7; font-size:12px; font-weight:900; white-space:nowrap; }
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
    .button-link { display:inline-flex; width:100%; min-height:38px; margin-top:8px; align-items:center; justify-content:center; padding:0 12px; border-radius:12px; border:1px solid rgba(255,255,255,.12); color:#fff8e6; background:rgba(255,255,255,.07); font-size:12px; font-weight:900; }
    .button-link.download { color:#041014; background:linear-gradient(135deg,#55e7ff,#b9fbff); border:0; }
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
    .template-grid,.blank-design-grid,.content-pack-grid { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:12px; margin-top:14px; }
    .content-pack-grid { grid-template-columns:repeat(3,minmax(0,1fr)); }
    .template-card,.blank-design-card,.content-pack-card { min-width:0; padding:14px; border-radius:18px; border:1px solid rgba(255,255,255,.1); background:rgba(0,0,0,.22); }
    .content-pack-card { display:flex; flex-direction:column; }
    .content-pack-card form { margin-top:auto; }
    .template-card h3,.blank-design-card h3,.content-pack-card h3 { margin:10px 0 8px; color:#fff8e6; font-size:17px; }
    .template-card p,.blank-design-card p,.content-pack-card p { margin:0 0 10px; font-size:13px; }
    .template-topline { display:flex; align-items:center; justify-content:space-between; gap:8px; }
    .demo-asset-folder { display:grid; gap:14px; margin:0 0 18px; padding:16px; border:1px solid rgba(53,231,255,.22); border-radius:20px; background:linear-gradient(180deg,rgba(53,231,255,.08),rgba(255,255,255,.035)); }
    .folder-head { display:flex; align-items:flex-start; justify-content:space-between; gap:14px; }
    .folder-head h2 { margin:8px 0 6px; }
    .folder-head p { margin:0; max-width:760px; }
    .folder-status { display:flex; flex-wrap:wrap; gap:8px; }
    .folder-status span { display:inline-flex; align-items:center; min-height:30px; padding:0 10px; border:1px solid rgba(255,255,255,.1); border-radius:999px; color:#dce7ff; background:rgba(0,0,0,.18); font-size:12px; font-weight:900; text-transform:uppercase; }
    .demo-asset-grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:12px; }
    .demo-asset-card { min-width:0; display:grid; gap:10px; padding:14px; border:1px solid rgba(255,255,255,.1); border-radius:16px; background:rgba(2,5,13,.52); }
    .demo-asset-card.ready { border-color:rgba(119,240,161,.24); }
    .demo-asset-card h3 { margin:0; color:#fff8e6; font-size:15px; }
    .demo-asset-card p { margin:0; font-size:12px; }
    .demo-asset-card form { margin:0; }
    .demo-asset-card button { width:100%; }
    .connect-smoke { display:grid; gap:12px; margin:16px 0; padding:16px; border:1px solid rgba(85,231,255,.18); border-radius:18px; background:rgba(85,231,255,.055); }
    .connect-smoke h2 { margin:0; }
    .connect-smoke p { margin:0; }
    .blank-design-preview { position:relative; overflow:hidden; aspect-ratio:16/10; margin-bottom:12px; border-radius:16px; border:1px solid rgba(255,255,255,.12); background:radial-gradient(circle at 22% 18%, color-mix(in srgb,var(--secondary) 38%, transparent), transparent 35%),radial-gradient(circle at 78% 78%, color-mix(in srgb,var(--accent) 34%, transparent), transparent 38%),linear-gradient(135deg,#050713,#102034 55%,#1d0d20); box-shadow:inset 0 0 0 1px rgba(255,255,255,.04); }
    .blank-design-preview::before { content:""; position:absolute; inset:12%; border:2px solid color-mix(in srgb,var(--accent) 55%, transparent); border-radius:14px; box-shadow:0 0 34px color-mix(in srgb,var(--accent) 22%, transparent); }
    .blank-design-preview::after { content:""; position:absolute; inset:0; background-image:linear-gradient(rgba(255,255,255,.05) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.05) 1px,transparent 1px); background-size:32px 32px; opacity:.5; }
    .blank-design-preview span { position:absolute; left:14px; top:14px; width:34px; height:34px; border-radius:12px; background:var(--accent); box-shadow:0 0 22px color-mix(in srgb,var(--accent) 42%, transparent); }
    .blank-design-preview i { position:absolute; left:20%; right:12%; top:20px; height:11px; border-radius:999px; background:var(--secondary); opacity:.75; }
    .blank-design-preview em { position:absolute; left:16%; right:16%; top:34%; height:34%; border-radius:10px; border:2px solid color-mix(in srgb,var(--accent) 62%, transparent); background:rgba(2,5,13,.62); }
    .blank-design-preview strong { position:absolute; left:16%; right:16%; bottom:22%; height:13%; border-radius:10px; border:1px solid color-mix(in srgb,var(--secondary) 54%, transparent); background:rgba(255,255,255,.045); }
    .blank-design-preview b { position:absolute; left:26%; right:26%; bottom:10%; height:12px; border-radius:999px; background:linear-gradient(90deg,var(--accent),var(--secondary)); opacity:.78; }
    .inline-actions { display:grid; grid-template-columns:1fr 1fr; gap:8px; margin-top:12px; }
    .creative-brief { margin-top:10px; padding:10px; border-radius:14px; border:1px solid rgba(255,255,255,.09); background:rgba(0,0,0,.18); }
    .creative-brief summary { cursor:pointer; color:#ffdf8a; font-weight:900; }
    .creative-brief ul { margin:10px 0; padding-left:18px; color:#dce7ff; }
    .creative-brief p { margin:8px 0 0; font-size:12px; }
    .table-shell { width:100%; overflow-x:auto; }
    table { width:100%; border-collapse:collapse; margin-top:12px; overflow:hidden; border-radius:16px; }
    th, td { vertical-align:top; border-bottom:1px solid rgba(255,255,255,0.08); padding:12px; font-size:13px; }
    th { background:rgba(246,201,91,0.09); color:#ffdf8a; text-align:left; font-size:11px; text-transform:uppercase; letter-spacing:.08em; }
    small { color:#9fb2d7; }
    .post-copy { max-width:620px; white-space:pre-wrap; color:#fff8e6; line-height:1.45; }
    @media(max-width:1100px){ .growth-command-center,.growth-command-deck,.growth-shell,.campaign-layout,.results-grid{grid-template-columns:1fr}.goal-grid,.setup-grid,.publish-grid,.queue-board,.asset-gallery,.mission-steps,.command-links,.template-grid,.blank-design-grid,.content-pack-grid,.demo-asset-grid,.engine-grid,.mode-grid,.preview-grid,.idea-grid,.guardrail-grid,.performance-grid{grid-template-columns:repeat(2,minmax(0,1fr));}.calendar-grid{grid-template-columns:repeat(4,minmax(0,1fr));} }
    @media(max-width:900px){ body{padding:12px}.admin-hero{align-items:flex-start;flex-direction:column}.admin-brand img{width:46px;height:46px}.admin-nav{width:100%;display:grid;grid-template-columns:1fr 1fr}.admin-nav a{padding:0 10px}.growth-tabs{position:static;grid-template-columns:1fr 1fr}.metrics-grid,.inline-grid,.focus-actions,.campaign-actions,.goal-grid,.setup-grid,.publish-grid,.queue-board,.asset-gallery,.mission-steps,.command-links,.command-grid,.template-grid,.blank-design-grid,.content-pack-grid,.demo-asset-grid,.engine-grid,.mode-grid,.calendar-grid,.preview-grid,.idea-grid,.guardrail-grid,.performance-grid{grid-template-columns:1fr}.folder-head,.section-head{display:grid}.growth-command-center,.growth-command-deck{padding:14px}.page-section summary{align-items:flex-start;flex-direction:column}.page-section summary small{text-align:left}.page-section summary::after{align-self:flex-start}.section-body{padding:0 12px 14px} table,thead,tbody,tr,th,td{display:block} thead{display:none} tr{border:1px solid rgba(255,255,255,.08); border-radius:16px; margin-bottom:14px; overflow:hidden} td{border-bottom:1px solid rgba(255,255,255,.06)} td::before{content:attr(data-label);display:block;margin-bottom:4px;color:#ffdf8a;font-size:10px;font-weight:900;text-transform:uppercase;letter-spacing:.08em} }
    @media(max-width:420px){ .admin-nav{grid-template-columns:1fr}.metrics-grid{grid-template-columns:1fr} }
  </style>
</head>
<body>
  <div class="wrapper">
    <header class="admin-hero">
      <div class="admin-brand">
        <img src="/intothebattlelogo_logo_only.svg" alt="IntoTheBattle logo" />
        <div><h1>Company Growth</h1><p>Admin-only sales workflow</p></div>
      </div>
      <div class="admin-nav"><a href="/admin">Access Codes</a><a href="/admin/sponsors">Video Platform</a><a href="/admin/marketing">Company Growth</a><a href="/admin/blog">Blog Posts</a><a href="/admin/logout">Logout</a></div>
    </header>
    ${message ? `<div class="notice success">${escapeHtml(message)}</div>` : ''}
    ${error ? `<div class="notice error">${escapeHtml(error)}</div>` : ''}
    ${commandDeck}
    <nav class="growth-tabs" aria-label="Growth workflow">
      <a href="#create-campaign">Create Campaign</a>
      <a href="#queue">Queue</a>
      <a href="#assets">Assets</a>
      <a href="#results">Results</a>
      <a href="#settings">Settings</a>
    </nav>
    <div class="metrics-grid">
      <div class="metric-card"><span>Traffic</span><strong>${numberValue(performanceSummary.visits)}</strong><small>${numberValue(performanceSummary.days)} day visits</small></div>
      <div class="metric-card"><span>Drafts</span><strong>${numberValue(overallStatusCounts.draft)}</strong><small>Needs approval</small></div>
      <div class="metric-card"><span>Due Now</span><strong>${numberValue(diagnostics.dueApprovedCount)}</strong><small>Approved posts</small></div>
      <div class="metric-card"><span>Proof Assets</span><strong>${numberValue(creativeAssetCounts.approved)}</strong><small>Approved assets</small></div>
    </div>

    <section class="growth-section card" id="create-campaign">
      <div class="section-head">
        <div>
          <h2>Create Campaign</h2>
          <p>Pick the business goal, choose real proof, generate platform-ready posts, then send only the best work into the queue.</p>
        </div>
        <span class="status-pill ready">campaign builder</span>
      </div>
      <div class="goal-grid">${campaignGoalCards}</div>
      <div class="campaign-layout">
        <div class="campaign-card">
          <h3>Fast daily SEO drafts</h3>
          <p>Creates UTM-tagged posts from the public pages. Use this when you need a clean daily baseline across channels.</p>
          <form method="POST" action="/admin/marketing/generate">
            <label>Date</label>
            <input name="date" type="date" value="${escapeAttr(nowDate)}" />
            <label><input name="force" type="checkbox" value="1" /> Rebuild existing drafts</label>
            <button type="submit">Generate Daily Drafts</button>
          </form>
        </div>
        <div class="campaign-card" id="content-packs">
          <h3>One-click content packs</h3>
          <p>Use one approved proof asset to generate coordinated hooks, proof copy, CTAs, UTM links, SEO fields, and production briefs.</p>
          <div class="content-pack-grid">${contentPackCards || '<div class="empty-state">No content packs configured.</div>'}</div>
        </div>
      </div>
      <div class="campaign-card" id="variant-builder">
        <h3>Variant builder</h3>
        <p>Build specific creative variants from an approved asset when a campaign needs more control than a full pack.</p>
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
      </div>
    </section>

    <section class="growth-section" id="queue">
      <div class="section-head">
        <div>
          <h2>Queue</h2>
          <p>Approve, recover, and publish from one board. The detailed editor stays available for copy, UTM, schedule, hashtag, and keyword changes.</p>
        </div>
        <span class="status-pill ${escapeAttr(autoPostStatus)}">${escapeHtml(autoPostLabel)}</span>
      </div>
      ${queueBoard}
      <div class="publish-grid">
        <div class="publish-card">
          <h3>Dry-run publish</h3>
          <p>Test the approved queue without sending live posts.</p>
          <form method="POST" action="/admin/marketing/publish">
            <input type="hidden" name="dryRun" value="1" />
            <label>Limit</label>
            <input name="limit" type="number" min="1" max="50" value="10" />
            <button type="submit" class="secondary">Dry Run Publish</button>
          </form>
        </div>
        <div class="publish-card">
          <h3>Live publish</h3>
          <p>Send approved due posts through configured webhooks.</p>
          <form method="POST" action="/admin/marketing/publish" onsubmit="return confirm('Publish approved due posts to configured outbound webhooks?')">
            <input type="hidden" name="dryRun" value="0" />
            <label>Limit</label>
            <input name="limit" type="number" min="1" max="50" value="10" />
            <button type="submit" class="test">Publish Approved</button>
          </form>
        </div>
        <div class="publish-card">
          <h3>Recover failed</h3>
          <p>Move failed posts back to draft after setup is fixed.</p>
          <form method="POST" action="/admin/marketing/recover-failed">
            <label>Limit</label>
            <input name="limit" type="number" min="1" max="50" value="10" />
            <button type="submit" class="danger">Move Failed to Draft</button>
          </form>
        </div>
        <div class="publish-card">
          <h3>Seven-day calendar</h3>
          <p>Scheduled posts across the next week.</p>
          <div class="calendar-grid">${campaignCalendar}</div>
        </div>
      </div>
      <details class="card page-section" id="daily-queue">
        <summary><span>Detailed content editor</span><small>Full copy, UTM, schedule, hashtag, and keyword controls.</small></summary>
        <div class="section-body">
          <form method="GET" action="/admin/marketing">
            <div class="inline-grid compact">
              <span><label>Status</label><select name="status">${statusOptions}</select></span>
              <span><label>Date</label><input name="date" type="date" value="${escapeAttr(selectedDate)}" /></span>
              <span><button type="submit">Filter Queue</button></span>
            </div>
          </form>
          <div class="table-shell">
            <table>
              <thead><tr><th>Platform</th><th>Status</th><th>Draft</th><th>Actions</th></tr></thead>
              <tbody>${rows || '<tr><td colspan="4">No marketing posts generated yet.</td></tr>'}</tbody>
            </table>
          </div>
        </div>
      </details>
    </section>

    <section class="growth-section" id="assets">
      <div class="section-head">
        <div>
          <h2>Assets</h2>
          <p>Keep campaign creative tied to real product proof. Approved assets are what the campaign builder should use first.</p>
        </div>
        <span class="status-pill ready">${numberValue(creativeAssetCounts.approved)} approved</span>
      </div>
      ${assetGallery}
      <details class="card page-section" id="asset-vault" open>
        <summary><span>Proof asset vault</span><small>Save demo frames, upload product proof, or add an approved URL.</small></summary>
        <div class="section-body">
          ${battleDemoAssetFolder}
          <div class="campaign-actions">
            <form method="POST" action="/admin/marketing/creative-assets/upload" enctype="multipart/form-data">
              <h3>Upload proof asset</h3>
              <div class="inline-grid compact">
                <span><label>Title</label><input name="title" maxlength="120" placeholder="Real overlay action frame" required /></span>
                <span><label>Asset type</label><select name="assetType"><option value="">Auto from file</option>${assetTypeOptions}</select></span>
                <span><label>Status</label><select name="approvalStatus"><option value="approved">Approved</option><option value="draft">Draft</option><option value="blocked">Blocked</option></select></span>
              </div>
              <label>Upload image or video</label>
              <input name="creativeAsset" type="file" accept="image/png,image/jpeg,image/webp,image/gif,video/mp4,video/webm,video/quicktime,video/x-m4v" required />
              <div class="inline-grid compact">
                <span><label>Source</label><input name="source" maxlength="80" value="admin-upload" /></span>
                <span><label>Notes</label><input name="notes" maxlength="500" placeholder="Why this asset is approved and where it should be used" /></span>
                <span><button type="submit">Upload Asset</button></span>
              </div>
            </form>
            <form method="POST" action="/admin/marketing/creative-assets">
              <h3>Save proof URL</h3>
              <div class="inline-grid compact">
                <span><label>Title</label><input name="title" maxlength="120" placeholder="Real overlay demo clip" required /></span>
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
          </div>
          <div class="table-shell">
            <table>
              <thead><tr><th>Asset</th><th>Status</th><th>URL</th><th>Actions</th></tr></thead>
              <tbody>${creativeAssetRows || '<tr><td colspan="4">No creative assets saved yet.</td></tr>'}</tbody>
            </table>
          </div>
        </div>
      </details>
      <details class="card page-section">
        <summary><span>Templates and generated variants</span><small>Reusable creative systems, design starters, and generated packages.</small></summary>
        <div class="section-body">
          <div class="metrics-grid">
            <div class="metric-card"><span>Ready Variants</span><strong>${numberValue(creativeQualityCounts.ready)}</strong></div>
            <div class="metric-card"><span>Queued Variants</span><strong>${numberValue(creativeVariantCounts.queued)}</strong></div>
            <div class="metric-card"><span>Blocked Variants</span><strong>${numberValue(creativeQualityCounts.blocked)}</strong></div>
            <div class="metric-card"><span>Draft Variants</span><strong>${numberValue(creativeVariantCounts.draft)}</strong></div>
          </div>
          <h2 style="margin-top:18px;">Creative templates</h2>
          <div class="template-grid">${templateCards || '<div class="empty-state">No templates configured.</div>'}</div>
          <h2 style="margin-top:18px;">Design starters</h2>
          <div class="blank-design-grid">${blankDesignCards || '<div class="empty-state">No design templates configured.</div>'}</div>
          <h2 style="margin-top:18px;">Generated variants</h2>
          <div class="table-shell">
            <table>
              <thead><tr><th>Template</th><th>Status</th><th>Asset</th><th>Copy</th><th>Actions</th></tr></thead>
              <tbody>${creativeVariantRows || '<tr><td colspan="5">No creative variants generated yet.</td></tr>'}</tbody>
            </table>
          </div>
        </div>
      </details>
    </section>

    <section class="growth-section" id="results">
      <div class="section-head">
        <div>
          <h2>Results</h2>
          <p>Use UTM visits, publish history, and quality guardrails to decide what the next campaign should do.</p>
        </div>
        <span class="status-pill ${numberValue(performanceSummary.visits) ? 'ready' : 'warn'}">${numberValue(performanceSummary.visits) ? 'learning' : 'needs traffic'}</span>
      </div>
      <div class="results-grid">
        <div class="results-stack">
          <div class="card">
            <h2>Growth pulse</h2>
            <p>Tracked UTM visits in the last ${numberValue(performanceSummary.days)} days: <strong>${numberValue(performanceSummary.visits)}</strong>. Last tracked visit: <strong>${escapeHtml(formatSponsorDate(performanceSummary.lastVisit))}</strong>.</p>
            ${performancePanels}
          </div>
          <div class="card">
            <h2>Guardrails</h2>
            <div class="guardrail-grid">${guardrailCards}</div>
          </div>
        </div>
        <div class="results-stack">
          <div class="card">
            <h2>Post previews</h2>
            <div class="preview-grid">${postPreviewCards || '<div class="empty-state">No draft or approved posts to preview.</div>'}</div>
          </div>
          <div class="card">
            <h2>Content ideas</h2>
            <div class="idea-grid">${ideaCards || '<div class="empty-state">No content ideas configured.</div>'}</div>
          </div>
        </div>
      </div>
      <details class="card page-section">
        <summary><span>Recent visits and publish events</span><small>Audit trail for UTM traffic, dry-runs, posts, failures, and recovery.</small></summary>
        <div class="section-body">
          <div class="table-shell">
            <table>
              <thead><tr><th>Source</th><th>Campaign</th><th>Landing path</th></tr></thead>
              <tbody>${recentVisitRows || '<tr><td colspan="3">No UTM visits recorded yet.</td></tr>'}</tbody>
            </table>
          </div>
          <div class="table-shell">
            <table>
              <thead><tr><th>Event</th><th>Platform</th><th>Topic</th><th>Detail</th></tr></thead>
              <tbody>${eventRows || '<tr><td colspan="4">No publish events recorded yet.</td></tr>'}</tbody>
            </table>
          </div>
        </div>
      </details>
    </section>

    <section class="growth-section" id="settings">
      <div class="section-head">
        <div>
          <h2>Settings</h2>
          <p>Connection health, publishing mode, webhooks, and lead API checks live here so setup does not clutter campaign work.</p>
        </div>
        <span class="status-pill ${escapeAttr(autoPostStatus)}">${escapeHtml(autoPostLabel)}</span>
      </div>
      <div class="setup-grid">${setupChecklist}</div>
      ${autoPostBlockers.length ? `<div class="warning-note ${diagnostics.autoPostEnabled ? 'failed' : ''}">${autoPostBlockers.map(blocker => escapeHtml(blocker)).join('<br />')}</div>` : '<div class="warning-note">Auto-posting is live-gated and ready. Only approved due posts will publish.</div>'}
      <div class="card focus-card" id="growth-controls">
        <h2>Growth engine controls</h2>
        <p><span class="status-pill ${escapeAttr(autoPostStatus)}">${escapeHtml(autoPostLabel)}</span> Due approved posts: <strong>${numberValue(diagnostics.dueApprovedCount)}</strong>. Check interval: <strong>${numberValue(diagnostics.autoPostIntervalMinutes)}</strong> min. Batch limit: <strong>${numberValue(diagnostics.autoPostLimit)}</strong>.</p>
        <p>Platforms: ${escapeHtml((diagnostics.platforms || []).join(', '))}. Webhooks configured: ${escapeHtml(configuredWebhooks.length ? configuredWebhooks.join(', ') : 'none')}.</p>
        <div class="engine-grid">${engineSteps}</div>
        <h2>Autopilot modes</h2>
        <div class="mode-grid">${autopilotModes}</div>
        <div class="connect-smoke">
          <h2>Connection smoke test</h2>
          <p>Send one admin test lead through the same HubSpot/Segment growth-sync path used by signup intent.</p>
          <form method="POST" action="/admin/marketing/growth-sync-smoke">
            <div class="inline-grid compact">
              <span><label>Test email</label><input name="email" type="email" value="growth-smoke@example.com" required /></span>
              <span><label>Name</label><input name="name" value="Growth Smoke" maxlength="120" /></span>
              <span><label>TikTok username</label><input name="tiktokUsername" value="growth_smoke" maxlength="80" /></span>
            </div>
            <button type="submit" class="secondary">Run Connection Smoke Test</button>
          </form>
        </div>
      </div>
    </section>
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
      calendarPosts: listMarketingPosts({ limit: 200 }),
      events: listMarketingPublishEvents({ limit: 30 }),
      performanceSummary: marketingPerformanceSummary({ days: 14 }),
      recentVisits: listRecentMarketingVisits({ limit: 25 }),
      diagnostics: marketingAutomationDiagnostics(),
      growthDiagnostics: growthIntegrationDiagnostics(),
      filters: { status, date },
      creativeTemplates: listCreativeTemplates(),
      blankDesigns: listBlankDesignTemplates(),
      contentPacks: listContentGenerationPacks(),
      creativeAssets: listCreativeAssets({ limit: 60 }),
      creativeVariants: listCreativeVariants({ limit: 60 }),
      creativeOptions: creativeTemplateOptions(),
    }));
  } catch (err) {
    res.status(500).send(renderMarketingAdminPage({
      error: err?.message || 'Marketing page failed to load',
      posts: [],
      calendarPosts: [],
      events: [],
      performanceSummary: marketingPerformanceSummary({ days: 14 }),
      recentVisits: [],
      diagnostics: marketingAutomationDiagnostics(),
      growthDiagnostics: growthIntegrationDiagnostics(),
      filters: { status, date },
      creativeTemplates: listCreativeTemplates(),
      blankDesigns: listBlankDesignTemplates(),
      contentPacks: listContentGenerationPacks(),
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

router.post('/marketing/demo-assets/save', requireAdminAuth, (req, res) => {
  try {
    const assetKey = String(req.body.assetKey || '').trim();
    const keys = assetKey && assetKey !== 'all' ? [assetKey] : [];
    const result = saveBattleDemoContentAssets(keys);
    const skippedText = result.skipped ? `, skipped ${result.skipped} already saved` : '';
    res.redirect(`/admin/marketing?message=${encodeURIComponent(`Saved ${result.inserted} battle demo content asset${result.inserted === 1 ? '' : 's'}${skippedText}`)}#asset-vault`);
  } catch (err) {
    res.redirect(`/admin/marketing?error=${encodeURIComponent(err?.message || 'Battle demo asset save failed')}#asset-vault`);
  }
});

router.post('/marketing/growth-sync-smoke', requireAdminAuth, async (req, res) => {
  try {
    const result = await syncLeadToGrowthApis({
      email: req.body.email,
      name: req.body.name || 'Growth Smoke',
      tiktokUsername: req.body.tiktokUsername || 'growth_smoke',
      source: 'admin-marketing-smoke',
      lastPath: '/admin/marketing',
      eventName: 'Admin Growth Connection Smoke Test',
      properties: {
        smokeTest: true,
        adminPage: 'company-growth',
      },
    });
    if (!result.ok) {
      return res.redirect(`/admin/marketing?error=${encodeURIComponent(result.error || 'Growth connection smoke test failed')}#growth-controls`);
    }
    const providerSummary = Array.isArray(result.providers) && result.providers.length
      ? result.providers.map(provider => `${provider.provider || 'provider'}:${provider.status || provider.reason || 'unknown'}`).join(', ')
      : (result.skipped ? 'skipped: growth sync disabled' : 'no providers configured');
    res.redirect(`/admin/marketing?message=${encodeURIComponent(`Connection smoke test ${result.skipped ? 'skipped safely' : 'completed'} (${providerSummary})`)}#growth-controls`);
  } catch (err) {
    res.redirect(`/admin/marketing?error=${encodeURIComponent(err?.message || 'Growth connection smoke test failed')}#growth-controls`);
  }
});

router.post('/marketing/creative-assets/upload', requireAdminAuth, (req, res) => {
  const capacityRedirect = growthUploadCapacityRedirect(req);
  if (capacityRedirect) return res.redirect(capacityRedirect);
  growthAssetUpload.single('creativeAsset')(req, res, (err) => {
    if (err) {
      const message = err?.code === 'LIMIT_FILE_SIZE'
        ? `Creative asset is too large. Maximum growth upload size is ${Math.round(GROWTH_CREATIVE_UPLOAD_MAX_BYTES / 1024 / 1024)}MB.`
        : err.message || 'Creative asset upload failed';
      return res.redirect(`/admin/marketing?error=${encodeURIComponent(message)}`);
    }
    if (!req.file) return res.redirect(`/admin/marketing?error=${encodeURIComponent('Choose an image or video asset')}`);

    const postWriteCapacityRedirect = uploadedGrowthFileCapacityRedirect(req.file.path, req.file.size);
    if (postWriteCapacityRedirect) return res.redirect(postWriteCapacityRedirect);

    try {
      const requestedType = String(req.body.assetType || '').trim();
      addCreativeAsset({
        title: req.body.title || req.file.originalname,
        assetType: requestedType || inferGrowthAssetType(req.file),
        assetUrl: `/growth-assets/${encodeURIComponent(req.file.filename)}`,
        source: req.body.source || 'admin-upload',
        approvalStatus: req.body.approvalStatus,
        notes: req.body.notes || `Uploaded ${req.file.originalname || req.file.filename}`,
      });
      return res.redirect('/admin/marketing?message=Creative%20asset%20uploaded');
    } catch (saveErr) {
      deleteGrowthUploadFile(req.file.path);
      return res.redirect(`/admin/marketing?error=${encodeURIComponent(saveErr?.message || 'Creative asset save failed')}`);
    }
  });
});

router.post('/marketing/creative-assets/:id/status', requireAdminAuth, (req, res) => {
  try {
    updateCreativeAssetStatus(req.params.id, String(req.body.status || '').trim().toLowerCase());
    res.redirect('/admin/marketing?message=Creative%20asset%20status%20updated');
  } catch (err) {
    res.redirect(`/admin/marketing?error=${encodeURIComponent(err?.message || 'Creative asset status update failed')}`);
  }
});

router.get('/marketing/creative-variants/:id/download.svg', requireAdminAuth, (req, res) => {
  try {
    const pkg = buildCreativeProductionPackage(req.params.id);
    const svg = renderCreativeVariantSvg(req.params.id);
    res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${pkg.files.svgFilename.replace(/"/g, '')}"`);
    res.send(svg);
  } catch (err) {
    res.status(404).send(err?.message || 'Creative variant not found');
  }
});

router.get('/marketing/creative-variants/:id/brief.json', requireAdminAuth, (req, res) => {
  try {
    const pkg = buildCreativeProductionPackage(req.params.id);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${pkg.files.briefFilename.replace(/"/g, '')}"`);
    res.send(JSON.stringify(pkg, null, 2));
  } catch (err) {
    res.status(404).json({ error: err?.message || 'Creative variant not found' });
  }
});

function sendDesignTemplateSvg(req, res) {
  try {
    const brief = buildBlankDesignBrief(req.params.key);
    const svg = renderBlankDesignSvg(req.params.key);
    res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${brief.files.svgFilename.replace(/"/g, '')}"`);
    res.send(svg);
  } catch (err) {
    res.status(404).send(err?.message || 'Design template not found');
  }
}

function sendDesignTemplateBrief(req, res) {
  try {
    const brief = buildBlankDesignBrief(req.params.key);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${brief.files.briefFilename.replace(/"/g, '')}"`);
    res.send(JSON.stringify(brief, null, 2));
  } catch (err) {
    res.status(404).json({ error: err?.message || 'Design template not found' });
  }
}

router.get('/marketing/design-templates/:key/download.svg', requireAdminAuth, sendDesignTemplateSvg);
router.get('/marketing/design-templates/:key/brief.json', requireAdminAuth, sendDesignTemplateBrief);
router.get('/marketing/blank-designs/:key/download.svg', requireAdminAuth, sendDesignTemplateSvg);
router.get('/marketing/blank-designs/:key/brief.json', requireAdminAuth, sendDesignTemplateBrief);

router.post('/marketing/content-packs/generate', requireAdminAuth, (req, res) => {
  try {
    const result = generateCreativeContentPack({
      packKey: req.body.packKey,
      assetId: req.body.assetId,
      countPerItem: req.body.countPerItem,
    });
    const duplicateText = result.skipped ? `, skipped ${result.skipped} duplicates` : '';
    const incompatibleText = result.incompatible?.length ? `, ignored ${result.incompatible.length} incompatible outputs` : '';
    res.redirect(`/admin/marketing?message=${encodeURIComponent(`${result.packLabel} generated ${result.count} variants from ${result.assetTitle}${duplicateText}${incompatibleText}`)}`);
  } catch (err) {
    res.redirect(`/admin/marketing?error=${encodeURIComponent(err?.message || 'Content pack generation failed')}`);
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

router.post('/marketing/recover-failed', requireAdminAuth, (req, res) => {
  const limit = Math.max(1, Math.min(50, Number(req.body.limit) || 10));
  try {
    const result = recoverFailedMarketingPosts({ limit });
    res.redirect(`/admin/marketing?message=${encodeURIComponent(`Moved ${result.count} failed post${result.count === 1 ? '' : 's'} back to draft`)}`);
  } catch (err) {
    res.redirect(`/admin/marketing?error=${encodeURIComponent(err?.message || 'Marketing recovery failed')}`);
  }
});

router.get('/codes', requireAdminAuth, (req, res) => {
  res.redirect('/admin');
});

export default router;
