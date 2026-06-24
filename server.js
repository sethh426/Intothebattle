import './loadEnv.js';
import { TikTokLive } from '@tiktool/live';
import express from 'express';
import cookieParser from 'cookie-parser';
import { createServer } from 'http';
import { Server } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';
import pino from 'pino';
import * as Sentry from '@sentry/node';
import { createClient as createRedisClient } from 'redis';
import { createAdapter } from '@socket.io/redis-adapter';
import promClient from 'prom-client';
import fs from 'fs';
import multer from 'multer';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import db, { getDbHealthSnapshot } from './tiktokbr/db/db.js';
import authRoutes from './tiktokbr/routes/auth.js';
import adminRoutes from './tiktokbr/routes/admin.js';
import paypalRoutes from './tiktokbr/routes/paypal.js';
import requireAccess from './tiktokbr/middleware/auth.js';
import requireDashboardAccess from './tiktokbr/middleware/requireDashboardAccess.js';
import { getE2EAuthRecord } from './tiktokbr/auth/e2eAuth.js';
import { getEmailDiagnostics, sendTransactionalEmail } from './tiktokbr/email/postmarkMailer.js';
import { setPlatformSponsorTestHandler } from './tiktokbr/platformSponsorTestBus.js';
import { getSponsorMediaToolStatus, processSponsorUpload } from './tiktokbr/sponsorMediaProcessor.js';
import {
  buildPlanEntitlements as buildSharedPlanEntitlements,
  isBetaTesterAccessCode,
  isPaidAccessCode as isSharedPaidAccessCode,
  isPaidAuthRecord,
} from './tiktokbr/services/entitlements.js';
import { buildLaunchReadinessReport } from './tiktokbr/services/launchReadiness.js';
import { buildUploadDecision, getStorageUsage, uploadLimitBytes } from './tiktokbr/services/storagePolicy.js';
import { growthIntegrationDiagnostics, syncLeadToGrowthApis } from './tiktokbr/services/growthIntegrations.js';
import { marketingAutomationDiagnostics, publishApprovedMarketingPosts, recordMarketingVisit } from './tiktokbr/services/marketingAutomation.js';
import {
  getOrCreateRoom,
  getRoom,
  getAllRooms,
  saveRoomSettings,
  getRoomPaths,
  DEFAULT_AUDIO_CONFIG,
  DEFAULT_OVERLAY_SETTINGS,
} from './roomManager.js';

const DEFAULT_ROOM_ID = 'default';
function getDefaultRoom() {
  return getOrCreateRoom(DEFAULT_ROOM_ID);
}

// Feature gate for room-scoped behavior. Production defaults to signed,
// room-scoped overlay access unless explicitly disabled.
const enableRoomScoped = process.env.ENABLE_ROOM_SCOPED == null
  ? process.env.NODE_ENV === 'production'
  : process.env.ENABLE_ROOM_SCOPED === 'true';

function requiresRoomId() {
  try {
    const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get('require_room_id');
    return row ? row.value !== '0' : true;
  } catch (err) {
    logger.error({ err }, 'Failed to read require_room_id; using default room requirement');
    return true;
  }
}

function getAuthRecord(token) {
  if (!token) return null;
  const e2eAuth = getE2EAuthRecord(token);
  if (e2eAuth) return e2eAuth;

  try {
    const accessCode = db.prepare('SELECT * FROM access_codes WHERE session_token = ?').get(token);
    if (accessCode) return { type: 'code', record: accessCode };
    const user = db.prepare('SELECT * FROM users WHERE session_token = ?').get(token);
    if (user) return { type: 'user', record: user };
  } catch (err) {
    logger.error({ err, token }, 'Auth lookup failed');
  }
  return null;
}

function getUserRoomId(userId) {
  try {
    const row = db.prepare('SELECT room_id FROM user_rooms WHERE user_id = ? ORDER BY id LIMIT 1').get(userId);
    return row ? row.room_id : null;
  } catch (err) {
    logger.error({ err, userId }, 'Failed to read user room assignment');
    return null;
  }
}

function getLatestUserSubscription(userId) {
  try {
    return db.prepare('SELECT * FROM subscriptions WHERE user_id = ? ORDER BY updated_at DESC LIMIT 1').get(userId);
  } catch (err) {
    logger.error({ err, userId }, 'Failed to read user subscription');
    return null;
  }
}

function createRoomId() {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 10);
}

function roomNameForOwner(name) {
  const owner = String(name || 'Creator').trim() || 'Creator';
  return `${owner}'s room`;
}

function ensureRoomSettingsRow(roomId) {
  if (!roomId) return;
  db.prepare('INSERT INTO room_settings (room_id) VALUES (?) ON CONFLICT (room_id) DO NOTHING').run(roomId);
}

function createPrivateRoomForUser(user) {
  if (!user?.id) return null;
  const roomId = createRoomId();
  db.prepare(
    'INSERT INTO user_rooms (user_id, room_id, room_name, created_at, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)'
  ).run(user.id, roomId, roomNameForOwner(user.name));
  ensureRoomSettingsRow(roomId);
  logger.warn({ userId: user.id, roomId }, 'Created missing private room for user account');
  return roomId;
}

function ensureUserRoomId(user) {
  if (!user?.id) return null;
  const existing = getUserRoomId(user.id);
  if (existing) return existing;
  try {
    return createPrivateRoomForUser(user);
  } catch (err) {
    logger.error({ err, userId: user.id }, 'Failed to create private user room');
    return null;
  }
}

function isPaidAccessCode(row) {
  return isSharedPaidAccessCode(row);
}

function isPaidAuth(auth) {
  return isPaidAuthRecord(auth, { getLatestUserSubscription });
}

function buildPlanEntitlements(auth) {
  return buildSharedPlanEntitlements(auth, { getLatestUserSubscription });
}

function logAuthInfo(req, extras = {}) {
  logger.info({
    path: req?.path,
    method: req?.method,
    tokenPresent: !!req?.cookies?.session_token,
    tokenLength: req?.cookies?.session_token ? String(req.cookies.session_token).length : 0,
    requiresRoomId: requiresRoomId(),
    ...extras,
  }, 'Auth info');
}

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });
if (process.env.SENTRY_DSN) {
  Sentry.init({ dsn: process.env.SENTRY_DSN });
  logger.info('Sentry initialized');
}

process.on('unhandledRejection', (reason, promise) => {
  logger.error({ reason }, 'Unhandled Promise Rejection');
});
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught Exception');
  process.exit(1);
});

const collectDefaultMetrics = promClient.collectDefaultMetrics;
const register = promClient.register;
collectDefaultMetrics({ prefix: 'tiktokbr_' });
const overlayGauge = new promClient.Gauge({ name: 'tiktokbr_overlay_count', help: 'Number of connected overlay clients' });
const playerGauge  = new promClient.Gauge({ name: 'tiktokbr_player_count',  help: 'Number of alive players' });

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const API_KEY = process.env.API_KEY;
let DEV_TEST_MODE = process.env.DEV_TEST_MODE === 'true';
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const OVERLAY_TOKEN_PARAM = 'overlay_token';
const OVERLAY_TOKEN_TTL = process.env.OVERLAY_TOKEN_TTL || '365d';
const STORAGE_ROOT = process.env.DISK_PATH || __dirname;
const PLATFORM_SPONSOR_DIR = path.join(STORAGE_ROOT, 'platform-sponsors');
const PLATFORM_SPONSOR_ENABLED = process.env.PLATFORM_SPONSOR_ENABLED !== 'false';
const PLATFORM_SPONSOR_INITIAL_DELAY_MS = Number(process.env.PLATFORM_SPONSOR_INITIAL_DELAY_MS || 8 * 60 * 1000);
const PLATFORM_SPONSOR_INTERVAL_MS = Number(process.env.PLATFORM_SPONSOR_INTERVAL_MS || 12 * 60 * 1000);
const PLATFORM_SPONSOR_ACTION_COOLDOWN_MS = Number(process.env.PLATFORM_SPONSOR_ACTION_COOLDOWN_MS || 45000);
const PLATFORM_SPONSOR_RETRY_DELAY_MS = Number(process.env.PLATFORM_SPONSOR_RETRY_DELAY_MS || 60000);
const PLATFORM_SPONSOR_INTENSE_WINDOW_MS = Number(process.env.PLATFORM_SPONSOR_INTENSE_WINDOW_MS || 30000);
const PLATFORM_SPONSOR_INTENSE_ACTION_LIMIT = Number(process.env.PLATFORM_SPONSOR_INTENSE_ACTION_LIMIT || 10);
const PLATFORM_SPONSOR_INTENSE_COOLDOWN_MS = Number(process.env.PLATFORM_SPONSOR_INTENSE_COOLDOWN_MS || 75000);
const PLATFORM_SPONSOR_COMPLETION_COOLDOWN_MS = Number(process.env.PLATFORM_SPONSOR_COMPLETION_COOLDOWN_MS || 3 * 60 * 1000);
const PLATFORM_SPONSOR_MIN_PLAYER_COUNT = Number(process.env.PLATFORM_SPONSOR_MIN_PLAYER_COUNT || 1);
const PLATFORM_SPONSOR_JITTER_MS = Number(process.env.PLATFORM_SPONSOR_JITTER_MS || 90000);
const PLATFORM_SPONSOR_NO_REPEAT_COUNT = Number(process.env.PLATFORM_SPONSOR_NO_REPEAT_COUNT || 3);
const PLATFORM_SPONSOR_ACTIVE_HOURS_UTC = String(process.env.PLATFORM_SPONSOR_ACTIVE_HOURS_UTC || '').trim();
const SPONSOR_PREPARE_TIMEOUT_MS = Number(process.env.SPONSOR_PREPARE_TIMEOUT_MS || 8000);
const SERVER_HORDE_ID = '__HORDE__';
const SERVER_BOSS_ID = '__BOSS__';
const BATTLE_ROUND_DURATION_MS = Number(process.env.BATTLE_ROUND_DURATION_MS || 4 * 60 * 1000);
const BOSS_WAVE_HP = Number(process.env.BOSS_WAVE_HP || 1200);
const BOSS_WAVE_DURATION_MS = Number(process.env.BOSS_WAVE_DURATION_MS || 90 * 1000);
const BOSS_WAVE_ATTACK_INTERVAL_MS = Number(process.env.BOSS_WAVE_ATTACK_INTERVAL_MS || 11 * 1000);
const BOSS_WAVE_ATTACK_DAMAGE = Number(process.env.BOSS_WAVE_ATTACK_DAMAGE || 18);
const configuredFreeTrialDays = Number(process.env.FREE_TRIAL_DAYS || 7);
const FREE_TRIAL_DAYS = Number.isFinite(configuredFreeTrialDays) && configuredFreeTrialDays > 0
  ? Math.round(configuredFreeTrialDays)
  : 7;
const platformSponsorTimers = new Map();
const sponsorBreaks = new Map();
const SPONSOR_FINAL_STATUSES = new Set(['completed', 'failed', 'stopped']);
const BATTLE_ACTION_EVENTS = new Set([
  'attack',
  'commentDamage',
  'giftAttack',
  'like',
  'heal',
  'killEvent',
  'streakEvent',
  'giftCelebration',
  'follow',
  'socialBoost',
  'engagementSurge',
  'bossWave',
]);
const HIGH_INTENSITY_BATTLE_EVENTS = new Set([
  'commentDamage',
  'giftAttack',
  'killEvent',
  'streakEvent',
  'giftCelebration',
  'engagementSurge',
  'bossWave',
]);
const MATCH_PHASES = Object.freeze({
  IDLE: 'idle',
  SETUP: 'setup',
  LIVE: 'live',
  BOSS_WAVE: 'bossWave',
  FINAL_RUSH: 'finalRush',
  RECAP: 'recap',
  RESET: 'reset',
});
const MATCH_PHASE_VALUES = new Set(Object.values(MATCH_PHASES));
const ROOM_EVENT_QUEUE_TYPES = new Set([
  'attack',
  'commentDamage',
  'giftAttack',
  'giftEffect',
  'giftCelebration',
  'like',
  'heal',
  'playerCommand',
  'killEvent',
  'streakEvent',
  'follow',
  'socialBoost',
  'engagementSurge',
  'bossWave',
  'respawn',
  'sponsorPrepare',
  'sponsorScene',
  'soundEvent',
]);
const ROOM_EVENT_QUEUE_MAX = 180;
const ROOM_EVENT_FLUSH_DELAY_MS = 18;
const ROOM_EVENT_LANE_BUDGETS = Object.freeze({
  exclusive: 2,
  state: 8,
  celebration: 3,
  gameplay: 8,
  ambient: 4,
  sound: 2,
});
const ROOM_EVENT_LANE_ORDER = ['exclusive', 'state', 'celebration', 'gameplay', 'ambient', 'sound'];

function getOverlayTokenSecret() {
  return process.env.OVERLAY_TOKEN_SECRET || process.env.JWT_SECRET || '';
}

function normalizeRoomId(value) {
  const roomId = String(value || '').trim();
  return /^[A-Za-z0-9_-]{1,80}$/.test(roomId) ? roomId : '';
}

function createOverlayToken(roomId) {
  const normalizedRoomId = normalizeRoomId(roomId);
  const secret = getOverlayTokenSecret();
  if (!normalizedRoomId || !secret) return '';
  return jwt.sign({ purpose: 'overlay', roomId: normalizedRoomId }, secret, { expiresIn: OVERLAY_TOKEN_TTL });
}

function verifyOverlayToken(roomId, token) {
  const normalizedRoomId = normalizeRoomId(roomId);
  if (!normalizedRoomId || !token) return false;
  try {
    const payload = jwt.verify(String(token), getOverlayTokenSecret());
    return payload?.purpose === 'overlay' && payload?.roomId === normalizedRoomId;
  } catch (_err) {
    return false;
  }
}

function getOverlayTokenFromRequest(req) {
  return req.query?.[OVERLAY_TOKEN_PARAM] || req.query?.overlayToken || '';
}

function getOverlayTokenFromSocket(socket) {
  return socket.handshake?.auth?.overlayToken
    || socket.handshake?.auth?.overlay_token
    || socket.handshake?.query?.[OVERLAY_TOKEN_PARAM]
    || socket.handshake?.query?.overlayToken
    || '';
}

function appendOverlayAuth(urlPath, roomId, token, extraParams = {}) {
  const url = new URL(urlPath, 'http://localhost');
  url.searchParams.set('room_id', roomId);
  url.searchParams.set(OVERLAY_TOKEN_PARAM, token);
  for (const [key, value] of Object.entries(extraParams)) {
    if (value != null && value !== '') url.searchParams.set(key, String(value));
  }
  return `${url.pathname}${url.search}`;
}

function buildOverlayUrl(req, roomId, overlayPath = '/overlay', extraParams = {}) {
  const normalizedRoomId = normalizeRoomId(roomId);
  const token = createOverlayToken(normalizedRoomId);
  if (!normalizedRoomId || !token) return null;

  const configuredBase = process.env.APP_BASE_URL;
  const inferredBase = req ? `${req.protocol}://${req.get('host')}` : `http://localhost:${PORT}`;
  const base = (configuredBase || inferredBase).replace(/\/$/, '');
  return `${base}${appendOverlayAuth(overlayPath, normalizedRoomId, token, extraParams)}`;
}

function publicBaseUrl(req = null) {
  const configuredBase = process.env.APP_BASE_URL;
  const inferredBase = req ? `${req.protocol}://${req.get('host')}` : `http://localhost:${PORT}`;
  return (configuredBase || inferredBase).replace(/\/$/, '');
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function cleanPublicText(value, maxLength = 140) {
  return String(value || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function cleanEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email.slice(0, 254) : '';
}

function validateRuntimeConfiguration() {
  const production = process.env.NODE_ENV === 'production';
  if (production && !process.env.JWT_SECRET) {
    logger.fatal('JWT_SECRET is required in production');
    process.exit(1);
  }
  if (production && enableRoomScoped && !getOverlayTokenSecret()) {
    logger.fatal('OVERLAY_TOKEN_SECRET or JWT_SECRET is required for room-scoped overlay URLs');
    process.exit(1);
  }
}

function checkWritableStorage(options = {}) {
  const requiredDirs = [
    STORAGE_ROOT,
    path.join(STORAGE_ROOT, 'backgrounds'),
    path.join(STORAGE_ROOT, 'audio'),
    path.join(STORAGE_ROOT, 'sponsors'),
    PLATFORM_SPONSOR_DIR,
  ];

  const result = {
    ok: true,
    mode: process.env.DISK_PATH ? 'persistent' : 'local',
    root: STORAGE_ROOT,
    dirs: requiredDirs.map(dir => ({ path: dir, exists: fs.existsSync(dir), writable: false })),
    error: null,
  };

  try {
    for (const [index, dir] of requiredDirs.entries()) {
      fs.mkdirSync(dir, { recursive: true });
      fs.accessSync(dir, fs.constants.W_OK);
      result.dirs[index] = { path: dir, exists: true, writable: true };
    }
    const probe = path.join(STORAGE_ROOT, `.write-test-${process.pid}`);
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
  } catch (err) {
    result.ok = false;
    result.error = err?.message || String(err);
  }
  if (options.includeUsage) {
    result.usage = getStorageUsage(STORAGE_ROOT);
  }
  return result;
}

function validateWritableStorage() {
  const storage = checkWritableStorage();
  if (!storage.ok) {
    const message = `DISK_PATH is not writable: ${STORAGE_ROOT}`;
    if (process.env.NODE_ENV === 'production') {
      logger.fatal({ err: storage.error, storageRoot: STORAGE_ROOT }, message);
      process.exit(1);
    }
    logger.warn({ err: storage.error, storageRoot: STORAGE_ROOT }, message);
  }
  logger.info({
    mode: storage.mode,
    root: storage.root,
    dirs: storage.dirs,
  }, 'Persistence storage check');
}

validateRuntimeConfiguration();
validateWritableStorage();

let currentStreamer = process.argv[2] || '';
let client = null;
const TIKTOK_AUTO_RECONNECT = process.env.TIKTOK_AUTO_RECONNECT == null
  ? true
  : process.env.TIKTOK_AUTO_RECONNECT === 'true';
const TIKTOK_MAX_RECONNECT_ATTEMPTS = Math.max(0, Number(process.env.TIKTOK_MAX_RECONNECT_ATTEMPTS || 3));
const TIKTOK_HEARTBEAT_MS = Math.max(5000, Number(process.env.TIKTOK_HEARTBEAT_MS || 10000));

const CFG = {
  BASE_HP:                        300,
  BASE_STRENGTH:                   15,
  CHAT_STRENGTH_BOOST:              1,
  LIKE_HP_BOOST:                    2,
  SOCIAL_STRENGTH_BOOST:            5,
  FOLLOW_HP_BOOST:                  45,
  FOLLOW_STR_BOOST:                  2,
  FOLLOW_SHIELD_MS:              20000,
  SHARE_RALLY_HEAL:                 24,
  SHARE_STR_BOOST:                   7,
  SHARE_BOSS_MULTIPLIER:          0.65,
  REPOST_RALLY_HEAL:                38,
  REPOST_STR_BOOST:                 12,
  REPOST_SHIELD_MS:              18000,
  REPOST_BOSS_MULTIPLIER:          1.2,
  ENGAGEMENT_COMBO_WINDOW_MS:    30000,
  ENGAGEMENT_SURGE_COOLDOWN_MS:  12000,
  GIFT_HP_PER_DIAMOND:              3,
  GIFT_STR_PER_DIAMOND:             1,
  GIFT_MESSAGE_BOOST_MULTIPLIER:    3,
  GIFT_MESSAGE_BOOST_DURATION_MS: 45000,
  MESSAGE_LASER_MULTIPLIER:       1.5,
  ATTACK_VARIANCE:                0.4,
  RESPAWN_DELAY_MS:             60000,
  IDLE_TIMEOUT_MS:             600000,
  RESET_TIMEOUT_MS:            300000,
  SPECIAL_ATTACK_MULTIPLIER:        5,
  STREAK_LABELS: {
    3:  { label: 'TRIPLE KILL',   color: '#FFD93D', scale: 1.2 },
    5:  { label: 'RAMPAGE',       color: '#FF6B6B', scale: 1.4 },
    10: { label: 'UNSTOPPABLE',   color: '#C77DFF', scale: 1.6 },
    20: { label: 'GODLIKE',       color: '#FF9F43', scale: 2.0 },
  },
  GIFT_TIER_LEGENDARY: 1000,
  GIFT_TIER_RARE:       100,
  GIFT_TIER_UNCOMMON:    20,
  CRITICAL_HIT_THRESHOLD: 0.6,
};

const likeRateTracker = {};

// ────────────────────────────────
// CENTRAL EVENT DISPATCHER
// ────────────────────────────────
function emitEvent(type, payload = {}) {
  try {
    io.emit(type, { ...payload, _ts: Date.now() });
  } catch (err) {
    logger.error({ err, type }, 'emitEvent failed');
  }
}

function recordRoomBattleAction(room, type) {
  if (!room || !BATTLE_ACTION_EVENTS.has(type)) return;
  const now = Date.now();
  const schedule = getPlatformSponsorScheduleSettings();
  room.lastBattleActionAt = now;
  room.recentBattleActionAt = (room.recentBattleActionAt || [])
    .filter(timestamp => now - timestamp <= schedule.intenseWindowMs);
  room.recentBattleActionAt.push(now);
  if (HIGH_INTENSITY_BATTLE_EVENTS.has(type)) {
    room.lastHighIntensityBattleAt = now;
  }
}

function sanitizeMatchPhase(value, fallback = MATCH_PHASES.IDLE) {
  const phase = String(value || '').trim();
  return MATCH_PHASE_VALUES.has(phase) ? phase : fallback;
}

function currentRoomSessionId(room) {
  return room?.liveSession?.sessionId || room?.tiktokConnection?.sessionId || null;
}

function currentRoomPhase(room) {
  if (room?.matchLifecycle?.phase) return sanitizeMatchPhase(room.matchLifecycle.phase);
  if (room?.bossWave?.active) return MATCH_PHASES.BOSS_WAVE;
  if (room?.liveSession?.status === 'active') return MATCH_PHASES.LIVE;
  if (room?.lastSessionRecap) return MATCH_PHASES.RECAP;
  return MATCH_PHASES.IDLE;
}

function setRoomMatchPhase(room, phase, reason = '', detail = {}) {
  if (!room?.roomId) return null;
  const safePhase = sanitizeMatchPhase(phase, MATCH_PHASES.IDLE);
  room.matchLifecycle = {
    phase: safePhase,
    reason: String(reason || '').slice(0, 80),
    sessionId: detail.sessionId || currentRoomSessionId(room),
    updatedAt: Date.now(),
    detail: detail.detail || null,
  };
  return room.matchLifecycle;
}

function roomRuntimeEpoch(room) {
  if (!room) return 0;
  if (!Number.isFinite(Number(room.runtimeEpoch))) room.runtimeEpoch = 1;
  return room.runtimeEpoch;
}

function clearRoomEventQueue(room) {
  if (!room) return;
  if (room.eventQueueTimer) {
    clearTimeout(room.eventQueueTimer);
    room.eventQueueTimer = null;
  }
  room.eventQueue = [];
}

function advanceRoomRuntimeEpoch(room, reason = 'reset') {
  if (!room) return 0;
  clearRoomEventQueue(room);
  room.runtimeEpoch = roomRuntimeEpoch(room) + 1;
  setRoomMatchPhase(room, MATCH_PHASES.RESET, reason);
  return room.runtimeEpoch;
}

function roomEventLane(type, payload = {}) {
  if (type === 'sponsorPrepare' || type === 'sponsorScene') return 'exclusive';
  if (type === 'soundEvent') return 'sound';
  if (type === 'like' || type === 'giftEffect') return 'ambient';
  if (type === 'killEvent' || type === 'streakEvent' || type === 'giftCelebration' || type === 'follow' || type === 'engagementSurge') return 'celebration';
  if (type === 'bossWave') return ['started', 'defeated', 'expired', 'ended'].includes(payload?.type) ? 'celebration' : 'gameplay';
  return 'gameplay';
}

function roomEventPriority(type, payload = {}) {
  if (type === 'sponsorScene') return payload.action === 'hide' ? 125 : 120;
  if (type === 'sponsorPrepare') return 112;
  if (type === 'bossWave') return payload.type === 'defeated' ? 104 : payload.type === 'started' ? 98 : 86;
  if (type === 'killEvent' || type === 'streakEvent') return 94;
  if (type === 'giftCelebration' || type === 'engagementSurge') return 88;
  if (type === 'giftAttack') return 82;
  if (type === 'attack' || type === 'commentDamage') return payload.critical || payload.killed ? 78 : 68;
  if (type === 'follow' || type === 'socialBoost' || type === 'playerCommand') return 62;
  if (type === 'heal' || type === 'respawn') return 58;
  if (type === 'like') return payload.milestone ? 55 : 34;
  if (type === 'soundEvent') return Number(payload.priority) || 30;
  return 50;
}

function roomEventTtl(type) {
  if (type === 'sponsorPrepare' || type === 'sponsorScene') return 120000;
  if (type === 'bossWave') return 30000;
  if (type === 'attack' || type === 'commentDamage' || type === 'giftAttack') return 9000;
  if (type === 'like' || type === 'soundEvent') return 3500;
  return 15000;
}

function roomEventMergeKey(type, payload = {}) {
  if (type === 'soundEvent') return `sound:${payload.event || 'sound'}`;
  if (type === 'like' && payload.milestone) return `like:${payload.milestone}`;
  if (type === 'sponsorPrepare' || type === 'sponsorScene') return `${type}:${payload.breakId || payload.filename || payload.action || 'active'}`;
  if (type === 'bossWave' && payload.type !== 'attack') return `boss:${payload.type || 'status'}`;
  if (type === 'playerCommand') return `cmd:${payload.type || 'command'}:${payload.uniqueId || payload.nickname || ''}`;
  return '';
}

function roomEventEnvelope(room, type, payload = {}, meta = {}) {
  return {
    ...payload,
    _ts: Date.now(),
    _seq: meta.seq,
    _event: type,
    _sessionId: meta.sessionId || currentRoomSessionId(room),
    _phase: currentRoomPhase(room),
    _epoch: roomRuntimeEpoch(room),
    _priority: meta.priority,
    _lane: meta.lane,
  };
}

function dispatchRoomEvent(room, type, payload = {}, meta = {}) {
  try {
    recordRoomBattleAction(room, type);
    room.eventSeq = (room.eventSeq || 0) + 1;
    if (type === 'gameState') {
      io.to(room.roomId).emit(type, payload);
      return;
    }
    const priority = meta.priority == null ? roomEventPriority(type, payload) : meta.priority;
    const lane = meta.lane || roomEventLane(type, payload);
    io.to(room.roomId).emit(type, roomEventEnvelope(room, type, payload, {
      ...meta,
      seq: room.eventSeq,
      priority,
      lane,
    }));
  } catch (err) {
    logger.error({ err, type, room: room?.roomId }, 'emitRoomEvent failed');
  }
}

function scheduleRoomEventQueue(room) {
  if (!room || room.eventQueueTimer) return;
  room.eventQueueTimer = setTimeout(() => {
    room.eventQueueTimer = null;
    processRoomEventQueue(room);
  }, ROOM_EVENT_FLUSH_DELAY_MS);
  if (typeof room.eventQueueTimer.unref === 'function') room.eventQueueTimer.unref();
}

function processRoomEventQueue(room) {
  if (!room?.eventQueue?.length) return;
  const now = Date.now();
  const epoch = roomRuntimeEpoch(room);
  const budgets = { ...ROOM_EVENT_LANE_BUDGETS };
  const pending = room.eventQueue
    .filter(item => item.epoch === epoch && now - item.createdAt <= item.ttlMs)
    .sort((a, b) => (b.priority - a.priority) || (a.createdAt - b.createdAt));

  const remaining = [];
  let emitted = 0;
  const maxThisFlush = ROOM_EVENT_LANE_ORDER.reduce((sum, lane) => sum + (budgets[lane] || 0), 0);

  for (const item of pending) {
    const lane = item.lane || 'gameplay';
    if (emitted < maxThisFlush && (budgets[lane] || 0) > 0) {
      budgets[lane] -= 1;
      emitted += 1;
      dispatchRoomEvent(room, item.type, item.payload, {
        priority: item.priority,
        lane,
        sessionId: item.sessionId,
      });
    } else {
      remaining.push(item);
    }
  }

  room.eventQueue = remaining;
  if (room.eventQueue.length) scheduleRoomEventQueue(room);
}

function enqueueRoomEvent(room, type, payload = {}, options = {}) {
  if (!room?.roomId) return;
  if (!Array.isArray(room.eventQueue)) room.eventQueue = [];

  const lane = options.lane || roomEventLane(type, payload);
  const priority = options.priority == null ? roomEventPriority(type, payload) : options.priority;
  const mergeKey = options.mergeKey === undefined ? roomEventMergeKey(type, payload) : options.mergeKey;
  const item = {
    type,
    payload,
    lane,
    priority,
    mergeKey,
    sessionId: options.sessionId || currentRoomSessionId(room),
    epoch: roomRuntimeEpoch(room),
    ttlMs: Math.max(1000, Number(options.ttlMs) || roomEventTtl(type)),
    createdAt: Date.now(),
  };

  if (mergeKey) {
    const existingIndex = room.eventQueue.findIndex(existing => existing.type === type && existing.mergeKey === mergeKey);
    if (existingIndex >= 0) room.eventQueue.splice(existingIndex, 1);
  }

  room.eventQueue.push(item);
  if (room.eventQueue.length > ROOM_EVENT_QUEUE_MAX) {
    room.eventQueue.sort((a, b) => (a.priority - b.priority) || (a.createdAt - b.createdAt));
    room.eventQueue.splice(0, room.eventQueue.length - ROOM_EVENT_QUEUE_MAX);
  }
  scheduleRoomEventQueue(room);
}

function emitRoomEvent(room, type, payload = {}, options = {}) {
  if (!room?.roomId) return;
  if (options.immediate || !ROOM_EVENT_QUEUE_TYPES.has(type)) {
    dispatchRoomEvent(room, type, payload, options);
    return;
  }
  enqueueRoomEvent(room, type, payload, options);
}

function createSponsorBreakId(source = 'sponsor') {
  return `${String(source || 'sponsor').replace(/[^a-z0-9_-]/gi, '').slice(0, 24) || 'sponsor'}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function sanitizeSponsorEventType(value) {
  const eventType = String(value || '').trim().toLowerCase();
  return /^[a-z0-9_-]{1,40}$/.test(eventType) ? eventType : 'unknown';
}

function sponsorBreakStatusPayload(record, status, detail = {}) {
  return {
    breakId: record.breakId,
    sessionId: record.sessionId || null,
    status,
    source: record.source,
    creativeId: record.creativeId || null,
    filename: record.filename || null,
    title: record.payload?.title || '',
    partner: record.payload?.partner || '',
    message: detail.message || '',
    detail: detail.detail || '',
    startedAt: record.startedAt || null,
    requestedAt: record.requestedAt || null,
    decodedAt: record.decodedAt || null,
    readyAt: record.readyAt || null,
    firstFrameAt: record.firstFrameAt || null,
  };
}

function emitSponsorBreakStatus(room, record, status, detail = {}) {
  if (!room || !record) return;
  emitRoomEvent(room, 'sponsorBreakStatus', sponsorBreakStatusPayload(record, status, detail));
}

function recordSponsorPlaybackEvent(record, eventType, detail = null) {
  if (!record?.breakId) return;
  const normalizedEvent = sanitizeSponsorEventType(eventType);
  let detailText = '';
  if (detail != null) {
    try {
      detailText = typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 1000);
    } catch (_err) {
      detailText = String(detail).slice(0, 1000);
    }
  }

  try {
    db.prepare(`
      INSERT INTO sponsor_playback_events
        (break_id, room_id, source, creative_id, filename, event_type, detail, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `).run(
      record.breakId,
      record.roomId || null,
      record.source || 'creator',
      record.creativeId || null,
      record.filename || null,
      normalizedEvent,
      detailText || null
    );
  } catch (err) {
    logger.warn({ err, eventType: normalizedEvent, breakId: record.breakId }, 'Failed to record sponsor playback event');
  }
}

function updatePlatformSponsorCreativeMetric(record, metric) {
  if (!record || record.source !== 'platform' || !record.creativeId) return;
  try {
    if (metric === 'started' && !record.impressionRecorded) {
      record.impressionRecorded = true;
      db.prepare(`
        UPDATE platform_sponsor_creatives
        SET impressions = COALESCE(impressions, 0) + 1,
            last_shown_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(record.creativeId);
    } else if (metric === 'completed' && !record.completionRecorded && !record.failureRecorded) {
      record.completionRecorded = true;
      db.prepare(`
        UPDATE platform_sponsor_creatives
        SET completions = COALESCE(completions, 0) + 1,
            last_completed_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(record.creativeId);
    } else if (metric === 'failed' && !record.failureRecorded && !record.completionRecorded) {
      record.failureRecorded = true;
      db.prepare(`
        UPDATE platform_sponsor_creatives
        SET failures = COALESCE(failures, 0) + 1,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(record.creativeId);
    }
  } catch (err) {
    logger.warn({ err, creativeId: record.creativeId, metric }, 'Failed to update sponsor creative metric');
  }
}

function updatePlatformSponsorCreativeReadiness(record, readinessStatus) {
  if (!record || record.source !== 'platform' || !record.creativeId) return;
  const status = ['ready', 'tested', 'failed'].includes(readinessStatus) ? readinessStatus : 'ready';
  const timestampColumn = status === 'tested'
    ? ', last_tested_at = CURRENT_TIMESTAMP'
    : status === 'failed'
      ? ', last_failed_at = CURRENT_TIMESTAMP'
      : '';
  try {
    db.prepare(`
      UPDATE platform_sponsor_creatives
      SET readiness_status = ?,
          updated_at = CURRENT_TIMESTAMP
          ${timestampColumn}
      WHERE id = ?
    `).run(status, record.creativeId);
  } catch (err) {
    logger.warn({ err, creativeId: record.creativeId, readinessStatus: status }, 'Failed to update sponsor creative readiness');
  }
}

function updateRoomSponsorCreativeStatus(room, filename, patch = {}) {
  if (!room?.roomId || !filename) return;
  try {
    loadRoomSponsorConfig(room);
    const item = (room.sponsorLibrary || []).find(entry => entry.filename === filename);
    if (!item) return;
    Object.assign(item, patch, { updatedAt: new Date().toISOString() });
    saveRoomSponsorConfig(room);
  } catch (err) {
    logger.warn({ err, roomId: room.roomId, filename }, 'Failed to update creator sponsor creative status');
  }
}

function cleanupSponsorBreakLater(breakId) {
  const record = sponsorBreaks.get(breakId);
  if (!record) return;
  if (record.prepareTimer) clearTimeout(record.prepareTimer);
  if (record.cleanupTimer) clearTimeout(record.cleanupTimer);
  record.cleanupTimer = setTimeout(() => {
    const latest = sponsorBreaks.get(breakId);
    if (latest && latest.cleanupTimer === record.cleanupTimer) sponsorBreaks.delete(breakId);
  }, 120000);
  if (typeof record.cleanupTimer.unref === 'function') record.cleanupTimer.unref();
}

function roomHasActiveSponsorBreak(roomId) {
  return Array.from(sponsorBreaks.values()).some(record => (
    record.roomId === roomId && !SPONSOR_FINAL_STATUSES.has(record.status)
  ));
}

function getAlivePlayerCount(room) {
  return Object.values(room?.players || {}).filter(player => player?.alive).length;
}

function appSettingValue(key, fallback = '') {
  try {
    const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key);
    return row?.value ?? fallback;
  } catch (_err) {
    return fallback;
  }
}

function appSettingNumber(key, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const value = Number(appSettingValue(key, fallback));
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.round(value)));
}

function getPlatformSponsorScheduleSettings() {
  return {
    initialDelayMs: appSettingNumber('platform_sponsor_initial_delay_ms', PLATFORM_SPONSOR_INITIAL_DELAY_MS, 5000),
    intervalMs: appSettingNumber('platform_sponsor_interval_ms', PLATFORM_SPONSOR_INTERVAL_MS, 30000),
    actionCooldownMs: appSettingNumber('platform_sponsor_action_cooldown_ms', PLATFORM_SPONSOR_ACTION_COOLDOWN_MS, 0),
    retryDelayMs: appSettingNumber('platform_sponsor_retry_delay_ms', PLATFORM_SPONSOR_RETRY_DELAY_MS, 5000),
    intenseWindowMs: appSettingNumber('platform_sponsor_intense_window_ms', PLATFORM_SPONSOR_INTENSE_WINDOW_MS, 5000),
    intenseActionLimit: appSettingNumber('platform_sponsor_intense_action_limit', PLATFORM_SPONSOR_INTENSE_ACTION_LIMIT, 1),
    intenseCooldownMs: appSettingNumber('platform_sponsor_intense_cooldown_ms', PLATFORM_SPONSOR_INTENSE_COOLDOWN_MS, 0),
    completionCooldownMs: appSettingNumber('platform_sponsor_completion_cooldown_ms', PLATFORM_SPONSOR_COMPLETION_COOLDOWN_MS, 0),
    minPlayerCount: appSettingNumber('platform_sponsor_min_player_count', PLATFORM_SPONSOR_MIN_PLAYER_COUNT, 0, 100),
    jitterMs: appSettingNumber('platform_sponsor_jitter_ms', PLATFORM_SPONSOR_JITTER_MS, 0),
    noRepeatCount: appSettingNumber('platform_sponsor_no_repeat_count', PLATFORM_SPONSOR_NO_REPEAT_COUNT, 1, 50),
    activeHoursUtc: String(appSettingValue('platform_sponsor_active_hours_utc', PLATFORM_SPONSOR_ACTIVE_HOURS_UTC)).trim(),
  };
}

function isRoomInSponsorCooldown(room, settings = getPlatformSponsorScheduleSettings()) {
  if (!room?.lastBattleActionAt) return false;
  return Date.now() - room.lastBattleActionAt < settings.actionCooldownMs;
}

function isWithinPlatformSponsorActiveHours(now = new Date(), settings = getPlatformSponsorScheduleSettings()) {
  if (!settings.activeHoursUtc) return true;
  const hour = now.getUTCHours() + now.getUTCMinutes() / 60;
  return settings.activeHoursUtc.split(',')
    .map(part => part.trim())
    .filter(Boolean)
    .some(range => {
      const [startRaw, endRaw] = range.split('-').map(value => Number(value));
      if (!Number.isFinite(startRaw) || !Number.isFinite(endRaw)) return false;
      const start = Math.max(0, Math.min(24, startRaw));
      const end = Math.max(0, Math.min(24, endRaw));
      if (start === end) return true;
      if (start < end) return hour >= start && hour < end;
      return hour >= start || hour < end;
    });
}

function platformSponsorDelay(baseDelayMs = null, jitter = true, settings = getPlatformSponsorScheduleSettings()) {
  const base = Math.max(5000, Number(baseDelayMs) || settings.intervalMs);
  const jitterMs = jitter ? Math.max(0, settings.jitterMs) : 0;
  return base + (jitterMs ? Math.floor(Math.random() * jitterMs) : 0);
}

function getRecentPlatformSponsorCreativeIds(room) {
  return (room?.platformSponsorCreativeHistory || [])
    .map(id => Number(id))
    .filter(id => Number.isFinite(id));
}

function rememberPlatformSponsorCreative(room, creativeId) {
  if (!room || !creativeId) return;
  const id = Number(creativeId);
  if (!Number.isFinite(id)) return;
  const history = [id, ...getRecentPlatformSponsorCreativeIds(room).filter(item => item !== id)];
  const maxHistory = Math.max(1, getPlatformSponsorScheduleSettings().noRepeatCount);
  room.platformSponsorCreativeHistory = history.slice(0, maxHistory);
  room.lastPlatformSponsorCreativeId = id;
  room.lastPlatformSponsorAt = Date.now();
}

function getRoomSponsorPacingDecision(room) {
  const settings = getPlatformSponsorScheduleSettings();
  if (!room?.roomId) return { ok: false, reason: 'missing_room', retryMs: settings.retryDelayMs };
  if ((room.overlayCount || 0) <= 0) return { ok: false, reason: 'no_overlay', retryMs: settings.retryDelayMs };
  if (room.liveSession?.status !== 'active') return { ok: false, reason: 'no_active_session', retryMs: settings.retryDelayMs };
  if ([MATCH_PHASES.SETUP, MATCH_PHASES.RECAP, MATCH_PHASES.RESET, MATCH_PHASES.IDLE].includes(currentRoomPhase(room))) {
    return { ok: false, reason: 'session_not_playing', retryMs: settings.retryDelayMs };
  }
  if (roomHasActiveSponsorBreak(room.roomId)) return { ok: false, reason: 'active_break', retryMs: settings.retryDelayMs };
  if (!isWithinPlatformSponsorActiveHours(new Date(), settings)) return { ok: false, reason: 'outside_active_hours', retryMs: settings.intervalMs };

  const alivePlayers = getAlivePlayerCount(room);
  if (alivePlayers < Math.max(0, settings.minPlayerCount)) {
    return { ok: false, reason: 'not_enough_players', retryMs: settings.retryDelayMs, alivePlayers };
  }

  const now = Date.now();
  const recentBattleActions = (room.recentBattleActionAt || [])
    .filter(timestamp => now - timestamp <= settings.intenseWindowMs);
  room.recentBattleActionAt = recentBattleActions;

  if (isRoomInSponsorCooldown(room, settings)) {
    return { ok: false, reason: 'battle_action_cooldown', retryMs: settings.retryDelayMs, recentBattleActions: recentBattleActions.length };
  }

  if (recentBattleActions.length >= settings.intenseActionLimit) {
    return { ok: false, reason: 'battle_intensity', retryMs: settings.intenseCooldownMs, recentBattleActions: recentBattleActions.length };
  }

  if (room.lastHighIntensityBattleAt && now - room.lastHighIntensityBattleAt < settings.intenseCooldownMs) {
    return { ok: false, reason: 'high_intensity_cooldown', retryMs: settings.intenseCooldownMs };
  }

  if (room.lastSponsorCompletedAt && now - room.lastSponsorCompletedAt < settings.completionCooldownMs) {
    return { ok: false, reason: 'completion_cooldown', retryMs: settings.completionCooldownMs };
  }

  if (room.lastSponsorFailedAt && now - room.lastSponsorFailedAt < settings.retryDelayMs) {
    return { ok: false, reason: 'failure_backoff', retryMs: settings.retryDelayMs };
  }

  return { ok: true, reason: 'ready', alivePlayers, recentBattleActions: recentBattleActions.length };
}

function clampSessionNumber(value, fallback, min, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, Math.round(numeric)));
}

function sessionIdForRoom(room) {
  return `session-${room.roomId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function roomAlivePlayers(room) {
  return Object.values(room?.players || {}).filter(player => player?.alive);
}

function topSessionPlayers(room, limit = 5) {
  return getTopPlayers(room, limit).map(player => ({
    uniqueId: player.uniqueId,
    nickname: player.nickname || player.uniqueId,
    hp: Math.round(Number(player.hp) || 0),
    maxHp: Math.round(Number(player.maxHp) || CFG.BASE_HP),
    strength: Math.round(Number(player.strength) || CFG.BASE_STRENGTH),
    kills: Number(player.kills) || 0,
    alive: Boolean(player.alive),
  }));
}

function viewerCommandText() {
  return [
    '!join - enter the arena',
    '!emoji <symbol> - change your fighter icon',
    '!shield - reduce incoming damage',
    '!heal @name - restore a fighter',
    '!laser @name - quick cyber attack',
    '!fire @name - heavy fire attack',
    '!fire @boss - damage the boss wave when active',
  ].join('\n');
}

function buildSessionRecap(room, session, reason = 'manual_end') {
  const topPlayers = topSessionPlayers(room, 5);
  const startedAt = Number(session?.startedAt) || Date.now();
  const endedAt = Date.now();
  const roundsCompleted = Number(session?.roundsCompleted) || 0;
  const bossDefeats = Number(session?.bossDefeats) || 0;
  const totalKills = roomAlivePlayers(room).reduce((sum, player) => sum + (Number(player.kills) || 0), 0);
  return {
    reason,
    sessionId: session?.sessionId || '',
    shareUrl: session?.sessionId ? `${publicBaseUrl()}/battle-recap/${encodeURIComponent(session.sessionId)}` : '',
    startedAt,
    endedAt,
    durationMs: Math.max(0, endedAt - startedAt),
    roundsCompleted,
    bossDefeats,
    totalKills,
    activePlayers: roomAlivePlayers(room).length,
    winner: topPlayers[0] || null,
    topPlayers,
  };
}

function persistLiveSessionStart(room, session) {
  if (!room?.roomId || !session?.sessionId) return;
  try {
    db.prepare(`
      INSERT INTO live_sessions (session_id, room_id, status, started_at, summary_json, updated_at)
      VALUES (?, ?, 'active', CURRENT_TIMESTAMP, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(session_id) DO UPDATE SET
        status = 'active',
        updated_at = CURRENT_TIMESTAMP
    `).run(session.sessionId, room.roomId, JSON.stringify({ source: 'dashboard' }));
  } catch (err) {
    logger.warn({ err, roomId: room.roomId, sessionId: session.sessionId }, 'Failed to persist live session start');
  }
}

function persistLiveSessionEnd(room, recap) {
  if (!room?.roomId || !recap?.sessionId) return;
  try {
    db.prepare(`
      UPDATE live_sessions
      SET status = 'ended',
          ended_at = CURRENT_TIMESTAMP,
          summary_json = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE session_id = ?
    `).run(JSON.stringify(recap), recap.sessionId);
  } catch (err) {
    logger.warn({ err, roomId: room.roomId, sessionId: recap.sessionId }, 'Failed to persist live session recap');
  }
}

function parseSessionSummary(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (_err) {
    return null;
  }
}

function getPublicSessionRecap(sessionId, req = null) {
  const safeSessionId = cleanPublicText(sessionId, 180);
  if (!safeSessionId) return null;
  try {
    const row = db.prepare(`
      SELECT session_id, room_id, status, started_at, ended_at, summary_json
      FROM live_sessions
      WHERE session_id = ? AND status = 'ended'
      LIMIT 1
    `).get(safeSessionId);
    if (!row) return null;
    const summary = parseSessionSummary(row.summary_json) || {};
    return {
      sessionId: row.session_id,
      roomId: row.room_id,
      startedAt: summary.startedAt || row.started_at || null,
      endedAt: summary.endedAt || row.ended_at || null,
      durationMs: Number(summary.durationMs) || 0,
      roundsCompleted: Number(summary.roundsCompleted) || 0,
      bossDefeats: Number(summary.bossDefeats) || 0,
      totalKills: Number(summary.totalKills) || 0,
      activePlayers: Number(summary.activePlayers) || 0,
      winner: summary.winner || null,
      topPlayers: Array.isArray(summary.topPlayers) ? summary.topPlayers.slice(0, 5) : [],
      shareUrl: `${publicBaseUrl(req)}/battle-recap/${encodeURIComponent(row.session_id)}`,
    };
  } catch (err) {
    logger.warn({ err, sessionId: safeSessionId }, 'Failed to read public session recap');
    return null;
  }
}

function formatRecapClock(ms) {
  const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function renderBattleRecapPage(recap) {
  const winner = recap.winner?.nickname || recap.winner?.uniqueId || 'Arena still deciding';
  const topPlayers = (recap.topPlayers || []).map((player, index) => `
    <div class="fighter-row">
      <span>#${index + 1}</span>
      <strong>${escapeHtml(player.nickname || player.uniqueId || 'Player')}</strong>
      <b>${escapeHtml(String(Number(player.kills) || 0))} K</b>
    </div>
  `).join('');
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Battle Recap - IntoTheBattle</title>
  <meta name="robots" content="noindex, follow" />
  <link rel="icon" href="/intothebattlelogo_logo_only.svg" />
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{min-height:100vh;display:grid;place-items:center;padding:24px;font-family:Inter,system-ui,sans-serif;color:#fff8e6;background:radial-gradient(circle at 18% 0,rgba(246,201,91,.2),transparent 30%),radial-gradient(circle at 84% 20%,rgba(232,59,95,.16),transparent 30%),linear-gradient(180deg,#050608,#030406)}
    main{width:min(920px,100%);display:grid;gap:18px}
    .card{border:1px solid rgba(246,201,91,.22);border-radius:8px;background:rgba(5,7,11,.82);box-shadow:0 32px 90px rgba(0,0,0,.5);padding:clamp(24px,5vw,44px)}
    .brand{display:flex;align-items:center;gap:12px;margin-bottom:24px;color:#ffdf8a;font-weight:950;text-transform:uppercase;letter-spacing:.1em}.brand img{width:52px;height:52px}
    h1{font-size:clamp(42px,7vw,82px);line-height:.92;text-transform:uppercase;margin-bottom:16px}h1 span{display:block;color:#f6c95b}
    .lede{color:#c4ccdb;line-height:1.7;font-size:18px;margin-bottom:26px}
    .stats{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:18px}.stat,.fighter-row{border:1px solid rgba(255,255,255,.1);background:rgba(255,255,255,.045);border-radius:8px;padding:16px}.stat span{display:block;color:#a8afbf;font-size:12px;font-weight:900;text-transform:uppercase;letter-spacing:.08em}.stat strong{display:block;margin-top:8px;font-size:28px}
    .fighters{display:grid;gap:10px}.fighter-row{display:grid;grid-template-columns:44px 1fr auto;gap:12px;align-items:center}.fighter-row span{color:#55e7ff;font-weight:950}.fighter-row b{color:#ffdf8a}
    .actions{display:flex;gap:12px;flex-wrap:wrap;margin-top:24px}.btn{display:inline-flex;align-items:center;justify-content:center;min-height:50px;padding:0 18px;border-radius:8px;font-weight:950;text-decoration:none}.primary{color:#170c02;background:linear-gradient(135deg,#f6c95b,#fff0b9 52%,#ff6a3d)}.secondary{color:#fff;border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.06)}
    @media(max-width:720px){.stats{grid-template-columns:1fr 1fr}.fighter-row{grid-template-columns:34px 1fr auto}}
  </style>
</head>
<body>
  <main>
    <section class="card">
      <div class="brand"><img src="/intothebattlelogo_logo_only.svg" alt="" />IntoTheBattle recap</div>
      <h1>${escapeHtml(winner)} <span>won the arena.</span></h1>
      <p class="lede">A TikTok LIVE battle just wrapped. Viewers joined, attacked, powered up, and pushed the room through a playable stream moment.</p>
      <div class="stats">
        <div class="stat"><span>Duration</span><strong>${escapeHtml(formatRecapClock(recap.durationMs))}</strong></div>
        <div class="stat"><span>Rounds</span><strong>${escapeHtml(String(recap.roundsCompleted))}</strong></div>
        <div class="stat"><span>Boss clears</span><strong>${escapeHtml(String(recap.bossDefeats))}</strong></div>
        <div class="stat"><span>Players</span><strong>${escapeHtml(String(recap.activePlayers))}</strong></div>
      </div>
      <div class="fighters">${topPlayers || '<div class="fighter-row"><span>#</span><strong>No fighters recorded</strong><b>0 K</b></div>'}</div>
      <div class="actions"><a class="btn primary" href="/signup">Create your arena</a><a class="btn secondary" href="/how-to-play">See how players join</a></div>
    </section>
  </main>
</body>
</html>`;
}

function listPublicCreatorComments(limit = 12) {
  const safeLimit = Math.max(1, Math.min(30, Number(limit) || 12));
  try {
    return db.prepare(`
      SELECT id, name, role, comment, created_at
      FROM creator_comments
      WHERE COALESCE(status, 'approved') = 'approved'
        AND deleted_at IS NULL
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all(safeLimit).map(row => ({
      id: row.id,
      name: row.name || 'Creator',
      role: row.role || 'TikTok LIVE creator',
      comment: row.comment,
      createdAt: row.created_at,
    }));
  } catch (err) {
    logger.warn({ err }, 'Failed to load public creator comments');
    return [];
  }
}

function upsertSignupIntent({ email, name = '', tiktokUsername = '', source = 'signup', lastPath = '' } = {}) {
  const normalizedEmail = cleanEmail(email);
  if (!normalizedEmail) return { ok: false, error: 'Enter a valid email address.' };
  const cleanedName = cleanPublicText(name, 80);
  const cleanedTikTok = cleanPublicText(tiktokUsername, 80).replace(/^@+/, '');
  const cleanedSource = cleanPublicText(source, 40) || 'signup';
  const cleanedPath = String(lastPath || '').startsWith('/') ? cleanPublicText(lastPath, 180) : '';
  try {
    db.prepare(`
      INSERT INTO signup_intents (email, name, tiktok_username, source, last_path, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT(email) DO UPDATE SET
        name = COALESCE(NULLIF(excluded.name, ''), signup_intents.name),
        tiktok_username = COALESCE(NULLIF(excluded.tiktok_username, ''), signup_intents.tiktok_username),
        source = excluded.source,
        last_path = COALESCE(NULLIF(excluded.last_path, ''), signup_intents.last_path),
        updated_at = CURRENT_TIMESTAMP
    `).run(normalizedEmail, cleanedName, cleanedTikTok, cleanedSource, cleanedPath);
    return { ok: true, email: normalizedEmail };
  } catch (err) {
    logger.warn({ err, email: normalizedEmail }, 'Failed to save signup intent');
    return { ok: false, error: 'Unable to save signup progress.' };
  }
}

async function sendAbandonedSignupFollowups(limit = 20) {
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 20));
  const result = { scanned: 0, sent: 0, skipped: 0, failed: 0 };
  let rows = [];
  try {
    rows = db.prepare(`
      SELECT si.*
      FROM signup_intents si
      LEFT JOIN users u ON u.email = si.email
      WHERE si.followup_sent_at IS NULL
        AND si.converted_at IS NULL
        AND u.id IS NULL
        AND si.updated_at <= CURRENT_TIMESTAMP - interval '20 minutes'
      ORDER BY si.updated_at ASC
      LIMIT ?
    `).all(safeLimit);
  } catch (err) {
    logger.warn({ err }, 'Failed to load abandoned signup intents');
    throw err;
  }

  for (const row of rows) {
    result.scanned++;
    try {
      const name = cleanPublicText(row.name, 80) || 'creator';
      const delivery = await sendTransactionalEmail({
        to: row.email,
        subject: 'Your battle arena is ready, finish setup',
        tag: 'abandoned-signup',
        metadata: { source: 'signup-intent', signupIntentId: String(row.id) },
        htmlBody: `<p>Hey ${escapeHtml(name)},</p><p>Your battle arena is ready. Finish setup, copy your overlay URL, and test your first battle before your next TikTok LIVE.</p><p><a href="${publicBaseUrl()}/signup">Finish setup</a></p>`,
        textBody: `Hey ${name}, your battle arena is ready. Finish setup here: ${publicBaseUrl()}/signup`,
      });
      if (delivery.skipped) result.skipped++;
      else result.sent++;
      db.prepare('UPDATE signup_intents SET followup_sent_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(row.id);
    } catch (err) {
      result.failed++;
      logger.warn({ err, signupIntentId: row.id }, 'Failed to send abandoned signup follow-up');
    }
  }
  return result;
}

function currentRoundStatus(room) {
  const round = room?.roundState;
  if (!round?.active) return null;
  const now = Date.now();
  return {
    active: true,
    number: round.number,
    startedAt: round.startedAt,
    endsAt: round.endsAt,
    durationMs: round.durationMs,
    remainingMs: Math.max(0, round.endsAt - now),
    status: round.status || 'live',
  };
}

function currentBossStatus(room) {
  const boss = room?.bossWave;
  if (!boss?.active) return boss?.lastStatus || null;
  const now = Date.now();
  return {
    active: true,
    status: boss.status || 'live',
    startedAt: boss.startedAt,
    durationMs: Math.max(0, Math.round(Number(boss.durationMs) || BOSS_WAVE_DURATION_MS)),
    endsAt: boss.endsAt || null,
    remainingMs: boss.endsAt ? Math.max(0, boss.endsAt - now) : null,
    nextAttackAt: boss.nextAttackAt || null,
    nextAttackMs: boss.nextAttackAt ? Math.max(0, boss.nextAttackAt - now) : null,
    attackIntervalMs: Math.max(0, Math.round(Number(boss.attackIntervalMs) || BOSS_WAVE_ATTACK_INTERVAL_MS)),
    hp: Math.max(0, Math.round(Number(boss.hp) || 0)),
    maxHp: Math.max(1, Math.round(Number(boss.maxHp) || BOSS_WAVE_HP)),
    hits: Number(boss.hits) || 0,
    lastHitBy: boss.lastHitBy || null,
  };
}

function buildSessionStatus(room) {
  const session = room?.liveSession || null;
  const active = session?.status === 'active';
  const now = Date.now();
  const recap = room?.lastSessionRecap || null;
  const phase = currentRoomPhase(room);
  return {
    success: true,
    active,
    sessionId: session?.sessionId || null,
    status: active ? 'active' : phase,
    phase,
    lifecycle: room?.matchLifecycle || {
      phase,
      sessionId: currentRoomSessionId(room),
      updatedAt: null,
      reason: '',
    },
    startedAt: session?.startedAt || null,
    elapsedMs: active ? Math.max(0, now - Number(session.startedAt || now)) : 0,
    round: currentRoundStatus(room),
    bossWave: currentBossStatus(room),
    recap,
    commandText: viewerCommandText(),
    metrics: {
      players: roomAlivePlayers(room).length,
      roundsCompleted: Number(session?.roundsCompleted) || 0,
      bossDefeats: Number(session?.bossDefeats) || 0,
    },
  };
}

function emitSessionStatus(room) {
  emitRoomEvent(room, 'sessionStatus', buildSessionStatus(room));
}

function clearRoundTimer(room) {
  if (room?.roundState?.timer) {
    clearTimeout(room.roundState.timer);
    room.roundState.timer = null;
  }
}

function ensureLiveSession(room, source = 'dashboard', options = {}) {
  if (!room?.roomId) return null;
  if (room.liveSession?.status === 'active') return room.liveSession;
  const sessionId = options.sessionId || room?.tiktokConnection?.sessionId || sessionIdForRoom(room);
  const session = {
    sessionId,
    status: 'active',
    source,
    startedAt: Date.now(),
    roundsStarted: 0,
    roundsCompleted: 0,
    bossWavesStarted: 0,
    bossDefeats: 0,
  };
  room.liveSession = session;
  setRoomMatchPhase(room, options.phase || MATCH_PHASES.LIVE, 'session_started', { sessionId, detail: { source } });
  persistLiveSessionStart(room, session);
  emitRoomEvent(room, 'roundEvent', {
    type: 'session_started',
    sessionId,
    title: 'Battle session started',
    message: 'The arena is live.',
  });
  emitSessionStatus(room);
  return session;
}

function startLiveSession(room, source = 'dashboard', options = {}) {
  const session = ensureLiveSession(room, source, options);
  if (session) setRoomMatchPhase(room, options.phase || MATCH_PHASES.LIVE, 'session_active', { sessionId: session.sessionId, detail: { source } });
  emitSessionStatus(room);
  return session;
}

function endBattleRound(room, reason = 'manual') {
  if (!room?.roundState?.active) return { ok: false, reason: 'no_active_round' };
  const round = room.roundState;
  clearRoundTimer(room);
  round.active = false;
  round.status = 'ended';
  round.endedAt = Date.now();
  if (room.liveSession?.status === 'active') {
    room.liveSession.roundsCompleted = (Number(room.liveSession.roundsCompleted) || 0) + 1;
  }
  if (room.liveSession?.status === 'active') {
    setRoomMatchPhase(room, room.bossWave?.active ? MATCH_PHASES.BOSS_WAVE : MATCH_PHASES.LIVE, 'round_ended', { sessionId: room.liveSession.sessionId });
  }
  const topPlayers = topSessionPlayers(room, 3);
  emitRoomEvent(room, 'roundEvent', {
    type: 'round_ended',
    number: round.number,
    reason,
    title: `Round ${round.number} complete`,
    message: topPlayers[0] ? `${topPlayers[0].nickname} leads the arena.` : 'Round complete.',
    topPlayers,
  });
  emitSessionStatus(room);
  maybeTriggerMilestoneSponsorBreak(room, 'round_end');
  return { ok: true, round: { ...round, timer: undefined } };
}

function startBattleRound(room, options = {}) {
  const session = ensureLiveSession(room, options.source || 'dashboard', { phase: MATCH_PHASES.LIVE, sessionId: options.sessionId });
  if (!session) return null;
  if (room.roundState?.active) endBattleRound(room, 'new_round');
  const durationMs = clampSessionNumber(options.durationMs, BATTLE_ROUND_DURATION_MS, 30000, 30 * 60 * 1000);
  const number = (Number(session.roundsStarted) || 0) + 1;
  session.roundsStarted = number;
  setRoomMatchPhase(room, MATCH_PHASES.LIVE, 'round_started', { sessionId: session.sessionId, detail: { number } });
  room.roundState = {
    active: true,
    status: 'live',
    number,
    startedAt: Date.now(),
    durationMs,
    endsAt: Date.now() + durationMs,
    timer: null,
  };
  room.roundState.timer = setTimeout(() => endBattleRound(room, 'timer'), durationMs);
  if (typeof room.roundState.timer.unref === 'function') room.roundState.timer.unref();
  emitRoomEvent(room, 'roundEvent', {
    type: 'round_started',
    number,
    durationMs,
    title: `Round ${number}`,
    message: 'New battle round is live.',
  });
  emitSessionStatus(room);
  return room.roundState;
}

function clearBossWaveTimers(room) {
  const boss = room?.bossWave;
  if (!boss) return;
  if (boss.timer) {
    clearTimeout(boss.timer);
    boss.timer = null;
  }
  if (boss.attackTimer) {
    clearTimeout(boss.attackTimer);
    boss.attackTimer = null;
  }
}

function bossWaveTargets(room) {
  return getTopPlayers(room, 5)
    .filter(player => player?.alive && player.uniqueId !== SERVER_HORDE_ID)
    .slice(0, 5);
}

function applyBossDamageToPlayer(room, target, damage) {
  if (!room || !target?.uniqueId || !room.players[target.uniqueId]?.alive) return null;
  const player = room.players[target.uniqueId];
  let dmg = Math.max(1, Math.round(Number(damage) || BOSS_WAVE_ATTACK_DAMAGE));
  let shieldAbsorbed = 0;
  if (player.shieldUntil && player.shieldUntil > Date.now()) {
    shieldAbsorbed = Math.min(Math.max(1, Math.ceil(dmg * 0.45)), Math.max(0, dmg - 1));
    dmg = Math.max(1, dmg - shieldAbsorbed);
  }

  player.hp = Math.max(0, (Number(player.hp) || 0) - dmg);
  player.lastActive = Date.now();
  const killed = player.hp <= 0;
  if (killed) {
    player.alive = false;
    player.killStreak = 0;
    emitRoomEvent(room, 'killEvent', {
      killer: SERVER_BOSS_ID,
      killerNick: 'Boss Wave',
      killerKills: 0,
      killerStreak: 0,
      victim: target.uniqueId,
      victimNick: player.nickname || target.nickname || target.uniqueId,
      damage: dmg,
      effect: 'boss',
      attackerScope: 'boss',
      targetScope: 'top',
    });
  }

  return {
    attacker: SERVER_BOSS_ID,
    attackerNick: 'Boss Wave',
    target: target.uniqueId,
    targetNick: player.nickname || target.nickname || target.uniqueId,
    damage: dmg,
    killed,
    special: true,
    effect: killed ? 'explosion' : 'boss',
    intensity: killed ? 0.95 : 0.72,
    critical: dmg >= Math.max(12, (Number(player.maxHp) || CFG.BASE_HP) * 0.16),
    shielded: shieldAbsorbed > 0,
    shieldAbsorbed,
    attackerScope: 'boss',
    targetScope: 'top',
    remainingHpPct: Math.max(0, Number(player.hp) || 0) / Math.max(1, Number(player.maxHp) || CFG.BASE_HP),
  };
}

function runBossWaveAttack(room, reason = 'pulse') {
  const boss = room?.bossWave;
  if (!boss?.active) return [];
  if (boss.sessionId && currentRoomSessionId(room) && boss.sessionId !== currentRoomSessionId(room)) return [];
  const targets = bossWaveTargets(room);
  const attacks = [];
  const baseDamage = Math.max(4, Math.round(Number(boss.attackDamage) || BOSS_WAVE_ATTACK_DAMAGE));
  const remainingAfterStrike = boss.endsAt ? Math.max(0, boss.endsAt - Date.now()) : boss.attackIntervalMs;
  const projectedNextAttackAt = remainingAfterStrike > 1000
    ? Date.now() + Math.min(Math.max(900, boss.attackIntervalMs || BOSS_WAVE_ATTACK_INTERVAL_MS), remainingAfterStrike)
    : null;
  boss.nextAttackAt = projectedNextAttackAt;

  targets.forEach((target, index) => {
    const variance = 0.82 + Math.random() * 0.42;
    const falloff = Math.max(0.72, 1 - index * 0.06);
    const payload = applyBossDamageToPlayer(room, target, baseDamage * variance * falloff);
    if (!payload) return;
    payload.sequenceIndex = index;
    payload.totalTargets = targets.length;
    payload.impactDelayMs = 160 + index * 135;
    payload.bossSweep = true;
    attacks.push(payload);
    emitRoomEvent(room, 'attack', payload);
  });

  emitRoomEvent(room, 'bossWave', {
    type: 'attack',
    active: true,
    hp: boss.hp,
    maxHp: boss.maxHp,
    hits: boss.hits,
    targets: attacks.map(attack => ({
      uniqueId: attack.target,
      nickname: attack.targetNick,
      damage: attack.damage,
      killed: attack.killed,
    })),
    reason,
    durationMs: boss.durationMs,
    endsAt: boss.endsAt,
    remainingMs: boss.endsAt ? Math.max(0, boss.endsAt - Date.now()) : null,
    nextAttackAt: projectedNextAttackAt,
    attackIntervalMs: boss.attackIntervalMs,
  });

  if (attacks.length) {
    emitSoundAndSync(room, attacks.some(attack => attack.killed) ? 'kill' : 'attack', {
      intensity: attacks.some(attack => attack.killed) ? 0.9 : 0.72,
      tier: attacks.some(attack => attack.killed) ? 'rare' : 'common',
    });
    setTimeout(() => emitRoomEvent(room, 'gameState', room.players), 40);
    emitSessionStatus(room);
  }
  return attacks;
}

function scheduleBossWaveAttack(room, delayMs = BOSS_WAVE_ATTACK_INTERVAL_MS) {
  const boss = room?.bossWave;
  if (!boss?.active) return;
  if (boss.attackTimer) clearTimeout(boss.attackTimer);
  const scheduledSessionId = boss.sessionId || currentRoomSessionId(room);
  const remaining = boss.endsAt ? boss.endsAt - Date.now() : delayMs;
  if (remaining <= 0) {
    completeBossWave(room, null, 'expired');
    return;
  }
  const nextDelay = Math.max(900, Math.min(Math.round(delayMs), remaining));
  boss.nextAttackAt = Date.now() + nextDelay;
  boss.attackTimer = setTimeout(() => {
    boss.attackTimer = null;
    if (!room?.bossWave?.active) return;
    if (scheduledSessionId && currentRoomSessionId(room) !== scheduledSessionId) return;
    runBossWaveAttack(room);
    scheduleBossWaveAttack(room, room.bossWave.attackIntervalMs || BOSS_WAVE_ATTACK_INTERVAL_MS);
  }, nextDelay);
  if (typeof boss.attackTimer.unref === 'function') boss.attackTimer.unref();
}

function completeBossWave(room, finalHit = null, reason = 'defeated') {
  if (!room?.bossWave?.active) return { ok: false, reason: 'no_active_boss_wave' };
  const boss = room.bossWave;
  clearBossWaveTimers(room);
  boss.active = false;
  boss.status = reason;
  boss.endedAt = Date.now();
  boss.hp = Math.max(0, Number(boss.hp) || 0);
  boss.finalHitBy = finalHit;
  boss.lastStatus = {
    active: false,
    status: reason,
    hp: boss.hp,
    maxHp: boss.maxHp,
    hits: boss.hits,
    startedAt: boss.startedAt,
    durationMs: boss.durationMs,
    endsAt: boss.endsAt,
    remainingMs: 0,
    attackIntervalMs: boss.attackIntervalMs,
    endedAt: boss.endedAt,
    finalHitBy: finalHit,
  };
  if (reason === 'defeated' && room.liveSession?.status === 'active') {
    room.liveSession.bossDefeats = (Number(room.liveSession.bossDefeats) || 0) + 1;
  }
  if (room.liveSession?.status === 'active') {
    setRoomMatchPhase(room, MATCH_PHASES.LIVE, `boss_${reason}`, { sessionId: room.liveSession.sessionId });
  }
  emitRoomEvent(room, 'bossWave', {
    type: reason,
    active: false,
    hp: boss.hp,
    maxHp: boss.maxHp,
    hits: boss.hits,
    durationMs: boss.durationMs,
    endsAt: boss.endsAt,
    remainingMs: 0,
    attackIntervalMs: boss.attackIntervalMs,
    finalHitBy: finalHit,
    title: reason === 'defeated' ? 'Boss wave defeated' : 'Boss wave ended',
  });
  emitRoomEvent(room, 'roundEvent', {
    type: reason === 'defeated' ? 'boss_defeated' : 'boss_ended',
    title: reason === 'defeated' ? 'Boss wave defeated' : 'Boss wave ended',
    message: finalHit?.nickname ? `${finalHit.nickname} landed the final hit.` : 'The arena resets.',
  });
  emitSessionStatus(room);
  if (reason === 'defeated') maybeTriggerMilestoneSponsorBreak(room, 'boss_defeated');
  return { ok: true, bossWave: boss.lastStatus };
}

function startBossWave(room, options = {}) {
  const session = ensureLiveSession(room, options.source || 'dashboard', { phase: MATCH_PHASES.BOSS_WAVE, sessionId: options.sessionId });
  if (!session) return null;
  if (room.bossWave?.active) completeBossWave(room, null, 'restarted');
  const maxHp = clampSessionNumber(options.maxHp, BOSS_WAVE_HP, 200, 50000);
  const durationMs = clampSessionNumber(options.durationMs, BOSS_WAVE_DURATION_MS, 15000, 10 * 60 * 1000);
  const attackIntervalMs = clampSessionNumber(options.attackIntervalMs, BOSS_WAVE_ATTACK_INTERVAL_MS, 4000, 60000);
  const startedAt = Date.now();
  setRoomMatchPhase(room, MATCH_PHASES.BOSS_WAVE, 'boss_started', { sessionId: session.sessionId });
  room.bossWave = {
    active: true,
    status: 'live',
    sessionId: session.sessionId,
    hp: maxHp,
    maxHp,
    hits: 0,
    startedAt,
    durationMs,
    endsAt: startedAt + durationMs,
    attackIntervalMs,
    attackDamage: clampSessionNumber(options.attackDamage, BOSS_WAVE_ATTACK_DAMAGE, 4, 250),
    nextAttackAt: null,
    timer: null,
    attackTimer: null,
    lastHitBy: null,
  };
  room.bossWave.timer = setTimeout(() => completeBossWave(room, null, 'expired'), durationMs);
  if (typeof room.bossWave.timer.unref === 'function') room.bossWave.timer.unref();
  scheduleBossWaveAttack(room, Math.min(2400, Math.max(1000, attackIntervalMs * 0.28)));
  session.bossWavesStarted = (Number(session.bossWavesStarted) || 0) + 1;
  emitRoomEvent(room, 'bossWave', {
    type: 'started',
    active: true,
    hp: maxHp,
    maxHp,
    hits: 0,
    durationMs,
    endsAt: room.bossWave.endsAt,
    remainingMs: durationMs,
    nextAttackAt: room.bossWave.nextAttackAt,
    attackIntervalMs,
    title: 'Boss wave incoming',
  });
  emitRoomEvent(room, 'roundEvent', {
    type: 'boss_started',
    title: 'Boss wave incoming',
    message: 'Viewers can target @boss to break the horde.',
  });
  emitSessionStatus(room);
  return room.bossWave;
}

function damageBossWave(room, attackerId, attackerNick, multiplier = 1, effect = 'laser', comment = '') {
  const boss = room?.bossWave;
  const attacker = room?.players?.[attackerId];
  if (!boss?.active || !attacker?.alive) return { handled: false, reason: 'Boss wave is not active' };
  if (boss.sessionId && currentRoomSessionId(room) && boss.sessionId !== currentRoomSessionId(room)) {
    return { handled: false, reason: 'Boss wave belongs to a previous session' };
  }
  const variance = 1 - CFG.ATTACK_VARIANCE / 2 + Math.random() * CFG.ATTACK_VARIANCE;
  const damage = Math.max(4, Math.floor((Number(attacker.strength) || CFG.BASE_STRENGTH) * multiplier * variance));
  boss.hp = Math.max(0, (Number(boss.hp) || 0) - damage);
  boss.hits = (Number(boss.hits) || 0) + 1;
  boss.lastHitBy = { uniqueId: attackerId, nickname: attackerNick || attacker.nickname || attackerId, damage };
  attacker.lastActive = Date.now();
  const topBefore = new Set(getTopPlayers(room, 5).map(player => player.uniqueId));
  const attackPayload = {
    attacker: attackerId,
    attackerNick: attackerNick || attacker.nickname,
    target: SERVER_BOSS_ID,
    targetNick: 'Boss Wave',
    damage,
    killed: boss.hp <= 0,
    special: multiplier > 1.5,
    effect,
    intensity: Math.min(1, 0.48 + multiplier / 9),
    critical: multiplier >= 3,
    comment,
    attackerScope: topBefore.has(attackerId) ? 'top' : 'horde',
    targetScope: 'boss',
    remainingHpPct: boss.maxHp ? boss.hp / boss.maxHp : 0,
  };
  emitRoomEvent(room, 'attack', attackPayload);
  emitRoomEvent(room, 'commentDamage', {
    ...attackPayload,
    target: SERVER_BOSS_ID,
    targetScope: 'boss',
    commandDescription: effect,
  });
  emitSoundAndSync(room, boss.hp <= 0 ? 'kill' : (multiplier > 1.5 ? 'gift' : 'attack'), { intensity: attackPayload.intensity, tier: multiplier >= 5 ? 'rare' : 'common' });
  emitRoomEvent(room, 'bossWave', {
    type: boss.hp <= 0 ? 'defeated' : 'damaged',
    active: boss.hp > 0,
    hp: boss.hp,
    maxHp: boss.maxHp,
    hits: boss.hits,
    lastHitBy: boss.lastHitBy,
    damage,
    durationMs: boss.durationMs,
    endsAt: boss.endsAt,
    remainingMs: boss.endsAt ? Math.max(0, boss.endsAt - Date.now()) : null,
    nextAttackAt: boss.nextAttackAt || null,
    attackIntervalMs: boss.attackIntervalMs,
  });
  if (boss.hp <= 0) {
    completeBossWave(room, boss.lastHitBy, 'defeated');
  } else {
    emitSessionStatus(room);
  }
  return { handled: true, result: attackPayload, target: SERVER_BOSS_ID };
}

function endLiveSession(room, reason = 'manual_end') {
  if (!room?.liveSession || room.liveSession.status !== 'active') {
    return { ok: false, reason: 'no_active_session', recap: room?.lastSessionRecap || null };
  }
  const session = room.liveSession;
  clearRoundTimer(room);
  if (room.roundState?.active) {
    room.roundState.active = false;
    room.roundState.status = 'ended';
    room.roundState.endedAt = Date.now();
    session.roundsCompleted = (Number(session.roundsCompleted) || 0) + 1;
  }
  if (room.bossWave?.active) completeBossWave(room, null, 'ended');
  session.status = 'ended';
  session.endedAt = Date.now();
  const recap = buildSessionRecap(room, session, reason);
  room.lastSessionRecap = recap;
  setRoomMatchPhase(room, MATCH_PHASES.RECAP, 'session_ended', { sessionId: session.sessionId, detail: { reason } });
  persistLiveSessionEnd(room, recap);
  emitRoomEvent(room, 'roundEvent', {
    type: 'session_ended',
    title: 'Session recap ready',
    message: recap.winner ? `${recap.winner.nickname} finished on top.` : 'Battle session ended.',
    recap,
  });
  emitSessionStatus(room);
  return { ok: true, recap };
}

function normalizeTikTokUsername(value = '') {
  const username = String(value || '').trim().replace(/^@+/, '').toLowerCase();
  return /^[a-z0-9._]{2,32}$/i.test(username) ? username : '';
}

function clearLikeRateTrackerForRoom(roomId) {
  if (!roomId) return;
  const prefix = `${roomId}:`;
  for (const key of Object.keys(likeRateTracker)) {
    if (key.startsWith(prefix)) delete likeRateTracker[key];
  }
}

function buildTikTokConnectionStatus(room) {
  const connection = room?.tiktokConnection || {};
  const status = connection.status || 'disconnected';
  return {
    connectionId: connection.id || null,
    sessionId: connection.sessionId || null,
    username: connection.username || room?.streamerUsername || '',
    status,
    connected: Boolean(status === 'connected' && room?.tiktokClient?.connected),
    tiktokRoomId: connection.tiktokRoomId || null,
    startedAt: connection.startedAt || null,
    connectedAt: connection.connectedAt || null,
    disconnectedAt: connection.disconnectedAt || null,
    lastEventAt: connection.lastEventAt || null,
    lastEventType: connection.lastEventType || '',
    eventCount: Number(connection.eventCount) || 0,
    staleEventsDropped: Number(room?.staleTikTokEventsDropped) || 0,
    reason: connection.reason || '',
    error: connection.error || '',
  };
}

function emitTikTokConnectionStatus(room, patch = {}) {
  if (!room) return;
  room.tiktokConnection = {
    ...(room.tiktokConnection || {}),
    ...patch,
    updatedAt: Date.now(),
  };
  emitRoomEvent(room, 'tiktokConnection', buildTikTokConnectionStatus(room));
}

function resetRoomLiveRuntime(room, options = {}) {
  if (!room?.roomId) return;
  const reason = options.reason || 'stream_reset';
  const clearPlayers = options.clearPlayers !== false;

  clearRoomEventQueue(room);
  if (room.liveSession?.status === 'active') {
    endLiveSession(room, reason);
  } else {
    clearRoundTimer(room);
    room.roundState = null;
    if (room.bossWave?.active) {
      completeBossWave(room, null, reason);
    } else {
      clearBossWaveTimers(room);
      room.bossWave = null;
    }
    emitSessionStatus(room);
  }

  advanceRoomRuntimeEpoch(room, reason);
  stopSponsorBreaksForRoom(room, reason);
  clearPlatformSponsorSchedule(room.roomId);
  room.recentBattleActionAt = [];
  room.lastBattleActionAt = 0;
  room.lastHighIntensityBattleAt = 0;
  room.likeStats = { total: 0, lastMilestone: 0 };
  room.engagementStats = null;
  room.setupRehearsal = {
    active: false,
    reason,
    updatedAt: Date.now(),
  };
  clearLikeRateTrackerForRoom(room.roomId);

  if (clearPlayers) {
    room.players = {};
  } else {
    for (const player of Object.values(room.players || {})) {
      player.alive = false;
      player.forceSpawn = false;
    }
  }

  markRoomPlayerPresenceOffline(room);
  setRoomMatchPhase(room, MATCH_PHASES.IDLE, reason);
  emitRoomEvent(room, 'setupMode', room.setupRehearsal);
  emitRoomEvent(room, 'gameState', room.players);
  emitSessionStatus(room);
  updatePlayerGauge();
}

function stopRoomSetupRehearsal(room, reason = 'setup_rehearsal_reset') {
  if (!room?.roomId) return;
  resetRoomLiveRuntime(room, { reason, clearPlayers: true });
  room.setupRehearsal = {
    active: false,
    reason,
    updatedAt: Date.now(),
  };
  emitRoomEvent(room, 'setupMode', room.setupRehearsal);
}

function startRoomSetupRehearsal(room, options = {}) {
  if (!room?.roomId) return null;
  resetRoomLiveRuntime(room, { reason: 'setup_rehearsal_start', clearPlayers: true });
  room.setupRehearsal = {
    active: true,
    startedAt: Date.now(),
    updatedAt: Date.now(),
    source: options.source || 'dashboard',
  };
  emitRoomEvent(room, 'setupMode', {
    ...room.setupRehearsal,
    title: 'Setup rehearsal running',
    message: 'Demo events are isolated to this creator room.',
  });
  emitRoomEvent(room, 'roundEvent', {
    type: 'setup_rehearsal_started',
    title: 'Setup rehearsal running',
    message: 'Previewing chat, likes, gifts, boss wave, and broadcast break before TikTok connects.',
  });
  const timer = setTimeout(() => runRoomOverlayTest(room, options.action || 'burst'), 450);
  if (typeof timer.unref === 'function') timer.unref();
  return room.setupRehearsal;
}

function createTikTokConnection(room, username) {
  const id = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const sessionId = sessionIdForRoom(room);
  room.staleTikTokEventsDropped = 0;
  room.lastSessionRecap = null;
  setRoomMatchPhase(room, MATCH_PHASES.SETUP, 'stream_connecting', { sessionId, detail: { username } });
  room.tiktokConnection = {
    id,
    sessionId,
    username,
    status: 'connecting',
    startedAt: Date.now(),
    connectedAt: null,
    disconnectedAt: null,
    lastEventAt: null,
    lastEventType: '',
    eventCount: 0,
    staleEventsDropped: 0,
    tiktokRoomId: null,
    reason: '',
    error: '',
  };
  emitTikTokConnectionStatus(room);
  return room.tiktokConnection;
}

function isActiveTikTokConnection(room, tiktokClient, connectionId, sessionId = '') {
  return Boolean(
    room?.tiktokClient &&
    room.tiktokClient === tiktokClient &&
    room.tiktokConnection?.id === connectionId &&
    (!sessionId || room.tiktokConnection?.sessionId === sessionId)
  );
}

function markTikTokEventAccepted(room, eventType) {
  if (!room?.tiktokConnection) return;
  room.tiktokConnection.lastEventAt = Date.now();
  room.tiktokConnection.lastEventType = eventType;
  room.tiktokConnection.eventCount = (Number(room.tiktokConnection.eventCount) || 0) + 1;
}

function markTikTokEventDropped(room, connectionId, eventType) {
  if (room) room.staleTikTokEventsDropped = (Number(room.staleTikTokEventsDropped) || 0) + 1;
  logger.warn({ roomId: room?.roomId, connectionId, eventType, activeSessionId: currentRoomSessionId(room) }, 'Dropped stale TikTok event from inactive connection');
}

function maybeTriggerMilestoneSponsorBreak(room, trigger = 'milestone') {
  if (!PLATFORM_SPONSOR_ENABLED || !room?.roomId) return { started: false, reason: 'disabled' };
  if (room.planEntitlements?.canUseCreatorSponsors) return { started: false, reason: 'creator_controlled' };
  const pacing = getRoomSponsorPacingDecision(room);
  if (!pacing.ok) {
    if (pacing.retryMs) scheduleNextPlatformSponsor(room, pacing.retryMs);
    return { started: false, reason: pacing.reason, retryMs: pacing.retryMs };
  }
  const creative = pickPlatformSponsorCreative(getRecentPlatformSponsorCreativeIds(room));
  if (!creative) return { started: false, reason: 'no_creative' };
  const payload = buildPlatformSponsorPayload(room, creative);
  const record = startSponsorBreak(room, payload, { trigger, source: 'platform' });
  rememberPlatformSponsorCreative(room, creative.id);
  logger.info({ roomId: room.roomId, trigger, creativeId: creative.id }, 'Platform sponsor break prepared from gameplay milestone');
  return { started: true, breakId: record?.breakId || null, creativeId: creative.id };
}

function startPreparedSponsorBreak(room, record, reason = 'ready') {
  if (!room || !record || !sponsorBreaks.has(record.breakId)) return null;
  if (record.runtimeEpoch !== roomRuntimeEpoch(room)) {
    record.status = 'stopped';
    recordSponsorPlaybackEvent(record, 'stale_runtime', { reason });
    cleanupSponsorBreakLater(record.breakId);
    return record;
  }
  if (SPONSOR_FINAL_STATUSES.has(record.status)) return record;
  if (record.status === 'starting' || record.status === 'playing') return record;
  if (record.prepareTimer) {
    clearTimeout(record.prepareTimer);
    record.prepareTimer = null;
  }
  record.status = 'starting';
  record.startRequestedAt = Date.now();
  recordSponsorPlaybackEvent(record, 'start_requested', { reason });
  emitSponsorBreakStatus(room, record, 'starting', { message: reason === 'timeout' ? 'Started after prepare timeout' : 'Video ready, starting break' });
  emitRoomEvent(room, 'sponsorScene', { ...record.payload, action: 'show', preparedReason: reason });
  return record;
}

function startSponsorBreak(room, payload = {}, options = {}) {
  if (!room?.roomId) return null;
  const source = payload.source || options.source || 'creator';
  const breakId = payload.breakId || createSponsorBreakId(source);
  const scenePayload = {
    ...payload,
    action: 'show',
    source,
    breakId,
    statsMode: payload.statsMode || 'endcap',
    _ts: Date.now(),
  };

  const record = {
    breakId,
    roomId: room.roomId,
    sessionId: currentRoomSessionId(room),
    runtimeEpoch: roomRuntimeEpoch(room),
    source,
    creativeId: scenePayload.creativeId || null,
    filename: scenePayload.filename || null,
    payload: scenePayload,
    requestedAt: Date.now(),
    status: 'preparing',
    readySocketIds: new Set(),
    decodedSocketIds: new Set(),
    prepareTimer: null,
    cleanupTimer: null,
  };

  sponsorBreaks.set(breakId, record);
  recordSponsorPlaybackEvent(record, 'requested', { trigger: options.trigger || 'manual' });
  emitSponsorBreakStatus(room, record, 'preparing', { message: 'Preparing video in overlay' });
  emitRoomEvent(room, 'sponsorPrepare', { ...scenePayload, action: 'prepare' });

  record.prepareTimer = setTimeout(() => {
    const latest = sponsorBreaks.get(breakId);
    if (!latest || !['preparing', 'decoded'].includes(latest.status)) return;
    recordSponsorPlaybackEvent(latest, 'prepare_timeout');
    if (latest.payload?.videoUrl) {
      latest.status = 'failed';
      room.lastSponsorFailedAt = Date.now();
      updatePlatformSponsorCreativeMetric(latest, 'failed');
      updatePlatformSponsorCreativeReadiness(latest, 'failed');
      if (latest.source === 'creator') {
        updateRoomSponsorCreativeStatus(room, latest.filename, {
          readinessStatus: 'failed',
          lastFailedAt: new Date().toISOString(),
          playbackMessage: 'Overlay did not confirm video readiness before timeout.',
        });
      }
      emitSponsorBreakStatus(room, latest, 'failed', { message: 'Overlay did not confirm video readiness before timeout' });
      cleanupSponsorBreakLater(latest.breakId);
      if (latest.source === 'platform' && !room.planEntitlements?.canUseCreatorSponsors) {
        scheduleNextPlatformSponsor(room, getPlatformSponsorScheduleSettings().retryDelayMs);
      }
      return;
    }
    startPreparedSponsorBreak(room, latest, 'timeout');
  }, Math.max(1500, SPONSOR_PREPARE_TIMEOUT_MS));
  if (typeof record.prepareTimer.unref === 'function') record.prepareTimer.unref();
  return record;
}

function stopSponsorBreaksForRoom(room, reason = 'operator_stop') {
  if (!room?.roomId) return;
  for (const record of sponsorBreaks.values()) {
    if (record.roomId !== room.roomId || SPONSOR_FINAL_STATUSES.has(record.status)) continue;
    if (record.prepareTimer) clearTimeout(record.prepareTimer);
    record.status = 'stopped';
    recordSponsorPlaybackEvent(record, 'stopped', { reason });
    emitSponsorBreakStatus(room, record, 'stopped', { message: 'Break stopped' });
    cleanupSponsorBreakLater(record.breakId);
  }
}

function handleSponsorPlaybackEvent(socket, room, event = {}) {
  const breakId = String(event.breakId || '').trim();
  if (!breakId || !room?.roomId) return;
  const record = sponsorBreaks.get(breakId);
  if (!record || record.roomId !== room.roomId) return;

  const eventType = sanitizeSponsorEventType(event.status || event.event || event.type);
  const detail = {
    socketId: socket.id,
    clientType: socket.data?.clientType || 'unknown',
    message: String(event.message || '').slice(0, 240),
    readyState: event.readyState,
    currentTime: event.currentTime,
    duration: event.duration,
    mediaWidth: event.mediaWidth,
    mediaHeight: event.mediaHeight,
    mediaDurationMs: event.mediaDurationMs,
  };

  if (record.runtimeEpoch !== roomRuntimeEpoch(room)) {
    recordSponsorPlaybackEvent(record, 'stale_runtime_ack', detail);
    return;
  }

  recordSponsorPlaybackEvent(record, eventType, detail);

  if (SPONSOR_FINAL_STATUSES.has(record.status) && !['stopped', 'completed'].includes(eventType)) {
    return;
  }

  if (eventType === 'decoded') {
    record.decodedSocketIds.add(socket.id);
    record.decodedAt = record.decodedAt || Date.now();
    if (Number(event.mediaWidth) > 0) record.payload.mediaWidth = Number(event.mediaWidth);
    if (Number(event.mediaHeight) > 0) record.payload.mediaHeight = Number(event.mediaHeight);
    if (Number(event.mediaDurationMs) > 0) record.payload.mediaDurationMs = Number(event.mediaDurationMs);
    if (record.status === 'preparing') {
      record.status = 'decoded';
      emitSponsorBreakStatus(room, record, 'decoded', { message: 'Media decoded, waiting for playable frame' });
    }
    return;
  }

  if (eventType === 'ready') {
    record.readySocketIds.add(socket.id);
    record.readyAt = record.readyAt || Date.now();
    updatePlatformSponsorCreativeReadiness(record, 'ready');
    if (record.source === 'creator') {
      updateRoomSponsorCreativeStatus(room, record.filename, {
        readinessStatus: 'ready',
        lastReadyAt: new Date().toISOString(),
        playbackMessage: detail.message || 'Playable in overlay',
      });
    }
    if (['preparing', 'decoded'].includes(record.status)) {
      record.status = 'ready';
      emitSponsorBreakStatus(room, record, 'ready', { message: 'Media ready in overlay' });
      startPreparedSponsorBreak(room, record, 'ready');
    }
    return;
  }

  if (eventType === 'failed' || eventType === 'error') {
    record.status = 'failed';
    room.lastSponsorFailedAt = Date.now();
    updatePlatformSponsorCreativeMetric(record, 'failed');
    updatePlatformSponsorCreativeReadiness(record, 'failed');
    if (record.source === 'creator') {
      updateRoomSponsorCreativeStatus(room, record.filename, {
        readinessStatus: 'failed',
        lastFailedAt: new Date().toISOString(),
        playbackMessage: detail.message || 'Video failed to load',
      });
    }
    emitSponsorBreakStatus(room, record, 'failed', { message: detail.message || 'Video failed to load' });
    cleanupSponsorBreakLater(record.breakId);
    if (record.source === 'platform' && !room.planEntitlements?.canUseCreatorSponsors) {
      scheduleNextPlatformSponsor(room, getPlatformSponsorScheduleSettings().retryDelayMs);
    }
    return;
  }

  if (eventType === 'live') {
    if (record.status === 'starting' || record.status === 'ready') {
      record.status = 'live';
      record.liveAt = Date.now();
      emitSponsorBreakStatus(room, record, 'live', { message: detail.message || 'Break is live, waiting for first frame' });
    }
    return;
  }

  if (eventType === 'playing') {
    record.playingAt = record.playingAt || Date.now();
    if (!record.firstFrameReported && record.status !== 'playing') {
      record.status = 'live';
      emitSponsorBreakStatus(room, record, 'live', { message: detail.message || 'Playback started, waiting for first frame' });
    }
    return;
  }

  if (eventType === 'first_frame' || eventType === 'fallback_started') {
    if (!record.firstFrameReported) {
      record.firstFrameReported = true;
      record.status = 'playing';
      record.startedAt = record.startedAt || Date.now();
      record.firstFrameAt = Date.now();
      updatePlatformSponsorCreativeMetric(record, 'started');
      updatePlatformSponsorCreativeReadiness(record, 'tested');
      if (record.source === 'creator') {
        updateRoomSponsorCreativeStatus(room, record.filename, {
          readinessStatus: 'tested',
          lastTestedAt: new Date().toISOString(),
          playbackMessage: eventType === 'fallback_started' ? 'Break started without video media' : 'First frame confirmed in overlay',
        });
      }
      emitSponsorBreakStatus(room, record, 'playing', {
        message: eventType === 'fallback_started' ? 'Break started without video media' : 'First frame confirmed on screen',
      });
    }
    return;
  }

  if (eventType === 'video_completed') {
    record.status = 'stats';
    emitSponsorBreakStatus(room, record, 'video_completed', { message: 'Video finished, showing battle stats' });
    return;
  }

  if (eventType === 'completed') {
    record.status = 'completed';
    room.lastSponsorCompletedAt = Date.now();
    room.lastSponsorFailedAt = null;
    updatePlatformSponsorCreativeMetric(record, 'completed');
    emitSponsorBreakStatus(room, record, 'completed', { message: 'Break completed' });
    cleanupSponsorBreakLater(record.breakId);
    if (record.source === 'platform' && !room.planEntitlements?.canUseCreatorSponsors) {
      scheduleNextPlatformSponsor(room, getPlatformSponsorScheduleSettings().intervalMs);
    }
    return;
  }

  if (eventType === 'stopped') {
    record.status = 'stopped';
    emitSponsorBreakStatus(room, record, 'stopped', { message: 'Break stopped' });
    cleanupSponsorBreakLater(record.breakId);
    if (record.source === 'platform' && !room.planEntitlements?.canUseCreatorSponsors) {
      scheduleNextPlatformSponsor(room, getPlatformSponsorScheduleSettings().retryDelayMs);
    }
  }
}

function listActivePlatformSponsorCreatives() {
  try {
    return db.prepare(`
      SELECT *
      FROM platform_sponsor_creatives
      WHERE status = 'active'
        AND COALESCE(processing_status, 'ready') NOT IN ('processing', 'queued', 'failed')
        AND COALESCE(readiness_status, 'ready') IN ('ready', 'tested')
        AND COALESCE(quality_status, 'ready') <> 'blocked'
        AND (active_starts_at IS NULL OR active_starts_at <= CURRENT_TIMESTAMP)
        AND (active_ends_at IS NULL OR active_ends_at >= CURRENT_TIMESTAMP)
        AND (
          last_shown_at IS NULL
          OR last_shown_at <= CURRENT_TIMESTAMP - ((COALESCE(cooldown_seconds, 600))::text || ' seconds')::interval
        )
      ORDER BY uploaded_at DESC, id DESC
    `).all();
  } catch (err) {
    logger.error({ err }, 'Failed to load platform sponsor creatives');
    return [];
  }
}

function pickPlatformSponsorCreative(excludeCreativeIds = []) {
  const creatives = listActivePlatformSponsorCreatives();
  if (!creatives.length) return null;
  const excluded = new Set(
    (Array.isArray(excludeCreativeIds) ? excludeCreativeIds : [excludeCreativeIds])
      .map(id => Number(id))
      .filter(id => Number.isFinite(id))
  );
  const eligible = creatives.length > excluded.size
    ? creatives.filter(creative => !excluded.has(Number(creative.id)))
    : creatives;
  const totalWeight = eligible.reduce((sum, creative) => sum + Math.max(1, Number(creative.weight) || 1), 0);
  let cursor = Math.random() * totalWeight;
  for (const creative of eligible) {
    cursor -= Math.max(1, Number(creative.weight) || 1);
    if (cursor <= 0) return creative;
  }
  return eligible[0];
}

function buildPlatformSponsorPayload(room, creative) {
  const token = createOverlayToken(room.roomId);
  const timingProfile = parseSponsorTimingProfile(creative.timing_profile || creative.timingProfile || 'spotlight');
  const mediaDurationMs = creative.duration_seconds ? Math.round(Number(creative.duration_seconds) * 1000) : null;
  return {
    action: 'show',
    source: 'platform',
    filename: creative.filename,
    videoUrl: appendOverlayAuth(`/platform-sponsor/${encodeURIComponent(creative.filename)}`, room.roomId, token, { v: Date.now() }),
    partner: sanitizeSponsorText(creative.partner, 'IntoTheBattle Partner', 70),
    kicker: sponsorKickerForProfile(timingProfile),
    title: sanitizeSponsorText(creative.title, 'Power Moment', 90),
    subtitle: sanitizeSponsorText(creative.subtitle, 'Stay locked in. The next fight is loading.', 140),
    durationMs: sponsorProfileDuration(timingProfile, creative.duration_ms, mediaDurationMs),
    mediaDurationMs,
    muted: Number(creative.muted) !== 0,
    fit: creative.fit === 'cover' ? 'cover' : 'contain',
    statsMode: sponsorProfileStatsMode(timingProfile, creative.stats_mode),
    timingProfile,
    posterData: creative.thumbnail_data || '',
    creativeId: creative.id,
  };
}

function clearPlatformSponsorSchedule(roomId) {
  const timer = platformSponsorTimers.get(roomId);
  if (timer) clearTimeout(timer);
  platformSponsorTimers.delete(roomId);
}

function scheduleNextPlatformSponsor(room, delayMs = null) {
  if (!PLATFORM_SPONSOR_ENABLED) return;
  if (!room?.roomId) return;
  clearPlatformSponsorSchedule(room.roomId);
  const settings = getPlatformSponsorScheduleSettings();
  const requestedDelay = delayMs == null ? settings.intervalMs : delayMs;
  const safeDelay = platformSponsorDelay(requestedDelay, requestedDelay === settings.intervalMs || requestedDelay === settings.initialDelayMs, settings);
  const timer = setTimeout(() => {
    platformSponsorTimers.delete(room.roomId);
    if (room.planEntitlements?.canUseCreatorSponsors) return;

    const pacing = getRoomSponsorPacingDecision(room);
    if (!pacing.ok) {
      logger.debug({ roomId: room.roomId, reason: pacing.reason, alivePlayers: pacing.alivePlayers, recentBattleActions: pacing.recentBattleActions }, 'Platform sponsor pacing delayed break');
      scheduleNextPlatformSponsor(room, pacing.retryMs || getPlatformSponsorScheduleSettings().retryDelayMs);
      return;
    }

    const creative = pickPlatformSponsorCreative(getRecentPlatformSponsorCreativeIds(room));
    if (creative) {
      const payload = buildPlatformSponsorPayload(room, creative);
      startSponsorBreak(room, payload, { trigger: 'platform_timer', source: 'platform' });
      rememberPlatformSponsorCreative(room, creative.id);
      logger.info({ roomId: room.roomId, creativeId: creative.id, alivePlayers: pacing.alivePlayers }, 'Platform sponsor break prepared');
    }

    scheduleNextPlatformSponsor(room, getPlatformSponsorScheduleSettings().intervalMs);
  }, safeDelay);
  if (typeof timer.unref === 'function') timer.unref();
  platformSponsorTimers.set(room.roomId, timer);
}

function updatePlatformSponsorSchedule(room, entitlements) {
  if (!room?.roomId) return;
  room.planEntitlements = entitlements;
  if (!PLATFORM_SPONSOR_ENABLED || entitlements?.canUseCreatorSponsors) {
    clearPlatformSponsorSchedule(room.roomId);
    return;
  }
  if (!platformSponsorTimers.has(room.roomId)) {
    scheduleNextPlatformSponsor(room, getPlatformSponsorScheduleSettings().initialDelayMs);
  }
}

setPlatformSponsorTestHandler(({ creativeId, action = 'show' } = {}) => {
  const liveRooms = Array.from(getAllRooms().values())
    .filter(room => room && (room.overlayCount || 0) > 0 && !room.planEntitlements?.canUseCreatorSponsors);

  if (action === 'hide') {
    liveRooms.forEach(room => {
      stopSponsorBreaksForRoom(room, 'admin_stop_test');
      emitRoomEvent(room, 'sponsorScene', { action: 'hide', _ts: Date.now() });
    });
    logger.info({ roomCount: liveRooms.length }, 'Admin stopped platform sponsor test');
    return { roomCount: liveRooms.length };
  }

  const id = Number(creativeId);
  const creative = Number.isFinite(id)
    ? db.prepare('SELECT * FROM platform_sponsor_creatives WHERE id = ?').get(id)
    : null;
  if (!creative) {
    const err = new Error('Creative not found');
    err.status = 404;
    throw err;
  }
  if (!liveRooms.length) {
    const err = new Error('No live overlays are connected.');
    err.status = 409;
    throw err;
  }
  const playbackIssue = sponsorCreativePlaybackIssue(creative);
  if (playbackIssue) {
    const err = new Error(playbackIssue);
    err.status = 409;
    throw err;
  }

  liveRooms.forEach(room => {
    startSponsorBreak(room, buildPlatformSponsorPayload(room, creative), { trigger: 'admin_live_test', source: 'platform' });
    rememberPlatformSponsorCreative(room, creative.id);
  });
  logger.info({ creativeId: creative.id, roomCount: liveRooms.length }, 'Admin prepared platform sponsor test');
  return { creativeId: creative.id, roomCount: liveRooms.length, title: creative.title };
});

function getTotalOverlayCount() {
  return Array.from(getAllRooms().values()).reduce((sum, room) => sum + (room.overlayCount || 0), 0);
}

function getTotalPlayerCount() {
  return Array.from(getAllRooms().values()).reduce((sum, room) => {
    return sum + Object.values(room.players).filter(p => p.alive).length;
  }, 0);
}

function updateOverlayGauge() {
  try { overlayGauge.set(getTotalOverlayCount()); } catch (_) {}
}

function updatePlayerGauge() {
  try { playerGauge.set(getTotalPlayerCount()); } catch (_) {}
}

// ────────────────────────────────
// GIFT TIER CLASSIFIER
// ────────────────────────────────
function classifyGift(diamonds) {
  if (diamonds >= CFG.GIFT_TIER_LEGENDARY) {
    return { tier: 'legendary', effect: 'sphere',    intensity: 1.0,                                   color: '#FFD700', label: '💎 LEGENDARY GIFT' };
  }
  if (diamonds >= CFG.GIFT_TIER_RARE) {
    return { tier: 'rare',      effect: 'explosion', intensity: Math.min(diamonds / CFG.GIFT_TIER_LEGENDARY, 0.9), color: '#C77DFF', label: '🔮 RARE GIFT'      };
  }
  if (diamonds >= CFG.GIFT_TIER_UNCOMMON) {
    return { tier: 'uncommon',  effect: 'neon',      intensity: Math.min(diamonds / CFG.GIFT_TIER_RARE,       0.6), color: '#4D96FF', label: '✨ GIFT'           };
  }
  return   { tier: 'common',   effect: 'gift',      intensity: Math.min(diamonds / CFG.GIFT_TIER_UNCOMMON,   0.3), color: '#6BCB77', label: '🎁 GIFT'           };
}

// ────────────────────────────────
// ATTACK PAYLOAD BUILDER
// ────────────────────────────────
function buildAttackPayload(room, base, targetPlayer) {
  const remainingHpPct = targetPlayer
    ? Math.max(0, targetPlayer.hp) / Math.max(1, targetPlayer.maxHp)
    : null;
  const intensity = targetPlayer
    ? Math.min(base.damage / Math.max(1, targetPlayer.maxHp), 1)
    : 0.5;
  const preDamageHp = (targetPlayer?.hp || 0) + base.damage;
  const critical    = preDamageHp > 0 && base.damage / preDamageHp >= CFG.CRITICAL_HIT_THRESHOLD;

  return {
    ...base,
    intensity,
    critical,
    remainingHpPct,
    shotSpeed:  room.overlaySettings?.shotSpeed  || DEFAULT_OVERLAY_SETTINGS.shotSpeed,
    shotType:   room.overlaySettings?.shotType   || DEFAULT_OVERLAY_SETTINGS.shotType,
    laserColor: room.overlaySettings?.laserColor || DEFAULT_OVERLAY_SETTINGS.laserColor,
  };
}

// ────────────────────────────────
// SOUND ENRICHMENT
// ────────────────────────────────
function emitSoundAndSync(roomOrEvent, eventOrOptions = {}, options = {}) {
  if (typeof roomOrEvent === 'string') {
    const event = roomOrEvent;
    const { intensity = 0.5, tier = 'common' } = eventOrOptions;
    emitEvent('soundEvent', { event, intensity, tier });
    return;
  }

  const room = roomOrEvent;
  const event = eventOrOptions;
  const { intensity = 0.5, tier = 'common' } = options;
  emitRoomEvent(room, 'soundEvent', { event, intensity, tier });
}

// ────────────────────────────────
// EFFECT COMMAND MAP (all overlay effects)
// ────────────────────────────────
const EFFECT_COMMANDS = {
  // Fire family
  fire:        { effect: 'fire',      multiplier: 2.0, description: '🔥 FIRE'        },
  flame:       { effect: 'fire',      multiplier: 2.0, description: '🔥 FLAME'       },
  inferno:     { effect: 'fire',      multiplier: 3.5, description: '🔥 INFERNO'     },
  // Bubble/Water
  bubble:      { effect: 'bubble',    multiplier: 1.2, description: '🫧 BUBBLE'      },
  bubbles:     { effect: 'bubble',    multiplier: 1.2, description: '🫧 BUBBLES'     },
  water:       { effect: 'bubble',    multiplier: 1.2, description: '💧 WATER'       },
  // Neon
  neon:        { effect: 'neon',      multiplier: 1.5, description: '🌈 NEON'        },
  // Ripple / Wind / Spiral (new)
  ripple:      { effect: 'ripple',    multiplier: 2.5, description: '🌊 RIPPLE'      },
  wave:        { effect: 'ripple',    multiplier: 2.5, description: '🌊 WAVE'        },
  spiral:      { effect: 'ripple',    multiplier: 7.0, description: '🌀 SPIRAL'      },  // renamed from tsunami
  // Sphere / Orb
  sphere:      { effect: 'sphere',    multiplier: 3.0, description: '🔮 SPHERE'      },
  orb:         { effect: 'sphere',    multiplier: 3.0, description: '🔮 ORB'         },
  // Laser / Beam
  laser:       { effect: 'laser',     multiplier: 1.5, description: '⚡ LASER'       },
  beam:        { effect: 'beam',      multiplier: 1.5, description: '⚡ BEAM'        },
  // Projectile
  projectile:  { effect: 'projectile',multiplier: 1.0, description: '🏹 PROJECTILE'  },
  shot:        { effect: 'projectile',multiplier: 1.0, description: '🏹 SHOT'        },
  bullet:      { effect: 'projectile',multiplier: 1.0, description: '🔫 BULLET'     },
  // Explosion / Nuke / Meteor
  explosion:   { effect: 'explosion', multiplier: 4.0, description: '💥 EXPLOSION'  },
  boom:        { effect: 'explosion', multiplier: 4.0, description: '💥 BOOM'       },
  explode:     { effect: 'explosion', multiplier: 4.0, description: '💥 EXPLODE'    },
  nuke:        { effect: 'explosion', multiplier: 6.0, description: '☢️ NUKE'       },
  nukes:       { effect: 'explosion', multiplier: 6.0, description: '☢️ NUKES'      },
  meteor:      { effect: 'fire',      multiplier: 8.0, description: '☄️ METEOR'      },
  // Gift / Hearts (low damage visual flair)
  gift:        { effect: 'gift',      multiplier: 0.5, description: '🎁 GIFT'        },
  hearts:      { effect: 'gift',      multiplier: 0.5, description: '💖 HEARTS'     },
  heal:        { effect: 'gift',      multiplier: 0.5, description: '💚 HEAL'        },
};

// Pool of effects for random non‑command attacks (fire, water, wind, laser)
const RANDOM_ATTACK_EFFECTS = ['fire', 'bubble', 'ripple', 'laser'];

// ────────────────────────────────
// HELPER FUNCTIONS (unchanged)
// ────────────────────────────────
function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function isSafePath(baseDir, targetPath) {
  const base   = path.resolve(baseDir);
  const target = path.resolve(targetPath);
  return target === base || target.startsWith(base + path.sep);
}

function parseCookies(req) {
  return Object.fromEntries(
    (req.headers.cookie || '').split(';').map(part => {
      const [name, ...rest] = part.trim().split('=');
      return [name, rest.join('=')];
    }).filter(([name]) => name)
  );
}

function loadRoomPlayerStats(room) {
  try {
    const rows = db.prepare('SELECT * FROM room_player_stats WHERE room_id = ?').all(room.roomId);

    for (const row of rows) {
      const id = row.unique_id;
      if (!room.players[id]) {
        room.players[id] = {
          uniqueId: id,
          nickname: row.nickname || id,
          hp:       row.hp || CFG.BASE_HP,
          maxHp:    row.max_hp || CFG.BASE_HP,
          strength: row.strength || CFG.BASE_STRENGTH,
          kills:    row.kills || 0,
          killStreak: row.kill_streak || 0,
          lastKillTime: row.last_kill_time || 0,
          alive:    false,
          lastActive: row.last_active || Date.now(),
          x: 0, y: 0, vx: 0, vy: 0,
          color: row.color || randomColor(),
          messageBoostExpires: row.message_boost_expires || 0,
          forceSpawn: false,
        };
      } else {
        const target = room.players[id];
        target.uniqueId = target.uniqueId || id;
        target.nickname = target.nickname || row.nickname || id;
        target.maxHp = Math.max(target.maxHp || CFG.BASE_HP, row.max_hp || CFG.BASE_HP);
        target.strength = Math.max(target.strength || CFG.BASE_STRENGTH, row.strength || CFG.BASE_STRENGTH);
        target.kills = row.kills || target.kills || 0;
        target.killStreak = target.killStreak || row.kill_streak || 0;
        target.lastKillTime = target.lastKillTime || row.last_kill_time || 0;
      }
    }

    console.log(`📂 Loaded ${rows.length} saved player stats for room ${room.roomId}`);
  } catch (err) {
    console.error('Error loading player stats for room', room.roomId, err);
  }
}

function saveRoomPlayerStats(room) {
  try {
    const stmt = db.prepare(`
      INSERT INTO room_player_stats (
        room_id, unique_id, nickname, hp, max_hp, strength, kills,
        kill_streak, last_kill_time, alive, last_active, color,
        message_boost_expires, force_spawn
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(room_id, unique_id) DO UPDATE SET
        nickname = excluded.nickname,
        hp = excluded.hp,
        max_hp = excluded.max_hp,
        strength = excluded.strength,
        kills = excluded.kills,
        kill_streak = excluded.kill_streak,
        last_kill_time = excluded.last_kill_time,
        alive = excluded.alive,
        last_active = excluded.last_active,
        color = excluded.color,
        message_boost_expires = excluded.message_boost_expires,
        force_spawn = excluded.force_spawn
    `);
    const tx = db.transaction(() => {
      for (const id in room.players) {
        const player = room.players[id];
        stmt.run(
          room.roomId,
          id,
          player.nickname,
          player.hp,
          player.maxHp,
          player.strength,
          player.kills,
          player.killStreak || 0,
          player.lastKillTime || 0,
          0,
          player.lastActive || Date.now(),
          player.color || randomColor(),
          player.messageBoostExpires || 0,
          0
        );
      }
    });
    tx();
  } catch (err) {
    console.error('Error saving player stats for room', room.roomId, err);
  }
}

function roomBackgroundExists(room, filename = room?.currentBackground?.filename) {
  if (!room || !filename) return false;
  try {
    const { backgroundDir } = getRoomPaths(room.roomId);
    const filepath = path.join(backgroundDir, filename);
    return isSafePath(backgroundDir, filepath) && fs.existsSync(filepath);
  } catch (_err) {
    return false;
  }
}

function buildBackgroundPayload(room, extraParams = {}) {
  const filename = room?.currentBackground?.filename;
  if (!room || !filename || !roomBackgroundExists(room, filename)) return null;

  const urlPath = `/background/${encodeURIComponent(filename)}`;
  const token = createOverlayToken(room.roomId);
  let url;
  if (enableRoomScoped && token) {
    url = appendOverlayAuth(urlPath, room.roomId, token, extraParams);
  } else {
    const parsed = new URL(urlPath, 'http://localhost');
    for (const [key, value] of Object.entries(extraParams)) {
      if (value != null && value !== '') parsed.searchParams.set(key, String(value));
    }
    url = `${parsed.pathname}${parsed.search}`;
  }

  return { ...room.currentBackground, filename, url };
}

function deleteRoomBackgroundFile(room, filename = room?.currentBackground?.filename) {
  if (!room || !filename) return;
  const { backgroundDir, backgroundMetaFile } = getRoomPaths(room.roomId);
  const filepath = path.join(backgroundDir, filename);
  if (isSafePath(backgroundDir, filepath) && fs.existsSync(filepath)) fs.unlinkSync(filepath);
  if (fs.existsSync(backgroundMetaFile)) fs.unlinkSync(backgroundMetaFile);
}

function loadRoomBackground(room) {
  try {
    if (room.currentBackground) {
      if (roomBackgroundExists(room)) return;
      console.warn(`Background file missing for room ${room.roomId}: ${room.currentBackground.filename}`);
      room.currentBackground = null;
      saveRoomSettings(room.roomId);
    }
    const { backgroundDir, backgroundMetaFile } = getRoomPaths(room.roomId);
    ensureDir(backgroundDir);
    if (fs.existsSync(backgroundMetaFile)) {
      room.currentBackground = JSON.parse(fs.readFileSync(backgroundMetaFile, 'utf8'));
      saveRoomSettings(room.roomId);
      console.log(`📸 Migrated background metadata to DB for room ${room.roomId}: ${room.currentBackground.filename}`);
    }
  } catch (err) {
    console.error('Error loading background for room', room.roomId, err);
  }
}

function saveRoomBackgroundMeta(room, file) {
  try {
    const filename = typeof file === 'string' ? file : file?.filename;
    if (!filename) {
      room.currentBackground = null;
      saveRoomSettings(room.roomId);
      return;
    }
    room.currentBackground = {
      filename,
      originalName: file?.originalname || file?.originalName || filename,
      size: file?.size || 0,
      uploadedAt: new Date().toISOString(),
    };
    saveRoomSettings(room.roomId);
    const { backgroundDir, backgroundMetaFile } = getRoomPaths(room.roomId);
    ensureDir(backgroundDir);
    fs.writeFileSync(backgroundMetaFile, JSON.stringify(room.currentBackground, null, 2));
  } catch (err) {
    console.error('Error saving background meta for room', room.roomId, err);
  }
}

const AUDIO_FILE_EXTS = new Set(['.mp3', '.m4a', '.wav', '.ogg', '.webm', '.aac', '.flac']);
const PRESET_AUDIO_LABELS = new Map([
  ['sound1.mp3', 'Impact Hit'],
  ['sound2.mp3', 'Power Strike'],
  ['sound3.mp3', 'Boss Hit'],
  ['sound4.mp3', 'Quick Zap'],
  ['sound5.mp3', 'Level Up'],
  ['sound6.mp3', 'Shield Pulse'],
  ['sound7.mp3', 'Victory Blast'],
  ['sound8.m4a', 'Arena Rise'],
  ['sound9.mp3', 'Final Blow'],
]);

function listAudioFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(file => AUDIO_FILE_EXTS.has(path.extname(file).toLowerCase()));
}

function getBundledAudioDir() {
  return path.join(__dirname, 'audio');
}

function resolveAudioFile(room, filename) {
  const safeName = path.basename(filename || '');
  if (!room || !safeName) return null;
  const { audioDir } = getRoomPaths(room.roomId);
  const runtimePath = path.join(audioDir, safeName);
  if (isSafePath(audioDir, runtimePath) && fs.existsSync(runtimePath)) return runtimePath;

  const bundledDir = getBundledAudioDir();
  const bundledPath = path.join(bundledDir, safeName);
  if (isSafePath(bundledDir, bundledPath) && fs.existsSync(bundledPath)) return bundledPath;

  return null;
}

function audioEntryFromFile(filename, filePath, source) {
  return {
    filename,
    originalName: source === 'preset' ? (PRESET_AUDIO_LABELS.get(filename) || filename) : filename,
    size: fs.existsSync(filePath) ? fs.statSync(filePath).size : 0,
    uploadedAt: source === 'preset' ? '2026-01-01T00:00:00.000Z' : new Date().toISOString(),
    source,
  };
}

function loadRoomAudioConfig(room) {
  try {
    const { audioDir, audioConfigFile } = getRoomPaths(room.roomId);
    ensureDir(audioDir);

    const repoCandidates = [
      path.join(__dirname, 'audio', 'audio-config.json'),
      path.join(__dirname, 'audio', 'audio', 'audio-config.json'),
    ];
    const repoConfig = repoCandidates.find(p => fs.existsSync(p));
    const beforeAudioState = JSON.stringify({
      config: room.audioConfig,
      library: room.audioLibrary,
      settings: room.overlaySettings,
    });

    if (!room.audioLibrary.length && fs.existsSync(audioConfigFile)) {
      const saved = JSON.parse(fs.readFileSync(audioConfigFile, 'utf8'));
      room.audioConfig = { ...DEFAULT_AUDIO_CONFIG, ...(saved.config || {}) };
      room.audioLibrary = Array.isArray(saved.library) ? saved.library : [];
      room.overlaySettings = { ...DEFAULT_OVERLAY_SETTINGS, ...(saved.settings || {}) };
      saveRoomSettings(room.roomId);
      console.log(`🔊 Migrated legacy room audio settings into DB for room ${room.roomId}`);
    } else if (!room.audioLibrary.length && repoConfig) {
      const saved = JSON.parse(fs.readFileSync(repoConfig, 'utf8'));
      room.audioConfig = { ...DEFAULT_AUDIO_CONFIG, ...(saved.config || {}) };
      room.audioLibrary = Array.isArray(saved.library) ? saved.library : [];
      room.overlaySettings = { ...DEFAULT_OVERLAY_SETTINGS, ...(saved.settings || {}) };
      saveRoomSettings(room.roomId);
      console.log(`🔊 Seeded room audio settings from repo into DB for room ${room.roomId}`);
    }

    const bundledAudioDir = getBundledAudioDir();
    const runtimeFiles = listAudioFiles(audioDir);
    const bundledFiles = listAudioFiles(bundledAudioDir);

    if (!room.audioLibrary.length) {
      room.audioLibrary = bundledFiles.map(filename => audioEntryFromFile(filename, path.join(bundledAudioDir, filename), 'preset'));
    } else {
      const known = new Set(room.audioLibrary.map(entry => entry.filename));
      bundledFiles.forEach(filename => {
        if (!known.has(filename)) {
          room.audioLibrary.push(audioEntryFromFile(filename, path.join(bundledAudioDir, filename), 'preset'));
          known.add(filename);
        }
      });
      runtimeFiles.forEach(filename => {
        if (!known.has(filename)) {
          room.audioLibrary.push(audioEntryFromFile(filename, path.join(audioDir, filename), 'uploaded'));
          known.add(filename);
        }
      });
    }

    room.audioLibrary = room.audioLibrary
      .map(entry => {
        const filename = path.basename(entry?.filename || '');
        const filePath = resolveAudioFile(room, filename);
        if (!filename || !filePath) return null;
        const source = filePath.startsWith(bundledAudioDir) ? 'preset' : (entry.source || 'uploaded');
        return {
          ...entry,
          filename,
          originalName: source === 'preset' ? (PRESET_AUDIO_LABELS.get(filename) || entry.originalName || filename) : (entry.originalName || filename),
          size: fs.statSync(filePath).size,
          uploadedAt: entry.uploadedAt || (source === 'preset' ? '2026-01-01T00:00:00.000Z' : new Date().toISOString()),
          source,
        };
      })
      .filter(Boolean);

    room.audioLibrary.sort((a, b) => a.originalName.localeCompare(b.originalName, undefined, { numeric: true, sensitivity: 'base' }));

    const allUnassigned = Object.values(room.audioConfig).every(val => !val);
    if (allUnassigned && room.audioLibrary.length) {
      const eventOrder = ['attack', 'gift', 'kill', 'respawn', 'heal', 'follow', 'socialBoost', 'engagementSurge'];
      eventOrder.forEach((event, idx) => {
        if (idx < room.audioLibrary.length) room.audioConfig[event] = room.audioLibrary[idx].filename;
      });
    }

    const afterAudioState = JSON.stringify({
      config: room.audioConfig,
      library: room.audioLibrary,
      settings: room.overlaySettings,
    });
    if (afterAudioState !== beforeAudioState) saveRoomSettings(room.roomId);

    console.log(`🔊 Loaded audio settings for room ${room.roomId} (${room.audioLibrary.length} files)`);
  } catch (err) {
    console.error('Error loading audio config for room', room.roomId, err);
  }
}

function saveRoomAudioConfig(room) {
  try {
    saveRoomSettings(room.roomId);
  } catch (err) {
    console.error('Error saving audio config for room', room.roomId, err);
  }
}

function loadRoomSponsorConfig(room) {
  try {
    const { sponsorDir, sponsorConfigFile } = getRoomPaths(room.roomId);
    ensureDir(sponsorDir);

    if (!Array.isArray(room.sponsorLibrary)) room.sponsorLibrary = [];
    if (!room.sponsorLibrary.length && fs.existsSync(sponsorConfigFile)) {
      const saved = JSON.parse(fs.readFileSync(sponsorConfigFile, 'utf8'));
      room.sponsorLibrary = Array.isArray(saved.library) ? saved.library : [];
    }

    const diskFiles = fs.existsSync(sponsorDir)
      ? fs.readdirSync(sponsorDir).filter(file => ALLOWED_SPONSOR_EXTS.has(path.extname(file).toLowerCase()))
      : [];

    const known = new Set(room.sponsorLibrary.map(entry => entry.filename));
    diskFiles.forEach(filename => {
      if (!known.has(filename)) {
        const filePath = path.join(sponsorDir, filename);
        room.sponsorLibrary.push({
          filename,
          originalName: filename,
          title: path.basename(filename, path.extname(filename)),
          partner: 'Sponsor',
          size: fs.existsSync(filePath) ? fs.statSync(filePath).size : 0,
          uploadedAt: new Date().toISOString(),
        });
      }
    });

    room.sponsorLibrary = room.sponsorLibrary.filter(entry => {
      const runtimePath = path.join(sponsorDir, entry.filename);
      return isSafePath(sponsorDir, runtimePath) && fs.existsSync(runtimePath);
    });
    room.sponsorLibrary.sort((a, b) => a.originalName.localeCompare(b.originalName, undefined, { numeric: true, sensitivity: 'base' }));
    saveRoomSponsorConfig(room);
  } catch (err) {
    console.error('Error loading sponsor media for room', room.roomId, err);
  }
}

function saveRoomSponsorConfig(room) {
  try {
    const { sponsorDir, sponsorConfigFile } = getRoomPaths(room.roomId);
    ensureDir(sponsorDir);
    fs.writeFileSync(sponsorConfigFile, JSON.stringify({ library: room.sponsorLibrary || [] }, null, 2));
  } catch (err) {
    console.error('Error saving sponsor media config for room', room.roomId, err);
  }
}

function savePlayerStats() {
  for (const room of getAllRooms().values()) {
    saveRoomPlayerStats(room);
  }
}

function loadPlayerStats() {
  for (const room of getAllRooms().values()) {
    loadRoomPlayerStats(room);
  }
}

function loadCurrentBackground() {
  for (const room of getAllRooms().values()) {
    loadRoomBackground(room);
  }
}

function loadAudioConfig() {
  for (const room of getAllRooms().values()) {
    loadRoomAudioConfig(room);
  }
}

function loadSponsorConfig() {
  for (const room of getAllRooms().values()) {
    loadRoomSponsorConfig(room);
  }
}

const ALLOWED_BACKGROUND_EXTS  = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);
const ALLOWED_BACKGROUND_MIMES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const BACKGROUND_UPLOAD_MAX_BYTES = uploadLimitBytes('BACKGROUND_UPLOAD_MAX_MB', 10 * 1024 * 1024);

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, _file, cb) => {
      const fallbackDir = path.join(process.env.DISK_PATH || __dirname, 'backgrounds');
      const bgDir = req?.room ? getRoomPaths(req.room.roomId).backgroundDir : fallbackDir;
      ensureDir(bgDir);
      cb(null, bgDir);
    },
    filename:    (_req, file, cb) => {
      const ext     = path.extname(file.originalname || '').toLowerCase();
      const safeExt = ALLOWED_BACKGROUND_EXTS.has(ext) ? ext : '.png';
      cb(null, `background-${Date.now()}-${Math.random().toString(36).slice(2)}${safeExt}`);
    },
  }),
  limits:     { fileSize: BACKGROUND_UPLOAD_MAX_BYTES },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    const ok  = ALLOWED_BACKGROUND_EXTS.has(ext) && ALLOWED_BACKGROUND_MIMES.has(file.mimetype);
    ok ? cb(null, true) : cb(new Error('Invalid background type. Please upload JPG, PNG, GIF, or WEBP only.'));
  },
});

const ALLOWED_AUDIO_EXTS  = new Set(['.mp3', '.m4a', '.wav', '.ogg', '.webm', '.aac', '.flac']);
const ALLOWED_AUDIO_MIMES = new Set([
  'audio/mpeg', 'audio/mp3', 'audio/mp4', 'audio/x-m4a',
  'audio/wav', 'audio/wave', 'audio/x-wav',
  'audio/ogg', 'audio/webm', 'audio/aac',
  'audio/flac', 'audio/x-flac', 'video/webm',
]);
const AUDIO_UPLOAD_MAX_BYTES = uploadLimitBytes('AUDIO_UPLOAD_MAX_MB', 20 * 1024 * 1024);

const audioUpload = multer({
  storage: multer.diskStorage({
    destination: (req, _file, cb) => {
      const fallbackDir = path.join(process.env.DISK_PATH || __dirname, 'audio');
      const audioDir = req?.room ? getRoomPaths(req.room.roomId).audioDir : fallbackDir;
      ensureDir(audioDir);
      cb(null, audioDir);
    },
    filename:    (_req, file, cb) => {
      const ext     = path.extname(file.originalname || '').toLowerCase();
      const safeExt = ALLOWED_AUDIO_EXTS.has(ext) ? ext : '.mp3';
      cb(null, `audio-${Date.now()}-${Math.random().toString(36).slice(2)}${safeExt}`);
    },
  }),
  limits:     { fileSize: AUDIO_UPLOAD_MAX_BYTES },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    const ok  = ALLOWED_AUDIO_EXTS.has(ext) && ALLOWED_AUDIO_MIMES.has(file.mimetype);
    ok ? cb(null, true) : cb(new Error('Invalid audio type. Use MP3, M4A, WAV, OGG, AAC, FLAC, or WEBM.'));
  },
});

const ALLOWED_SPONSOR_EXTS = new Set(['.mp4', '.webm', '.m4v', '.mov']);
const ALLOWED_SPONSOR_MIMES = new Set([
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'video/x-m4v',
  'application/octet-stream',
]);
const SPONSOR_UPLOAD_MAX_BYTES = uploadLimitBytes('SPONSOR_UPLOAD_MAX_MB', 100 * 1024 * 1024);

const SPONSOR_CONTENT_TYPES = new Map([
  ['.mp4', 'video/mp4'],
  ['.m4v', 'video/mp4'],
  ['.webm', 'video/webm'],
  ['.mov', 'video/quicktime'],
]);

const sponsorUpload = multer({
  storage: multer.diskStorage({
    destination: (req, _file, cb) => {
      const fallbackDir = path.join(process.env.DISK_PATH || __dirname, 'sponsors');
      const sponsorDir = req?.room ? getRoomPaths(req.room.roomId).sponsorDir : fallbackDir;
      ensureDir(sponsorDir);
      cb(null, sponsorDir);
    },
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname || '').toLowerCase();
      const safeExt = ALLOWED_SPONSOR_EXTS.has(ext) ? ext : '.mp4';
      cb(null, `sponsor-${Date.now()}-${Math.random().toString(36).slice(2)}${safeExt}`);
    },
  }),
  limits: { fileSize: SPONSOR_UPLOAD_MAX_BYTES },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    const ok = ALLOWED_SPONSOR_EXTS.has(ext) && ALLOWED_SPONSOR_MIMES.has(file.mimetype);
    ok ? cb(null, true) : cb(new Error('Invalid sponsor media type. Upload MP4, WEBM, M4V, or MOV video.'));
  },
});

function uploadErrorMessage(err, label = 'Upload') {
  if (err?.code === 'LIMIT_FILE_SIZE') return `${label} is too large. Reduce the file size and try again.`;
  if (/no space left|ENOSPC/i.test(err?.message || '')) return 'Server storage is full. Delete old media or increase the Render disk before uploading.';
  return err?.message || `${label} failed.`;
}

function contentLengthBytes(req) {
  const value = Number(req.get('content-length'));
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function storageRootForUpload(req, category) {
  if (category === 'background' && req?.room) return getRoomPaths(req.room.roomId).backgroundDir;
  if (category === 'audio' && req?.room) return getRoomPaths(req.room.roomId).audioDir;
  if (category === 'sponsor' && req?.room) return getRoomPaths(req.room.roomId).sponsorDir;
  return STORAGE_ROOT;
}

function uploadCapacityErrorPayload(decision) {
  return {
    success: false,
    error: decision.message || 'Storage capacity is too low for this upload.',
    reason: decision.reason || 'storage_capacity',
    storage: {
      incomingBytes: decision.incomingBytes,
      humanIncoming: decision.humanIncoming,
      used: decision.usage?.humanBytes || null,
      available: decision.usage?.capacity?.humanAvailable || null,
      configuredLimit: decision.usage?.humanConfiguredLimit || null,
    },
  };
}

function rejectUploadRequestIfStorageLow(req, res, category) {
  const incomingBytes = contentLengthBytes(req);
  if (!incomingBytes) return false;
  const decision = buildUploadDecision(storageRootForUpload(req, category), incomingBytes, { category });
  if (decision.ok) return false;
  res.status(507).json(uploadCapacityErrorPayload(decision));
  return true;
}

function cleanupUploadedFile(file) {
  try {
    if (file?.path && fs.existsSync(file.path)) fs.unlinkSync(file.path);
  } catch (_err) {}
}

function rejectUploadedFileIfStorageLow(req, res, file, category) {
  const incomingBytes = Number(file?.size || 0);
  if (!incomingBytes) return false;
  const decision = buildUploadDecision(storageRootForUpload(req, category), incomingBytes, { category, alreadyWritten: true });
  if (decision.ok) return false;
  cleanupUploadedFile(file);
  res.status(507).json(uploadCapacityErrorPayload(decision));
  return true;
}

function randomColor() {
  const palette = ['#FF6B6B','#FFD93D','#6BCB77','#4D96FF','#FF6BB5','#C77DFF','#00C9A7','#FF9F43'];
  return palette[Math.floor(Math.random() * palette.length)];
}

function normalizeTikTokId(user) {
  if (!user || typeof user !== 'object') return null;
  return String(user.uniqueId || user.unique_id || user.userId || user.id || '').trim().toLowerCase() || null;
}

function normalizeTikTokNick(user) {
  if (!user || typeof user !== 'object') return null;
  return String(user.nickname || user.nick || user.displayName || user.name || '').trim() || null;
}

function resolveTikTokUser(eventPayload) {
  const user = eventPayload?.user || eventPayload?.sender || eventPayload?.author || {};
  const id = normalizeTikTokId(user);
  const nickname = normalizeTikTokNick(user) || id;
  return { id, nickname };
}

function likeIncrementFromEvent(eventPayload = {}) {
  const raw = Number(eventPayload.likeCount ?? eventPayload.count ?? eventPayload.likes ?? 1);
  if (!Number.isFinite(raw) || raw <= 0) return 1;
  return Math.max(1, Math.min(100, Math.round(raw)));
}

function updateRoomLikeMilestone(room, increment = 1) {
  if (!room) return { total: 0, milestone: null, tier: null };
  if (!room.likeStats || typeof room.likeStats !== 'object') {
    room.likeStats = { total: 0, lastMilestone: 0 };
  }
  const step = Math.max(1, Math.round(Number(increment) || 1));
  const previous = Math.max(0, Number(room.likeStats.total) || 0);
  const total = previous + step;
  room.likeStats.total = total;

  const previousHundred = Math.floor(previous / 100);
  const currentHundred = Math.floor(total / 100);
  if (currentHundred <= previousHundred) {
    return { total, milestone: null, tier: null };
  }

  const milestone = currentHundred * 100;
  room.likeStats.lastMilestone = milestone;
  return {
    total,
    milestone,
    tier: milestone % 1000 === 0 ? 'mega' : 'standard',
  };
}

function spawnPlayer(room, uniqueId, nickname) {
  if (!room || !uniqueId) return;
  if (room.players[uniqueId]?.alive) {
    room.players[uniqueId].lastActive = Date.now();
    if (nickname) room.players[uniqueId].nickname = nickname;
    return;
  }
  const ex = room.players[uniqueId];
  room.players[uniqueId] = {
    uniqueId,
    nickname:            nickname || uniqueId,
    hp:                  ex?.maxHp    || CFG.BASE_HP,
    maxHp:               ex?.maxHp    || CFG.BASE_HP,
    strength:            ex?.strength || CFG.BASE_STRENGTH,
    alive:               true,
    kills:               ex?.kills    || 0,
    killStreak:          0,
    lastKillTime:        0,
    lastActive:          Date.now(),
    x:  Math.random() * 760 + 20,
    y:  Math.random() * 380 + 20,
    vx: (Math.random() - 0.5) * 2,
    vy: (Math.random() - 0.5) * 2,
    color:               ex?.color               || randomColor(),
    iconEmoji:           ex?.iconEmoji           || '💎',
    messageBoostExpires: ex?.messageBoostExpires || 0,
    shieldUntil:         ex?.shieldUntil         || 0,
    forceSpawn:          ex?.forceSpawn          || false,
  };
  console.log(`⚔️  Spawned: @${uniqueId} (HP: ${room.players[uniqueId].hp}, STR: ${room.players[uniqueId].strength}, Kills: ${room.players[uniqueId].kills})`);
}

function awardStats(room, uniqueId, nickname, hpBoost = 0, strBoost = 0) {
  if (!room || !uniqueId) return;
  if (!room.players[uniqueId]?.alive) spawnPlayer(room, uniqueId, nickname);
  const p = room.players[uniqueId];
  if (!p?.alive) return;
  if (hpBoost > 0) {
    p.maxHp += Math.floor(hpBoost * 0.5);
    p.hp     = Math.min(p.maxHp, p.hp + hpBoost);
    emitRoomEvent(room, 'heal', { uniqueId, amount: hpBoost });
  }
  p.strength  += strBoost;
  p.lastActive = Date.now();
}

function normalizeSocialEngagementType(eventPayload = {}) {
  const text = [
    eventPayload.type,
    eventPayload.socialType,
    eventPayload.eventType,
    eventPayload.action,
    eventPayload.displayType,
    eventPayload.label,
    eventPayload.message,
  ].filter(Boolean).join(' ').toLowerCase();
  if (/\bre[\s_-]?post\b/.test(text) || /\breposted\b/.test(text)) return 'repost';
  if (/\bshare\b/.test(text) || /\bshared\b/.test(text)) return 'share';
  return 'share';
}

function activeRewardTargets(room, limit = 8) {
  return Object.values(room?.players || {})
    .filter(player => player && player.alive && player.uniqueId !== SERVER_HORDE_ID && player.uniqueId !== SERVER_BOSS_ID)
    .sort((a, b) => (Number(b.kills) || 0) - (Number(a.kills) || 0) || (Number(b.hp) || 0) - (Number(a.hp) || 0))
    .slice(0, limit);
}

function applySquadRally(room, amount, options = {}) {
  const affected = [];
  const shieldMs = Math.max(0, Number(options.shieldMs) || 0);
  const now = Date.now();
  activeRewardTargets(room).forEach(player => {
    const maxHp = Math.max(1, Number(player.maxHp) || CFG.BASE_HP);
    const before = Number(player.hp) || 0;
    player.hp = Math.min(maxHp, before + amount);
    if (shieldMs) player.shieldUntil = Math.max(Number(player.shieldUntil) || 0, now + shieldMs);
    affected.push({
      uniqueId: player.uniqueId,
      nickname: player.nickname,
      amount: Math.max(0, Math.round(player.hp - before)),
      shielded: Boolean(shieldMs),
    });
  });
  return affected;
}

function updateEngagementMomentum(room, type) {
  if (!room) return { combo: 1, score: 0, tier: '', tierLabel: '', triggered: false };
  if (!room.engagementStats || typeof room.engagementStats !== 'object') {
    room.engagementStats = {
      total: 0,
      follow: 0,
      share: 0,
      repost: 0,
      combo: 0,
      score: 0,
      lastAt: 0,
      lastSurgeAt: 0,
      lastTier: '',
    };
  }
  const stats = room.engagementStats;
  const now = Date.now();
  const value = type === 'repost' ? 4 : type === 'share' ? 2 : 1;
  const chained = stats.lastAt && now - stats.lastAt <= CFG.ENGAGEMENT_COMBO_WINDOW_MS;
  stats.combo = chained ? Math.min(99, (Number(stats.combo) || 0) + 1) : 1;
  stats.score = chained ? Math.min(120, Math.max(0, Number(stats.score) || 0) + value) : value;
  stats.total = (Number(stats.total) || 0) + 1;
  stats[type] = (Number(stats[type]) || 0) + 1;
  stats.lastAt = now;

  let tier = '';
  let tierLabel = '';
  if (stats.score >= 24 || stats.combo >= 12) {
    tier = 'takeover';
    tierLabel = 'Arena Takeover';
  } else if (stats.score >= 14 || stats.combo >= 7) {
    tier = 'viral';
    tierLabel = 'Viral Rally';
  } else if (stats.score >= 7 || stats.combo >= 4) {
    tier = 'surge';
    tierLabel = 'Crowd Surge';
  }

  const rank = { '': 0, surge: 1, viral: 2, takeover: 3 };
  const improved = rank[tier] > rank[stats.lastTier || ''];
  const cooledDown = !stats.lastSurgeAt || now - stats.lastSurgeAt >= CFG.ENGAGEMENT_SURGE_COOLDOWN_MS;
  const triggered = Boolean(tier && (improved || cooledDown));
  if (triggered) {
    stats.lastSurgeAt = now;
    stats.lastTier = tier;
  }

  return {
    combo: stats.combo,
    score: stats.score,
    tier,
    tierLabel,
    triggered,
    totals: {
      total: stats.total,
      follow: stats.follow,
      share: stats.share,
      repost: stats.repost,
    },
  };
}

function emitEngagementSurge(room, sourcePayload = {}, momentum = {}) {
  if (!room || !momentum?.triggered) return;
  const tier = momentum.tier || 'surge';
  const tierLabel = momentum.tierLabel || 'Crowd Surge';
  emitSoundAndSync(room, 'engagementSurge', {
    intensity: tier === 'takeover' ? 1 : tier === 'viral' ? 0.86 : 0.72,
    tier: tier === 'takeover' ? 'rare' : 'common',
  });
  emitRoomEvent(room, 'engagementSurge', {
    uniqueId: sourcePayload.uniqueId || '',
    nickname: sourcePayload.nickname || 'Crowd',
    type: sourcePayload.type || 'engagement',
    tier,
    tierLabel,
    combo: momentum.combo,
    score: momentum.score,
    totals: momentum.totals,
    color: sourcePayload.color || (tier === 'takeover' ? '#f6c95b' : '#7afcff'),
  });
}

function applyEngagementReward(room, uniqueId, nickname, engagementType = 'share', rawEvent = {}) {
  if (!room || !uniqueId) return null;
  if (!room.players[uniqueId]?.alive) spawnPlayer(room, uniqueId, nickname);
  const player = room.players[uniqueId];
  if (!player) return null;
  const type = engagementType === 'follow' ? 'follow' : engagementType === 'repost' ? 'repost' : 'share';
  const momentum = updateEngagementMomentum(room, type);
  const comboBoost = Math.min(1.45, 1 + Math.max(0, Number(momentum.score) || 0) * 0.025);
  const baseColor = type === 'repost' ? '#f6c95b' : type === 'follow' ? '#7afcff' : '#99ffda';

  if (type === 'follow') {
    const hpBoost = Math.round(CFG.FOLLOW_HP_BOOST * comboBoost);
    const strengthBoost = Math.max(CFG.FOLLOW_STR_BOOST, Math.round(CFG.FOLLOW_STR_BOOST * comboBoost));
    awardStats(room, uniqueId, nickname, hpBoost, strengthBoost);
    const current = room.players[uniqueId];
    if (current) current.shieldUntil = Math.max(Number(current.shieldUntil) || 0, Date.now() + CFG.FOLLOW_SHIELD_MS);
    emitSoundAndSync(room, 'follow', { intensity: 0.72, tier: 'common' });
    const payload = {
      uniqueId,
      nickname,
      type,
      rewardLabel: 'Recruit Shield',
      hpBoost,
      strengthBoost,
      shieldMs: CFG.FOLLOW_SHIELD_MS,
      combo: momentum.combo,
      comboScore: momentum.score,
      surgeTier: momentum.tier,
      surgeLabel: momentum.tierLabel,
      color: current?.color || baseColor,
    };
    emitRoomEvent(room, 'follow', payload);
    emitEngagementSurge(room, payload, momentum);
    emitRoomEvent(room, 'gameState', room.players);
    return { type, affectedCount: 1, hpBoost, strengthBoost, momentum };
  }

  const isRepost = type === 'repost';
  const rallyHeal = Math.round((isRepost ? CFG.REPOST_RALLY_HEAL : CFG.SHARE_RALLY_HEAL) * comboBoost);
  const strengthBoost = Math.round((isRepost ? CFG.REPOST_STR_BOOST : CFG.SHARE_STR_BOOST) * comboBoost);
  const shieldMs = isRepost ? CFG.REPOST_SHIELD_MS : 0;
  awardStats(room, uniqueId, nickname, 0, strengthBoost);
  const affected = applySquadRally(room, rallyHeal, { shieldMs });
  let bossPressure = false;
  if (room.bossWave?.active) {
    bossPressure = true;
    damageBossWave(room, uniqueId, nickname, isRepost ? CFG.REPOST_BOSS_MULTIPLIER : CFG.SHARE_BOSS_MULTIPLIER, isRepost ? 'explosion' : 'ripple', `${type} surge`);
  }
  emitSoundAndSync(room, 'socialBoost', { intensity: isRepost ? 0.92 : 0.66, tier: isRepost ? 'rare' : 'common' });
  const payload = {
    uniqueId,
    nickname,
    type,
    rewardLabel: isRepost ? 'Broadcast Surge' : 'Squad Rally',
    amount: strengthBoost,
    strengthBoost,
    rallyHeal,
    shieldMs,
    affectedCount: affected.length,
    affected,
    bossPressure,
    combo: momentum.combo,
    comboScore: momentum.score,
    surgeTier: momentum.tier,
    surgeLabel: momentum.tierLabel,
    rawType: rawEvent.type || rawEvent.socialType || rawEvent.eventType || '',
    color: room.players[uniqueId]?.color || baseColor,
  };
  emitRoomEvent(room, 'socialBoost', payload);
  emitEngagementSurge(room, payload, momentum);
  emitRoomEvent(room, 'gameState', room.players);
  return { type, affectedCount: affected.length, rallyHeal, strengthBoost, shieldMs, bossPressure, momentum };
}

// ────────────────────────────────
// DEAL DAMAGE (enriched)
// ────────────────────────────────
function dealDamage(room, attackerId, targetId, multiplier = 1) {
  const attacker = room.players[attackerId];
  const target   = room.players[targetId];

  if (!attacker?.alive || !target?.alive || attackerId === targetId) return null;

  let dmg = Math.floor(
    attacker.strength * multiplier *
    (1 - CFG.ATTACK_VARIANCE / 2 + Math.random() * CFG.ATTACK_VARIANCE)
  );
  let shieldAbsorbed = 0;
  if (target.shieldUntil && target.shieldUntil > Date.now()) {
    shieldAbsorbed = Math.min(Math.max(1, Math.ceil(dmg * 0.55)), Math.max(0, dmg - 1));
    dmg = Math.max(1, dmg - shieldAbsorbed);
  }

  const preDamageHp = target.hp;
  target.hp = Math.max(0, target.hp - dmg);

  let killed = false;

  if (target.hp === 0) {
    target.alive = false;
    attacker.kills++;

    const now = Date.now();
    const streakExpired = now - attacker.lastKillTime > 30000;
    attacker.killStreak  = streakExpired ? 1 : (attacker.killStreak || 0) + 1;
    attacker.lastKillTime = now;
    target.killStreak    = 0;

    killed = true;
    console.log(`💀 @${targetId} defeated by @${attackerId}! (streak: ${attacker.killStreak})`);

    emitRoomEvent(room, 'killEvent', {
      killer:        attackerId,
      killerNick:    attacker.nickname,
      killerKills:   attacker.kills,
      killerStreak:  attacker.killStreak,
      killerColor:   attacker.color,
      victim:        targetId,
      victimNick:    target.nickname,
      damage:        dmg,
      effect:        'explosion',
      multiplier,
    });

    const streakMeta = CFG.STREAK_LABELS[attacker.killStreak];
    if (streakMeta) {
      emitRoomEvent(room, 'streakEvent', {
        uniqueId:  attackerId,
        nickname:  attacker.nickname,
        streak:    attacker.killStreak,
        label:     streakMeta.label,
        color:     streakMeta.color,
        scale:     streakMeta.scale,
        killerColor: attacker.color,
      });
      console.log(`🔥 @${attackerId} streak: ${streakMeta.label}`);
    }

    emitRoomEvent(room, 'soundEvent', { event: 'kill', intensity: Math.min(multiplier / 8, 1), tier: multiplier >= 5 ? 'rare' : 'common' });

    setTimeout(() => {
      spawnPlayer(room, targetId, target.nickname);
      emitRoomEvent(room, 'respawn', {
        uniqueId:      targetId,
        nickname:      target.nickname,
        hp:            room.players[targetId]?.hp,
        maxHp:         room.players[targetId]?.maxHp,
        color:         room.players[targetId]?.color,
        respawnEffect: 'beam_down',
        delayMs:       CFG.RESPAWN_DELAY_MS,
      });
      emitRoomEvent(room, 'soundEvent', { event: 'respawn', intensity: 0.5, tier: 'common' });
      emitRoomEvent(room, 'gameState', room.players);
    }, CFG.RESPAWN_DELAY_MS);
  }

  console.log(`⚡ @${attackerId} → @${targetId} for ${dmg} dmg${killed ? ' (KILL!)' : ''}${multiplier > 1 ? ' (SPECIAL!)' : ''}`);

  const baseResult = {
    attacker: attackerId,
    target: targetId,
    damage: dmg,
    killed,
    special: multiplier > 1,
    shielded: shieldAbsorbed > 0,
    shieldAbsorbed,
  };
  return buildAttackPayload(room, baseResult, { ...target, hp: preDamageHp });
}

function normalizeName(value = '') {
  return String(value).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function findTarget(room, mention) {
  const lower = String(mention || '').toLowerCase();
  const norm  = normalizeName(mention);
  return Object.values(room.players).find(p =>
    String(p.uniqueId || '').toLowerCase() === lower ||
    String(p.nickname || '').toLowerCase() === lower ||
    normalizeName(p.uniqueId || '') === norm ||
    normalizeName(p.nickname || '') === norm
  );
}

function cleanMention(rawMention = '') {
  return String(rawMention).trim()
    .replace(/^@+/, '')
    .replace(/^[^\w.]+/, '')
    .replace(/[^\w.]+$/g, '');
}

function extractMentions(comment = '') {
  return [...String(comment).matchAll(/@([^\s@]+)/g)]
    .map(match => cleanMention(match[1]))
    .filter(Boolean);
}

function textTargetsBossWave(text, mentions = []) {
  const bossTargets = new Set([
    'boss',
    'horde',
    'thehorde',
    'raidboss',
    'waveboss',
    normalizeName(SERVER_BOSS_ID),
    normalizeName(SERVER_HORDE_ID),
  ]);
  if (mentions.some(mention => bossTargets.has(normalizeName(mention)))) return true;
  const value = String(text || '').trim();
  if (/(^|\s)!(?:boss|raidboss|waveboss)\b/i.test(value)) return true;
  if (/(^|\s)!\S+\s+@?(?:boss|horde|thehorde|raidboss|waveboss)\b/i.test(value)) return true;
  if (/(^|\s)(?:attack|hit|strike|damage|fight)\s+@?(?:boss|horde|thehorde|raidboss|waveboss)\b/i.test(value)) return true;
  if (/\b(?:boss|horde|raidboss|waveboss)\b/i.test(value)) return true;
  return false;
}

function parseAttackCommand(text = '') {
  const value = String(text || '');
  const explicit = value.match(/(?:^|\s)[!/](\S+)/i);
  const rawCommand = explicit?.[1] || value.match(/\b([a-z][a-z0-9_-]{1,24})\b/i)?.[1] || '';
  const normalized = String(rawCommand || '').toLowerCase();
  if (EFFECT_COMMANDS[normalized]) return EFFECT_COMMANDS[normalized];

  const words = value.toLowerCase().match(/[a-z][a-z0-9_-]*/g) || [];
  const naturalEffect = words.find(word => EFFECT_COMMANDS[word]);
  return naturalEffect ? EFFECT_COMMANDS[naturalEffect] : null;
}

// ────────────────────────────────
// REWRITTEN handleMentionAttack
// ────────────────────────────────
function sanitizeIconEmoji(value = '') {
  const token = String(value || '').trim().split(/\s+/)[0] || '';
  const cleaned = token.replace(/[<>{}[\]\\]/g, '').trim();
  return Array.from(cleaned).slice(0, 4).join('');
}

function healPlayer(room, targetId, amount) {
  const player = room.players[targetId];
  if (!player) return 0;
  const before = Number(player.hp) || 0;
  player.hp = Math.min(Number(player.maxHp) || CFG.BASE_HP, before + amount);
  player.lastActive = Date.now();
  return Math.max(0, player.hp - before);
}

function handlePlayerUtilityCommand(room, playerId, nickname, comment) {
  const text = String(comment || '').trim();
  if (!text) return { handled: false, stop: false };

  const emojiMatch = text.match(/^\s*(?:!|\/)?emoji\s+(.+)/i);
  if (emojiMatch) {
    if (!room.players[playerId]?.alive) spawnPlayer(room, playerId, nickname);
    const iconEmoji = sanitizeIconEmoji(emojiMatch[1]);
    if (room.players[playerId] && iconEmoji) {
      room.players[playerId].iconEmoji = iconEmoji;
      room.players[playerId].forceSpawn = true;
      room.players[playerId].lastActive = Date.now();
      emitRoomEvent(room, 'playerCommand', {
        type: 'emoji',
        uniqueId: playerId,
        nickname,
        iconEmoji,
        message: `${nickname} changed their fighter icon`,
      });
    }
    return { handled: true, stop: true };
  }

  const commandMatch = text.match(/^\s*(?:!|\/)?(join|spawn|play|help|commands|heal|shield|guard|block)\b(?:\s+(.+))?/i);
  if (!commandMatch) return { handled: false, stop: false };

  const command = commandMatch[1].toLowerCase();
  const rest = commandMatch[2] || '';
  if (['join', 'spawn', 'play'].includes(command)) {
    const wasAlive = Boolean(room.players[playerId]?.alive);
    if (!wasAlive) spawnPlayer(room, playerId, nickname);
    if (room.players[playerId]) {
      room.players[playerId].alive = true;
      room.players[playerId].forceSpawn = true;
      room.players[playerId].lastActive = Date.now();
    }
    emitRoomEvent(room, 'spawn', { uniqueId: playerId, nickname });
    emitRoomEvent(room, 'playerCommand', {
      type: 'join',
      uniqueId: playerId,
      nickname,
      message: wasAlive ? `${nickname} rallied their fighter` : `${nickname} entered the arena`,
    });
    return { handled: true, stop: true };
  }

  if (['help', 'commands'].includes(command)) {
    if (!room.players[playerId]?.alive) spawnPlayer(room, playerId, nickname);
    emitRoomEvent(room, 'playerCommand', {
      type: 'help',
      uniqueId: playerId,
      nickname,
      message: `${nickname} opened the command list`,
    });
    return { handled: true, stop: true };
  }

  if (command === 'heal') {
    if (!room.players[playerId]?.alive) spawnPlayer(room, playerId, nickname);
    const mention = extractMentions(rest)[0];
    const target = mention ? findTarget(room, mention) : room.players[playerId];
    if (!target) return { handled: true, stop: true, reason: 'Heal target not found' };
    if (!room.players[target.uniqueId]?.alive) spawnPlayer(room, target.uniqueId, target.nickname);
    const amount = Math.max(8, CFG.LIKE_HP_BOOST * 8);
    const healed = healPlayer(room, target.uniqueId, amount);
    emitSoundAndSync(room, 'heal', { intensity: 0.45, tier: 'common' });
    emitRoomEvent(room, 'heal', {
      uniqueId: target.uniqueId,
      nickname: target.nickname,
      amount: healed || amount,
      sourceId: playerId,
      sourceNick: nickname,
      color: '#77f0a1',
    });
    emitRoomEvent(room, 'playerCommand', {
      type: 'heal',
      uniqueId: target.uniqueId,
      nickname: target.nickname,
      sourceId: playerId,
      sourceNick: nickname,
      amount: healed || amount,
      message: mention ? `${nickname} healed ${target.nickname || target.uniqueId}` : `${nickname} recovered HP`,
    });
    return { handled: true, stop: true };
  }

  if (['shield', 'guard', 'block'].includes(command)) {
    if (!room.players[playerId]?.alive) spawnPlayer(room, playerId, nickname);
    if (room.players[playerId]) {
      room.players[playerId].shieldUntil = Date.now() + 12000;
      room.players[playerId].lastActive = Date.now();
      room.players[playerId].forceSpawn = true;
    }
    emitSoundAndSync(room, 'heal', { intensity: 0.35, tier: 'common' });
    emitRoomEvent(room, 'playerCommand', {
      type: 'shield',
      uniqueId: playerId,
      nickname,
      message: `${nickname} raised a shield`,
      durationMs: 12000,
    });
    return { handled: true, stop: true };
  }

  return { handled: false, stop: false };
}

function handleMentionAttack(room, attackerId, attackerNick, comment) {
  const text = String(comment || '');
  const mentions = extractMentions(text);
  const bossMentioned = Boolean(room?.bossWave?.active && textTargetsBossWave(text, mentions));
  if (!mentions.length && !bossMentioned) return { handled: false, reason: 'No @mention found' };

  // Parse command words with or without !/ prefix.
  const attackCommand = parseAttackCommand(text);
  let requestedEffect  = null;
  let commandMultiplier = 1;
  let commandDescription = null;
  let isSpecialCommand  = false;

  if (attackCommand) {
    const entry = attackCommand;
    if (entry) {
      requestedEffect    = entry.effect;
      commandMultiplier  = entry.multiplier;
      commandDescription = entry.description;
      isSpecialCommand   = commandMultiplier > 1.5;
    }
  } else {
    // No !command – use a random effect from the default pool
    requestedEffect = RANDOM_ATTACK_EFFECTS[Math.floor(Math.random() * RANDOM_ATTACK_EFFECTS.length)];
    commandMultiplier = CFG.MESSAGE_LASER_MULTIPLIER;
  }

  // Ensure attacker exists
  if (!room.players[attackerId]?.alive) {
    spawnPlayer(room, attackerId, attackerNick);
    if (room.players[attackerId]) room.players[attackerId].forceSpawn = true;
  }
  if (room.players[attackerId]) {
    room.players[attackerId].lastActive = Date.now();
    room.players[attackerId].forceSpawn = true;
  }

  const attacker    = room.players[attackerId];
  const boostActive = attacker && attacker.messageBoostExpires > Date.now();

  let multiplier = commandMultiplier;
  if (boostActive) multiplier *= CFG.GIFT_MESSAGE_BOOST_MULTIPLIER;

  if (bossMentioned) {
    return damageBossWave(room, attackerId, attackerNick, multiplier, requestedEffect || 'laser', text);
  }

  for (const mention of mentions) {
    const target = findTarget(room, mention);
    if (!target) {
      console.log(`⚠️ Mention target not found: @${mention} from comment: ${comment}`);
      continue;
    }
    if (target.uniqueId === attackerId) {
      console.log(`⚠️ Ignored self-attack from @${attackerId}`);
      continue;
    }
    if (!room.players[target.uniqueId]?.alive) {
      spawnPlayer(room, target.uniqueId, target.nickname);
      if (room.players[target.uniqueId]) room.players[target.uniqueId].forceSpawn = true;
    }

    const topBefore = new Set(getTopPlayers(room, 5).map(p => p.uniqueId));
    const attackerScope = topBefore.has(attackerId) ? 'top' : 'horde';
    const targetScope = topBefore.has(target.uniqueId) ? 'top' : 'horde';
    const result = dealDamage(room, attackerId, target.uniqueId, multiplier);
    if (result) {
      result.effect = requestedEffect;                // force the chosen effect
      result.special            = isSpecialCommand;
      result.commandDescription = commandDescription || requestedEffect;
      result.giftBoosted        = boostActive;
      result.attackerScope      = attackerScope;
      result.targetScope        = targetScope;

      emitAttackAndSync(room, result);
      emitSoundAndSync(room, isSpecialCommand ? 'gift' : 'attack');
      emitRoomEvent(room, 'commentDamage', {
        attacker: attackerId,
        attackerNick,
        target:   target.uniqueId,
        targetNick: target.nickname,
        damage:   result.damage,
        killed:   result.killed,
        comment,
        special:  isSpecialCommand,
        effect:   requestedEffect,
        intensity: result.intensity,
        critical:  result.critical,
        giftBoosted: boostActive,
        commandDescription: commandDescription || requestedEffect,
        laserColor: result.laserColor,
        shotSpeed: result.shotSpeed,
        attackerScope,
        targetScope,
      });

      const cmdLabel = commandDescription || requestedEffect || 'MESSAGE';
      console.log(`💬 ${attackerNick} ${cmdLabel} → @${target.uniqueId} for ${result.damage} hp${boostActive ? ' (gift boost)' : ''}`);
      return { handled: true, result, target: target.uniqueId };
    }
  }

  return { handled: false, reason: 'No valid attack target found' };
}

// ────────────────────────────────
// APP & SOCKET.IO SETUP
// ────────────────────────────────
const app        = express();
const trustProxyHops = Number(process.env.TRUST_PROXY_HOPS || 1);
app.set('trust proxy', trustProxyHops);

app.get('/healthz', (_req, res) => {
  res.status(200).send('ok');
});

app.use((req, res, next) => {
  if (process.env.LOG_LEVEL === 'debug') {
    logger.debug({ method: req.method, path: req.path, ip: req.ip, query: req.query }, 'Incoming request');
  }
  next();
});

function safeOrigin(value) {
  try {
    return value ? new URL(value).origin : '';
  } catch (_err) {
    return '';
  }
}

function markRoomPlayerPresenceOffline(room) {
  if (!room?.roomId) return;
  try {
    db.prepare('UPDATE room_player_stats SET alive = 0, force_spawn = 0 WHERE room_id = ?').run(room.roomId);
  } catch (err) {
    logger.warn({ err, roomId: room.roomId }, 'Failed to mark persisted room players offline');
  }
}

function requestOrigin(req) {
  const host = req.get('host');
  if (!host) return '';
  return `${req.protocol}://${host}`;
}

function allowedBrowserOrigins(req) {
  return new Set([
    requestOrigin(req),
    safeOrigin(process.env.APP_BASE_URL),
  ].filter(Boolean));
}

function isAllowedBrowserOrigin(req, value) {
  const origin = safeOrigin(value);
  return Boolean(origin && allowedBrowserOrigins(req).has(origin));
}

function isAllowedSocketOrigin(origin) {
  if (!origin) return true;
  const normalized = safeOrigin(origin);
  if (!normalized) return false;
  const appOrigin = safeOrigin(process.env.APP_BASE_URL);
  return !appOrigin || normalized === appOrigin;
}

function shouldBypassOriginCheck(req) {
  return req.path === '/api/paypal/webhook';
}

const httpServer = createServer(app);
const io         = new Server(httpServer, {
  cors: {
    origin(origin, callback) {
      callback(null, isAllowedSocketOrigin(origin));
    },
  },
});

function emitAttackAndSync(room, result) {
  if (!result) return;
  if (!room.players[result.attacker] || !room.players[result.target]) {
    logger.warn({ attacker: result.attacker, target: result.target, room: room.roomId }, 'Emitting attack for player(s) not present in room state');
  }
  emitRoomEvent(room, 'attack', result);
  setTimeout(() => emitRoomEvent(room, 'gameState', room.players), 40);
}

function emitGiftAttackAndSync(room, result) {
  emitRoomEvent(room, 'giftAttack', result);
  setTimeout(() => emitRoomEvent(room, 'gameState', room.players), 40);
}

const enableRedisAdapter = process.env.ENABLE_REDIS_ADAPTER === 'true';
if (process.env.REDIS_URL && enableRedisAdapter) {
  (async () => {
    try {
      const pubClient = createRedisClient({ url: process.env.REDIS_URL });
      const subClient = pubClient.duplicate();

      // Add 5s timeout to prevent hanging on unreachable Redis
      const connectTimeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Redis connection timeout after 5s')), 5000)
      );

      await Promise.race([
        Promise.all([pubClient.connect(), subClient.connect()]),
        connectTimeout
      ]);

      io.adapter(createAdapter(pubClient, subClient));
      logger.info({ redis: process.env.REDIS_URL }, 'Socket.IO Redis adapter enabled');
    } catch (err) {
      logger.error({ err }, 'Failed to initialize Redis adapter for Socket.IO - continuing without Redis');
    }
  })();
} else {
  if (process.env.REDIS_URL && !enableRedisAdapter) {
    logger.info({ redis: process.env.REDIS_URL }, 'REDIS_URL present but ENABLE_REDIS_ADAPTER=false — running single-instance Socket.IO');
  } else {
    logger.info('Socket.IO running in single-instance mode (no Redis)');
  }
}

app.use(cookieParser());
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), usb=()');
  if (!req.path.startsWith('/overlay')) {
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  }
  if (/^\/(?:api|admin|dashboard|profile|stats|overlay|overlay-v2|state)(?:\/|$)/.test(req.path)) {
    res.setHeader('Cache-Control', 'no-store');
  }
  next();
});

app.use((req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || shouldBypassOriginCheck(req)) return next();
  const origin = req.get('origin');
  const referer = req.get('referer');
  if (!origin && !referer) return next();
  if ((origin && isAllowedBrowserOrigin(req, origin)) || (!origin && referer && isAllowedBrowserOrigin(req, referer))) {
    return next();
  }
  logger.warn({ method: req.method, path: req.path, origin: origin || null, referer: referer || null }, 'Blocked cross-origin state-changing request');
  return res.status(403).json({ success: false, error: 'Cross-origin request blocked' });
});

app.use((req, _res, next) => {
  if (req.method !== 'GET') return next();
  if (/^\/(?:api|admin|audio|background|dashboard|debug|metrics|overlay|overlay-v2|platform-sponsor|socket.io|sponsor|state|stats|vendor)(?:\/|$)/.test(req.path)) return next();
  const query = req.query || {};
  if (!(query.utm_source || query.utm_medium || query.utm_campaign || query.utm_content)) return next();
  recordMarketingVisit({
    utmSource: query.utm_source,
    utmMedium: query.utm_medium,
    utmCampaign: query.utm_campaign,
    utmContent: query.utm_content,
    path: req.originalUrl || req.url || req.path,
    referrer: req.get('referer') || '',
    userAgent: req.get('user-agent') || '',
  });
  next();
});

// Request debug logging middleware
app.use((req, res, next) => {
  const startTime = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - startTime;
    const logData = {
      method: req.method,
      path: req.path,
      statusCode: res.statusCode,
      durationMs: duration,
      ip: req.ip,
      userAgent: req.get('user-agent'),
    };
    
    // Log at appropriate level based on status code
    if (res.statusCode >= 500) {
      logger.error(logData, `${req.method} ${req.path}`);
    } else if (res.statusCode >= 400) {
      logger.warn(logData, `${req.method} ${req.path}`);
    } else {
      logger.debug(logData, `${req.method} ${req.path}`);
    }
  });
  next();
});

app.use('/', authRoutes);
app.use('/admin', adminRoutes);
app.use('/', paypalRoutes);

app.get('/', (req, res) => {
  const token = req.cookies?.session_token;
  if (token) {
    try {
      const auth = getAuthRecord(token);
      if (auth?.type === 'code') {
        const row = auth.record;
        if (row && !row.is_revoked) {
          if (new Date(row.expires_at) >= new Date()) return res.redirect('/dashboard');
          res.clearCookie('session_token', { path: '/', httpOnly: true, sameSite: 'lax' });
        }
      }
      if (auth?.type === 'user') {
        const user = auth.record;
        if (user && user.is_active) {
          return res.redirect('/dashboard');
        }
      }
    } catch (err) {
      logger.error({ err, path: req.path }, 'Homepage auth check failed; clearing auth cookie');
      res.clearCookie('session_token', { path: '/', httpOnly: true, sameSite: 'lax' });
    }
  }
  // If not authenticated, serve the public homepage instead of forcing login
  const homePath = path.join(__dirname, 'home.html');
  res.sendFile(homePath, (err) => {
    if (err) {
      logger.error({ err, path: homePath }, 'Failed to serve homepage');
      res.status(500).send('Internal Server Error');
    }
  });
});

app.get('/home', (_req, res) => res.sendFile(path.join(__dirname, 'home.html')));
app.get(['/sponsors', '/sponsors.html'], (_req, res) => res.sendFile(path.join(__dirname, 'sponsors.html')));
app.get(['/how-to-play', '/how-to-play.html', '/players', '/game-guide'], (_req, res) => res.sendFile(path.join(__dirname, 'how-to-play.html')));
app.get(['/site-map', '/site-map.html', '/sitemap'], (_req, res) => res.sendFile(path.join(__dirname, 'sitemap.html')));
app.get('/verify-email', (_req, res) => res.sendFile(path.join(__dirname, 'verify-email.html')));
app.get('/signup', (_req, res) => res.sendFile(path.join(__dirname, 'signup.html')));
app.get(['/battle-clip', '/battle-clip.html'], (_req, res) => res.sendFile(path.join(__dirname, 'battle-clip.html')));
app.get(['/overlay-preview', '/overlay-preview.html', '/overlay-demo', '/overlay-demo.html'], (_req, res) => res.sendFile(path.join(__dirname, 'overlay.html')));
app.get(['/overlay-v2-preview', '/overlay-v2-preview.html', '/overlay-v2-demo', '/overlay-v2-demo.html'], (_req, res) => res.sendFile(path.join(__dirname, 'overlay-v2.html')));
app.get(['/overlay-phaser', '/overlay-phaser.html'], (_req, res) => res.sendFile(path.join(__dirname, 'overlay-phaser.html')));
app.get('/register', (req, res) => {
  const token = req.cookies?.session_token;
  const auth = getAuthRecord(token);
  if (auth?.type === 'user') {
    const user = auth.record;
    if (user && user.is_active) {
      return res.redirect('/dashboard');
    }
  }
  res.sendFile(path.join(__dirname, 'register.html'));
});
app.get('/login', (req, res) => {
  const token = req.cookies?.session_token;
  const auth = getAuthRecord(token);
  if (auth?.type === 'code') {
    const row = auth.record;
    if (row && !row.is_revoked) {
      if (new Date(row.expires_at) >= new Date()) return res.redirect('/dashboard');
    }
  }
  if (auth?.type === 'user') {
    const user = auth.record;
    if (user && user.is_active) {
      return res.redirect('/dashboard');
    }
  }
  res.sendFile(path.join(__dirname, 'login.html'));
});
app.get('/profile', requireAccess, (_req, res) => res.sendFile(path.join(__dirname, 'profile.html')));
app.get('/request-password-reset', (_req, res) => res.sendFile(path.join(__dirname, 'request-password-reset.html')));
app.get('/reset-password', (_req, res) => res.sendFile(path.join(__dirname, 'reset-password.html')));
app.get('/paywall', (_req, res) => res.sendFile(path.join(__dirname, 'paywall.html')));
app.get('/paywall-link', (req, res) => {
  const inAppCheckoutConfigured = Boolean(
    process.env.PAYPAL_CLIENT_ID &&
    (process.env.PAYPAL_PLAN_ID || process.env.PAYPAL_SUBSCRIPTION_PLAN_ID)
  );
  if (inAppCheckoutConfigured && req.query?.fallback !== '1') {
    return res.redirect(302, '/paywall?checkout=paypal');
  }

  const url = process.env.PAYPAL_PAYMENT_LINK;
  if (!url) {
    return res.redirect(302, '/billing/error?reason=paypal_not_configured');
  }
  res.redirect(302, url);
});

app.get('/battle-recap/:sessionId', (req, res) => {
  const recap = getPublicSessionRecap(req.params.sessionId, req);
  if (!recap) return res.status(404).sendFile(path.join(__dirname, '404.html'));
  res.send(renderBattleRecapPage(recap));
});

app.get('/api/public/session-recap/:sessionId', (req, res) => {
  const recap = getPublicSessionRecap(req.params.sessionId, req);
  if (!recap) return res.status(404).json({ success: false, error: 'Recap not found' });
  res.json({ success: true, recap });
});

app.get('/api/public/comments', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=45');
  res.json({ success: true, comments: listPublicCreatorComments(18) });
});

app.post('/api/public/comments', (req, res) => {
  const name = cleanPublicText(req.body?.name, 70) || 'Creator';
  const email = cleanEmail(req.body?.email) || null;
  const role = cleanPublicText(req.body?.role, 80) || 'TikTok LIVE creator';
  const comment = cleanPublicText(req.body?.comment, 260);
  if (comment.length < 8) {
    return res.status(400).json({ success: false, error: 'Write a slightly longer comment.' });
  }
  try {
    db.prepare(`
      INSERT INTO creator_comments (name, email, role, comment, status, created_at)
      VALUES (?, ?, ?, ?, 'approved', CURRENT_TIMESTAMP)
    `).run(name, email, role, comment);
    return res.json({ success: true, comments: listPublicCreatorComments(18) });
  } catch (err) {
    logger.warn({ err }, 'Failed to save creator comment');
    return res.status(500).json({ success: false, error: 'Unable to save comment.' });
  }
});

app.post('/api/signup-intent', async (req, res) => {
  const result = upsertSignupIntent({
    email: req.body?.email,
    name: req.body?.name,
    tiktokUsername: req.body?.tiktokUsername,
    source: req.body?.source || 'signup',
    lastPath: req.body?.lastPath || req.path,
  });
  if (result.ok) {
    syncLeadToGrowthApis({
      email: req.body?.email,
      name: req.body?.name,
      tiktokUsername: req.body?.tiktokUsername,
      source: req.body?.source || 'signup',
      lastPath: req.body?.lastPath || req.path,
      eventName: 'Signup Intent Captured',
      properties: {
        endpoint: '/api/signup-intent',
      },
    }).catch(err => {
      logger.warn({ err: err?.message || err }, 'Growth API signup-intent sync failed');
    });
  }
  res.status(result.ok ? 200 : 400).json({ success: result.ok, error: result.error || undefined });
});

// Legacy code endpoints. Open code generation is retired; normal creator
// signup now creates a free account through /register or Google.
app.post('/auth/generate-code', express.json(), (req, res) => {
  res.status(410).json({
    success: false,
    error: 'Open code generation has been retired. Create a free creator account instead.',
    signupUrl: '/signup',
  });
});

app.post('/auth/create-account', express.json(), (req, res) => {
  const { email, code, name, tiktokUsername, roomName } = req.body;
  if (!email || !code || !name || !tiktokUsername || !roomName) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    const row = db.prepare('SELECT * FROM access_codes WHERE email = ? AND code = ?')
      .get(email.toLowerCase().trim(), code.toUpperCase());
    
    if (!row) return res.status(401).json({ error: 'Invalid code or email' });
    if (row.session_token) return res.status(400).json({ error: 'Code already used' });

    // Generate session token
    const sessionToken = jwt.sign(
      { email, code },
      process.env.JWT_SECRET,
      { expiresIn: '90d' }
    );

    // Create first room
    const roomId = createRoomId();

    // Update access code with profile and session. Existing access codes keep
    // their original expiration and paid/free status.
    db.prepare(`
      UPDATE access_codes
      SET session_token = ?, streamer_name = ?, tiktok_username = ?, room_id = ?,
          subscription_status = COALESCE(subscription_status, 'active')
      WHERE id = ?
    `).run(sessionToken, name, tiktokUsername, roomId, row.id);

    // Create room settings
    db.prepare(`
      INSERT INTO room_settings (room_id, overlay_settings, audio_config, audio_library)
      VALUES (?, ?, ?, ?)
    `).run(
      roomId,
      JSON.stringify(DEFAULT_OVERLAY_SETTINGS),
      JSON.stringify(DEFAULT_AUDIO_CONFIG),
      JSON.stringify([])
    );

    // Set session cookie using Express helper so browsers accept it with fetch credentials
    res.cookie('session_token', sessionToken, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 90 * 24 * 60 * 60 * 1000,
    });
    res.json({ success: true, roomId });
  } catch (err) {
    console.error('Account creation error:', err);
    res.status(500).json({ error: 'Failed to create account' });
  }
});

app.get(['/overlay.html', '/overlay'], (req, res) => {
  if (enableRoomScoped && req.query.room_id) {
    const roomId = normalizeRoomId(req.query.room_id);
    const overlayToken = getOverlayTokenFromRequest(req);
    if (!roomId) return res.status(400).send('Invalid room id');
    if (!verifyOverlayToken(roomId, overlayToken)) return res.status(401).send('Unauthorized overlay URL');
    return res.sendFile(path.join(__dirname, 'overlay.html'));
  }
  if (enableRoomScoped) {
    const room = getSessionRoom(req);
    if (room) {
      const overlayUrl = buildOverlayUrl(req, room.roomId);
      if (overlayUrl) return res.redirect(302, overlayUrl);
    }
  }
  return requireAccess(req, res, () => res.sendFile(path.join(__dirname, 'overlay.html')));
});

app.get(['/overlay-v2.html', '/overlay-v2'], (req, res) => {
  if (enableRoomScoped && req.query.room_id) {
    const roomId = normalizeRoomId(req.query.room_id);
    const overlayToken = getOverlayTokenFromRequest(req);
    if (!roomId) return res.status(400).send('Invalid room id');
    if (!verifyOverlayToken(roomId, overlayToken)) return res.status(401).send('Unauthorized overlay URL');
    return res.sendFile(path.join(__dirname, 'overlay-v2.html'));
  }
  if (enableRoomScoped) {
    const room = getSessionRoom(req);
    if (room) {
      const overlayUrl = buildOverlayUrl(req, room.roomId, '/overlay-v2');
      if (overlayUrl) return res.redirect(302, overlayUrl);
    }
  }
  return requireAccess(req, res, () => res.sendFile(path.join(__dirname, 'overlay-v2.html')));
});
app.get('/admin-panel',  requireAccess, (_req, res) => res.redirect('/admin'));

function assignPrivateRoomIfMissing(row) {
  if (row.room_id) return row.room_id;

  const assignedRoom = createRoomId();
  try {
    db.prepare('UPDATE access_codes SET room_id = ? WHERE id = ?').run(assignedRoom, row.id);
    ensureRoomSettingsRow(assignedRoom);
    row.room_id = assignedRoom;
    logger.warn({ rowId: row.id, code: row.code, assignedRoom, requiresRoomId: requiresRoomId() }, 'Created missing private room for access code');
  } catch (err) {
    logger.error({ err, rowId: row.id, code: row.code }, 'Failed to assign default room to access code');
  }
  return assignedRoom;
}

function socketAuth(socket, next) {
  const e2eAuth = getE2EAuthRecord(parseCookies(socket.request).session_token);
  if (e2eAuth) {
    socket.roomId = enableRoomScoped ? assignPrivateRoomIfMissing(e2eAuth.record) : DEFAULT_ROOM_ID;
    socket.accessCode = e2eAuth.record;
    return next();
  }

  // Allow signed OBS overlays to supply a room id through the Socket.IO handshake.
  const authRoom = enableRoomScoped ? (socket.handshake?.auth?.roomId || socket.handshake?.query?.room_id) : null;
  if (authRoom) {
    const roomId = normalizeRoomId(authRoom);
    const overlayToken = getOverlayTokenFromSocket(socket);
    if (roomId && verifyOverlayToken(roomId, overlayToken)) {
      socket.roomId = roomId;
      socket.data.overlayAuth = true;
      return next();
    }
    logger.warn({ authRoom: authRoom || null, tokenPresent: !!overlayToken }, 'Socket auth failed: invalid overlay token');
    return next(new Error('Unauthorized: invalid overlay token'));
  }

  // Otherwise require a valid session_token cookie and DB-backed access code
  const cookies = socket.handshake.headers.cookie || '';
  const parsed = Object.fromEntries(
    cookies.split(';').map(c => {
      const [name, ...rest] = c.trim().split('=');
      return [name, rest.join('=')];
    }).filter(([name]) => name)
  );
  const token = parsed.session_token;
  if (!token) {
    logger.warn({ authRoom: authRoom || null, tokenPresent: false }, 'Socket auth failed: no session token');
    return next(new Error('Unauthorized: no session token'));
  }

  try {
    jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    logger.warn({ tokenLength: String(token).length }, 'Socket auth failed: invalid token');
    return next(new Error('Unauthorized: invalid token'));
  }

  const row = db.prepare('SELECT * FROM access_codes WHERE session_token = ?').get(token);
  if (row) {
    if (row.is_revoked || new Date(row.expires_at) < new Date()) {
      logger.warn({ rowId: row?.id, code: row?.code, isRevoked: row?.is_revoked, expiresAt: row?.expires_at }, 'Socket auth failed: expired or revoked');
      return next(new Error('Unauthorized: expired or revoked'));
    }
    socket.roomId = enableRoomScoped ? assignPrivateRoomIfMissing(row) : DEFAULT_ROOM_ID;
    socket.accessCode = row;
    return next();
  }

  const user = db.prepare('SELECT * FROM users WHERE session_token = ?').get(token);
  if (!user || !user.is_active) {
    logger.warn({ userId: user?.id, isActive: user?.is_active }, 'Socket auth failed: invalid user session');
    return next(new Error('Unauthorized: invalid session'));
  }
  socket.roomId = enableRoomScoped ? ensureUserRoomId(user) : DEFAULT_ROOM_ID;
  if (!socket.roomId) {
    logger.error({ userId: user.id }, 'Socket auth failed: user has no room and room creation failed');
    return next(new Error('Unauthorized: room unavailable'));
  }
  socket.user = user;
  next();
}

function requireRoom(req, res, next) {
  const token = req.cookies?.session_token;
  if (!token) {
    logger.warn({ path: req.path, method: req.method, tokenPresent: false }, 'API auth failed: no session token');
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }

  const auth = getAuthRecord(token);
  if (!auth) {
    logger.warn({ path: req.path, method: req.method, tokenPresent: true }, 'API auth failed: invalid token');
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }
  req.auth = auth;

  if (auth.type === 'code') {
    const row = auth.record;
    if (row.is_revoked || new Date(row.expires_at) < new Date()) {
      logger.warn({ path: req.path, method: req.method, rowId: row?.id, code: row?.code, isRevoked: row?.is_revoked, expiresAt: row?.expires_at }, 'API auth failed: expired or revoked');
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    req.roomId = enableRoomScoped ? assignPrivateRoomIfMissing(row) : DEFAULT_ROOM_ID;
    logger.info({ path: req.path, method: req.method, rowId: row.id, code: row.code, roomId: req.roomId, requiresRoomId: requiresRoomId() }, '/api/connect auth success');
  } else {
    const user = auth.record;
    if (!user.is_active) {
      logger.warn({ path: req.path, method: req.method, userId: user.id }, 'API auth failed: user disabled');
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    const roomId = enableRoomScoped ? ensureUserRoomId(user) : DEFAULT_ROOM_ID;
    if (!roomId) {
      logger.error({ path: req.path, method: req.method, userId: user.id }, 'API auth failed: user room unavailable');
      return res.status(500).json({ success: false, error: 'Creator room unavailable. Please try again.' });
    }
    req.roomId = roomId;
    req.user = user;
    logger.info({ path: req.path, method: req.method, userId: user.id, roomId, requiresRoomId: requiresRoomId() }, '/api/connect auth success');
  }

  req.room = getOrCreateRoom(req.roomId);
  loadRoomPlayerStats(req.room);
  loadRoomBackground(req.room);
  loadRoomAudioConfig(req.room);
  req.planEntitlements = buildPlanEntitlements(auth);
  updatePlatformSponsorSchedule(req.room, req.planEntitlements);
  next();
}

function requireCreatorSponsorAccess(req, res, next) {
  const auth = req.auth || getAuthRecord(req.cookies?.session_token);
  const plan = buildPlanEntitlements(auth);
  if (!plan.canUseCreatorSponsors) {
    return res.status(403).json({
      success: false,
      error: 'Creator sponsor controls require Creator Pro or beta tester access.',
      upgradeUrl: '/paywall?reason=creator_sponsors',
      plan,
    });
  }
  next();
}

function getSessionRoom(req) {
  const token = req.cookies?.session_token;
  const auth = getAuthRecord(token);
  if (!auth) return null;

  let roomId = DEFAULT_ROOM_ID;
  if (auth.type === 'code') {
    const row = auth.record;
    if (row.is_revoked || new Date(row.expires_at) < new Date()) return null;
    roomId = enableRoomScoped ? assignPrivateRoomIfMissing(row) : DEFAULT_ROOM_ID;
  } else {
    const user = auth.record;
    if (!user.is_active) return null;
    roomId = enableRoomScoped ? ensureUserRoomId(user) : DEFAULT_ROOM_ID;
    if (!roomId) return null;
  }

  const room = getOrCreateRoom(roomId);
  loadRoomPlayerStats(room);
  loadRoomBackground(room);
  loadRoomAudioConfig(room);
  return room;
}

function parseDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function toIsoStringOrNull(date) {
  return date ? date.toISOString() : null;
}

function trialExpiresAtForUser(user) {
  const createdAt = parseDate(user?.created_at);
  if (!createdAt) return null;
  return new Date(createdAt.getTime() + FREE_TRIAL_DAYS * 24 * 60 * 60 * 1000);
}

function isTrialStatus(value) {
  return ['trial', 'trialing', 'free-trial', 'full-access-trial'].includes(String(value || '').toLowerCase());
}

function daysRemainingUntil(date, now = new Date()) {
  if (!date) return null;
  return Math.max(0, Math.ceil((date.getTime() - now.getTime()) / (24 * 60 * 60 * 1000)));
}

function paywallUrl(reason) {
  return `/paywall?reason=${encodeURIComponent(reason || 'subscription_required')}`;
}

function buildAccessCodeSubscriptionStatus(row, now = new Date()) {
  const expiresAt = parseDate(row.expires_at);
  const rawStatus = String(row.subscription_status || 'active').toLowerCase();
  const paid = isPaidAccessCode(row);
  const beta = isBetaTesterAccessCode(row);
  const creatorSponsors = (paid || beta);

  let status = paid ? 'active' : beta ? 'beta' : 'free';
  let reason = null;
  let accessAllowed = true;

  if (row.is_revoked) {
    status = 'revoked';
    reason = 'revoked';
    accessAllowed = false;
  } else if (expiresAt && expiresAt < now) {
    status = 'expired';
    reason = 'expired';
    accessAllowed = false;
  } else if (['cancelled', 'suspended', 'expired', 'revoked'].includes(rawStatus)) {
    status = beta ? 'beta' : 'free';
  }

  return {
    type: 'code',
    status,
    tier: paid && accessAllowed ? 'paid' : beta && accessAllowed ? 'beta' : 'free',
    planName: paid && accessAllowed ? 'Creator Pro' : beta && accessAllowed ? 'Beta Tester' : 'Free',
    canUseCreatorSponsors: creatorSponsors && accessAllowed,
    platformSponsorManaged: !(creatorSponsors && accessAllowed),
    betaTester: beta && accessAllowed,
    reason,
    accessAllowed,
    actionRequired: !accessAllowed,
    paywallUrl: accessAllowed ? null : paywallUrl(reason),
    subscription: {
      status: rawStatus,
      planType: paid ? 'Creator Pro' : beta ? 'Beta Tester' : 'Free',
      paypalSubscriptionId: row.paypal_subscription_id || null,
      startedAt: null,
      nextBillingDate: null,
      expiresAt: toIsoStringOrNull(expiresAt),
    },
  };
}

function buildUserSubscriptionStatus(user, now = new Date()) {
  if (!user.is_active) {
    return {
      type: 'user',
      status: 'revoked',
      reason: 'revoked',
      accessAllowed: false,
      actionRequired: true,
      paywallUrl: paywallUrl('revoked'),
      subscription: null,
    };
  }

  const subscription = db.prepare(
    'SELECT * FROM subscriptions WHERE user_id = ? ORDER BY updated_at DESC LIMIT 1'
  ).get(user.id);

  if (!subscription) {
    const fallbackTrialExpiresAt = trialExpiresAtForUser(user);
    const fallbackTrialActive = fallbackTrialExpiresAt && fallbackTrialExpiresAt >= now;
    if (fallbackTrialActive) {
      return {
        type: 'user',
        status: 'trialing',
        tier: 'trial',
        planName: '7-Day Full Access',
        canUseCreatorSponsors: true,
        platformSponsorManaged: false,
        reason: null,
        accessAllowed: true,
        actionRequired: false,
        paywallUrl: null,
        subscription: {
          status: 'trialing',
          planType: '7-Day Full Access',
          paypalSubscriptionId: null,
          startedAt: toIsoStringOrNull(parseDate(user.created_at)),
          nextBillingDate: null,
          expiresAt: toIsoStringOrNull(fallbackTrialExpiresAt),
        },
      };
    }
    return {
      type: 'user',
      status: 'free',
      tier: 'free',
      planName: 'Free',
      canUseCreatorSponsors: false,
      platformSponsorManaged: true,
      reason: null,
      accessAllowed: true,
      actionRequired: false,
      paywallUrl: null,
      subscription: {
        status: 'free',
        planType: 'Free',
        paypalSubscriptionId: null,
        startedAt: null,
        nextBillingDate: null,
        expiresAt: null,
      },
    };
  }

  const rawStatus = String(subscription.status || 'unknown').toLowerCase();
  const startedAt = parseDate(subscription.started_at);
  const expiresAt = parseDate(subscription.expires_at);
  const nextBillingDate = parseDate(subscription.next_billing_date);
  let status = rawStatus;
  let reason = null;
  let accessAllowed = true;
  const paid = rawStatus === 'active';
  const trial = isTrialStatus(rawStatus) && (!expiresAt || expiresAt >= now);

  if (!paid && !trial) {
    status = 'free';
  }

  return {
    type: 'user',
    status,
    tier: paid ? 'paid' : trial ? 'trial' : 'free',
    planName: paid ? 'Creator Pro' : trial ? '7-Day Full Access' : 'Free',
    canUseCreatorSponsors: paid || trial,
    platformSponsorManaged: !(paid || trial),
    reason,
    accessAllowed,
    actionRequired: !accessAllowed,
    paywallUrl: accessAllowed ? null : paywallUrl(reason),
    subscription: {
      status: rawStatus,
      planType: paid ? (subscription.plan_type || 'Creator Pro') : trial ? (subscription.plan_type || '7-Day Full Access') : 'Free',
      paypalSubscriptionId: subscription.paypal_subscription_id || null,
      startedAt: toIsoStringOrNull(startedAt),
      nextBillingDate: toIsoStringOrNull(nextBillingDate),
      expiresAt: toIsoStringOrNull(expiresAt),
    },
  };
}

function buildSubscriptionStatus(auth) {
  if (!auth) return null;
  if (auth.type === 'code') return buildAccessCodeSubscriptionStatus(auth.record);
  return buildUserSubscriptionStatus(auth.record);
}

io.use(socketAuth);

app.use((req, res, next) => {
  if (req.path === '/dashboard.html' || req.path === '/dashboard-login.html') {
    return res.redirect('/dashboard');
  }
  if (req.path === '/profile.html') {
    return res.redirect('/profile');
  }
  if (req.path === '/stats.html') {
    return res.redirect('/stats');
  }
  if (req.path.startsWith('/backgrounds/') || /^\/audio\/[^/]+\/.+/.test(req.path) || /^\/players_[^/]+\.json$/.test(req.path)) {
    return res.status(404).send('Not found');
  }
  next();
});

const publicAssetFiles = new Map([
  ['/logo.svg', 'logo.svg'],
  ['/intothebattlelogo_logo_only.svg', 'intothebattlelogo_logo_only.svg'],
  ['/robots.txt', 'robots.txt'],
  ['/sitemap.xml', 'sitemap.xml'],
]);

app.get([...publicAssetFiles.keys()], (req, res) => {
  const file = publicAssetFiles.get(req.path);
  return res.sendFile(path.join(__dirname, file));
});

app.use('/js', express.static(path.join(__dirname, 'js'), {
  dotfiles: 'deny',
  etag: true,
  fallthrough: false,
  index: false,
  maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0,
}));

app.use('/vendor/microsoft-clarity', express.static(path.join(__dirname, 'node_modules', '@microsoft', 'clarity'), {
  dotfiles: 'deny',
  etag: true,
  fallthrough: false,
  index: false,
  maxAge: process.env.NODE_ENV === 'production' ? '1d' : 0,
}));

app.use('/vendor/phaser', express.static(path.join(__dirname, 'node_modules', 'phaser', 'dist'), {
  dotfiles: 'deny',
  etag: true,
  fallthrough: false,
  index: false,
  maxAge: process.env.NODE_ENV === 'production' ? '7d' : 0,
}));

app.get('/api/public-config', (_req, res) => {
  const clarityProjectId = String(process.env.CLARITY_PROJECT_ID || '').trim();
  res.set('Cache-Control', process.env.NODE_ENV === 'production' ? 'public, max-age=300' : 'no-store');
  res.json({
    clarity: {
      enabled: Boolean(clarityProjectId && process.env.NODE_ENV === 'production'),
      projectId: clarityProjectId || null,
    },
  });
});

function requireMetricsAccess(req, res, next) {
  if (process.env.NODE_ENV !== 'production') return next();

  const expectedToken = process.env.METRICS_TOKEN;
  if (!expectedToken) return res.status(404).send('Not found');

  const authHeader = req.get('authorization') || '';
  const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice('Bearer '.length) : '';
  const suppliedToken = bearerToken || req.get('x-metrics-token');
  if (suppliedToken === expectedToken) return next();

  return res.status(401).send('Unauthorized');
}

function requireDiagnosticsAccess(req, res, next) {
  if (process.env.NODE_ENV !== 'production') return next();

  const expectedToken = process.env.DIAGNOSTICS_TOKEN || process.env.METRICS_TOKEN;
  if (!expectedToken) return res.status(404).send('Not found');

  const authHeader = req.get('authorization') || '';
  const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice('Bearer '.length) : '';
  const suppliedToken = bearerToken || req.get('x-diagnostics-token') || req.get('x-metrics-token');
  if (suppliedToken === expectedToken) return next();

  return res.status(401).send('Unauthorized');
}

app.get('/metrics', requireMetricsAccess, async (_req, res) => {
  try {
    res.setHeader('Content-Type', register.contentType);
    res.end(await register.metrics());
  } catch (err) {
    res.status(500).end(err.message);
  }
});

app.get('/api/runtime/diagnostics', requireDiagnosticsAccess, (req, res) => {
  const storage = checkWritableStorage({ includeUsage: true });
  const dbHealth = getDbHealthSnapshot();
  const ok = storage.ok && (dbHealth.mode === 'stub' || dbHealth.initialized);

  res.status(ok ? 200 : 503).json({
    ok,
    time: new Date().toISOString(),
    request: {
      host: req.get('host'),
      protocol: req.protocol,
    },
    runtime: {
      nodeEnv: process.env.NODE_ENV || 'development',
      host: HOST,
      port: PORT,
      envPortPresent: Boolean(process.env.PORT),
      roomScoped: enableRoomScoped,
      devTestMode: DEV_TEST_MODE,
    },
    config: {
      appBaseUrl: process.env.APP_BASE_URL || null,
      jwtSecretPresent: Boolean(process.env.JWT_SECRET),
      overlayTokenSecretPresent: Boolean(process.env.OVERLAY_TOKEN_SECRET),
      apiKeyPresent: Boolean(API_KEY),
      metricsTokenPresent: Boolean(process.env.METRICS_TOKEN),
      diagnosticsTokenPresent: Boolean(process.env.DIAGNOSTICS_TOKEN),
      platformSponsorEnabled: PLATFORM_SPONSOR_ENABLED,
    },
    email: getEmailDiagnostics(),
    growth: growthIntegrationDiagnostics(),
    marketing: marketingAutomationDiagnostics(),
    storage,
    database: dbHealth,
  });
});

app.get('/api/runtime/launch-readiness', requireDiagnosticsAccess, (_req, res) => {
  const storage = checkWritableStorage({ includeUsage: true });
  const report = buildLaunchReadinessReport({
    env: process.env,
    storage,
    database: getDbHealthSnapshot(),
    email: getEmailDiagnostics(),
    sponsorTools: getSponsorMediaToolStatus(),
  });
  res.status(report.ok ? 200 : 503).json(report);
});

app.post('/api/runtime/email-test', requireDiagnosticsAccess, async (req, res) => {
  const to = String(req.body?.to || process.env.POSTMARK_TEST_EMAIL || '').trim();
  if (!to) {
    return res.status(400).json({
      success: false,
      error: 'Set POSTMARK_TEST_EMAIL or send {"to":"you@example.com"} in the request body.',
      email: getEmailDiagnostics(),
    });
  }

  try {
    const delivery = await sendTransactionalEmail({
      to,
      subject: 'IntoTheBattle email test',
      tag: 'runtime-email-test',
      metadata: { source: 'runtime-diagnostics' },
      htmlBody: '<p>IntoTheBattle email delivery is working.</p>',
      textBody: 'IntoTheBattle email delivery is working.',
    });

    if (delivery.skipped) {
      return res.status(503).json({
        success: false,
        skipped: true,
        reason: delivery.reason,
        email: getEmailDiagnostics(),
      });
    }

    return res.json({
      success: true,
      messageId: delivery.messageId,
      submittedAt: delivery.submittedAt,
      email: getEmailDiagnostics(),
    });
  } catch (err) {
    return res.status(502).json({
      success: false,
      error: err.message || 'Postmark email delivery failed.',
      provider: err.emailDelivery || null,
      email: getEmailDiagnostics(),
    });
  }
});

app.post('/api/runtime/signup-followups', requireDiagnosticsAccess, async (req, res) => {
  try {
    const result = await sendAbandonedSignupFollowups(req.body?.limit);
    return res.json({ success: true, ...result });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: err.message || 'Unable to process signup follow-ups.',
    });
  }
});

app.post('/api/runtime/growth-sync-test', requireDiagnosticsAccess, async (req, res) => {
  const email = cleanEmail(req.body?.email || process.env.POSTMARK_TEST_EMAIL || '');
  if (!email) {
    return res.status(400).json({
      success: false,
      error: 'Set POSTMARK_TEST_EMAIL or send {"email":"you@example.com"} in the request body.',
      growth: growthIntegrationDiagnostics(),
    });
  }

  const result = await syncLeadToGrowthApis({
    email,
    name: req.body?.name || 'IntoTheBattle Test Lead',
    tiktokUsername: req.body?.tiktokUsername || 'growth_test',
    source: 'runtime-diagnostics',
    lastPath: '/api/runtime/growth-sync-test',
    eventName: 'Growth Integration Test',
    properties: { manualTest: true },
  });

  return res.status(result.ok ? 200 : 502).json({
    success: result.ok,
    ...result,
    growth: growthIntegrationDiagnostics(),
  });
});

app.get('/audio/:filename', (req, res) => {
  const filename = path.basename(req.params.filename);
  const bundledDir = getBundledAudioDir();
  const bundledPath = path.join(bundledDir, filename);
  const bundledPresetPath = isSafePath(bundledDir, bundledPath) && fs.existsSync(bundledPath)
    ? bundledPath
    : null;
  let room = req.room || null;
  if (!room && enableRoomScoped && req.query.room_id) {
    const roomId = normalizeRoomId(req.query.room_id);
    const overlayToken = getOverlayTokenFromRequest(req);
    if (!roomId) return res.status(400).send('Invalid room id');
    if (!verifyOverlayToken(roomId, overlayToken)) return res.status(401).send('Unauthorized');
    room = getOrCreateRoom(roomId);
  }
  if (!room) room = getSessionRoom(req);
  if (!room) {
    if (bundledPresetPath) return res.sendFile(bundledPresetPath);
    return res.status(401).send('Unauthorized');
  }
  const audioPath = resolveAudioFile(room, filename);
  if (audioPath) return res.sendFile(audioPath);
  return res.status(404).send('Audio file not found');
});

app.get('/sponsor/:filename', (req, res) => {
  const filename = path.basename(req.params.filename);
  let room = req.room || null;
  if (!room && enableRoomScoped && req.query.room_id) {
    const roomId = normalizeRoomId(req.query.room_id);
    const overlayToken = getOverlayTokenFromRequest(req);
    if (!roomId) return res.status(400).send('Invalid room id');
    if (!verifyOverlayToken(roomId, overlayToken)) return res.status(401).send('Unauthorized');
    room = getOrCreateRoom(roomId);
  }
  if (!room) room = getSessionRoom(req);
  if (!room) return res.status(401).send('Unauthorized');
  loadRoomSponsorConfig(room);
  const { sponsorDir } = getRoomPaths(room.roomId);
  const runtimePath = path.join(sponsorDir, filename);
  if (!isSafePath(sponsorDir, runtimePath)) return res.status(403).send('Forbidden');
  if (fs.existsSync(runtimePath)) return sendSponsorMedia(req, res, runtimePath, filename);
  return res.status(404).send('Sponsor media not found');
});

function hasAdminSession(req) {
  const token = req.cookies?.admin_session_token;
  if (!token) return false;
  try {
    const row = db.prepare('SELECT * FROM admin_sessions WHERE session_token = ?').get(token);
    return Boolean(row && new Date(row.expires_at) >= new Date());
  } catch (err) {
    logger.error({ err }, 'Failed to verify admin media access');
    return false;
  }
}

app.get('/platform-sponsor/:filename', (req, res) => {
  if (enableRoomScoped && req.query.room_id) {
    const roomId = normalizeRoomId(req.query.room_id);
    const overlayToken = getOverlayTokenFromRequest(req);
    if (!roomId) return res.status(400).send('Invalid room id');
    if (!verifyOverlayToken(roomId, overlayToken)) return res.status(401).send('Unauthorized');
  } else if (!hasAdminSession(req)) {
    return res.status(401).send('Unauthorized');
  }

  const filename = path.basename(req.params.filename);
  const runtimePath = path.join(PLATFORM_SPONSOR_DIR, filename);
  if (!isSafePath(PLATFORM_SPONSOR_DIR, runtimePath)) return res.status(403).send('Forbidden');
  if (!fs.existsSync(runtimePath)) return res.status(404).send('Sponsor media not found');
  return sendSponsorMedia(req, res, runtimePath, filename);
});

function sanitizeSponsorText(value, fallback = '', maxLength = 120) {
  const text = String(value || '').trim();
  return (text || fallback).slice(0, maxLength);
}

function parseSponsorDuration(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 15000;
  return Math.max(5000, Math.min(120000, Math.round(parsed)));
}

function parseSponsorMuted(value) {
  return !(value === false || value === 'false' || value === '0' || value === 0);
}

function parseSponsorStatsMode(value) {
  return ['endcap', 'delayed', 'hidden', 'always'].includes(value) ? value : 'endcap';
}

const SPONSOR_TIMING_PROFILES = {
  bumper: { durationMs: 6000, statsMode: 'hidden', kicker: 'Arena Bumper' },
  spotlight: { durationMs: 12000, statsMode: 'endcap', kicker: 'Arena Spotlight' },
  feature: { durationMs: 20000, statsMode: 'endcap', kicker: 'Feature Moment' },
  full: { durationMs: null, statsMode: 'endcap', kicker: 'Arena Spotlight' },
};

function parseSponsorTimingProfile(value) {
  const profile = String(value || '').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(SPONSOR_TIMING_PROFILES, profile) ? profile : 'spotlight';
}

function sponsorProfileDuration(profile, requestedDuration, mediaDurationMs = null) {
  const config = SPONSOR_TIMING_PROFILES[profile] || SPONSOR_TIMING_PROFILES.spotlight;
  if (profile === 'full' && Number(mediaDurationMs) > 0) {
    return Math.max(5000, Math.min(60000, Math.round(Number(mediaDurationMs))));
  }
  if (config.durationMs) return config.durationMs;
  return parseSponsorDuration(requestedDuration);
}

function sponsorProfileStatsMode(profile, requestedStatsMode) {
  const config = SPONSOR_TIMING_PROFILES[profile] || SPONSOR_TIMING_PROFILES.spotlight;
  const requested = String(requestedStatsMode || '').trim().toLowerCase();
  if (['endcap', 'delayed', 'hidden', 'always'].includes(requested)) return requested;
  return config.statsMode || 'endcap';
}

function sponsorKickerForProfile(profile) {
  return (SPONSOR_TIMING_PROFILES[profile] || SPONSOR_TIMING_PROFILES.spotlight).kicker;
}

function sponsorCreativePlaybackIssue(entry) {
  if (!entry) return null;
  const processingStatus = String(entry.processingStatus || entry.processing_status || '').trim().toLowerCase();
  const readinessStatus = String(entry.readinessStatus || entry.readiness_status || '').trim().toLowerCase();
  const qualityStatus = String(entry.qualityGateStatus || entry.quality_status || '').trim().toLowerCase();

  if (['processing', 'queued'].includes(processingStatus)) return 'Sponsor media is still processing.';
  if (processingStatus === 'failed') return entry.processingMessage || entry.processing_message || 'Sponsor media processing failed.';
  if (qualityStatus === 'blocked') return entry.qualityBlockers || entry.quality_blockers || 'Sponsor media failed the production quality gate.';
  if (readinessStatus === 'failed') return entry.playbackMessage || entry.playback_message || 'Sponsor media failed its last overlay test.';

  return null;
}

function sponsorContentType(filename) {
  return SPONSOR_CONTENT_TYPES.get(path.extname(filename || '').toLowerCase()) || 'application/octet-stream';
}

function inlineContentDisposition(filename) {
  const fallback = path.basename(filename || 'sponsor-video').replace(/["\r\n]/g, '');
  return `inline; filename="${fallback}"`;
}

function sponsorMediaEtag(stat) {
  return `W/"${Number(stat.size || 0).toString(16)}-${Math.round(Number(stat.mtimeMs || 0)).toString(16)}"`;
}

function requestMatchesEtag(req, etag) {
  const raw = String(req.headers['if-none-match'] || '').trim();
  if (!raw) return false;
  return raw.split(',').map(value => value.trim()).includes(etag);
}

function requestMatchesModifiedSince(req, stat) {
  const raw = String(req.headers['if-modified-since'] || '').trim();
  if (!raw) return false;
  const since = Date.parse(raw);
  if (!Number.isFinite(since)) return false;
  return Math.floor(stat.mtimeMs / 1000) <= Math.floor(since / 1000);
}

function sendSponsorMedia(req, res, filepath, filename) {
  let stat;
  try {
    stat = fs.statSync(filepath);
  } catch (_err) {
    return res.status(404).send('Sponsor media not found');
  }

  const fileSize = stat.size;
  const contentType = sponsorContentType(filename);
  const etag = sponsorMediaEtag(stat);
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Disposition', inlineContentDisposition(filename));
  res.setHeader('ETag', etag);
  res.setHeader('Last-Modified', stat.mtime.toUTCString());
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (!fileSize) {
    res.setHeader('Content-Length', '0');
    return res.status(204).end();
  }

  const range = req.headers.range;
  if (!range) {
    if (requestMatchesEtag(req, etag) || requestMatchesModifiedSince(req, stat)) {
      return res.status(304).end();
    }
    res.setHeader('Content-Length', fileSize);
    if (req.method === 'HEAD') return res.status(200).end();
    const stream = fs.createReadStream(filepath);
    stream.on('error', () => {
      if (!res.headersSent) res.status(500).end();
      else res.destroy();
    });
    return stream.pipe(res);
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match) {
    res.setHeader('Content-Range', `bytes */${fileSize}`);
    return res.status(416).end();
  }

  let start;
  let end;
  if (match[1] === '' && match[2] !== '') {
    const suffixLength = Number(match[2]);
    start = Math.max(fileSize - suffixLength, 0);
    end = fileSize - 1;
  } else {
    start = Number(match[1] || 0);
    end = match[2] === '' ? fileSize - 1 : Number(match[2]);
  }

  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end >= fileSize || start > end) {
    res.setHeader('Content-Range', `bytes */${fileSize}`);
    return res.status(416).end();
  }

  const chunkSize = end - start + 1;
  res.status(206);
  res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
  res.setHeader('Content-Length', chunkSize);
  if (req.method === 'HEAD') return res.end();

  const stream = fs.createReadStream(filepath, { start, end });
  stream.on('error', () => {
    if (!res.headersSent) res.status(500).end();
    else res.destroy();
  });
  return stream.pipe(res);
}

function buildSponsorScenePayload(room, body = {}) {
  loadRoomSponsorConfig(room);
  const filename = body.filename ? path.basename(String(body.filename)) : '';
  const entry = filename ? room.sponsorLibrary.find(item => item.filename === filename) : null;
  if (filename && !entry) return { error: 'Sponsor media not found' };
  const playbackIssue = entry ? sponsorCreativePlaybackIssue(entry) : null;
  if (playbackIssue) return { error: playbackIssue, status: 409 };
  const timingProfile = parseSponsorTimingProfile(body.timingProfile || body.placement || 'spotlight');
  const mediaDurationMs = entry?.durationSeconds ? Math.round(Number(entry.durationSeconds) * 1000) : null;

  return {
    action: 'show',
    source: 'creator',
    filename: entry?.filename || null,
    title: sanitizeSponsorText(body.title, entry?.title || entry?.originalName || 'Power Moment', 90),
    partner: sanitizeSponsorText(body.partner, entry?.partner || 'Presented By', 70),
    kicker: sponsorKickerForProfile(timingProfile),
    subtitle: sanitizeSponsorText(body.subtitle, entry?.subtitle || 'Stay locked in. The next fight is loading.', 140),
    durationMs: sponsorProfileDuration(timingProfile, body.durationMs, mediaDurationMs),
    mediaDurationMs,
    mediaWidth: entry?.width || null,
    mediaHeight: entry?.height || null,
    processingStatus: entry?.processingStatus || null,
    readinessStatus: entry?.readinessStatus || null,
    muted: parseSponsorMuted(body.muted),
    fit: ['cover', 'contain'].includes(body.fit) ? body.fit : 'contain',
    statsMode: sponsorProfileStatsMode(timingProfile, body.statsMode),
    timingProfile,
    posterData: entry?.thumbnailData || '',
    theme: ['arena', 'premium', 'minimal'].includes(body.theme) ? body.theme : 'arena',
    _ts: Date.now(),
  };
}

io.on('connection', (socket) => {
  const room = getOrCreateRoom(socket.roomId);
  if (!room) {
    socket.disconnect();
    return;
  }
  const socketAuthRecord = socket.user
    ? { type: 'user', record: socket.user }
    : socket.accessCode
      ? { type: 'code', record: socket.accessCode }
      : null;
  updatePlatformSponsorSchedule(room, buildPlanEntitlements(socketAuthRecord));

  if (!room.initialized) {
    loadRoomPlayerStats(room);
    loadRoomBackground(room);
    loadRoomAudioConfig(room);
    loadRoomSponsorConfig(room);
    room.initialized = true;
  }

  socket.emit('serverReady', {
    socketId: socket.id,
    roomId: room.roomId,
    overlayCount: room.overlayCount,
    overlaySettings: room.overlaySettings,
    laserColor: room.overlaySettings.laserColor,
    gameStateCount: Object.values(room.players).filter(p => p.alive).length,
    stream: buildTikTokConnectionStatus(room),
  });

  socket.on('register', ({ type } = {}, ack) => {
    const clientType = String(type || 'unknown').toLowerCase();
    const previousType = socket.data.clientType;
    socket.data.clientType = clientType;
    socket.join(room.roomId);

    if (clientType === 'overlay') {
      if (previousType !== 'overlay') room.overlayCount++;
      emitRoomEvent(room, 'overlayCount', { count: room.overlayCount });
      updateOverlayGauge();

      socket.emit('gameState',        room.players);
      socket.emit('audioConfig',      room.audioConfig);
      socket.emit('overlaySettings',  room.overlaySettings);
      socket.emit('laserColor',       room.overlaySettings.laserColor);
      socket.emit('sessionStatus',    buildSessionStatus(room));
      socket.emit('tiktokConnection',  buildTikTokConnectionStatus(room));
      socket.emit('setupMode',         room.setupRehearsal || { active: false });
      const bossStatus = currentBossStatus(room);
      if (bossStatus?.active) socket.emit('bossWave', { type: 'started', ...bossStatus });
      const background = buildBackgroundPayload(room, { v: Date.now() });
      if (background) socket.emit('backgroundChanged', background);
    } else if (clientType === 'dashboard' || clientType === 'stats') {
      if (previousType === 'overlay') {
        room.overlayCount = Math.max(0, room.overlayCount - 1);
        emitRoomEvent(room, 'overlayCount', { count: room.overlayCount });
        updateOverlayGauge();
      }
      socket.emit('overlayCount',    { count: room.overlayCount });
      socket.emit('overlaySettings', room.overlaySettings);
      socket.emit('laserColor',      room.overlaySettings.laserColor);
      socket.emit('gameState',       room.players);
      socket.emit('sessionStatus',   buildSessionStatus(room));
      socket.emit('tiktokConnection', buildTikTokConnectionStatus(room));
      socket.emit('setupMode',        room.setupRehearsal || { active: false });
    }

    if (typeof ack === 'function') {
      ack({ success: true, type: clientType, roomId: room.roomId, overlayCount: room.overlayCount, eventSeq: room.eventSeq || 0 });
    }
  });

  socket.on('disconnect', () => {
    if (socket.data.clientType === 'overlay') {
      room.overlayCount = Math.max(0, room.overlayCount - 1);
      emitRoomEvent(room, 'overlayCount', { count: room.overlayCount });
      updateOverlayGauge();
    }
  });

  socket.on('sponsorPlaybackEvent', (event = {}) => {
    handleSponsorPlaybackEvent(socket, room, event);
  });

  socket.on('layoutUpdate', (settings) => {
    emitRoomEvent(room, 'layoutUpdate', settings);
  });
});

// ────────────────────────────────
// DASHBOARD & ASSET ROUTES (unchanged)
// ────────────────────────────────
app.get('/dashboard/logout', (req, res) => {
  const token = req.cookies?.session_token;
  if (token) {
    db.prepare('UPDATE access_codes SET session_token = NULL WHERE session_token = ?').run(token);
    db.prepare('UPDATE users SET session_token = NULL WHERE session_token = ?').run(token);
  }
  res.clearCookie('session_token', { path: '/', httpOnly: true, sameSite: 'lax' });
  res.redirect('/login');
});

app.get('/logout', (req, res) => {
  const token = req.cookies?.session_token;
  if (token) {
    db.prepare('UPDATE access_codes SET session_token = NULL WHERE session_token = ?').run(token);
    db.prepare('UPDATE users SET session_token = NULL WHERE session_token = ?').run(token);
  }
  res.clearCookie('session_token', { path: '/', httpOnly: true, sameSite: 'lax' });
  res.clearCookie('fp', { path: '/', sameSite: 'lax' });
  res.redirect('/');
});

app.get('/dashboard', requireDashboardAccess, (_req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});

app.get('/dashboard/welcome', requireDashboardAccess, (_req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard-welcome.html'));
});

// Debug endpoint: return session-backed auth record for troubleshooting (non-production only)
app.get('/debug/session-info', (req, res) => {
  if (process.env.NODE_ENV === 'production') return res.status(404).send('Not found');
  const token = req.cookies?.session_token;
  if (!token) return res.json({ success: true, token: null });
  try {
    const auth = getAuthRecord(token);
    if (!auth) return res.json({ success: true, token, auth: null });
    if (auth.type === 'code') {
      const row = auth.record;
      return res.json({ success: true, type: 'code', row });
    }
    const user = auth.record;
    const subscription = db.prepare('SELECT * FROM subscriptions WHERE user_id = ? ORDER BY updated_at DESC LIMIT 1').get(user.id);
    return res.json({ success: true, type: 'user', user, subscription });
  } catch (err) {
    console.error('debug/session-info error:', err);
    return res.status(500).json({ success: false, error: 'Server error' });
  }
});

app.get('/stats', requireDashboardAccess, (_req, res) => res.sendFile(path.join(__dirname, 'stats.html')));

app.get('/state', (req, res) => {
  if (enableRoomScoped && req.query.room_id) {
    const roomId = normalizeRoomId(req.query.room_id);
    const overlayToken = getOverlayTokenFromRequest(req);
    if (!roomId) return res.status(400).json({ success: false, error: 'Invalid room id' });
    if (!verifyOverlayToken(roomId, overlayToken)) return res.status(401).json({ success: false, error: 'Unauthorized' });
    const room = getOrCreateRoom(roomId);
    loadRoomPlayerStats(room);
    loadRoomBackground(room);
    loadRoomAudioConfig(room);
    return res.json(room.players);
  }
  if (!req.room) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }
  return res.json(req.room.players);
});

app.get('/api/status', requireRoom, (req, res) => {
  const stream = buildTikTokConnectionStatus(req.room);
  res.json({
    roomId:           req.room.roomId,
    overlayUrl:       buildOverlayUrl(req, req.room.roomId),
    overlayV2Url:     buildOverlayUrl(req, req.room.roomId, '/overlay-v2'),
    setupOverlayUrl:  buildOverlayUrl(req, req.room.roomId, '/overlay', { setup: '1', controls: '1', debug: '1' }),
    setupOverlayV2Url: buildOverlayUrl(req, req.room.roomId, '/overlay-v2', { setup: '1', render: '1080p', source: '1', show_status: '1' }),
    plan:             buildPlanEntitlements(req.auth),
    username:         req.room.streamerUsername || '',
    connected:        stream.connected,
    stream,
    overlayConnected: req.room.overlayCount > 0,
    overlayCount:     req.room.overlayCount,
    playerCount:      Object.values(req.room.players).filter(p => p.alive).length,
    background:       buildBackgroundPayload(req.room, { v: Date.now() }),
    overlaySettings:  req.room.overlaySettings,
    devTestMode:      DEV_TEST_MODE,
    setupRehearsal:   req.room.setupRehearsal || { active: false },
    session:          buildSessionStatus(req.room),
  });
});

app.get('/api/session/status', requireRoom, (req, res) => {
  res.json(buildSessionStatus(req.room));
});

app.post('/api/session/start', requireRoom, (req, res) => {
  const session = startLiveSession(req.room, 'dashboard');
  res.json({ success: true, session: buildSessionStatus(req.room), sessionId: session?.sessionId || null });
});

app.post('/api/session/end', requireRoom, (req, res) => {
  const result = endLiveSession(req.room, 'dashboard_end');
  res.status(result.ok ? 200 : 409).json({
    success: result.ok,
    error: result.ok ? undefined : 'No active session to end.',
    ...result,
    session: buildSessionStatus(req.room),
  });
});

app.post('/api/session/round/start', requireRoom, (req, res) => {
  const round = startBattleRound(req.room, {
    source: 'dashboard',
    durationMs: req.body?.durationMs,
  });
  res.json({ success: true, round: currentRoundStatus(req.room) || round, session: buildSessionStatus(req.room) });
});

app.post('/api/session/round/end', requireRoom, (req, res) => {
  const result = endBattleRound(req.room, 'dashboard_end');
  res.status(result.ok ? 200 : 409).json({
    success: result.ok,
    error: result.ok ? undefined : 'No active round to end.',
    ...result,
    session: buildSessionStatus(req.room),
  });
});

app.post('/api/session/boss/start', requireRoom, (req, res) => {
  const bossWave = startBossWave(req.room, {
    source: 'dashboard',
    maxHp: req.body?.maxHp,
    durationMs: req.body?.durationMs,
    attackIntervalMs: req.body?.attackIntervalMs,
    attackDamage: req.body?.attackDamage,
  });
  res.json({ success: true, bossWave: currentBossStatus(req.room) || bossWave, session: buildSessionStatus(req.room) });
});

app.post('/api/session/boss/stop', requireRoom, (req, res) => {
  const result = completeBossWave(req.room, null, 'stopped');
  res.status(result.ok ? 200 : 409).json({
    success: result.ok,
    error: result.ok ? undefined : 'No active boss wave to stop.',
    ...result,
    session: buildSessionStatus(req.room),
  });
});

app.get('/api/subscription/status', (req, res) => {
  try {
    const auth = getAuthRecord(req.cookies?.session_token);
    if (!auth) return res.status(401).json({ success: false, error: 'Unauthorized' });

    const status = buildSubscriptionStatus(auth);
    if (!status) return res.status(401).json({ success: false, error: 'Unauthorized' });
    return res.json({ success: true, ...status });
  } catch (err) {
    logger.error({ err }, 'Failed to build subscription status');
    return res.status(500).json({ success: false, error: 'Unable to load subscription status' });
  }
});

function ensureRoomLiveTestPlayers(room) {
  const testPlayers = [
    { id: 'arena_orion', nick: 'Orion', x: 240, y: 170, icon: '\u2694\ufe0f' },
    { id: 'arena_blaze', nick: 'Blaze', x: 540, y: 195, icon: '\ud83d\udd25' },
    { id: 'arena_nova', nick: 'Nova', x: 390, y: 315, icon: '\ud83d\udc8e' },
  ];
  testPlayers.forEach((player, index) => {
    if (!room.players[player.id]) spawnPlayer(room, player.id, player.nick);
    const record = room.players[player.id];
    if (!record) return;
    record.uniqueId = player.id;
    record.nickname = player.nick;
    record.alive = true;
    record.hp = Math.max(80, Number(record.hp) || CFG.BASE_HP);
    record.maxHp = Math.max(CFG.BASE_HP, Number(record.maxHp) || CFG.BASE_HP);
    record.strength = Math.max(CFG.BASE_STRENGTH, Number(record.strength) || CFG.BASE_STRENGTH);
    record.x = player.x;
    record.y = player.y;
    record.vx = (index - 1) * 0.4;
    record.vy = (index === 1 ? 0.3 : -0.2);
    record.iconEmoji = player.icon;
    record.forceSpawn = true;
    record.lastActive = Date.now();
  });
  emitRoomEvent(room, 'gameState', room.players);
  return testPlayers;
}

function runRoomOverlayTest(room, action) {
  const normalizedAction = String(action || '').toLowerCase();
  ensureRoomLiveTestPlayers(room);
  const attackerId = 'arena_orion';
  const targetId = 'arena_blaze';
  const supportId = 'arena_nova';

  if (normalizedAction === 'attack') {
    const result = handleMentionAttack(room, attackerId, 'Orion', '!laser @arena_blaze');
    emitRoomEvent(room, 'gameState', room.players);
    return { success: true, action: normalizedAction, result };
  }

  if (normalizedAction === 'gift') {
    const diamonds = 25;
    awardStats(room, supportId, 'Nova', diamonds * CFG.GIFT_HP_PER_DIAMOND, diamonds * CFG.GIFT_STR_PER_DIAMOND);
    const result = dealDamage(room, supportId, targetId, 2.1);
    if (result) {
      emitGiftAttackAndSync(room, {
        ...result,
        diamonds,
        effect: 'laser',
        intensity: 0.72,
        giftColor: '#7afcff',
        attackerScope: 'top',
        targetScope: 'top',
      });
    }
    const giftMeta = classifyGift(diamonds);
    emitSoundAndSync(room, 'gift', { intensity: 0.72, tier: giftMeta.tier || 'common' });
    emitRoomEvent(room, 'giftCelebration', {
      attacker: supportId,
      nickname: 'Nova',
      giftName: 'Test Gift',
      diamonds,
      ...giftMeta,
    });
    emitRoomEvent(room, 'gameState', room.players);
    return { success: true, action: normalizedAction, result };
  }

  if (normalizedAction === 'like') {
    const hearts = 8;
    const intensity = 0.65;
    awardStats(room, supportId, 'Nova', CFG.LIKE_HP_BOOST * hearts, 0);
    const likeMilestone = updateRoomLikeMilestone(room, 100);
    emitSoundAndSync(room, 'heal', { intensity, tier: 'common' });
    emitRoomEvent(room, 'like', {
      uniqueId: supportId,
      nickname: 'Nova',
      hearts,
      rate: 240,
      increment: 100,
      totalLikes: likeMilestone.total,
      milestone: likeMilestone.milestone,
      milestoneTier: likeMilestone.tier,
      intensity,
      color: room.players[supportId]?.color || '#ff4f8f',
    });
    emitRoomEvent(room, 'gameState', room.players);
    return { success: true, action: normalizedAction, hearts, intensity };
  }

  if (normalizedAction === 'heal') {
    const amount = healPlayer(room, supportId, 80) || 80;
    emitSoundAndSync(room, 'heal', { intensity: 0.5, tier: 'common' });
    emitRoomEvent(room, 'heal', {
      uniqueId: supportId,
      nickname: 'Nova',
      amount,
      color: room.players[supportId]?.color,
    });
    emitRoomEvent(room, 'gameState', room.players);
    return { success: true, action: normalizedAction, amount };
  }

  if (normalizedAction === 'follow') {
    const reward = applyEngagementReward(room, supportId, 'Nova', 'follow');
    return { success: true, action: normalizedAction, reward };
  }

  if (normalizedAction === 'share' || normalizedAction === 'social') {
    const reward = applyEngagementReward(room, supportId, 'Nova', 'share', { type: 'share' });
    return { success: true, action: normalizedAction, reward };
  }

  if (normalizedAction === 'repost') {
    const reward = applyEngagementReward(room, supportId, 'Nova', 'repost', { type: 'repost' });
    return { success: true, action: normalizedAction, reward };
  }

  if (normalizedAction === 'kill') {
    if (room.players[targetId]) room.players[targetId].hp = 1;
    const result = dealDamage(room, attackerId, targetId, 8);
    emitAttackAndSync(room, result);
    emitRoomEvent(room, 'gameState', room.players);
    return { success: true, action: normalizedAction, result };
  }

  if (normalizedAction === 'streak') {
    if (room.players[attackerId]) {
      room.players[attackerId].killStreak = 2;
      room.players[attackerId].lastKillTime = Date.now();
    }
    if (room.players[targetId]) {
      room.players[targetId].alive = true;
      room.players[targetId].hp = 1;
    }
    const result = dealDamage(room, attackerId, targetId, 8);
    emitAttackAndSync(room, result);
    emitRoomEvent(room, 'gameState', room.players);
    return { success: true, action: normalizedAction, result };
  }

  if (normalizedAction === 'boss') {
    const session = startLiveSession(room, 'overlay_test');
    const bossWave = startBossWave(room, { source: 'overlay_test', maxHp: 900 });
    const timer = setTimeout(() => {
      damageBossWave(room, attackerId, 'Orion', 2.4, 'laser', '!laser @boss');
      emitRoomEvent(room, 'gameState', room.players);
    }, 650);
    if (typeof timer.unref === 'function') timer.unref();
    return {
      success: true,
      action: normalizedAction,
      session: buildSessionStatus(room),
      sessionId: session?.sessionId || null,
      bossWave,
    };
  }

  if (normalizedAction === 'sponsor' || normalizedAction === 'break') {
    const record = startSponsorBreak(room, {
      source: 'creator',
      partner: 'Arena Partner',
      kicker: 'Battle Break',
      title: 'Arena Spotlight',
      subtitle: 'Chat made the moment. The next round is loading.',
      durationMs: 7000,
      statsMode: 'endcap',
      timingProfile: 'spotlight',
      muted: true,
      fit: 'cover',
    }, { trigger: 'overlay_test', source: 'creator' });
    if (record) {
      const timer = setTimeout(() => startPreparedSponsorBreak(room, record, 'test_ready'), 450);
      if (typeof timer.unref === 'function') timer.unref();
    }
    return { success: true, action: normalizedAction, breakId: record?.breakId || null };
  }

  if (normalizedAction === 'burst' || normalizedAction === 'show') {
    const sequence = ['attack', 'like', 'follow', 'share', 'repost', 'gift', 'boss', 'sponsor'];
    sequence.forEach((eventName, index) => {
      const timer = setTimeout(() => runRoomOverlayTest(room, eventName), index * 950);
      if (typeof timer.unref === 'function') timer.unref();
    });
    emitRoomEvent(room, 'roundEvent', {
      type: 'overlay_test_burst',
      title: 'Overlay test running',
      message: 'Chat, likes, follows, shares, reposts, gifts, boss wave, and broadcast break are being previewed.',
    });
    return { success: true, action: normalizedAction, sequence };
  }

  return { success: false, error: 'Unknown overlay test action.' };
}

app.post('/api/overlay/test/:action', requireRoom, (req, res) => {
  const result = runRoomOverlayTest(req.room, req.params.action);
  res.status(result.success ? 200 : 400).json(result);
});

app.post('/api/stream/setup/start', requireRoom, (req, res) => {
  const allowedSetupActions = new Set(['attack', 'gift', 'like', 'heal', 'follow', 'share', 'repost', 'kill', 'streak', 'boss', 'sponsor', 'burst']);
  const requestedAction = String(req.body?.action || 'burst').toLowerCase();
  const rehearsal = startRoomSetupRehearsal(req.room, {
    source: 'dashboard',
    action: allowedSetupActions.has(requestedAction) ? requestedAction : 'burst',
  });
  res.json({
    success: true,
    setupRehearsal: rehearsal,
    session: buildSessionStatus(req.room),
    overlayUrl: buildOverlayUrl(req, req.room.roomId, '/overlay', { setup: '1', controls: '1', debug: '1' }),
    overlayV2Url: buildOverlayUrl(req, req.room.roomId, '/overlay-v2', { setup: '1', render: '1080p', source: '1', show_status: '1' }),
  });
});

app.post('/api/stream/setup/reset', requireRoom, (req, res) => {
  stopRoomSetupRehearsal(req.room, 'setup_rehearsal_reset');
  res.json({
    success: true,
    setupRehearsal: req.room.setupRehearsal || { active: false },
    session: buildSessionStatus(req.room),
  });
});

app.post('/api/dev/test-mode', blockInProduction, (req, res) => {
  const { enabled } = req.body || {};
  if (typeof enabled !== 'boolean') return res.status(400).json({ success: false, error: 'Invalid enabled value' });
  DEV_TEST_MODE = enabled;
  emitEvent('devModeChanged', { enabled });
  res.json({ success: true, enabled: DEV_TEST_MODE });
});

app.post('/api/dev/sound', blockInProduction, (req, res) => {
  const { type } = req.body || {};
  if (!['laser', 'heal', 'special'].includes(type)) return res.status(400).json({ success: false, error: 'Invalid sound type' });
  emitEvent('devSound', { type });
  res.json({ success: true });
});

app.post('/api/dev/sound-settings', blockInProduction, (req, res) => {
  const { enabled } = req.body || {};
  if (typeof enabled !== 'boolean') return res.status(400).json({ success: false, error: 'Invalid enabled value' });
  emitEvent('soundSettings', { enabled });
  res.json({ success: true });
});

app.post('/api/dev/laser-color', requireRoom, (req, res) => {
  const { color } = req.body || {};
  if (typeof color !== 'string' || !color.trim()) return res.status(400).json({ success: false, error: 'Invalid color' });
  req.room.overlaySettings.laserColor = color.trim();
  saveRoomAudioConfig(req.room);
  emitRoomEvent(req.room, 'overlaySettings', req.room.overlaySettings);
  emitRoomEvent(req.room, 'laserColor', { color: req.room.overlaySettings.laserColor });
  res.json({ success: true, color: req.room.overlaySettings.laserColor });
});

app.post('/api/dev/overlay-settings', requireRoom, (req, res) => {
  const { shotType, shotSpeed, color } = req.body || {};
  const validTypes = ['beam', 'pulse', 'wave', 'burst', 'ripple'];
  if (typeof shotType === 'string' && shotType) {
    if (!validTypes.includes(shotType)) return res.status(400).json({ success: false, error: `Invalid shot type. Must be one of: ${validTypes.join(', ')}` });
    req.room.overlaySettings.shotType = shotType;
  }
  if (typeof shotSpeed === 'number' && shotSpeed > 0 && shotSpeed <= 3) {
    req.room.overlaySettings.shotSpeed = shotSpeed;
  }
  if (typeof color === 'string' && color.trim()) {
    req.room.overlaySettings.laserColor = color.trim();
  }
  saveRoomAudioConfig(req.room);
  emitRoomEvent(req.room, 'overlaySettings', req.room.overlaySettings);
  res.json({ success: true, settings: req.room.overlaySettings });
});

app.post('/api/connect', requireRoom, (req, res) => {
  const { username } = req.body;
  if (!username) return res.json({ success: false, error: 'Username required' });
  if (!API_KEY)  return res.status(500).json({ success: false, error: 'Missing TikTok API_KEY in .env' });
  try {
    const stream = connectToStreamer(username, req.room);
    res.json({ success: true, username: stream.username, status: stream.status, stream });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message || 'Unable to connect TikTok stream' });
  }
});

app.post('/api/reset', requireRoom, (req, res) => { disconnectStreamer(req.room); res.json({ success: true }); });
app.post('/api/overlay/reload', requireRoom, (req, res) => {
  emitRoomEvent(req.room, 'forceReload', { v: Date.now(), delayMs: 3000, reason: 'Operator reload' });
  res.json({ success: true });
});

app.post('/api/players/clear', requireRoom, (req, res) => {
  req.room.players = {};
  markRoomPlayerPresenceOffline(req.room);
  emitRoomEvent(req.room, 'gameState', req.room.players);
  updatePlayerGauge();
  res.json({ success: true });
});

app.post('/api/background/upload', requireRoom, (req, res) => {
  res.type('application/json');
  if (rejectUploadRequestIfStorageLow(req, res, 'background')) return;
  upload.single('background')(req, res, (err) => {
    try {
      if (err)       return res.status(err?.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ success: false, error: uploadErrorMessage(err, 'Background image') });
      if (!req.file) return res.status(400).json({ success: false, error: 'No background image was uploaded.' });
      if (rejectUploadedFileIfStorageLow(req, res, req.file, 'background')) return;
      deleteRoomBackgroundFile(req.room);
      saveRoomBackgroundMeta(req.room, req.file);
      const background = buildBackgroundPayload(req.room, { v: Date.now() });
      emitRoomEvent(req.room, 'backgroundChanged', background || { filename: null });
      console.log(`📸 Background uploaded for room ${req.room.roomId}: ${req.file.filename}`);
      return res.json({ success: true, filename: req.file.filename, background, url: background?.url || `/background/${encodeURIComponent(req.file.filename)}` });
    } catch (uploadErr) {
      console.error('Background upload error:', uploadErr);
      return res.status(500).json({ success: false, error: uploadErr.message || 'Server error during background upload' });
    }
  });
});

app.post('/api/background/clear', requireRoom, (req, res) => {
  try {
    deleteRoomBackgroundFile(req.room);
    req.room.currentBackground = null;
    saveRoomSettings(req.room.roomId);
    emitRoomEvent(req.room, 'backgroundChanged', { filename: null });
    console.log(`📸 Background cleared for room ${req.room.roomId}`);
    res.json({ success: true });
  } catch (err) {
    console.error('Background clear error:', err);
    res.json({ success: false, error: err.message });
  }
});

app.get('/background/:filename', (req, res) => {
  try {
    // Support signed public background fetches by room_id query param for OBS overlays.
    let room = null;
    if (enableRoomScoped && req.query && req.query.room_id) {
      const roomId = normalizeRoomId(req.query.room_id);
      const overlayToken = getOverlayTokenFromRequest(req);
      if (!roomId) return res.status(400).send('Invalid room id');
      if (!verifyOverlayToken(roomId, overlayToken)) return res.status(401).send('Unauthorized');
      room = getOrCreateRoom(roomId);
    } else {
      room = getSessionRoom(req);
      if (!room) return res.status(401).send('Unauthorized');
    }

    const { backgroundDir } = getRoomPaths(room.roomId);
    const filepath = path.join(backgroundDir, req.params.filename);
    if (!isSafePath(backgroundDir, filepath)) return res.status(403).send('Forbidden');
    if (!fs.existsSync(filepath)) return res.status(404).send('Background not found');
    return res.sendFile(filepath);
  } catch (err) {
    console.error('Background fetch error:', err);
    return res.status(500).send('Server error');
  }
});

app.get('/api/audio', requireRoom, (req, res) => {
  res.json({ success: true, library: req.room.audioLibrary, config: req.room.audioConfig, settings: req.room.overlaySettings });
});

app.post('/api/audio/upload', requireRoom, (req, res) => {
  res.type('application/json');
  if (rejectUploadRequestIfStorageLow(req, res, 'audio')) return;
  audioUpload.single('audio')(req, res, (err) => {
    if (err)       return res.status(err?.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ success: false, error: uploadErrorMessage(err, 'Audio file') });
    if (!req.file) return res.status(400).json({ success: false, error: 'No audio file uploaded.' });
    if (rejectUploadedFileIfStorageLow(req, res, req.file, 'audio')) return;
    const entry = {
      filename:     req.file.filename,
      originalName: req.file.originalname,
      size:         req.file.size,
      uploadedAt:   new Date().toISOString(),
    };
    req.room.audioLibrary.push(entry);
    saveRoomAudioConfig(req.room);
    console.log(`🔊 Audio uploaded for room ${req.room.roomId}: ${req.file.originalname} → ${req.file.filename}`);
    res.json({ success: true, file: entry });
  });
});

app.post('/api/audio/assign', requireRoom, (req, res) => {
  const { event, filename } = req.body;
  const validEvents = Object.keys(DEFAULT_AUDIO_CONFIG);
  if (!validEvents.includes(event)) {
    return res.status(400).json({ success: false, error: `Invalid event. Must be one of: ${validEvents.join(', ')}` });
  }
  if (filename === null || filename === '') {
    req.room.audioConfig[event] = null;
    saveRoomAudioConfig(req.room);
    emitRoomEvent(req.room, 'audioConfig', req.room.audioConfig);
    return res.json({ success: true, event, filename: null });
  }
  if (!req.room.audioLibrary.some(f => f.filename === filename)) {
    return res.status(404).json({ success: false, error: 'File not found in audio library.' });
  }
  req.room.audioConfig[event] = filename;
  saveRoomAudioConfig(req.room);
  emitRoomEvent(req.room, 'audioConfig', req.room.audioConfig);
  console.log(`🔊 Assigned "${filename}" to event "${event}" for room ${req.room.roomId}`);
  res.json({ success: true, event, filename });
});

app.delete('/api/audio/delete/:filename', requireRoom, (req, res) => {
  const { filename } = req.params;
  const { audioDir } = getRoomPaths(req.room.roomId);
  const filepath     = path.join(audioDir, filename);
  if (!isSafePath(audioDir, filepath)) return res.status(403).json({ success: false, error: 'Forbidden' });
  const before = req.room.audioLibrary.length;
  req.room.audioLibrary = req.room.audioLibrary.filter(f => f.filename !== filename);
  if (req.room.audioLibrary.length === before) return res.status(404).json({ success: false, error: 'File not found in library.' });
  let changed = false;
  for (const ev of Object.keys(req.room.audioConfig)) {
    if (req.room.audioConfig[ev] === filename) { req.room.audioConfig[ev] = null; changed = true; }
  }
  try { if (fs.existsSync(filepath)) fs.unlinkSync(filepath); } catch (_e) {}
  saveRoomAudioConfig(req.room);
  if (changed) emitRoomEvent(req.room, 'audioConfig', req.room.audioConfig);
  console.log(`🗑️ Deleted audio for room ${req.room.roomId}: ${filename}`);
  res.json({ success: true, filename, configUpdated: changed });
});

app.get('/api/sponsors', requireRoom, requireCreatorSponsorAccess, (req, res) => {
  loadRoomSponsorConfig(req.room);
  res.json({ success: true, library: req.room.sponsorLibrary || [] });
});

app.post('/api/sponsor/upload', requireRoom, requireCreatorSponsorAccess, (req, res) => {
  res.type('application/json');
  if (rejectUploadRequestIfStorageLow(req, res, 'sponsor')) return;
  sponsorUpload.single('sponsor')(req, res, async (err) => {
    if (err) return res.status(err?.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ success: false, error: uploadErrorMessage(err, 'Sponsor video') });
    if (!req.file) return res.status(400).json({ success: false, error: 'No sponsor video uploaded.' });
    if (rejectUploadedFileIfStorageLow(req, res, req.file, 'sponsor')) return;

    let mediaMeta;
    try {
      loadRoomSponsorConfig(req.room);
      const { sponsorDir } = getRoomPaths(req.room.roomId);
      mediaMeta = await processSponsorUpload({ file: req.file, body: req.body || {}, targetDir: sponsorDir });
      if (rejectUploadedFileIfStorageLow(req, res, { path: mediaMeta.filepath, size: mediaMeta.fileSize }, 'sponsor')) return;
      const qualityNotes = [...(mediaMeta.qualityWarnings || []), ...(mediaMeta.qualityRecommendations || [])];
      const entry = {
        filename: mediaMeta.filename,
        originalName: req.file.originalname,
        originalFilename: mediaMeta.originalFilename,
        title: sanitizeSponsorText(req.body?.title, path.basename(req.file.originalname, path.extname(req.file.originalname)) || 'Power Moment', 90),
        partner: sanitizeSponsorText(req.body?.partner, 'Sponsor', 70),
        subtitle: sanitizeSponsorText(req.body?.subtitle, 'Stay locked in. The next fight is loading.', 140),
        size: mediaMeta.fileSize,
        mimeType: mediaMeta.mimeType,
        durationSeconds: mediaMeta.durationSeconds,
        width: mediaMeta.width,
        height: mediaMeta.height,
        aspectRatio: mediaMeta.aspectRatio,
        videoCodec: mediaMeta.videoCodec,
        audioCodec: mediaMeta.audioCodec,
        thumbnailData: mediaMeta.thumbnailData,
        qualityWarnings: mediaMeta.qualityWarnings,
        qualityGateStatus: mediaMeta.qualityGateStatus,
        qualityGateScore: mediaMeta.qualityGateScore,
        qualityGateBlockers: mediaMeta.qualityGateBlockers,
        qualityRecommendations: mediaMeta.qualityRecommendations,
        normalized: mediaMeta.normalized,
        processingStatus: mediaMeta.processingStatus,
        processingMessage: mediaMeta.processingMessage,
        readinessStatus: 'ready',
        playbackMessage: qualityNotes.length ? `Ready with quality notes: ${qualityNotes.join(' ')}` : 'Ready for overlay test.',
        processedAt: mediaMeta.processedAt,
        uploadedAt: new Date().toISOString(),
      };
      req.room.sponsorLibrary.push(entry);
      saveRoomSponsorConfig(req.room);
      console.log(`Sponsor media uploaded for room ${req.room.roomId}: ${req.file.originalname} -> ${entry.filename}`);
      res.json({ success: true, file: entry });
    } catch (uploadErr) {
      try { if (req.file?.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path); } catch (_cleanupErr) {}
      try { if (mediaMeta?.filepath && fs.existsSync(mediaMeta.filepath)) fs.unlinkSync(mediaMeta.filepath); } catch (_cleanupErr) {}
      logger.warn({ err: uploadErr, roomId: req.room?.roomId }, 'Sponsor media processing failed');
      res.status(uploadErr.statusCode || 500).json({
        success: false,
        error: uploadErr.message || 'Sponsor video processing failed.',
        qualityGate: uploadErr.qualityGate || null,
      });
    }
  });
});

app.delete('/api/sponsor/delete/:filename', requireRoom, requireCreatorSponsorAccess, (req, res) => {
  const filename = path.basename(req.params.filename);
  const { sponsorDir } = getRoomPaths(req.room.roomId);
  const filepath = path.join(sponsorDir, filename);
  if (!isSafePath(sponsorDir, filepath)) return res.status(403).json({ success: false, error: 'Forbidden' });

  loadRoomSponsorConfig(req.room);
  const before = req.room.sponsorLibrary.length;
  req.room.sponsorLibrary = req.room.sponsorLibrary.filter(file => file.filename !== filename);
  if (req.room.sponsorLibrary.length === before) return res.status(404).json({ success: false, error: 'Sponsor media not found.' });

  try { if (fs.existsSync(filepath)) fs.unlinkSync(filepath); } catch (_err) {}
  saveRoomSponsorConfig(req.room);
  res.json({ success: true, filename });
});

app.post('/api/sponsor/play', requireRoom, requireCreatorSponsorAccess, (req, res) => {
  const payload = buildSponsorScenePayload(req.room, req.body || {});
  if (payload.error) return res.status(payload.status || 404).json({ success: false, error: payload.error });
  const record = startSponsorBreak(req.room, payload, { trigger: 'creator_dashboard', source: 'creator' });
  res.json({ success: true, breakId: record?.breakId || null, status: record?.status || 'preparing', scene: record?.payload || payload });
});

app.post('/api/sponsor/stop', requireRoom, requireCreatorSponsorAccess, (req, res) => {
  stopSponsorBreaksForRoom(req.room, 'creator_dashboard_stop');
  emitRoomEvent(req.room, 'sponsorScene', { action: 'hide', _ts: Date.now() });
  res.json({ success: true });
});

function blockInProduction(_req, res, next) {
  if (process.env.NODE_ENV === 'production') {
    return res.status(404).json({ success: false, error: 'Not found' });
  }
  next();
}

function requireDevTestMode(_req, res, next) {
  if (!DEV_TEST_MODE) return res.status(403).json({ success: false, error: 'Developer test mode is disabled' });
  next();
}

function ensureTestPlayers(options = {}) {
  const room = getDefaultRoom();
  const reset = options.reset === true;
  const testPlayers = [
    { id: 'test_alpha',   nick: 'Alpha'   },
    { id: 'test_bravo',   nick: 'Bravo'   },
    { id: 'test_charlie', nick: 'Charlie' },
    { id: 'test_delta',   nick: 'Delta'   },
    { id: 'test_echo',    nick: 'Echo'    },
    { id: 'test_foxtrot', nick: 'Foxtrot', hp: 180 },
    { id: 'test_glitch',  nick: 'Glitch',  hp: 170 },
    { id: 'test_nova',    nick: 'Nova',    hp: 160 },
  ];
  testPlayers.forEach((item, index) => {
    if (!reset && room.players[item.id]) {
      room.players[item.id].alive = room.players[item.id].alive !== false;
      room.players[item.id].forceSpawn = true;
      room.players[item.id].lastActive = Date.now();
      return;
    }
    const maxHp = item.hp || CFG.BASE_HP;
    room.players[item.id] = {
      uniqueId: item.id, nickname: item.nick,
      hp: maxHp, maxHp,
      strength: CFG.BASE_STRENGTH, alive: true, kills: 0,
      killStreak: 0, lastKillTime: 0,
      lastActive: Date.now(),
      x: 100 + index * 100, y: 100 + index * 40,
      vx: (Math.random() - 0.5) * 1.5,
      vy: (Math.random() - 0.5) * 1.5,
      color: randomColor(), messageBoostExpires: 0, forceSpawn: true,
    };
  });
  emitRoomEvent(room, 'gameState', room.players);
}

app.get('/api/test/status', blockInProduction, (_req, res) => res.json({ enabled: DEV_TEST_MODE }));

app.post('/api/test/spawn', blockInProduction, requireDevTestMode, (_req, res) => {
  ensureTestPlayers({ reset: true });
  console.log('🧪 Test players spawned');
  res.json({ success: true });
});

app.post('/api/test/attack', blockInProduction, requireDevTestMode, (_req, res) => {
  ensureTestPlayers();
  const room = getDefaultRoom();
  const result = handleMentionAttack(room, 'test_alpha', 'Alpha', '@test_bravo');
  emitRoomEvent(room, 'gameState', room.players);
  res.json({ success: true, result });
});

app.post('/api/test/horde-attack', blockInProduction, requireDevTestMode, (_req, res) => {
  ensureTestPlayers();
  const room = getDefaultRoom();
  const result = handleMentionAttack(room, 'test_foxtrot', 'Foxtrot', '@test_alpha !laser');
  emitRoomEvent(room, 'gameState', room.players);
  res.json({ success: true, result });
});

app.post('/api/test/like', blockInProduction, requireDevTestMode, (_req, res) => {
  ensureTestPlayers();
  const room = getDefaultRoom();
  const id = 'test_bravo';
  const player = room.players[id];
  const hearts = 2;
  const intensity = 0.55;

  awardStats(room, id, player.nickname, CFG.LIKE_HP_BOOST, 0);
  emitSoundAndSync(room, 'heal', { intensity, tier: 'common' });
  emitRoomEvent(room, 'like', {
    uniqueId: id,
    nickname: player.nickname,
    hearts,
    rate: 150,
    intensity,
    color: player.color || '#ff4f8f',
  });
  emitRoomEvent(room, 'gameState', room.players);
  res.json({ success: true, uniqueId: id, hearts, intensity });
});

app.post('/api/test/follow', blockInProduction, requireDevTestMode, (_req, res) => {
  ensureTestPlayers();
  const room = getDefaultRoom();
  const id = 'test_delta';
  const player = room.players[id];
  const reward = applyEngagementReward(room, id, player.nickname, 'follow');
  res.json({ success: true, uniqueId: id, reward });
});

app.post('/api/test/social', blockInProduction, requireDevTestMode, (_req, res) => {
  ensureTestPlayers();
  const room = getDefaultRoom();
  const id = 'test_echo';
  const player = room.players[id];
  const type = String(_req.query?.type || _req.body?.type || 'share').toLowerCase() === 'repost' ? 'repost' : 'share';
  const reward = applyEngagementReward(room, id, player.nickname, type, { type });
  res.json({ success: true, uniqueId: id, reward });
});

app.post('/api/test/gift', blockInProduction, requireDevTestMode, (_req, res) => {
  ensureTestPlayers();
  const room = getDefaultRoom();
  const attackerId  = 'test_charlie';
  const diamonds    = 25;
  const targets     = ['test_alpha', 'test_bravo', 'test_delta'];
  const attacksMade = [];

  awardStats(room, attackerId, room.players[attackerId].nickname,
    diamonds * CFG.GIFT_HP_PER_DIAMOND,
    diamonds * CFG.GIFT_STR_PER_DIAMOND
  );
  if (room.players[attackerId]) {
    room.players[attackerId].messageBoostExpires = Date.now() + CFG.GIFT_MESSAGE_BOOST_DURATION_MS;
  }
  emitRoomEvent(room, 'gameState', room.players);

  // Determine gift effect based on diamond amount (new rule)
  const giftEffect = diamonds > 100 ? 'fire' : 'laser';  // meteor or laser

  const topBeforeGift = new Set(getTopPlayers(room, 5).map(p => p.uniqueId));
  targets.forEach(targetId => {
    const target = room.players[targetId];
    if (!target?.alive) return;
    const damage = diamonds;
    target.hp    = Math.max(0, target.hp - damage);
    let killed   = false;
    if (target.hp === 0) {
      killed = true; target.alive = false; room.players[attackerId].kills++;
      setTimeout(() => {
        spawnPlayer(room, target.uniqueId, target.nickname);
        emitRoomEvent(room, 'respawn', { uniqueId: target.uniqueId, respawnEffect: 'beam_down' });
        emitRoomEvent(room, 'gameState', room.players);
      }, CFG.RESPAWN_DELAY_MS);
    }
    const giftAttack = {
      attacker: attackerId, target: targetId, damage, killed, diamonds,
      effect: giftEffect,
      intensity: diamonds > 100 ? 1.0 : 0.7,
      giftColor: diamonds > 100 ? '#FF4500' : '#7afcff',
      attackerScope: topBeforeGift.has(attackerId) ? 'top' : 'horde',
      targetScope: topBeforeGift.has(targetId) ? 'top' : 'horde',
    };
    attacksMade.push(giftAttack);
    emitGiftAttackAndSync(room, giftAttack);
    emitSoundAndSync(room, killed ? 'kill' : 'gift', { intensity: giftAttack.intensity, tier: diamonds > 100 ? 'legendary' : 'common' });
  });

  const giftMeta = classifyGift(diamonds);
  emitRoomEvent(room, 'giftEffect', { attacker: attackerId, giftName: 'Test Gift', diamonds, ...giftMeta });
  setTimeout(() => {
    emitRoomEvent(room, 'giftCelebration', {
      attacker: attackerId, nickname: room.players[attackerId]?.nickname || 'Charlie',
      giftName: 'Test Gift', diamonds, ...giftMeta,
    });
  }, 800);

  emitRoomEvent(room, 'gameState', room.players);
  console.log('🧪 Test gift attack sent');
  res.json({ success: true, attacks: attacksMade });
});

// ... (other test endpoints unchanged, they can remain as is)

// ────────────────────────────────
// TIKTOK EVENT HANDLING
// ────────────────────────────────
function setupTikTokEvents(tiktokClient, room, connectionId) {
  const connectionSessionId = room?.tiktokConnection?.sessionId || '';
  const onTikTok = (eventType, handler) => {
    tiktokClient.on(eventType, (...args) => {
      if (!isActiveTikTokConnection(room, tiktokClient, connectionId, connectionSessionId)) {
        markTikTokEventDropped(room, connectionId, eventType);
        return;
      }
      markTikTokEventAccepted(room, eventType);
      handler(...args);
    });
  };

  onTikTok('connected', () => {
    startLiveSession(room, 'tiktok', { sessionId: connectionSessionId, phase: MATCH_PHASES.LIVE });
    emitTikTokConnectionStatus(room, {
      status: 'connected',
      connectedAt: Date.now(),
      disconnectedAt: null,
      reason: '',
      error: '',
    });
    console.log(`✅ Connected to @${room.streamerUsername || 'unknown'}'s LIVE stream for room ${room.roomId}\n`);
  });

  onTikTok('roomInfo', (info = {}) => {
    emitTikTokConnectionStatus(room, {
      status: 'connected',
      tiktokRoomId: info.roomId || room.tiktokConnection?.tiktokRoomId || null,
    });
  });

  onTikTok('disconnected', (code, reason) => {
    const willReconnect = !tiktokClient.intentionalClose && TIKTOK_AUTO_RECONNECT;
    if (willReconnect) {
      setRoomMatchPhase(room, MATCH_PHASES.SETUP, 'stream_reconnecting', { sessionId: connectionSessionId });
    } else if (room.liveSession?.status === 'active') {
      endLiveSession(room, 'stream_disconnected');
    }
    emitTikTokConnectionStatus(room, {
      status: willReconnect ? 'reconnecting' : 'disconnected',
      disconnectedAt: Date.now(),
      reason: reason || `code ${code || 'unknown'}`,
    });
    if (!willReconnect && room.tiktokClient === tiktokClient) room.tiktokClient = null;
  });

  onTikTok('member', (e) => {
    const { id, nickname: nick } = resolveTikTokUser(e);
    if (!id) return;
    spawnPlayer(room, id, nick);
    if (room.players[id]) room.players[id].alive = true;
    emitRoomEvent(room, 'gameState', room.players);
    emitRoomEvent(room, 'spawn', { uniqueId: id });
  });

  onTikTok('chat', (e) => {
    const { id, nickname } = resolveTikTokUser(e);
    const comment = String(e.comment || e.message || '').trim();
    if (!id) return;

    awardStats(room, id, nickname, 0, CFG.CHAT_STRENGTH_BOOST);

    const utilityCommand = handlePlayerUtilityCommand(room, id, nickname, comment);
    if (utilityCommand.handled) console.log(`Player command from @${nickname}: ${utilityCommand.reason || comment}`);
    if (utilityCommand.stop) {
      emitRoomEvent(room, 'gameState', room.players);
      return;
    }

    const iconMatch = comment.match(/^\s*(?:!emoji|\/emoji|emoji)\s+(.+)/i);
    if (iconMatch) {
      const requestedIcon = String(iconMatch[1]).trim().split(/\s+/)[0];
      const topPlayers = getTopPlayers(room, 5).map(p => p.uniqueId);
      if (topPlayers.includes(id)) {
        if (!room.players[id]) spawnPlayer(room, id, nickname);
        if (room.players[id]) {
          room.players[id].iconEmoji  = requestedIcon || room.players[id].iconEmoji || '💎';
          room.players[id].lastActive = Date.now();
          emitRoomEvent(room, 'gameState', room.players);
          console.log(`🎭 @${nickname} updated icon emoji to ${room.players[id].iconEmoji}`);
        }
      } else {
        console.log(`⚠️ @${nickname} is not in the top 5 and cannot change icon emoji`);
      }
      return;
    }

    if (/\bspawn\b/i.test(comment)) {
      if (!room.players[id]?.alive) {
        spawnPlayer(room, id, nickname);
        console.log(`🟢 @${nickname} spawned via chat command`);
      }
      if (room.players[id]) room.players[id].forceSpawn = true;
    }

    const attackResult = handleMentionAttack(room, id, nickname, comment);
    if (!attackResult.handled && attackResult.reason !== 'No @mention found') {
      console.log(`⚠️ Chat attack not handled: ${attackResult.reason}`);
    }

    emitRoomEvent(room, 'gameState', room.players);
  });

  onTikTok('gift', (e) => {
    const { id, nickname } = resolveTikTokUser(e);
    const diamonds = (e.diamondCount || e.amount || 1) * (e.repeatCount || 1);
    if (!id) return;

    const alivePlayers  = Object.values(room.players).filter(p => p.alive);
    const boardHasSpace = alivePlayers.length < 20;

    if (!room.players[id]) spawnPlayer(room, id, nickname);
    else if (!room.players[id].alive && boardHasSpace) spawnPlayer(room, id, nickname);

    if (room.players[id]) {
      room.players[id].forceSpawn = true;
      room.players[id].lastActive = Date.now();
    }

    awardStats(room, id, nickname, diamonds * CFG.GIFT_HP_PER_DIAMOND, diamonds * CFG.GIFT_STR_PER_DIAMOND);
    if (room.players[id]) room.players[id].messageBoostExpires = Date.now() + CFG.GIFT_MESSAGE_BOOST_DURATION_MS;

    emitRoomEvent(room, 'gameState', room.players);

    // --- Gift attack effect rules ---
    // Big gifts (>100 diamonds) → meteor (fire), otherwise → laser
    const giftEffect = diamonds > 100 ? 'fire' : 'laser';
    const giftIntensity = diamonds > 100 ? 1.0 : Math.min(diamonds / 100, 0.8);

    const aliveTargets = Object.values(room.players).filter(p => p.alive && p.uniqueId !== id);

    if (aliveTargets.length > 0) {
      const targetsToAttack = [];
      for (let i = 0; i < 3 && aliveTargets.length > 0; i++) {
        const idx = Math.floor(Math.random() * aliveTargets.length);
        targetsToAttack.push(aliveTargets.splice(idx, 1)[0]);
      }

      const topBeforeGift = new Set(getTopPlayers(room, 5).map(p => p.uniqueId));
      targetsToAttack.forEach(target => {
        const damage = diamonds;
        target.hp    = Math.max(0, target.hp - damage);
        let killed   = false;

        if (target.hp === 0) {
          killed = true;
          target.alive = false;
          room.players[id].kills++;
          console.log(`💀 @${target.uniqueId} defeated by gift attack from @${id}!`);
          setTimeout(() => {
            spawnPlayer(room, target.uniqueId, target.nickname);
            emitRoomEvent(room, 'respawn', {
              uniqueId: target.uniqueId,
              nickname: target.nickname,
              respawnEffect: 'beam_down',
            });
            emitSoundAndSync(room, 'respawn', { intensity: 0.5, tier: 'common' });
            emitRoomEvent(room, 'gameState', room.players);
          }, CFG.RESPAWN_DELAY_MS);
        }

        emitGiftAttackAndSync(room, {
          attacker: id, target: target.uniqueId, damage, killed, diamonds,
          effect:    giftEffect,
          intensity: giftIntensity,
          giftColor: diamonds > 100 ? '#FF4500' : '#7afcff',
          attackerScope: topBeforeGift.has(id) ? 'top' : 'horde',
          targetScope: topBeforeGift.has(target.uniqueId) ? 'top' : 'horde',
        });
        emitSoundAndSync(room, killed ? 'kill' : 'gift', { intensity: giftIntensity, tier: diamonds > 100 ? 'legendary' : 'common' });
        console.log(`🎁 @${id} → @${target.uniqueId} via gift for ${damage} dmg${killed ? ' (KILL!)' : ''}`);
      });
    }

    const giftMeta = classifyGift(diamonds);
    emitRoomEvent(room, 'giftEffect', { attacker: id, giftName: e.giftName, diamonds, ...giftMeta });

    setTimeout(() => {
      emitRoomEvent(room, 'giftCelebration', {
        attacker: id,
        nickname,
        giftName:  e.giftName,
        diamonds,
        ...giftMeta,
      });
    }, 800);

    emitRoomEvent(room, 'gameState', room.players);
    console.log(`🎁 @${id} sent ${e.giftName} (${diamonds} 💎) [${giftMeta.tier}]`);
  });

  onTikTok('like', (e) => {
    const { id, nickname } = resolveTikTokUser(e);
    if (!id) return;
    if (!room.players[id]) spawnPlayer(room, id, nickname);
    const likeIncrement = likeIncrementFromEvent(e);
    awardStats(room, id, nickname, CFG.LIKE_HP_BOOST * Math.min(5, likeIncrement), 0);
    const likeMilestone = updateRoomLikeMilestone(room, likeIncrement);

    const likeKey = `${room.roomId}:${id}`;
    if (!likeRateTracker[likeKey]) {
      likeRateTracker[likeKey] = { likes: [], window: 90000 };
    }
    const now = Date.now();
    for (let i = 0; i < Math.min(10, likeIncrement); i += 1) {
      likeRateTracker[likeKey].likes.push(now);
    }
    likeRateTracker[likeKey].likes = likeRateTracker[likeKey].likes.filter(t => now - t < likeRateTracker[likeKey].window);

    const likeCount  = likeRateTracker[likeKey].likes.length;
    let heartCount   = 1;
    if (likeCount >= 500) heartCount = 3;
    else if (likeCount >= 100) heartCount = 2;

    emitSoundAndSync(room, 'heal', { intensity: Math.min(likeCount / 500, 1), tier: 'common' });
    emitRoomEvent(room, 'like', {
      uniqueId: id,
      nickname,
      hearts:    heartCount,
      rate:      likeCount,
      increment:  likeIncrement,
      totalLikes: likeMilestone.total,
      milestone: likeMilestone.milestone,
      milestoneTier: likeMilestone.tier,
      intensity: Math.min(likeCount / 500, 1),
      color:     room.players[id]?.color || '#FF6B6B',
    });
    emitRoomEvent(room, 'gameState', room.players);
  });

  onTikTok('social', (e) => {
    const { id, nickname } = resolveTikTokUser(e);
    if (!id) return;
    const type = normalizeSocialEngagementType(e);
    const reward = applyEngagementReward(room, id, nickname, type, e);
    console.log(`Social reward: @${nickname} ${type}`, reward || '');
  });

  onTikTok('follow', (e) => {
    const id   = e.user?.uniqueId;
    const nick = e.user?.nickname || id;
    if (!id) return;
    console.log(`❤️  @${nick} followed!`);
    applyEngagementReward(room, id, nick, 'follow', e);
  });

  onTikTok('error', (err) => {
    emitTikTokConnectionStatus(room, {
      status: room.tiktokClient?.connected ? 'connected' : 'error',
      error: err?.message || String(err || 'TikTok connection error'),
    });
    console.error('⚠️  TikTok error:', err?.message || err);
  });
}

function safeDisconnectClient(room = getDefaultRoom(), reason = 'operator_disconnect') {
  const targetClient = room?.tiktokClient || (room?.roomId === DEFAULT_ROOM_ID ? client : null);
  if (!targetClient) {
    if (room?.tiktokConnection && !['disconnected', 'error'].includes(room.tiktokConnection.status)) {
      emitTikTokConnectionStatus(room, {
        status: 'disconnected',
        disconnectedAt: Date.now(),
        reason,
      });
    }
    return;
  }
  try {
    targetClient.intentionalClose = true;
    if (typeof targetClient.destroy === 'function') targetClient.destroy();
    else targetClient.disconnect();
  } catch (err) {
    console.error('⚠️ Error during disconnect:', err?.message || err);
  }
  if (room?.tiktokConnection) {
    emitTikTokConnectionStatus(room, {
      status: 'disconnected',
      disconnectedAt: Date.now(),
      reason,
    });
  }
  if (room) room.tiktokClient = null;
  if (targetClient === client) client = null;
}

function connectToStreamer(username, room = getDefaultRoom(), options = {}) {
  if (!room) throw new Error('Cannot connect TikTok stream without a room');
  const normalizedUsername = normalizeTikTokUsername(username);
  if (!normalizedUsername) throw new Error('Enter a valid TikTok username.');
  safeDisconnectClient(room, 'new_stream_requested');
  if (options.resetLiveRuntime !== false) {
    resetRoomLiveRuntime(room, { reason: 'new_stream_requested', clearPlayers: true });
  }
  if (room.roomId === DEFAULT_ROOM_ID) currentStreamer = normalizedUsername;
  room.streamerUsername = normalizedUsername;
  const connection = createTikTokConnection(room, normalizedUsername);
  const tiktokClient = new TikTokLive({
    uniqueId: normalizedUsername,
    apiKey: API_KEY,
    autoReconnect: TIKTOK_AUTO_RECONNECT,
    maxReconnectAttempts: TIKTOK_MAX_RECONNECT_ATTEMPTS,
    heartbeatInterval: TIKTOK_HEARTBEAT_MS,
  });
  room.tiktokClient = tiktokClient;
  if (room.roomId === DEFAULT_ROOM_ID) client = tiktokClient;
  setupTikTokEvents(tiktokClient, room, connection.id);
  if (room.planEntitlements) updatePlatformSponsorSchedule(room, room.planEntitlements);
  room.tiktokConnectPromise = tiktokClient.connect().catch(err => {
    console.error('❌ Could not connect:', err?.message || err);
    console.error(`   Make sure @${normalizedUsername} is currently LIVE on TikTok`);
    if (isActiveTikTokConnection(room, tiktokClient, connection.id, connection.sessionId)) {
      setRoomMatchPhase(room, MATCH_PHASES.IDLE, 'stream_connect_failed', { sessionId: connection.sessionId });
      emitTikTokConnectionStatus(room, {
        status: 'error',
        disconnectedAt: Date.now(),
        error: err?.message || String(err || 'Could not connect'),
      });
      room.tiktokClient = null;
    }
    if (client === tiktokClient) client = null;
  });
  return buildTikTokConnectionStatus(room);
}

function disconnectStreamer(room = getDefaultRoom()) {
  safeDisconnectClient(room, 'operator_disconnect');
  if (!room || room.roomId === DEFAULT_ROOM_ID) currentStreamer = '';
  if (room) {
    room.streamerUsername = '';
    resetRoomLiveRuntime(room, { reason: 'operator_disconnect', clearPlayers: true });
    emitTikTokConnectionStatus(room, {
      username: '',
      status: 'disconnected',
      disconnectedAt: Date.now(),
      reason: 'operator_disconnect',
      error: '',
    });
  }
}

function getTopPlayers(roomOrCount = 20, count = 20) {
  let room = null;
  if (typeof roomOrCount === 'object' && roomOrCount?.roomId) {
    room = roomOrCount;
  } else if (typeof roomOrCount === 'number') {
    count = roomOrCount;
  } else if (typeof roomOrCount === 'string') {
    room = getRoom(roomOrCount) || getDefaultRoom();
  }

  const players = room
    ? Object.values(room.players)
    : Array.from(getAllRooms().values()).flatMap(r => Object.values(r.players));

  return players
    .filter(p => p.alive)
    .sort((a, b) => {
      const aF = a.forceSpawn ? 1 : 0;
      const bF = b.forceSpawn ? 1 : 0;
      if (aF !== bF) return bF - aF;
      const maxHpDiff = (b.maxHp || b.hp || 0) - (a.maxHp || a.hp || 0);
      if (maxHpDiff !== 0) return maxHpDiff;
      const killDiff = (b.kills || 0) - (a.kills || 0);
      if (killDiff !== 0) return killDiff;
      return String(a.nickname || a.uniqueId || '').localeCompare(String(b.nickname || b.uniqueId || ''));
    })
    .slice(0, count);
}

let marketingAutoPostRunning = false;
let marketingAutoPostTimer = null;

async function runMarketingAutoPostCycle(reason = 'interval') {
  const diagnostics = marketingAutomationDiagnostics();
  if (!diagnostics.autoPostEnabled) return { skipped: true, reason: 'disabled' };
  if (marketingAutoPostRunning) return { skipped: true, reason: 'already_running' };

  if (!diagnostics.autoPostReady) {
    logger.warn({
      reason,
      automationEnabled: diagnostics.enabled,
      dryRun: diagnostics.dryRun,
      configuredWebhooks: diagnostics.configuredWebhooks,
    }, 'Marketing auto-post is enabled but not ready');
    return { skipped: true, reason: 'not_ready', diagnostics };
  }

  marketingAutoPostRunning = true;
  try {
    const result = await publishApprovedMarketingPosts({
      limit: diagnostics.autoPostLimit,
      dryRun: false,
    });
    if (result.attempted > 0 || result.failed > 0) {
      logger.info({
        reason,
        attempted: result.attempted,
        published: result.published,
        failed: result.failed,
        skipped: result.skipped,
      }, 'Marketing auto-post cycle complete');
    } else {
      logger.debug({ reason }, 'Marketing auto-post cycle found no due posts');
    }
    return result;
  } catch (err) {
    logger.error({ err, reason }, 'Marketing auto-post cycle failed');
    return { skipped: false, failed: 1, error: err?.message || String(err) };
  } finally {
    marketingAutoPostRunning = false;
  }
}

function startMarketingAutoPoster() {
  const diagnostics = marketingAutomationDiagnostics();
  if (!diagnostics.autoPostEnabled) return;
  const intervalMs = diagnostics.autoPostIntervalMs;
  logger.info({
    ready: diagnostics.autoPostReady,
    intervalMs,
    limit: diagnostics.autoPostLimit,
    platforms: diagnostics.platforms,
    configuredWebhooks: diagnostics.configuredWebhooks,
  }, 'Marketing auto-post scheduler enabled');
  const initialDelayMs = Math.min(30_000, intervalMs);
  const firstRun = setTimeout(() => runMarketingAutoPostCycle('startup'), initialDelayMs);
  if (typeof firstRun.unref === 'function') firstRun.unref();
  marketingAutoPostTimer = setInterval(() => runMarketingAutoPostCycle('interval'), intervalMs);
  if (typeof marketingAutoPostTimer.unref === 'function') marketingAutoPostTimer.unref();
}

setInterval(() => {
  const cutoff = Date.now() - CFG.IDLE_TIMEOUT_MS;
  for (const room of getAllRooms().values()) {
    for (const id of Object.keys(room.players)) {
      if (room.players[id].lastActive < cutoff) {
        delete room.players[id];
        logger.info({ player: id, room: room.roomId }, 'Removed idle player due to inactivity');
      }
    }
    emitRoomEvent(room, 'gameState', room.players);
  }
  updatePlayerGauge();
}, 60_000);

let saveCounter = 0;

function tick() {
  for (const room of getAllRooms().values()) {
    for (const id in room.players) {
      const p = room.players[id];
      if (!p.alive) continue;
      p.x += p.vx;
      p.y += p.vy;
      if (p.x < 20 || p.x > 980)  p.vx *= -1;
      if (p.y < 20 || p.y > 1800) p.vy *= -1;
      p.x = Math.max(20, Math.min(980,  p.x));
      p.y = Math.max(20, Math.min(1800, p.y));
    }
    emitRoomEvent(room, 'gameState', room.players);
  }
  try { playerGauge.set(getTotalPlayerCount()); } catch (_) {}
  if (++saveCounter >= 100) { savePlayerStats(); saveCounter = 0; }
}

const GAME_TICK_MS = Math.max(100, Number(process.env.GAME_TICK_MS || 250));
setInterval(tick, GAME_TICK_MS);

// Quiet known noisy probes and missing favicon requests.
app.get('/favicon.ico', (_req, res) => {
  return res.status(204).end();
});

app.all('/wp-login.php', (_req, res) => {
  return res.status(404).end();
});

// Return explicit 404 responses and log missing routes/assets.
app.use((req, res) => {
  const quiet404Paths = new Set(['/favicon.ico', '/wp-login.php']);
  const logFn = quiet404Paths.has(req.path) ? logger.debug.bind(logger) : logger.warn.bind(logger);

  logFn({ method: req.method, path: req.path, query: req.query }, 'Route not found');
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'Not found' });
  }
  if (req.accepts('html')) {
    return res.status(404).sendFile(path.join(__dirname, '404.html'));
  }
  if (req.accepts('json')) {
    return res.status(404).json({ error: 'Not found' });
  }
  return res.status(404).type('txt').send('Not found');
});

app.use((err, req, res, next) => {
  logger.error({ err, method: req.method, path: req.path }, 'Unhandled server error');
  res.status(500).send('Internal server error');
});

httpServer.listen(PORT, HOST, () => {
  logger.info('\n🎮 PvP Game Server running!');
  logger.info({ host: HOST, port: PORT, envPort: process.env.PORT }, 'Server bind info');
  logger.info({ url: `http://localhost:${PORT}/overlay.html` }, 'Overlay URL');
  logger.info({ url: `http://localhost:${PORT}/dashboard` }, 'Dashboard URL');
  logger.info({ url: `http://localhost:${PORT}/stats` }, 'Stats URL');
  logger.info({ url: `http://localhost:${PORT}/state` }, 'State JSON URL');
  logger.info({ devTestMode: DEV_TEST_MODE }, 'Dev test mode');

  try { loadPlayerStats(); } catch (err) { logger.error({ err }, 'Failed to load player stats'); }
  try { loadCurrentBackground(); } catch (err) { logger.error({ err }, 'Failed to load current background'); }
  try { loadAudioConfig(); } catch (err) { logger.error({ err }, 'Failed to load audio config'); }
  try { loadSponsorConfig(); } catch (err) { logger.error({ err }, 'Failed to load sponsor media config'); }
  try { startMarketingAutoPoster(); } catch (err) { logger.error({ err }, 'Failed to start marketing auto-post scheduler'); }

  if (currentStreamer) {
    try { connectToStreamer(currentStreamer); } catch (err) { logger.error({ err, streamer: currentStreamer }, 'Failed to connect to streamer on startup'); }
  }
});
