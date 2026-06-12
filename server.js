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
import checkTrial from './tiktokbr/middleware/checkTrial.js';
import { getE2EAuthRecord } from './tiktokbr/auth/e2eAuth.js';
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

function checkWritableStorage() {
  const requiredDirs = [
    STORAGE_ROOT,
    path.join(STORAGE_ROOT, 'backgrounds'),
    path.join(STORAGE_ROOT, 'audio'),
    path.join(STORAGE_ROOT, 'sponsors'),
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
    io.to(room.roomId).emit(type, { ...payload, _ts: Date.now() });
  } catch (err) {
    logger.error({ err, type, room: room.roomId }, 'emitRoomEvent failed');
  }
}

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

function loadRoomBackground(room) {
  try {
    if (room.currentBackground) return;
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

function saveRoomBackgroundMeta(room, filename) {
  try {
    room.currentBackground = { filename };
    saveRoomSettings(room.roomId);
  } catch (err) {
    console.error('Error saving background meta for room', room.roomId, err);
  }
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

    const repoFiles = fs.existsSync(audioDir)
      ? fs.readdirSync(audioDir).filter(file => {
          const ext = path.extname(file).toLowerCase();
          return ['.mp3', '.m4a', '.wav', '.ogg', '.aac', '.flac', '.webm'].includes(ext);
        })
      : [];

    if (!room.audioLibrary.length) {
      room.audioLibrary = repoFiles.map(filename => ({
        filename,
        originalName: filename,
        size: fs.existsSync(path.join(audioDir, filename)) ? fs.statSync(path.join(audioDir, filename)).size : 0,
        uploadedAt: new Date().toISOString(),
      }));
    } else {
      const known = new Set(room.audioLibrary.map(entry => entry.filename));
      repoFiles.forEach(filename => {
        if (!known.has(filename)) {
          const filePath = path.join(audioDir, filename);
          room.audioLibrary.push({
            filename,
            originalName: filename,
            size: fs.existsSync(filePath) ? fs.statSync(filePath).size : 0,
            uploadedAt: new Date().toISOString(),
          });
        }
      });
    }

    room.audioLibrary = room.audioLibrary.filter(entry => {
      const runtimePath = path.join(audioDir, entry.filename);
      return isSafePath(audioDir, runtimePath) && fs.existsSync(runtimePath);
    });

    room.audioLibrary.sort((a, b) => a.originalName.localeCompare(b.originalName, undefined, { numeric: true, sensitivity: 'base' }));

    const allUnassigned = Object.values(room.audioConfig).every(val => !val);
    if (allUnassigned && room.audioLibrary.length) {
      const eventOrder = ['attack', 'gift', 'kill', 'respawn', 'heal', 'follow'];
      eventOrder.forEach((event, idx) => {
        if (idx < room.audioLibrary.length) room.audioConfig[event] = room.audioLibrary[idx].filename;
      });
      saveRoomSettings(room.roomId);
    }

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
  limits:     { fileSize: 10 * 1024 * 1024 },
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
  limits:     { fileSize: 20 * 1024 * 1024 },
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
  limits: { fileSize: 250 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    const ok = ALLOWED_SPONSOR_EXTS.has(ext) && ALLOWED_SPONSOR_MIMES.has(file.mimetype);
    ok ? cb(null, true) : cb(new Error('Invalid sponsor media type. Upload MP4, WEBM, M4V, or MOV video.'));
  },
});

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

    const result = dealDamage(room, attackerId, target.uniqueId, multiplier);
    if (result) {
      result.effect = requestedEffect;                // force the chosen effect
      result.special            = isSpecialCommand;
      result.commandDescription = commandDescription || requestedEffect;
      result.giftBoosted        = boostActive;

      emitAttackAndSync(room, result);
      emitSoundAndSync(room, isSpecialCommand ? 'gift' : 'attack');
      emitRoomEvent(room, 'commentDamage', {
        attacker: attackerNick,
        target:   target.nickname,
        damage:   result.damage,
        comment,
        special:  isSpecialCommand,
        effect:   requestedEffect,
        intensity: result.intensity,
        critical:  result.critical,
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
          if (row.trial_started) {
            const trialStart = new Date(row.trial_started);
            const trialEnd = new Date(trialStart.getTime() + (row.trial_days || 14) * 24 * 60 * 60 * 1000);
            const now = new Date();
            if (now <= trialEnd || row.subscription_status === 'active') {
              return res.redirect('/dashboard');
            }
            res.clearCookie('session_token', { path: '/', httpOnly: true, sameSite: 'lax' });
          } else {
            return res.redirect('/dashboard');
          }
        }
      }
      if (auth?.type === 'user') {
        const user = auth.record;
        if (user && user.is_active) {
          const subscription = db.prepare("SELECT * FROM subscriptions WHERE user_id = ? AND status IN ('active','trial') ORDER BY updated_at DESC LIMIT 1").get(user.id);
          if (subscription) {
            return res.redirect('/dashboard');
          }
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
app.get('/verify-email', (_req, res) => res.sendFile(path.join(__dirname, 'verify-email.html')));
app.get('/signup', (_req, res) => res.sendFile(path.join(__dirname, 'signup.html')));
app.get(['/overlay-preview', '/overlay-preview.html'], (_req, res) => res.sendFile(path.join(__dirname, 'overlay-demo.html')));
app.get('/register', (req, res) => {
  const token = req.cookies?.session_token;
  const auth = getAuthRecord(token);
  if (auth?.type === 'user') {
    const user = auth.record;
    if (user && user.is_active) {
      const subscription = db.prepare("SELECT * FROM subscriptions WHERE user_id = ? AND status IN ('active','trial') ORDER BY updated_at DESC LIMIT 1").get(user.id);
      if (subscription) {
        return res.redirect('/dashboard');
      }
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
      if (!row.trial_started) {
        return res.redirect('/dashboard');
      }
      const trialStart = new Date(row.trial_started);
      const trialEnd = new Date(trialStart.getTime() + (row.trial_days || 14) * 24 * 60 * 60 * 1000);
      const now = new Date();
      if (now <= trialEnd || row.subscription_status === 'active') {
        return res.redirect('/dashboard');
      }
    }
  }
  if (auth?.type === 'user') {
    const user = auth.record;
    if (user && user.is_active) {
      const subscription = db.prepare("SELECT * FROM subscriptions WHERE user_id = ? AND status IN ('active','trial') ORDER BY updated_at DESC LIMIT 1").get(user.id);
      if (subscription) {
        return res.redirect('/dashboard');
      }
    }
  }
  res.sendFile(path.join(__dirname, 'login.html'));
});
app.get('/profile', requireAccess, (_req, res) => res.sendFile(path.join(__dirname, 'profile.html')));
app.get('/request-password-reset', (_req, res) => res.sendFile(path.join(__dirname, 'request-password-reset.html')));
app.get('/reset-password', (_req, res) => res.sendFile(path.join(__dirname, 'reset-password.html')));
app.get('/paywall', (_req, res) => res.sendFile(path.join(__dirname, 'paywall.html')));
app.get('/paywall-link', (_req, res) => {
  const url = process.env.PAYPAL_PAYMENT_LINK || 'https://www.paypal.com';
  res.redirect(302, url);
});

// Auth endpoints for trial signup
app.post('/auth/generate-code', express.json(), (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });

  try {
    const code = Math.random().toString(36).slice(2, 10).toUpperCase();
    const expiresAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');
    
    db.prepare(`
      INSERT INTO access_codes (code, email, expires_at, trial_started, trial_days, subscription_status)
      VALUES (?, ?, ?, CURRENT_TIMESTAMP, 14, 'trial')
    `).run(code, email.toLowerCase().trim(), expiresAt);
    
    res.json({ success: true, code });
  } catch (err) {
    console.error('Code generation error:', err);
    res.status(500).json({ error: 'Failed to generate code' });
  }
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

    // Update access code with profile and session
    // Ensure trial metadata is initialized and set session token
    const trialDaysDefault = 14;
    const expiresAt = new Date(Date.now() + trialDaysDefault * 24 * 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');
    db.prepare(`
      UPDATE access_codes
      SET session_token = ?, streamer_name = ?, tiktok_username = ?, room_id = ?,
          trial_started = COALESCE(trial_started, CURRENT_TIMESTAMP),
          trial_days = COALESCE(trial_days, ?),
          subscription_status = COALESCE(subscription_status, 'trial'),
          expires_at = COALESCE(expires_at, ?)
      WHERE id = ?
    `).run(sessionToken, name, tiktokUsername, roomId, trialDaysDefault, expiresAt, row.id);

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
  if (!row || row.is_revoked || new Date(row.expires_at) < new Date()) {
    logger.warn({ rowId: row?.id, code: row?.code, isRevoked: row?.is_revoked, expiresAt: row?.expires_at }, 'Socket auth failed: expired or revoked');
    return next(new Error('Unauthorized: expired or revoked'));
  }
  socket.roomId = enableRoomScoped ? assignDefaultRoomIfMissing(row) : DEFAULT_ROOM_ID;
  socket.accessCode = row;
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
  const trialStartedAt = parseDate(row.trial_started);
  const trialDays = Number(row.trial_days || 14);
  const trialEndsAt = trialStartedAt
    ? new Date(trialStartedAt.getTime() + trialDays * 24 * 60 * 60 * 1000)
    : null;
  const rawStatus = String(row.subscription_status || 'active').toLowerCase();

  let status = rawStatus;
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
  } else if (trialStartedAt && rawStatus !== 'active') {
    if (trialEndsAt && now <= trialEndsAt) {
      status = 'trial';
    } else {
      status = 'expired';
      reason = 'trial_expired';
      accessAllowed = false;
    }
  } else if (['cancelled', 'suspended', 'expired', 'revoked'].includes(rawStatus)) {
    reason = rawStatus;
    accessAllowed = false;
  } else {
    status = rawStatus || 'active';
  }

  return {
    type: 'code',
    status,
    reason,
    accessAllowed,
    actionRequired: !accessAllowed,
    paywallUrl: accessAllowed ? null : paywallUrl(reason),
    trial: trialStartedAt ? {
      startedAt: toIsoStringOrNull(trialStartedAt),
      days: trialDays,
      endsAt: toIsoStringOrNull(trialEndsAt),
      daysRemaining: daysRemainingUntil(trialEndsAt, now),
    } : null,
    subscription: {
      status: rawStatus,
      planType: row.code_type || 'access-code',
      paypalSubscriptionId: row.paypal_subscription_id || null,
      startedAt: toIsoStringOrNull(trialStartedAt),
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
      trial: null,
      subscription: null,
    };
  }

  const subscription = db.prepare(
    'SELECT * FROM subscriptions WHERE user_id = ? ORDER BY updated_at DESC LIMIT 1'
  ).get(user.id);

  if (!subscription) {
    return {
      type: 'user',
      status: 'none',
      reason: 'no_subscription',
      accessAllowed: false,
      actionRequired: true,
      paywallUrl: paywallUrl('no_subscription'),
      trial: null,
      subscription: null,
    };
  }

  const rawStatus = String(subscription.status || 'unknown').toLowerCase();
  const startedAt = parseDate(subscription.started_at);
  const expiresAt = parseDate(subscription.expires_at);
  const nextBillingDate = parseDate(subscription.next_billing_date);
  let status = rawStatus;
  let reason = null;
  let accessAllowed = rawStatus === 'active';

  if (rawStatus === 'trial') {
    if (expiresAt && now <= expiresAt) {
      accessAllowed = true;
    } else {
      status = 'expired';
      reason = 'trial_expired';
      accessAllowed = false;
    }
  } else if (!accessAllowed) {
    reason = ['cancelled', 'suspended', 'expired'].includes(rawStatus)
      ? rawStatus
      : 'subscription_required';
  }

  return {
    type: 'user',
    status,
    reason,
    accessAllowed,
    actionRequired: !accessAllowed,
    paywallUrl: accessAllowed ? null : paywallUrl(reason),
    trial: rawStatus === 'trial' ? {
      startedAt: toIsoStringOrNull(startedAt),
      days: startedAt && expiresAt
        ? Math.max(0, Math.round((expiresAt.getTime() - startedAt.getTime()) / (24 * 60 * 60 * 1000)))
        : null,
      endsAt: toIsoStringOrNull(expiresAt),
      daysRemaining: daysRemainingUntil(expiresAt, now),
    } : null,
    subscription: {
      status: rawStatus,
      planType: subscription.plan_type || (rawStatus === 'trial' ? 'trial' : 'PayPal'),
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

app.use(express.static(__dirname));

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
  const storage = checkWritableStorage();
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
    },
    storage,
    database: dbHealth,
  });
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
  const { audioDir } = getRoomPaths(room.roomId);
  const runtimePath = path.join(audioDir, filename);
  if (!isSafePath(audioDir, runtimePath)) return res.status(403).send('Forbidden');
  if (fs.existsSync(runtimePath)) return res.sendFile(runtimePath);
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
  if (fs.existsSync(runtimePath)) return res.sendFile(runtimePath);
  return res.status(404).send('Sponsor media not found');
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

function buildSponsorScenePayload(room, body = {}) {
  loadRoomSponsorConfig(room);
  const filename = body.filename ? path.basename(String(body.filename)) : '';
  const entry = filename ? room.sponsorLibrary.find(item => item.filename === filename) : null;
  if (filename && !entry) return { error: 'Sponsor media not found' };

  return {
    action: 'show',
    filename: entry?.filename || null,
    title: sanitizeSponsorText(body.title, entry?.title || entry?.originalName || 'Sponsor Spotlight', 90),
    partner: sanitizeSponsorText(body.partner, entry?.partner || 'Presented By', 70),
    subtitle: sanitizeSponsorText(body.subtitle, 'We will be right back to the battle.', 140),
    durationMs: parseSponsorDuration(body.durationMs),
    muted: parseSponsorMuted(body.muted),
    fit: ['cover', 'contain'].includes(body.fit) ? body.fit : 'cover',
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

  socket.on('register', ({ type } = {}) => {
    const clientType = String(type || 'unknown').toLowerCase();
    socket.data.clientType = clientType;
    socket.join(room.roomId);

    if (clientType === 'overlay') {
      room.overlayCount++;
      emitRoomEvent(room, 'overlayCount', { count: room.overlayCount });
      updateOverlayGauge();

      socket.emit('gameState',        room.players);
      socket.emit('audioConfig',      room.audioConfig);
      socket.emit('overlaySettings',  room.overlaySettings);
      socket.emit('laserColor',       room.overlaySettings.laserColor);
      if (room.currentBackground) {
        socket.emit('backgroundChanged', { filename: room.currentBackground.filename });
      }
    } else if (clientType === 'dashboard' || clientType === 'stats') {
      socket.emit('overlayCount',    { count: room.overlayCount });
      socket.emit('overlaySettings', room.overlaySettings);
      socket.emit('laserColor',      room.overlaySettings.laserColor);
      socket.emit('gameState',       room.players);
    }
  });

  socket.on('disconnect', () => {
    if (socket.data.clientType === 'overlay') {
      room.overlayCount = Math.max(0, room.overlayCount - 1);
      emitRoomEvent(room, 'overlayCount', { count: room.overlayCount });
      updateOverlayGauge();
    }
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

app.get('/dashboard', checkTrial, (_req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});

app.get('/dashboard/welcome', checkTrial, (_req, res) => {
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

app.get('/stats', checkTrial, (_req, res) => res.sendFile(path.join(__dirname, 'stats.html')));

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
  username:         req.room.streamerUsername || currentStreamer,
  connected:        !!(client && client.connected),
  overlayConnected: req.room.overlayCount > 0,
  overlayCount:     req.room.overlayCount,
  playerCount:      Object.values(req.room.players).filter(p => p.alive).length,
  background:       req.room.currentBackground,
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
  upload.single('background')(req, res, (err) => {
    try {
      if (err)       return res.status(400).json({ success: false, error: err.message || 'Background upload failed' });
      if (!req.file) return res.status(400).json({ success: false, error: 'No background image was uploaded.' });
      deleteRoomBackgroundFile(req.room);
      saveRoomBackgroundMeta(req.room, req.file.filename);
      emitRoomEvent(req.room, 'backgroundChanged', { filename: req.file.filename });
      console.log(`📸 Background uploaded for room ${req.room.roomId}: ${req.file.filename}`);
      return res.json({ success: true, filename: req.file.filename, url: `/background/${req.file.filename}` });
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
  audioUpload.single('audio')(req, res, (err) => {
    if (err)       return res.status(400).json({ success: false, error: err.message });
    if (!req.file) return res.status(400).json({ success: false, error: 'No audio file uploaded.' });
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

app.get('/api/sponsors', requireRoom, (req, res) => {
  loadRoomSponsorConfig(req.room);
  res.json({ success: true, library: req.room.sponsorLibrary || [] });
});

app.post('/api/sponsor/upload', requireRoom, (req, res) => {
  res.type('application/json');
  sponsorUpload.single('sponsor')(req, res, (err) => {
    if (err) return res.status(400).json({ success: false, error: err.message });
    if (!req.file) return res.status(400).json({ success: false, error: 'No sponsor video uploaded.' });

    loadRoomSponsorConfig(req.room);
    const entry = {
      filename: req.file.filename,
      originalName: req.file.originalname,
      title: sanitizeSponsorText(req.body?.title, path.basename(req.file.originalname, path.extname(req.file.originalname)), 90),
      partner: sanitizeSponsorText(req.body?.partner, 'Sponsor', 70),
      subtitle: sanitizeSponsorText(req.body?.subtitle, 'We will be right back to the battle.', 140),
      size: req.file.size,
      uploadedAt: new Date().toISOString(),
    };
    req.room.sponsorLibrary.push(entry);
    saveRoomSponsorConfig(req.room);
    console.log(`Sponsor media uploaded for room ${req.room.roomId}: ${req.file.originalname} -> ${req.file.filename}`);
    res.json({ success: true, file: entry });
  });
});

app.delete('/api/sponsor/delete/:filename', requireRoom, (req, res) => {
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

app.post('/api/sponsor/play', requireRoom, (req, res) => {
  const payload = buildSponsorScenePayload(req.room, req.body || {});
  if (payload.error) return res.status(404).json({ success: false, error: payload.error });
  emitRoomEvent(req.room, 'sponsorScene', payload);
  res.json({ success: true, scene: payload });
});

app.post('/api/sponsor/stop', requireRoom, (req, res) => {
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

function ensureTestPlayers() {
  const room = getDefaultRoom();
  const testPlayers = [
    { id: 'test_alpha',   nick: 'Alpha'   },
    { id: 'test_bravo',   nick: 'Bravo'   },
    { id: 'test_charlie', nick: 'Charlie' },
    { id: 'test_delta',   nick: 'Delta'   },
    { id: 'test_echo',    nick: 'Echo'    },
  ];
  testPlayers.forEach((item, index) => {
    room.players[item.id] = {
      uniqueId: item.id, nickname: item.nick,
      hp: CFG.BASE_HP, maxHp: CFG.BASE_HP,
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
  ensureTestPlayers();
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
      const aHp = a.hp != null ? a.hp : (a.maxHp || 0);
      const bHp = b.hp != null ? b.hp : (b.maxHp || 0);
      const hpDiff = bHp - aHp;
      if (hpDiff !== 0) return hpDiff;
      return (b.maxHp || 0) - (a.maxHp || 0);
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

setInterval(tick, 100);

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
