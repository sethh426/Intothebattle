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
const SPONSOR_PREPARE_TIMEOUT_MS = Number(process.env.SPONSOR_PREPARE_TIMEOUT_MS || 8000);
const platformSponsorTimers = new Map();
const sponsorBreaks = new Map();
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
]);

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

function buildOverlayUrl(req, roomId) {
  const normalizedRoomId = normalizeRoomId(roomId);
  const token = createOverlayToken(normalizedRoomId);
  if (!normalizedRoomId || !token) return null;

  const configuredBase = process.env.APP_BASE_URL;
  const inferredBase = req ? `${req.protocol}://${req.get('host')}` : `http://localhost:${PORT}`;
  const base = (configuredBase || inferredBase).replace(/\/$/, '');
  return `${base}${appendOverlayAuth('/overlay', normalizedRoomId, token)}`;
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

const CFG = {
  BASE_HP:                        300,
  BASE_STRENGTH:                   15,
  CHAT_STRENGTH_BOOST:              1,
  LIKE_HP_BOOST:                    2,
  SOCIAL_STRENGTH_BOOST:            5,
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

function emitRoomEvent(room, type, payload = {}) {
  try {
    if (room && BATTLE_ACTION_EVENTS.has(type)) {
      room.lastBattleActionAt = Date.now();
    }
    room.eventSeq = (room.eventSeq || 0) + 1;
    io.to(room.roomId).emit(type, { ...payload, _ts: Date.now(), _seq: room.eventSeq, _event: type });
  } catch (err) {
    logger.error({ err, type, room: room.roomId }, 'emitRoomEvent failed');
  }
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
    record.roomId === roomId && !['completed', 'failed', 'stopped'].includes(record.status)
  ));
}

function isRoomInSponsorCooldown(room) {
  if (!room?.lastBattleActionAt) return false;
  return Date.now() - room.lastBattleActionAt < PLATFORM_SPONSOR_ACTION_COOLDOWN_MS;
}

function startPreparedSponsorBreak(room, record, reason = 'ready') {
  if (!room || !record || !sponsorBreaks.has(record.breakId)) return null;
  if (record.status === 'starting' || record.status === 'playing') return record;
  if (record.prepareTimer) {
    clearTimeout(record.prepareTimer);
    record.prepareTimer = null;
  }
  record.status = 'starting';
  record.startingAt = Date.now();
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
    source,
    creativeId: scenePayload.creativeId || null,
    filename: scenePayload.filename || null,
    payload: scenePayload,
    requestedAt: Date.now(),
    status: 'preparing',
    readySocketIds: new Set(),
    prepareTimer: null,
    cleanupTimer: null,
  };

  sponsorBreaks.set(breakId, record);
  recordSponsorPlaybackEvent(record, 'requested', { trigger: options.trigger || 'manual' });
  emitSponsorBreakStatus(room, record, 'preparing', { message: 'Preparing video in overlay' });
  emitRoomEvent(room, 'sponsorPrepare', { ...scenePayload, action: 'prepare' });

  record.prepareTimer = setTimeout(() => {
    const latest = sponsorBreaks.get(breakId);
    if (!latest || latest.status !== 'preparing') return;
    recordSponsorPlaybackEvent(latest, 'prepare_timeout');
    if (latest.payload?.videoUrl) {
      latest.status = 'failed';
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
    if (record.roomId !== room.roomId || ['completed', 'failed', 'stopped'].includes(record.status)) continue;
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
  };

  recordSponsorPlaybackEvent(record, eventType, detail);

  if (eventType === 'ready') {
    record.readySocketIds.add(socket.id);
    updatePlatformSponsorCreativeReadiness(record, 'ready');
    if (record.source === 'creator') {
      updateRoomSponsorCreativeStatus(room, record.filename, {
        readinessStatus: 'ready',
        lastReadyAt: new Date().toISOString(),
        playbackMessage: detail.message || 'Decoded in overlay',
      });
    }
    if (record.status === 'preparing') {
      record.status = 'ready';
      emitSponsorBreakStatus(room, record, 'ready', { message: 'Video loaded in overlay' });
      startPreparedSponsorBreak(room, record, 'ready');
    }
    return;
  }

  if (eventType === 'failed' || eventType === 'error') {
    record.status = 'failed';
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
    return;
  }

  if (eventType === 'first_frame' || eventType === 'playing' || eventType === 'fallback_started') {
    if (!record.firstFrameReported) {
      record.firstFrameReported = true;
      record.status = 'playing';
      record.startedAt = Date.now();
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
        message: eventType === 'fallback_started' ? 'Break started without video media' : 'First frame is on screen',
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
    updatePlatformSponsorCreativeMetric(record, 'completed');
    emitSponsorBreakStatus(room, record, 'completed', { message: 'Break completed' });
    cleanupSponsorBreakLater(record.breakId);
    return;
  }

  if (eventType === 'stopped') {
    record.status = 'stopped';
    emitSponsorBreakStatus(room, record, 'stopped', { message: 'Break stopped' });
    cleanupSponsorBreakLater(record.breakId);
  }
}

function listActivePlatformSponsorCreatives() {
  try {
    return db.prepare(`
      SELECT *
      FROM platform_sponsor_creatives
      WHERE status = 'active'
        AND COALESCE(readiness_status, 'ready') IN ('ready', 'tested')
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

function pickPlatformSponsorCreative(excludeCreativeId = null) {
  const creatives = listActivePlatformSponsorCreatives();
  if (!creatives.length) return null;
  const eligible = creatives.length > 1 && excludeCreativeId
    ? creatives.filter(creative => Number(creative.id) !== Number(excludeCreativeId))
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
  return {
    action: 'show',
    source: 'platform',
    filename: creative.filename,
    videoUrl: appendOverlayAuth(`/platform-sponsor/${encodeURIComponent(creative.filename)}`, room.roomId, token, { v: Date.now() }),
    partner: sanitizeSponsorText(creative.partner, 'IntoTheBattle Partner', 70),
    kicker: 'Arena Spotlight',
    title: sanitizeSponsorText(creative.title, 'Power Moment', 90),
    subtitle: sanitizeSponsorText(creative.subtitle, 'Stay locked in. The next fight is loading.', 140),
    durationMs: parseSponsorDuration(creative.duration_ms),
    muted: Number(creative.muted) !== 0,
    fit: creative.fit === 'cover' ? 'cover' : 'contain',
    statsMode: parseSponsorStatsMode(creative.stats_mode),
    creativeId: creative.id,
  };
}

function clearPlatformSponsorSchedule(roomId) {
  const timer = platformSponsorTimers.get(roomId);
  if (timer) clearTimeout(timer);
  platformSponsorTimers.delete(roomId);
}

function scheduleNextPlatformSponsor(room, delayMs = PLATFORM_SPONSOR_INTERVAL_MS) {
  if (!PLATFORM_SPONSOR_ENABLED) return;
  if (!room?.roomId) return;
  clearPlatformSponsorSchedule(room.roomId);
  const safeDelay = Math.max(5000, Number(delayMs) || PLATFORM_SPONSOR_INTERVAL_MS);
  const timer = setTimeout(() => {
    platformSponsorTimers.delete(room.roomId);
    if (room.planEntitlements?.canUseCreatorSponsors) return;

    if ((room.overlayCount || 0) > 0) {
      if (roomHasActiveSponsorBreak(room.roomId) || isRoomInSponsorCooldown(room)) {
        scheduleNextPlatformSponsor(room, PLATFORM_SPONSOR_RETRY_DELAY_MS);
        return;
      }

      const creative = pickPlatformSponsorCreative(room.lastPlatformSponsorCreativeId);
      if (creative) {
        const payload = buildPlatformSponsorPayload(room, creative);
        startSponsorBreak(room, payload, { trigger: 'platform_timer', source: 'platform' });
        room.lastPlatformSponsorCreativeId = creative.id;
        room.lastPlatformSponsorAt = Date.now();
        logger.info({ roomId: room.roomId, creativeId: creative.id }, 'Platform sponsor break prepared');
      }
    }

    scheduleNextPlatformSponsor(room, PLATFORM_SPONSOR_INTERVAL_MS);
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
    scheduleNextPlatformSponsor(room, PLATFORM_SPONSOR_INITIAL_DELAY_MS);
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

  liveRooms.forEach(room => {
    startSponsorBreak(room, buildPlatformSponsorPayload(room, creative), { trigger: 'admin_live_test', source: 'platform' });
    room.lastPlatformSponsorCreativeId = creative.id;
    room.lastPlatformSponsorAt = Date.now();
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

const DASHBOARD_OWNER_EMAIL  = process.env.DASHBOARD_EMAIL    || '';
const DASHBOARD_PASSWORD     = process.env.DASHBOARD_PASSWORD || '';
const DASHBOARD_COOKIE_NAME  = 'dashboard_auth';
const DASHBOARD_COOKIE_VALUE = Buffer.from(`${DASHBOARD_OWNER_EMAIL}:${DASHBOARD_PASSWORD}`).toString('base64');

function parseCookies(req) {
  return Object.fromEntries(
    (req.headers.cookie || '').split(';').map(part => {
      const [name, ...rest] = part.trim().split('=');
      return [name, rest.join('=')];
    }).filter(([name]) => name)
  );
}

function isDashboardAuthed(req) {
  return parseCookies(req)[DASHBOARD_COOKIE_NAME] === DASHBOARD_COOKIE_VALUE;
}

function loadRoomPlayerStats(room) {
  try {
    let rows = db.prepare('SELECT * FROM room_player_stats WHERE room_id = ?').all(room.roomId);
    if (!rows.length) {
      const { playerStatsFile } = getRoomPaths(room.roomId);
      if (fs.existsSync(playerStatsFile)) {
        const saved = JSON.parse(fs.readFileSync(playerStatsFile, 'utf8'));
        const insert = db.prepare(`
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
          for (const id in saved) {
            const s = saved[id] || {};
            insert.run(
              room.roomId,
              id,
              s.nickname || id,
              s.hp || s.maxHp || CFG.BASE_HP,
              s.maxHp || CFG.BASE_HP,
              s.strength || CFG.BASE_STRENGTH,
              s.kills || 0,
              s.killStreak || 0,
              s.lastKillTime || 0,
              s.alive ? 1 : 0,
              s.lastActive || Date.now(),
              s.color || randomColor(),
              s.messageBoostExpires || 0,
              s.forceSpawn ? 1 : 0
            );
          }
        });
        tx();
        rows = db.prepare('SELECT * FROM room_player_stats WHERE room_id = ?').all(room.roomId);
        console.log(`📂 Migrated ${rows.length} legacy saved player stats for room ${room.roomId}`);
      }
    }

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
          alive:    Boolean(row.alive),
          lastActive: row.last_active || Date.now(),
          x: 0, y: 0, vx: 0, vy: 0,
          color: row.color || randomColor(),
          messageBoostExpires: row.message_boost_expires || 0,
          forceSpawn: Boolean(row.force_spawn),
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
          player.alive ? 1 : 0,
          player.lastActive || Date.now(),
          player.color || randomColor(),
          player.messageBoostExpires || 0,
          player.forceSpawn ? 1 : 0
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
      const eventOrder = ['attack', 'gift', 'kill', 'respawn', 'heal', 'follow'];
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

// ────────────────────────────────
// DEAL DAMAGE (enriched)
// ────────────────────────────────
function dealDamage(room, attackerId, targetId, multiplier = 1) {
  const attacker = room.players[attackerId];
  const target   = room.players[targetId];

  if (!attacker?.alive || !target?.alive || attackerId === targetId) return null;

  const dmg = Math.floor(
    attacker.strength * multiplier *
    (1 - CFG.ATTACK_VARIANCE / 2 + Math.random() * CFG.ATTACK_VARIANCE)
  );

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

  const baseResult = { attacker: attackerId, target: targetId, damage: dmg, killed, special: multiplier > 1 };
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

// ────────────────────────────────
// REWRITTEN handleMentionAttack
// ────────────────────────────────
function handleMentionAttack(room, attackerId, attackerNick, comment) {
  const mentions = extractMentions(comment);
  if (!mentions.length) return { handled: false, reason: 'No @mention found' };

  // Parse !command
  const cmdMatch = String(comment || '').match(/!(\S+)/i);
  let requestedEffect  = null;
  let commandMultiplier = 1;
  let commandDescription = null;
  let isSpecialCommand  = false;

  if (cmdMatch) {
    const cmd = cmdMatch[1].toLowerCase();
    const entry = EFFECT_COMMANDS[cmd];
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

const httpServer = createServer(app);
const io         = new Server(httpServer, { cors: { origin: '*' } });

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
app.get('/verify-email', (_req, res) => res.sendFile(path.join(__dirname, 'verify-email.html')));
app.get('/signup', (_req, res) => res.sendFile(path.join(__dirname, 'signup.html')));
app.get(['/overlay-preview', '/overlay-preview.html', '/overlay-demo', '/overlay-demo.html'], (_req, res) => res.sendFile(path.join(__dirname, 'overlay.html')));
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
    const roomId = Math.random().toString(36).slice(2, 10);

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
    res.cookie('session_token', sessionToken, { httpOnly: true, sameSite: 'lax', maxAge: 90 * 24 * 60 * 60 * 1000 });
    res.json({ success: true, roomId, sessionToken });
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
app.get('/admin-panel',  requireAccess, (_req, res) => res.redirect('/admin'));

function assignDefaultRoomIfMissing(row) {
  if (row.room_id) return row.room_id;

  const assignedRoom = DEFAULT_ROOM_ID;
  try {
    db.prepare('UPDATE access_codes SET room_id = ? WHERE id = ?').run(assignedRoom, row.id);
    row.room_id = assignedRoom;
    logger.info({ rowId: row.id, code: row.code, assignedRoom, requiresRoomId: requiresRoomId() }, 'Assigned default room to access code missing room_id');
  } catch (err) {
    logger.error({ err, rowId: row.id, code: row.code }, 'Failed to assign default room to access code');
  }
  return assignedRoom;
}

function socketAuth(socket, next) {
  const e2eAuth = getE2EAuthRecord(parseCookies(socket.request).session_token);
  if (e2eAuth) {
    socket.roomId = enableRoomScoped ? assignDefaultRoomIfMissing(e2eAuth.record) : DEFAULT_ROOM_ID;
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
    socket.roomId = enableRoomScoped ? assignDefaultRoomIfMissing(row) : DEFAULT_ROOM_ID;
    socket.accessCode = row;
    return next();
  }

  const user = db.prepare('SELECT * FROM users WHERE session_token = ?').get(token);
  if (!user || !user.is_active) {
    logger.warn({ userId: user?.id, isActive: user?.is_active }, 'Socket auth failed: invalid user session');
    return next(new Error('Unauthorized: invalid session'));
  }
  socket.roomId = enableRoomScoped ? (getUserRoomId(user.id) || DEFAULT_ROOM_ID) : DEFAULT_ROOM_ID;
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
    req.roomId = enableRoomScoped ? assignDefaultRoomIfMissing(row) : DEFAULT_ROOM_ID;
    logger.info({ path: req.path, method: req.method, rowId: row.id, code: row.code, roomId: req.roomId, requiresRoomId: requiresRoomId() }, '/api/connect auth success');
  } else {
    const user = auth.record;
    if (!user.is_active) {
      logger.warn({ path: req.path, method: req.method, userId: user.id }, 'API auth failed: user disabled');
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    const roomId = enableRoomScoped ? (getUserRoomId(user.id) || DEFAULT_ROOM_ID) : DEFAULT_ROOM_ID;
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
    roomId = enableRoomScoped ? assignDefaultRoomIfMissing(row) : DEFAULT_ROOM_ID;
  } else {
    const user = auth.record;
    if (!user.is_active) return null;
    roomId = enableRoomScoped ? (getUserRoomId(user.id) || DEFAULT_ROOM_ID) : DEFAULT_ROOM_ID;
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

  if (!paid) {
    status = 'free';
  }

  return {
    type: 'user',
    status,
    tier: paid ? 'paid' : 'free',
    planName: paid ? 'Creator Pro' : 'Free',
    canUseCreatorSponsors: paid,
    platformSponsorManaged: !paid,
    reason,
    accessAllowed,
    actionRequired: !accessAllowed,
    paywallUrl: accessAllowed ? null : paywallUrl(reason),
    subscription: {
      status: rawStatus,
      planType: paid ? (subscription.plan_type || 'Creator Pro') : 'Free',
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
  const suppliedToken = bearerToken || req.get('x-metrics-token') || req.query.token;
  if (suppliedToken === expectedToken) return next();

  return res.status(401).send('Unauthorized');
}

function requireDiagnosticsAccess(req, res, next) {
  if (process.env.NODE_ENV !== 'production') return next();

  const expectedToken = process.env.DIAGNOSTICS_TOKEN || process.env.METRICS_TOKEN;
  if (!expectedToken) return res.status(404).send('Not found');

  const authHeader = req.get('authorization') || '';
  const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice('Bearer '.length) : '';
  const suppliedToken = bearerToken || req.get('x-diagnostics-token') || req.get('x-metrics-token') || req.query.token;
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

app.get('/audio/:filename', (req, res) => {
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

function sponsorCreativePlaybackIssue(entry) {
  if (!entry) return null;
  const processingStatus = String(entry.processingStatus || entry.processing_status || '').trim().toLowerCase();
  const readinessStatus = String(entry.readinessStatus || entry.readiness_status || '').trim().toLowerCase();

  if (['processing', 'queued'].includes(processingStatus)) return 'Sponsor media is still processing.';
  if (processingStatus === 'failed') return entry.processingMessage || entry.processing_message || 'Sponsor media processing failed.';
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

function sendSponsorMedia(req, res, filepath, filename) {
  let stat;
  try {
    stat = fs.statSync(filepath);
  } catch (_err) {
    return res.status(404).send('Sponsor media not found');
  }

  const fileSize = stat.size;
  const contentType = sponsorContentType(filename);
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'private, max-age=300');
  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Disposition', inlineContentDisposition(filename));

  if (!fileSize) {
    res.setHeader('Content-Length', '0');
    return res.status(204).end();
  }

  const range = req.headers.range;
  if (!range) {
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

  return {
    action: 'show',
    source: 'creator',
    filename: entry?.filename || null,
    title: sanitizeSponsorText(body.title, entry?.title || entry?.originalName || 'Power Moment', 90),
    partner: sanitizeSponsorText(body.partner, entry?.partner || 'Presented By', 70),
    kicker: 'Arena Spotlight',
    subtitle: sanitizeSponsorText(body.subtitle, entry?.subtitle || 'Stay locked in. The next fight is loading.', 140),
    durationMs: parseSponsorDuration(body.durationMs),
    mediaDurationMs: entry?.durationSeconds ? Math.round(Number(entry.durationSeconds) * 1000) : null,
    mediaWidth: entry?.width || null,
    mediaHeight: entry?.height || null,
    processingStatus: entry?.processingStatus || null,
    readinessStatus: entry?.readinessStatus || null,
    muted: parseSponsorMuted(body.muted),
    fit: ['cover', 'contain'].includes(body.fit) ? body.fit : 'contain',
    statsMode: parseSponsorStatsMode(body.statsMode),
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
  res.clearCookie(DASHBOARD_COOKIE_NAME, { path: '/', httpOnly: true, sameSite: 'lax' });
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

app.get('/api/status', requireRoom, (req, res) => res.json({
  roomId:           req.room.roomId,
  overlayUrl:       buildOverlayUrl(req, req.room.roomId),
  plan:             buildPlanEntitlements(req.auth),
  username:         req.room.streamerUsername || currentStreamer,
  connected:        !!(client && client.connected),
  overlayConnected: req.room.overlayCount > 0,
  overlayCount:     req.room.overlayCount,
  playerCount:      Object.values(req.room.players).filter(p => p.alive).length,
  background:       buildBackgroundPayload(req.room, { v: Date.now() }),
  overlaySettings:  req.room.overlaySettings,
  devTestMode:      DEV_TEST_MODE,
}));

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
  connectToStreamer(username, req.room);
  res.json({ success: true });
});

app.post('/api/reset', requireRoom, (_req, res) => { disconnectStreamer(); res.json({ success: true }); });
app.post('/api/overlay/reload', requireRoom, (req, res) => {
  emitRoomEvent(req.room, 'forceReload', { v: Date.now(), delayMs: 3000, reason: 'Operator reload' });
  res.json({ success: true });
});

app.post('/api/players/clear', requireRoom, (req, res) => {
  for (const id in req.room.players) { req.room.players[id].alive = false; req.room.players[id].forceSpawn = false; }
  emitRoomEvent(req.room, 'gameState', req.room.players);
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
        normalized: mediaMeta.normalized,
        processingStatus: mediaMeta.processingStatus,
        processingMessage: mediaMeta.processingMessage,
        readinessStatus: 'ready',
        playbackMessage: mediaMeta.qualityWarnings.length ? mediaMeta.qualityWarnings.join(' ') : 'Ready for overlay test.',
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
      res.status(500).json({ success: false, error: uploadErr.message || 'Sponsor video processing failed.' });
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
  emitSoundAndSync(room, 'follow', { intensity: 0.6, tier: 'common' });
  emitRoomEvent(room, 'follow', { uniqueId: id, nickname: player.nickname, color: player.color });
  res.json({ success: true, uniqueId: id });
});

app.post('/api/test/social', blockInProduction, requireDevTestMode, (_req, res) => {
  ensureTestPlayers();
  const room = getDefaultRoom();
  const id = 'test_echo';
  const player = room.players[id];
  awardStats(room, id, player.nickname, 0, CFG.SOCIAL_STRENGTH_BOOST);
  emitRoomEvent(room, 'socialBoost', {
    uniqueId: id,
    nickname: player.nickname,
    amount: CFG.SOCIAL_STRENGTH_BOOST,
    color: player.color || '#ffd166',
  });
  emitRoomEvent(room, 'gameState', room.players);
  res.json({ success: true, uniqueId: id, amount: CFG.SOCIAL_STRENGTH_BOOST });
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
function setupTikTokEvents(tiktokClient, room) {
  tiktokClient.on('connected', () => {
    console.log(`✅ Connected to @${room.streamerUsername || currentStreamer || 'unknown'}'s LIVE stream for room ${room.roomId}\n`);
  });

  tiktokClient.on('member', (e) => {
    const id   = e.user?.uniqueId;
    const nick = e.user?.nickname || id;
    if (!id) return;
    spawnPlayer(room, id, nick);
    if (room.players[id]) room.players[id].alive = true;
    emitRoomEvent(room, 'gameState', room.players);
    emitRoomEvent(room, 'spawn', { uniqueId: id });
  });

  tiktokClient.on('chat', (e) => {
    const { id, nickname } = resolveTikTokUser(e);
    const comment = String(e.comment || e.message || '').trim();
    if (!id) return;

    awardStats(room, id, nickname, 0, CFG.CHAT_STRENGTH_BOOST);

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

  tiktokClient.on('gift', (e) => {
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

  tiktokClient.on('like', (e) => {
    const { id, nickname } = resolveTikTokUser(e);
    if (!id) return;
    if (!room.players[id]) spawnPlayer(room, id, nickname);
    awardStats(room, id, nickname, CFG.LIKE_HP_BOOST, 0);

    const likeKey = `${room.roomId}:${id}`;
    if (!likeRateTracker[likeKey]) {
      likeRateTracker[likeKey] = { likes: [], window: 90000 };
    }
    const now = Date.now();
    likeRateTracker[likeKey].likes.push(now);
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
      intensity: Math.min(likeCount / 500, 1),
      color:     room.players[id]?.color || '#FF6B6B',
    });
    emitRoomEvent(room, 'gameState', room.players);
  });

  tiktokClient.on('social', (e) => {
    const { id, nickname } = resolveTikTokUser(e);
    if (!id) return;
    if (!room.players[id]) spawnPlayer(room, id, nickname);
    awardStats(room, id, nickname, 0, CFG.SOCIAL_STRENGTH_BOOST);
    emitRoomEvent(room, 'socialBoost', {
      uniqueId: id,
      nickname,
      amount: CFG.SOCIAL_STRENGTH_BOOST,
      color: room.players[id]?.color || '#ffd166',
    });
    emitRoomEvent(room, 'gameState', room.players);
  });

  tiktokClient.on('follow', (e) => {
    const id   = e.user?.uniqueId;
    const nick = e.user?.nickname || id;
    if (!id) return;
    console.log(`❤️  @${nick} followed!`);
    emitSoundAndSync(room, 'follow', { intensity: 0.6, tier: 'common' });
    emitRoomEvent(room, 'follow', { uniqueId: id, nickname: nick, color: room.players[id]?.color });
  });

  tiktokClient.on('error', (err) => {
    console.error('⚠️  TikTok error:', err?.message || err);
  });
}

function safeDisconnectClient() {
  if (!client) return;
  try {
    if (client.ws) { client.ws.onerror = () => {}; client.ws.onclose = () => {}; }
    client.disconnect();
  } catch (err) {
    console.error('⚠️ Error during disconnect:', err?.message || err);
  }
  client = null;
}

function connectToStreamer(username, room = getDefaultRoom()) {
  safeDisconnectClient();
  currentStreamer = username;
  room.streamerUsername = username;
  client = new TikTokLive({ uniqueId: currentStreamer, apiKey: API_KEY });
  setupTikTokEvents(client, room);
  client.connect().catch(err => {
    console.error('❌ Could not connect:', err?.message || err);
    console.error(`   Make sure @${currentStreamer} is currently LIVE on TikTok`);
    client = null;
  });
}

function disconnectStreamer() {
  safeDisconnectClient();
  currentStreamer = '';
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
  if (req.accepts('html')) {
    return res.status(404).send('<h1>404 Not Found</h1><p>The requested resource was not found on the server.</p>');
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

  if (currentStreamer) {
    try { connectToStreamer(currentStreamer); } catch (err) { logger.error({ err, streamer: currentStreamer }, 'Failed to connect to streamer on startup'); }
  }
});
