import { TikTokLive } from '@tiktool/live';
import express from 'express';
import cookieParser from 'cookie-parser';
import { createServer } from 'http';
import { Server } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import pino from 'pino';
import * as Sentry from '@sentry/node';
import { createClient as createRedisClient } from 'redis';
import { createAdapter } from '@socket.io/redis-adapter';
import promClient from 'prom-client';
import fs from 'fs';
import multer from 'multer';
import jwt from 'jsonwebtoken';
import db from './tiktokbr/db/db.js';
import authRoutes from './tiktokbr/routes/auth.js';
import adminRoutes from './tiktokbr/routes/admin.js';
import paypalRoutes from './tiktokbr/routes/paypal.js';
import requireAccess from './tiktokbr/middleware/auth.js';
import checkTrial from './tiktokbr/middleware/checkTrial.js';
import {
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

dotenv.config();

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });
if (process.env.SENTRY_DSN) {
  Sentry.init({ dsn: process.env.SENTRY_DSN });
  logger.info('Sentry initialized');
}

const collectDefaultMetrics = promClient.collectDefaultMetrics;
const register = promClient.register;
collectDefaultMetrics({ prefix: 'tiktokbr_' });
const overlayGauge = new promClient.Gauge({ name: 'tiktokbr_overlay_count', help: 'Number of connected overlay clients' });
const playerGauge  = new promClient.Gauge({ name: 'tiktokbr_player_count',  help: 'Number of alive players' });

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const API_KEY = process.env.API_KEY;
let DEV_TEST_MODE = process.env.DEV_TEST_MODE === 'true';
const PORT = process.env.PORT || 3000;

let currentStreamer = process.argv[2] || '';

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
    const { playerStatsFile } = getRoomPaths(room.roomId);
    if (!fs.existsSync(playerStatsFile)) return;
    const saved = JSON.parse(fs.readFileSync(playerStatsFile, 'utf8'));
    for (const id in saved) {
      const s = saved[id] || {};
      if (!room.players[id]) {
        room.players[id] = {
          uniqueId: id,
          nickname: s.nickname || id,
          hp:       s.maxHp   || CFG.BASE_HP,
          maxHp:    s.maxHp   || CFG.BASE_HP,
          strength: s.strength || CFG.BASE_STRENGTH,
          kills:    s.kills   || 0,
          killStreak: 0,
          lastKillTime: 0,
          alive:    false,
          lastActive: Date.now(),
          x: 0, y: 0, vx: 0, vy: 0,
          color: randomColor(),
          messageBoostExpires: 0,
          forceSpawn: false,
        };
      } else {
        const target = room.players[id];
        target.uniqueId   = target.uniqueId || id;
        target.nickname   = target.nickname || s.nickname || id;
        target.maxHp      = Math.max(target.maxHp    || CFG.BASE_HP,       s.maxHp    || CFG.BASE_HP);
        target.strength   = Math.max(target.strength || CFG.BASE_STRENGTH, s.strength || CFG.BASE_STRENGTH);
        target.kills      = s.kills || target.kills || 0;
        target.killStreak = target.killStreak || 0;
        target.lastKillTime = target.lastKillTime || 0;
      }
    }
    console.log(`📂 Loaded ${Object.keys(saved).length} saved player stats for room ${room.roomId}`);
  } catch (err) {
    console.error('Error loading player stats for room', room.roomId, err);
  }
}

function saveRoomPlayerStats(room) {
  try {
    const toSave = {};
    for (const id in room.players) {
      toSave[id] = {
        nickname: room.players[id].nickname,
        maxHp:    room.players[id].maxHp,
        strength: room.players[id].strength,
        kills:    room.players[id].kills,
      };
    }
    const { playerStatsFile } = getRoomPaths(room.roomId);
    fs.writeFileSync(playerStatsFile, JSON.stringify(toSave, null, 2));
  } catch (err) {
    console.error('Error saving player stats for room', room.roomId, err);
  }
}

function loadRoomBackground(room) {
  try {
    const { backgroundDir, backgroundMetaFile } = getRoomPaths(room.roomId);
    ensureDir(backgroundDir);
    if (fs.existsSync(backgroundMetaFile)) {
      room.currentBackground = JSON.parse(fs.readFileSync(backgroundMetaFile, 'utf8'));
      console.log(`📸 Loaded background for room ${room.roomId}: ${room.currentBackground.filename}`);
    }
  } catch (err) {
    console.error('Error loading background for room', room.roomId, err);
  }
}

function saveRoomBackgroundMeta(room, filename) {
  try {
    const { backgroundDir, backgroundMetaFile } = getRoomPaths(room.roomId);
    ensureDir(backgroundDir);
    room.currentBackground = { filename };
    fs.writeFileSync(backgroundMetaFile, JSON.stringify(room.currentBackground, null, 2));
  } catch (err) {
    console.error('Error saving background meta for room', room.roomId, err);
  }
}

function deleteRoomBackgroundFile(room) {
  if (!room.currentBackground?.filename) return;
  const { backgroundDir } = getRoomPaths(room.roomId);
  const oldPath = path.join(backgroundDir, room.currentBackground.filename);
  if (!isSafePath(backgroundDir, oldPath)) return;
  try {
    if (fs.existsSync(oldPath)) {
      fs.unlinkSync(oldPath);
      console.log('📸 Deleted old background for room', room.roomId, room.currentBackground.filename);
    }
  } catch (err) {
    console.warn('Could not delete old background for room', room.roomId, err.message);
  }
}

function loadRoomAudioConfig(room) {
  try {
    const { audioDir, audioConfigFile } = getRoomPaths(room.roomId);
    ensureDir(audioDir);
    const cfgFile = audioConfigFile;

    const repoCandidates = [
      path.join(__dirname, 'audio', 'audio-config.json'),
      path.join(__dirname, 'audio', 'audio', 'audio-config.json'),
    ];
    const repoConfig = repoCandidates.find(p => fs.existsSync(p));
    if (!fs.existsSync(cfgFile) && repoConfig) {
      fs.copyFileSync(repoConfig, cfgFile);
      console.log('🔊 Seeded room audio-config.json from repo for room', room.roomId);
    }

    if (fs.existsSync(cfgFile)) {
      const saved = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
      room.audioConfig = { ...DEFAULT_AUDIO_CONFIG, ...(saved.config || {}) };
      room.audioLibrary = Array.isArray(saved.library) ? saved.library : [];
      room.overlaySettings = { ...DEFAULT_OVERLAY_SETTINGS, ...(saved.settings || {}) };
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
    }

    console.log(`🔊 Loaded audio settings for room ${room.roomId} (${room.audioLibrary.length} files)`);
  } catch (err) {
    console.error('Error loading audio config for room', room.roomId, err);
  }
}

function saveRoomAudioConfig(room) {
  try {
    const { audioDir, audioConfigFile } = getRoomPaths(room.roomId);
    ensureDir(audioDir);
    fs.writeFileSync(audioConfigFile, JSON.stringify({ config: room.audioConfig, library: room.audioLibrary, settings: room.overlaySettings }, null, 2));
  } catch (err) {
    console.error('Error saving audio config for room', room.roomId, err);
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

const ALLOWED_BACKGROUND_EXTS  = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);
const ALLOWED_BACKGROUND_MIMES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, _file, cb) => {
      const bgDir = req?.room ? getRoomPaths(req.room.roomId).backgroundDir : path.join(__dirname, 'backgrounds');
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
      const audioDir = req?.room ? getRoomPaths(req.room.roomId).audioDir : path.join(__dirname, 'audio');
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

if (process.env.REDIS_URL) {
  (async () => {
    try {
      const pubClient = createRedisClient({ url: process.env.REDIS_URL });
      const subClient = pubClient.duplicate();
      await pubClient.connect();
      await subClient.connect();
      io.adapter(createAdapter(pubClient, subClient));
      logger.info({ redis: process.env.REDIS_URL }, 'Redis adapter connected for Socket.IO');
    } catch (err) {
      logger.error({ err }, 'Failed to initialize Redis adapter for Socket.IO');
    }
  })();
}

app.set('trust proxy', 1);
app.use(cookieParser());
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

app.use('/', authRoutes);
app.use('/admin', adminRoutes);
app.use('/', paypalRoutes);

app.get('/', (req, res) => {
  // If logged in with active trial/subscription, go to dashboard
  const token = req.cookies?.session_token;
  if (token) {
    const row = db.prepare('SELECT * FROM access_codes WHERE session_token = ?').get(token);
    if (row && !row.is_revoked) {
      // Check trial/subscription status
      if (row.trial_started) {
        const trialStart = new Date(row.trial_started);
        const trialEnd = new Date(trialStart.getTime() + (row.trial_days || 14) * 24 * 60 * 60 * 1000);
        const now = new Date();
        if (now > trialEnd && row.subscription_status !== 'active') {
          return res.redirect('/paywall');
        }
      }
      return res.redirect('/dashboard');
    }
  }
  // Not logged in, show landing page
  res.sendFile(path.join(__dirname, 'home.html'));
});
app.get('/home', (_req, res) => res.sendFile(path.join(__dirname, 'home.html')));
app.get('/signup', (_req, res) => res.sendFile(path.join(__dirname, 'signup.html')));
app.get('/paywall', (_req, res) => res.sendFile(path.join(__dirname, 'paywall.html')));
app.get('/login', (_req, res) => res.redirect('/home'));

// Auth endpoints for trial signup
app.post('/auth/generate-code', express.json(), (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });

  try {
    const code = Math.random().toString(36).slice(2, 10).toUpperCase();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');
    
    db.prepare(`
      INSERT INTO access_codes (code, email, expires_at, trial_started, trial_days, subscription_status)
      VALUES (?, ?, ?, CURRENT_TIMESTAMP, 14, 'active')
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
    db.prepare(`
      UPDATE access_codes
      SET session_token = ?, streamer_name = ?, tiktok_username = ?, room_id = ?
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

    // Set session cookie
    res.setHeader('Set-Cookie', `session_token=${sessionToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${90 * 24 * 60 * 60}`);
    res.json({ success: true, roomId });
  } catch (err) {
    console.error('Account creation error:', err);
    res.status(500).json({ error: 'Failed to create account' });
  }
});

app.get(['/overlay.html', '/overlay'], (req, res, next) => {

  if (req.query.room_id) {
    return res.sendFile(path.join(__dirname, 'overlay.html'));
  }
  return requireAccess(req, res, () => res.sendFile(path.join(__dirname, 'overlay.html')));
});
app.get('/admin-panel',  requireAccess, (_req, res) => res.redirect('/admin'));

function socketAuth(socket, next) {
  // Allow unauthenticated overlays to supply a room id via the socket auth payload
  // (client: io({ auth: { roomId } })) or query param (legacy).
  const authRoom = socket.handshake?.auth?.roomId || socket.handshake?.query?.room_id;
  if (authRoom) {
    socket.roomId = String(authRoom);
    return next();
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
  if (!token) return next(new Error('Unauthorized: no session token'));

  try {
    jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return next(new Error('Unauthorized: invalid token'));
  }

  const row = db.prepare('SELECT * FROM access_codes WHERE session_token = ?').get(token);
  if (!row || row.is_revoked || new Date(row.expires_at) < new Date()) {
    return next(new Error('Unauthorized: expired or revoked'));
  }
  if (!row.room_id) {
    return next(new Error('Unauthorized: room assignment missing'));
  }
  socket.accessCode = row;
  socket.roomId = row.room_id;
  next();
}

function requireRoom(req, res, next) {
  const token = req.cookies?.session_token;
  if (!token) return res.status(401).json({ success: false, error: 'Unauthorized' });

  const row = db.prepare('SELECT * FROM access_codes WHERE session_token = ?').get(token);
  if (!row || row.is_revoked || new Date(row.expires_at) < new Date()) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }
  if (!row.room_id) {
    return res.status(400).json({ success: false, error: 'No room assigned' });
  }

  req.roomId = row.room_id;
  req.room = getOrCreateRoom(row.room_id);
  loadRoomPlayerStats(req.room);
  loadRoomBackground(req.room);
  loadRoomAudioConfig(req.room);
  next();
}

io.use(socketAuth);

app.use((req, res, next) => {
  if (req.path === '/dashboard.html' || req.path === '/dashboard-login.html') {
    return res.redirect('/dashboard');
  }
  next();
});

app.use(express.static(__dirname));

app.get('/metrics', async (_req, res) => {
  try {
    res.setHeader('Content-Type', register.contentType);
    res.end(await register.metrics());
  } catch (err) {
    res.status(500).end(err.message);
  }
});

app.get('/audio/:filename', (req, res) => {
  const filename = path.basename(req.params.filename);
  const room = req.room || (req.query.room_id ? getOrCreateRoom(String(req.query.room_id)) : null);
  if (!room) return res.status(401).send('Unauthorized');
  const { audioDir } = getRoomPaths(room.roomId);
  const runtimePath = path.join(audioDir, filename);
  if (!isSafePath(audioDir, runtimePath)) return res.status(403).send('Forbidden');
  if (fs.existsSync(runtimePath)) return res.sendFile(runtimePath);
  return res.status(404).send('Audio file not found');
});

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
app.get('/dashboard/logout', (_req, res) => {
  res.setHeader('Set-Cookie', `${DASHBOARD_COOKIE_NAME}=; Path=/; HttpOnly; Max-Age=0; SameSite=Lax`);
  res.redirect('/login');
});

app.get('/logout', (_req, res) => {
  res.setHeader('Set-Cookie', 'session_token=; Path=/; HttpOnly; Max-Age=0; SameSite=Lax');
  res.redirect('/');
});

app.get('/dashboard', checkTrial, (_req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});

app.get('/dashboard/welcome', checkTrial, (_req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard-welcome.html'));
});

app.get('/stats', checkTrial, (_req, res) => res.sendFile(path.join(__dirname, 'stats.html')));

app.get('/state', (req, res) => {
  if (req.query.room_id) {
    const room = getOrCreateRoom(String(req.query.room_id));
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
  username:         req.room.streamerUsername || currentStreamer,
  connected:        !!(client && client.connected),
  overlayConnected: req.room.overlayCount > 0,
  overlayCount:     req.room.overlayCount,
  playerCount:      Object.values(req.room.players).filter(p => p.alive).length,
  background:       req.room.currentBackground,
  overlaySettings:  req.room.overlaySettings,
  devTestMode:      DEV_TEST_MODE,
}));

app.post('/api/dev/test-mode', (req, res) => {
  const { enabled } = req.body || {};
  if (typeof enabled !== 'boolean') return res.status(400).json({ success: false, error: 'Invalid enabled value' });
  DEV_TEST_MODE = enabled;
  emitEvent('devModeChanged', { enabled });
  res.json({ success: true, enabled: DEV_TEST_MODE });
});

app.post('/api/dev/sound', (req, res) => {
  const { type } = req.body || {};
  if (!['laser', 'heal', 'special'].includes(type)) return res.status(400).json({ success: false, error: 'Invalid sound type' });
  emitEvent('devSound', { type });
  res.json({ success: true });
});

app.post('/api/dev/sound-settings', (req, res) => {
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

app.post('/api/reset', (_req, res) => { disconnectStreamer(); res.json({ success: true }); });
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
    // Support public background fetches by room_id query param (for unauthenticated overlays)
    let room = null;
    if (req.query && req.query.room_id) {
      room = getOrCreateRoom(String(req.query.room_id));
    } else {
      // Fallback to existing requireRoom behavior using session_token cookie
      const token = req.cookies?.session_token;
      if (!token) return res.status(401).send('Unauthorized');
      const row = db.prepare('SELECT * FROM access_codes WHERE session_token = ?').get(token);
      if (!row || row.is_revoked || new Date(row.expires_at) < new Date()) return res.status(401).send('Unauthorized');
      if (!row.room_id) return res.status(400).send('No room assigned');
      room = getOrCreateRoom(row.room_id);
      loadRoomPlayerStats(room);
      loadRoomBackground(room);
      loadRoomAudioConfig(room);
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

app.get('/api/test/status', (_req, res) => res.json({ enabled: DEV_TEST_MODE }));

app.post('/api/test/spawn', requireDevTestMode, (_req, res) => {
  ensureTestPlayers();
  console.log('🧪 Test players spawned');
  res.json({ success: true });
});

app.post('/api/test/attack', requireDevTestMode, (_req, res) => {
  ensureTestPlayers();
  const room = getDefaultRoom();
  const result = handleMentionAttack(room, 'test_alpha', 'Alpha', '@test_bravo');
  emitRoomEvent(room, 'gameState', room.players);
  res.json({ success: true, result });
});

app.post('/api/test/gift', requireDevTestMode, (_req, res) => {
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

httpServer.listen(PORT, () => {
  logger.info('\n🎮 PvP Game Server running!');
  logger.info({ url: `http://localhost:${PORT}/overlay.html` }, 'Overlay URL');
  logger.info({ url: `http://localhost:${PORT}/dashboard` }, 'Dashboard URL');
  logger.info({ url: `http://localhost:${PORT}/stats` }, 'Stats URL');
  logger.info({ url: `http://localhost:${PORT}/state` }, 'State JSON URL');
  logger.info({ devTestMode: DEV_TEST_MODE }, 'Dev test mode');

  loadPlayerStats();
  loadCurrentBackground();
  loadAudioConfig();

  if (currentStreamer) connectToStreamer(currentStreamer);
});