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

const players = {};
const likeRateTracker = {};

const PLAYERS_FILE   = path.join(__dirname, 'players.json');
const BG_DIR         = path.join(__dirname, 'backgrounds');
const BG_FILE        = path.join(BG_DIR,    'current-bg.json');
const AUDIO_DIR      = path.join(__dirname, 'audio');
const AUDIO_CFG_FILE = path.join(AUDIO_DIR, 'audio-config.json');

const DEFAULT_AUDIO_CONFIG = {
  attack:  null,
  gift:    null,
  kill:    null,
  respawn: null,
  heal:    null,
  follow:  null,
};
const DEFAULT_OVERLAY_SETTINGS = {
  laserColor: '#7afcff',
  shotType:   'beam',
  shotSpeed:  1,
};
let audioConfig      = { ...DEFAULT_AUDIO_CONFIG };
let audioLibrary     = [];
let overlaySettings  = { ...DEFAULT_OVERLAY_SETTINGS };

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
function buildAttackPayload(base, targetPlayer) {
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
    shotSpeed:  overlaySettings.shotSpeed  || 1,
    shotType:   overlaySettings.shotType   || 'beam',
    laserColor: overlaySettings.laserColor || '#7afcff',
  };
}

// ────────────────────────────────
// SOUND ENRICHMENT
// ────────────────────────────────
function emitSoundAndSync(event, { intensity = 0.5, tier = 'common' } = {}) {
  emitEvent('soundEvent', { event, intensity, tier });
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

function loadPlayerStats() {
  try {
    if (!fs.existsSync(PLAYERS_FILE)) return;
    const saved = JSON.parse(fs.readFileSync(PLAYERS_FILE, 'utf8'));
    for (const id in saved) {
      const s = saved[id] || {};
      if (!players[id]) {
        players[id] = {
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
        players[id].uniqueId   = players[id].uniqueId || id;
        players[id].nickname   = players[id].nickname || s.nickname || id;
        players[id].maxHp      = Math.max(players[id].maxHp    || CFG.BASE_HP,       s.maxHp    || CFG.BASE_HP);
        players[id].strength   = Math.max(players[id].strength || CFG.BASE_STRENGTH, s.strength || CFG.BASE_STRENGTH);
        players[id].kills      = s.kills || players[id].kills || 0;
        players[id].killStreak = players[id].killStreak || 0;
        players[id].lastKillTime = players[id].lastKillTime || 0;
      }
    }
    console.log(`📂 Loaded ${Object.keys(saved).length} saved player stats`);
  } catch (err) {
    console.error('Error loading player stats:', err);
  }
}

function savePlayerStats() {
  try {
    const toSave = {};
    for (const id in players) {
      toSave[id] = {
        nickname:  players[id].nickname,
        maxHp:     players[id].maxHp,
        strength:  players[id].strength,
        kills:     players[id].kills,
      };
    }
    fs.writeFileSync(PLAYERS_FILE, JSON.stringify(toSave, null, 2));
  } catch (err) {
    console.error('Error saving player stats:', err);
  }
}

let currentBackground = null;

function loadCurrentBackground() {
  try {
    ensureDir(BG_DIR);
    if (fs.existsSync(BG_FILE)) {
      currentBackground = JSON.parse(fs.readFileSync(BG_FILE, 'utf8'));
      console.log(`📸 Loaded background: ${currentBackground.filename}`);
    }
  } catch (err) {
    console.error('Error loading background:', err);
  }
}

function saveBackgroundMeta(filename) {
  try {
    ensureDir(BG_DIR);
    currentBackground = { filename };
    fs.writeFileSync(BG_FILE, JSON.stringify(currentBackground, null, 2));
  } catch (err) {
    console.error('Error saving background meta:', err);
  }
}

function deleteCurrentBackgroundFile() {
  if (!currentBackground?.filename) return;
  const oldPath = path.join(BG_DIR, currentBackground.filename);
  if (!isSafePath(BG_DIR, oldPath)) return;
  try {
    if (fs.existsSync(oldPath)) {
      fs.unlinkSync(oldPath);
      console.log('📸 Deleted old background:', currentBackground.filename);
    }
  } catch (err) {
    console.warn('Could not delete old background:', err.message);
  }
}

function loadAudioConfig() {
  try {
    ensureDir(AUDIO_DIR);

    if (!fs.existsSync(AUDIO_CFG_FILE)) {
      const repoConfigCandidates = [
        path.join(__dirname, 'audio', 'audio-config.json'),
        path.join(__dirname, 'audio', 'audio', 'audio-config.json')
      ];
      const repoConfig = repoConfigCandidates.find(p => fs.existsSync(p));
      if (repoConfig) {
        fs.copyFileSync(repoConfig, AUDIO_CFG_FILE);
        console.log('🔊 Seeded audio-config.json from repo');
      }
    }

    if (fs.existsSync(AUDIO_CFG_FILE)) {
      const saved  = JSON.parse(fs.readFileSync(AUDIO_CFG_FILE, 'utf8'));
      audioConfig  = { ...DEFAULT_AUDIO_CONFIG, ...(saved.config  || {}) };
      audioLibrary = Array.isArray(saved.library) ? saved.library : [];
      overlaySettings = { ...DEFAULT_OVERLAY_SETTINGS, ...(saved.settings || {}) };

      const repoFiles = fs.existsSync(AUDIO_DIR)
        ? fs.readdirSync(AUDIO_DIR).filter(file => {
            const ext = path.extname(file).toLowerCase();
            return ['.mp3', '.m4a', '.wav', '.ogg', '.aac', '.flac', '.webm'].includes(ext);
          })
        : [];

      if (!audioLibrary.length) {
        audioLibrary = repoFiles.map(filename => {
          const filePath = path.join(AUDIO_DIR, filename);
          return {
            filename,
            originalName: filename,
            size: fs.existsSync(filePath) ? fs.statSync(filePath).size : 0,
            uploadedAt: new Date().toISOString(),
          };
        });
      } else {
        const knownFilenames = new Set(audioLibrary.map(entry => entry.filename));
        repoFiles.forEach(filename => {
          if (filename === path.basename(AUDIO_CFG_FILE)) return;
          if (!knownFilenames.has(filename)) {
            const filePath = path.join(AUDIO_DIR, filename);
            const size = fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
            audioLibrary.push({
              filename,
              originalName: filename,
              size,
              uploadedAt: new Date().toISOString(),
            });
          }
        });
      }

      audioLibrary = audioLibrary.filter(entry => {
        const runtimePath = path.join(AUDIO_DIR, entry.filename);
        const repoPath    = path.join(__dirname, 'audio', entry.filename);
        return isSafePath(AUDIO_DIR, runtimePath) &&
          (fs.existsSync(runtimePath) || fs.existsSync(repoPath));
      });

      audioLibrary.sort((a, b) => a.originalName.localeCompare(b.originalName, undefined, { numeric: true, sensitivity: 'base' }));

      const allUnassigned = Object.values(audioConfig).every(val => !val);
      if (allUnassigned && audioLibrary.length) {
        const eventOrder = ['attack', 'gift', 'kill', 'respawn', 'heal', 'follow'];
        eventOrder.forEach((event, idx) => {
          if (idx < audioLibrary.length) audioConfig[event] = audioLibrary[idx].filename;
        });
      }

      console.log(`🔊 Loaded audio config (${audioLibrary.length} files)`);
    }
  } catch (err) {
    console.error('Error loading audio config:', err);
  }
}

function saveAudioConfig() {
  try {
    ensureDir(AUDIO_DIR);
    fs.writeFileSync(AUDIO_CFG_FILE, JSON.stringify(
      { config: audioConfig, library: audioLibrary, settings: overlaySettings }, null, 2
    ));
  } catch (err) {
    console.error('Error saving audio config:', err);
  }
}

const ALLOWED_BACKGROUND_EXTS  = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);
const ALLOWED_BACKGROUND_MIMES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => { ensureDir(BG_DIR); cb(null, BG_DIR); },
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
    destination: (_req, _file, cb) => { ensureDir(AUDIO_DIR); cb(null, AUDIO_DIR); },
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

function spawnPlayer(uniqueId, nickname) {
  if (!uniqueId) return;
  if (players[uniqueId]?.alive) {
    players[uniqueId].lastActive = Date.now();
    if (nickname) players[uniqueId].nickname = nickname;
    return;
  }
  const ex = players[uniqueId];
  players[uniqueId] = {
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
  console.log(`⚔️  Spawned: @${uniqueId} (HP: ${players[uniqueId].hp}, STR: ${players[uniqueId].strength}, Kills: ${players[uniqueId].kills})`);
}

function awardStats(uniqueId, nickname, hpBoost = 0, strBoost = 0) {
  if (!uniqueId) return;
  if (!players[uniqueId]?.alive) spawnPlayer(uniqueId, nickname);
  const p = players[uniqueId];
  if (!p?.alive) return;
  if (hpBoost > 0) {
    p.maxHp += Math.floor(hpBoost * 0.5);
    p.hp     = Math.min(p.maxHp, p.hp + hpBoost);
    emitEvent('heal', { uniqueId, amount: hpBoost });
  }
  p.strength  += strBoost;
  p.lastActive = Date.now();
}

// ────────────────────────────────
// DEAL DAMAGE (enriched)
// ────────────────────────────────
function dealDamage(attackerId, targetId, multiplier = 1) {
  const attacker = players[attackerId];
  const target   = players[targetId];

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

    emitEvent('killEvent', {
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
      emitEvent('streakEvent', {
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

    emitEvent('soundEvent', { event: 'kill', intensity: Math.min(multiplier / 8, 1), tier: multiplier >= 5 ? 'rare' : 'common' });

    setTimeout(() => {
      spawnPlayer(targetId, target.nickname);
      emitEvent('respawn', {
        uniqueId:      targetId,
        nickname:      target.nickname,
        hp:            players[targetId]?.hp,
        maxHp:         players[targetId]?.maxHp,
        color:         players[targetId]?.color,
        respawnEffect: 'beam_down',
        delayMs:       CFG.RESPAWN_DELAY_MS,
      });
      emitEvent('soundEvent', { event: 'respawn', intensity: 0.5, tier: 'common' });
      emitEvent('gameState', players);
    }, CFG.RESPAWN_DELAY_MS);
  }

  console.log(`⚡ @${attackerId} → @${targetId} for ${dmg} dmg${killed ? ' (KILL!)' : ''}${multiplier > 1 ? ' (SPECIAL!)' : ''}`);

  const baseResult = { attacker: attackerId, target: targetId, damage: dmg, killed, special: multiplier > 1 };
  return buildAttackPayload(baseResult, { ...target, hp: preDamageHp });
}

function normalizeName(value = '') {
  return String(value).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function findTarget(mention) {
  const lower = String(mention || '').toLowerCase();
  const norm  = normalizeName(mention);
  return Object.values(players).find(p =>
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
function handleMentionAttack(attackerId, attackerNick, comment) {
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
  if (!players[attackerId]?.alive) {
    spawnPlayer(attackerId, attackerNick);
    if (players[attackerId]) players[attackerId].forceSpawn = true;
  }
  if (players[attackerId]) {
    players[attackerId].lastActive = Date.now();
    players[attackerId].forceSpawn = true;
  }

  const attacker    = players[attackerId];
  const boostActive = attacker && attacker.messageBoostExpires > Date.now();

  let multiplier = commandMultiplier;
  if (boostActive) multiplier *= CFG.GIFT_MESSAGE_BOOST_MULTIPLIER;

  for (const mention of mentions) {
    const target = findTarget(mention);
    if (!target) {
      console.log(`⚠️ Mention target not found: @${mention} from comment: ${comment}`);
      continue;
    }
    if (target.uniqueId === attackerId) {
      console.log(`⚠️ Ignored self-attack from @${attackerId}`);
      continue;
    }
    if (!players[target.uniqueId]?.alive) {
      spawnPlayer(target.uniqueId, target.nickname);
      if (players[target.uniqueId]) players[target.uniqueId].forceSpawn = true;
    }

    const result = dealDamage(attackerId, target.uniqueId, multiplier);
    if (result) {
      result.effect = requestedEffect;                // force the chosen effect
      result.special            = isSpecialCommand;
      result.commandDescription = commandDescription || requestedEffect;
      result.giftBoosted        = boostActive;

      emitAttackAndSync(result);
      emitSoundAndSync(
        isSpecialCommand ? 'gift' : 'attack',
        { intensity: result.intensity, tier: isSpecialCommand ? 'rare' : 'common' }
      );
      emitEvent('commentDamage', {
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

function emitAttackAndSync(result) {
  if (!result) return;
  if (!players[result.attacker] || !players[result.target]) {
    logger.warn({ attacker: result.attacker, target: result.target }, 'Emitting attack for player(s) not present in state');
  }
  emitEvent('attack', result);
  setTimeout(() => emitEvent('gameState', players), 40);
}

function emitGiftAttackAndSync(result) {
  emitEvent('giftAttack', result);
  setTimeout(() => emitEvent('gameState', players), 40);
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

app.get('/', (_req, res) => res.redirect('/login'));
app.get('/overlay.html', requireAccess, (_req, res) => res.sendFile(path.join(__dirname, 'overlay.html')));
app.get('/overlay',      requireAccess, (_req, res) => res.sendFile(path.join(__dirname, 'overlay.html')));
app.get('/admin-panel',  requireAccess, (_req, res) => res.redirect('/admin'));

function socketAuth(socket, next) {
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
  socket.accessCode = row;
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

app.use('/audio', (req, res, next) => {
  const filename    = path.basename(req.path);
  const runtimePath = path.join(AUDIO_DIR, filename);
  const repoPath    = path.join(__dirname, 'audio', filename);
  if (!isSafePath(AUDIO_DIR, runtimePath)) return res.status(403).send('Forbidden');
  if (fs.existsSync(runtimePath)) return res.sendFile(runtimePath);
  if (fs.existsSync(repoPath))    return res.sendFile(repoPath);
  next();
}, express.static(AUDIO_DIR));

let overlayCount = 0;

io.on('connection', (socket) => {
  socket.emit('serverReady', {
    socketId: socket.id,
    overlayCount,
    overlaySettings,
    laserColor: overlaySettings.laserColor,
    gameStateCount: Object.values(players).filter(p => p.alive).length,
  });

  socket.on('register', ({ type } = {}) => {
    const clientType = String(type || 'unknown').toLowerCase();
    socket.data.clientType = clientType;

    if (clientType === 'overlay') {
      socket.join('overlays');
      overlayCount++;
      emitEvent('overlayCount', { count: overlayCount });
      try { overlayGauge.set(overlayCount); } catch (_) {}

      socket.emit('gameState',        players);
      socket.emit('audioConfig',      audioConfig);
      socket.emit('overlaySettings',  overlaySettings);
      socket.emit('laserColor',       overlaySettings.laserColor);
      if (currentBackground) {
        socket.emit('backgroundChanged', { filename: currentBackground.filename });
      }
    } else if (clientType === 'dashboard' || clientType === 'stats') {
      socket.join(clientType);
      socket.emit('overlayCount',    { count: overlayCount });
      socket.emit('overlaySettings', overlaySettings);
      socket.emit('laserColor',      overlaySettings.laserColor);
      socket.emit('gameState',       players);
    }
  });

  socket.on('disconnect', () => {
    if (socket.data.clientType === 'overlay') {
      overlayCount = Math.max(0, overlayCount - 1);
      emitEvent('overlayCount', { count: overlayCount });
      try { overlayGauge.set(overlayCount); } catch (_) {}
    }
  });

  socket.on('layoutUpdate', (settings) => {
    emitEvent('layoutUpdate', settings);
  });
});

// ────────────────────────────────
// DASHBOARD & ASSET ROUTES (unchanged)
// ────────────────────────────────
app.get('/dashboard/logout', (_req, res) => {
  res.setHeader('Set-Cookie', `${DASHBOARD_COOKIE_NAME}=; Path=/; HttpOnly; Max-Age=0; SameSite=Lax`);
  res.redirect('/login');
});

app.get('/dashboard', (req, res) => {
  if (isDashboardAuthed(req)) return res.sendFile(path.join(__dirname, 'dashboard.html'));
  const token = req.cookies.session_token;
  if (token) {
    const row = db.prepare('SELECT * FROM access_codes WHERE session_token = ?').get(token);
    if (row && !row.is_revoked && new Date(row.expires_at) > new Date()) {
      return res.sendFile(path.join(__dirname, 'dashboard.html'));
    }
  }
  res.redirect('/login');
});

app.get('/dashboard/welcome', (req, res) => {
  if (isDashboardAuthed(req)) return res.sendFile(path.join(__dirname, 'dashboard-welcome.html'));
  const token = req.cookies.session_token;
  if (token) {
    const row = db.prepare('SELECT * FROM access_codes WHERE session_token = ?').get(token);
    if (row && !row.is_revoked && new Date(row.expires_at) > new Date()) {
      return res.sendFile(path.join(__dirname, 'dashboard-welcome.html'));
    }
  }
  res.redirect('/login');
});

app.get('/stats', (_req, res) => res.sendFile(path.join(__dirname, 'stats.html')));
app.get('/state', (_req, res) => res.json(players));

app.get('/api/status', (_req, res) => res.json({
  username:         currentStreamer,
  connected:        !!(client && client.connected),
  overlayConnected: overlayCount > 0,
  overlayCount,
  playerCount:      Object.values(players).filter(p => p.alive).length,
  background:       currentBackground,
  overlaySettings,
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

app.post('/api/dev/laser-color', (req, res) => {
  const { color } = req.body || {};
  if (typeof color !== 'string' || !color.trim()) return res.status(400).json({ success: false, error: 'Invalid color' });
  overlaySettings.laserColor = color.trim();
  saveAudioConfig();
  emitEvent('overlaySettings', overlaySettings);
  emitEvent('laserColor', { color: overlaySettings.laserColor });
  res.json({ success: true, color: overlaySettings.laserColor });
});

app.post('/api/dev/overlay-settings', (req, res) => {
  const { shotType, shotSpeed, color } = req.body || {};
  const validTypes = ['beam', 'pulse', 'wave', 'burst', 'ripple'];
  if (typeof shotType === 'string' && shotType) {
    if (!validTypes.includes(shotType)) return res.status(400).json({ success: false, error: `Invalid shot type. Must be one of: ${validTypes.join(', ')}` });
    overlaySettings.shotType = shotType;
  }
  if (typeof shotSpeed === 'number' && shotSpeed > 0 && shotSpeed <= 3) {
    overlaySettings.shotSpeed = shotSpeed;
  }
  if (typeof color === 'string' && color.trim()) {
    overlaySettings.laserColor = color.trim();
  }
  saveAudioConfig();
  emitEvent('overlaySettings', overlaySettings);
  res.json({ success: true, settings: overlaySettings });
});

app.post('/api/connect', (req, res) => {
  const { username } = req.body;
  if (!username) return res.json({ success: false, error: 'Username required' });
  if (!API_KEY)  return res.status(500).json({ success: false, error: 'Missing TikTok API_KEY in .env' });
  connectToStreamer(username);
  res.json({ success: true });
});

app.post('/api/reset',          (_req, res) => { disconnectStreamer(); res.json({ success: true }); });
app.post('/api/overlay/reload', (_req, res) => {
  emitEvent('forceReload', { v: Date.now(), delayMs: 3000, reason: 'Operator reload' });
  res.json({ success: true });
});

app.post('/api/players/clear', (_req, res) => {
  for (const id in players) { players[id].alive = false; players[id].forceSpawn = false; }
  emitEvent('gameState', players);
  res.json({ success: true });
});

app.post('/api/background/upload', (req, res) => {
  res.type('application/json');
  ensureDir(BG_DIR);
  upload.single('background')(req, res, (err) => {
    try {
      if (err)       return res.status(400).json({ success: false, error: err.message || 'Background upload failed' });
      if (!req.file) return res.status(400).json({ success: false, error: 'No background image was uploaded.' });
      deleteCurrentBackgroundFile();
      saveBackgroundMeta(req.file.filename);
      emitEvent('backgroundChanged', { filename: req.file.filename });
      console.log(`📸 Background uploaded: ${req.file.filename}`);
      return res.json({ success: true, filename: req.file.filename, url: `/background/${req.file.filename}` });
    } catch (uploadErr) {
      console.error('Background upload error:', uploadErr);
      return res.status(500).json({ success: false, error: uploadErr.message || 'Server error during background upload' });
    }
  });
});

app.post('/api/background/clear', (_req, res) => {
  try {
    deleteCurrentBackgroundFile();
    currentBackground = null;
    try { if (fs.existsSync(BG_FILE)) fs.unlinkSync(BG_FILE); } catch (_e) {}
    emitEvent('backgroundChanged', { filename: null });
    console.log('📸 Background cleared');
    res.json({ success: true });
  } catch (err) {
    console.error('Background clear error:', err);
    res.json({ success: false, error: err.message });
  }
});

app.get('/background/:filename', (req, res) => {
  const filepath = path.join(BG_DIR, req.params.filename);
  if (!isSafePath(BG_DIR, filepath)) return res.status(403).send('Forbidden');
  if (!fs.existsSync(filepath))      return res.status(404).send('Background not found');
  return res.sendFile(filepath);
});

app.get('/api/audio', (_req, res) => {
  res.json({ success: true, library: audioLibrary, config: audioConfig, settings: overlaySettings });
});

app.post('/api/audio/upload', (req, res) => {
  res.type('application/json');
  ensureDir(AUDIO_DIR);
  audioUpload.single('audio')(req, res, (err) => {
    if (err)       return res.status(400).json({ success: false, error: err.message });
    if (!req.file) return res.status(400).json({ success: false, error: 'No audio file uploaded.' });
    const entry = {
      filename:     req.file.filename,
      originalName: req.file.originalname,
      size:         req.file.size,
      uploadedAt:   new Date().toISOString(),
    };
    audioLibrary.push(entry);
    saveAudioConfig();
    console.log(`🔊 Audio uploaded: ${req.file.originalname} → ${req.file.filename}`);
    res.json({ success: true, file: entry });
  });
});

app.post('/api/audio/assign', (req, res) => {
  const { event, filename } = req.body;
  const validEvents = Object.keys(DEFAULT_AUDIO_CONFIG);
  if (!validEvents.includes(event)) {
    return res.status(400).json({ success: false, error: `Invalid event. Must be one of: ${validEvents.join(', ')}` });
  }
  if (filename === null || filename === '') {
    audioConfig[event] = null;
    saveAudioConfig();
    emitEvent('audioConfig', audioConfig);
    return res.json({ success: true, event, filename: null });
  }
  if (!audioLibrary.some(f => f.filename === filename)) {
    return res.status(404).json({ success: false, error: 'File not found in audio library.' });
  }
  audioConfig[event] = filename;
  saveAudioConfig();
  emitEvent('audioConfig', audioConfig);
  console.log(`🔊 Assigned "${filename}" to event "${event}"`);
  res.json({ success: true, event, filename });
});

app.delete('/api/audio/delete/:filename', (req, res) => {
  const { filename } = req.params;
  const filepath     = path.join(AUDIO_DIR, filename);
  if (!isSafePath(AUDIO_DIR, filepath)) return res.status(403).json({ success: false, error: 'Forbidden' });
  const before = audioLibrary.length;
  audioLibrary = audioLibrary.filter(f => f.filename !== filename);
  if (audioLibrary.length === before) return res.status(404).json({ success: false, error: 'File not found in library.' });
  let changed = false;
  for (const ev of Object.keys(audioConfig)) {
    if (audioConfig[ev] === filename) { audioConfig[ev] = null; changed = true; }
  }
  try { if (fs.existsSync(filepath)) fs.unlinkSync(filepath); } catch (_e) {}
  saveAudioConfig();
  if (changed) emitEvent('audioConfig', audioConfig);
  console.log(`🗑️ Deleted audio: ${filename}`);
  res.json({ success: true, filename, configUpdated: changed });
});

function requireDevTestMode(_req, res, next) {
  if (!DEV_TEST_MODE) return res.status(403).json({ success: false, error: 'Developer test mode is disabled' });
  next();
}

function ensureTestPlayers() {
  const testPlayers = [
    { id: 'test_alpha',   nick: 'Alpha'   },
    { id: 'test_bravo',   nick: 'Bravo'   },
    { id: 'test_charlie', nick: 'Charlie' },
    { id: 'test_delta',   nick: 'Delta'   },
    { id: 'test_echo',    nick: 'Echo'    },
  ];
  testPlayers.forEach((item, index) => {
    players[item.id] = {
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
  emitEvent('gameState', players);
}

app.get('/api/test/status', (_req, res) => res.json({ enabled: DEV_TEST_MODE }));

app.post('/api/test/spawn', requireDevTestMode, (_req, res) => {
  ensureTestPlayers();
  console.log('🧪 Test players spawned');
  res.json({ success: true });
});

app.post('/api/test/attack', requireDevTestMode, (_req, res) => {
  ensureTestPlayers();
  const result = handleMentionAttack('test_alpha', 'Alpha', '@test_bravo');
  emitEvent('gameState', players);
  res.json({ success: true, result });
});

app.post('/api/test/gift', requireDevTestMode, (_req, res) => {
  ensureTestPlayers();
  const attackerId  = 'test_charlie';
  const diamonds    = 25;
  const targets     = ['test_alpha', 'test_bravo', 'test_delta'];
  const attacksMade = [];

  awardStats(attackerId, players[attackerId].nickname,
    diamonds * CFG.GIFT_HP_PER_DIAMOND,
    diamonds * CFG.GIFT_STR_PER_DIAMOND
  );
  if (players[attackerId]) {
    players[attackerId].messageBoostExpires = Date.now() + CFG.GIFT_MESSAGE_BOOST_DURATION_MS;
  }
  emitEvent('gameState', players);

  // Determine gift effect based on diamond amount (new rule)
  const giftEffect = diamonds > 100 ? 'fire' : 'laser';  // meteor or laser

  targets.forEach(targetId => {
    const target = players[targetId];
    if (!target?.alive) return;
    const damage = diamonds;
    target.hp    = Math.max(0, target.hp - damage);
    let killed   = false;
    if (target.hp === 0) {
      killed = true; target.alive = false; players[attackerId].kills++;
      setTimeout(() => {
        spawnPlayer(target.uniqueId, target.nickname);
        emitEvent('respawn', { uniqueId: target.uniqueId, respawnEffect: 'beam_down' });
        emitEvent('gameState', players);
      }, CFG.RESPAWN_DELAY_MS);
    }
    const giftAttack = {
      attacker: attackerId, target: targetId, damage, killed, diamonds,
      effect: giftEffect,              // server-controlled effect (laser/meteor)
      intensity: diamonds > 100 ? 1.0 : 0.7,
      giftColor: diamonds > 100 ? '#FF4500' : '#7afcff',
    };
    attacksMade.push(giftAttack);
    emitGiftAttackAndSync(giftAttack);
    emitSoundAndSync(killed ? 'kill' : 'gift', { intensity: giftAttack.intensity, tier: diamonds > 100 ? 'legendary' : 'common' });
  });

  // Celebration banner still uses original tier classification
  const giftMeta = classifyGift(diamonds);
  emitEvent('giftEffect', { attacker: attackerId, giftName: 'Test Gift', diamonds, ...giftMeta });
  setTimeout(() => {
    emitEvent('giftCelebration', {
      attacker: attackerId, nickname: players[attackerId]?.nickname || 'Charlie',
      giftName: 'Test Gift', diamonds, ...giftMeta,
    });
  }, 800);

  emitEvent('gameState', players);
  console.log('🧪 Test gift attack sent');
  res.json({ success: true, attacks: attacksMade });
});

// ... (other test endpoints unchanged, they can remain as is)

// ────────────────────────────────
// TIKTOK EVENT HANDLING
// ────────────────────────────────
function setupTikTokEvents(tiktokClient) {
  tiktokClient.on('connected', () => {
    console.log(`✅ Connected to @${currentStreamer}'s LIVE stream\n`);
  });

  tiktokClient.on('member', (e) => {
    const id   = e.user?.uniqueId;
    const nick = e.user?.nickname || id;
    if (!id) return;
    spawnPlayer(id, nick);
    if (players[id]) players[id].alive = true;
    emitEvent('gameState', players);
    emitEvent('spawn', { uniqueId: id });
  });

  tiktokClient.on('chat', (e) => {
    const { id, nickname } = resolveTikTokUser(e);
    const comment = String(e.comment || e.message || '').trim();
    if (!id) return;

    awardStats(id, nickname, 0, CFG.CHAT_STRENGTH_BOOST);

    const iconMatch = comment.match(/^\s*(?:!emoji|\/emoji|emoji)\s+(.+)/i);
    if (iconMatch) {
      const requestedIcon = String(iconMatch[1]).trim().split(/\s+/)[0];
      const topPlayers = getTopPlayers(5).map(p => p.uniqueId);
      if (topPlayers.includes(id)) {
        if (!players[id]) spawnPlayer(id, nickname);
        if (players[id]) {
          players[id].iconEmoji  = requestedIcon || players[id].iconEmoji || '💎';
          players[id].lastActive = Date.now();
          emitEvent('gameState', players);
          console.log(`🎭 @${nickname} updated icon emoji to ${players[id].iconEmoji}`);
        }
      } else {
        console.log(`⚠️ @${nickname} is not in the top 5 and cannot change icon emoji`);
      }
      return;
    }

    if (/\bspawn\b/i.test(comment)) {
      if (!players[id]?.alive) {
        spawnPlayer(id, nickname);
        console.log(`🟢 @${nickname} spawned via chat command`);
      }
      if (players[id]) players[id].forceSpawn = true;
    }

    const attackResult = handleMentionAttack(id, nickname, comment);
    if (!attackResult.handled && attackResult.reason !== 'No @mention found') {
      console.log(`⚠️ Chat attack not handled: ${attackResult.reason}`);
    }

    emitEvent('gameState', players);
  });

  tiktokClient.on('gift', (e) => {
    const { id, nickname } = resolveTikTokUser(e);
    const diamonds = (e.diamondCount || e.amount || 1) * (e.repeatCount || 1);
    if (!id) return;

    const alivePlayers  = Object.values(players).filter(p => p.alive);
    const boardHasSpace = alivePlayers.length < 20;

    if (!players[id]) spawnPlayer(id, nickname);
    else if (!players[id].alive && boardHasSpace) spawnPlayer(id, nickname);

    if (players[id]) {
      players[id].forceSpawn = true;
      players[id].lastActive = Date.now();
    }

    awardStats(id, nickname, diamonds * CFG.GIFT_HP_PER_DIAMOND, diamonds * CFG.GIFT_STR_PER_DIAMOND);
    if (players[id]) players[id].messageBoostExpires = Date.now() + CFG.GIFT_MESSAGE_BOOST_DURATION_MS;

    emitEvent('gameState', players);

    // --- Gift attack effect rules ---
    // Big gifts (>100 diamonds) → meteor (fire), otherwise → laser
    const giftEffect = diamonds > 100 ? 'fire' : 'laser';
    const giftIntensity = diamonds > 100 ? 1.0 : Math.min(diamonds / 100, 0.8);

    const aliveTargets = Object.values(players).filter(p => p.alive && p.uniqueId !== id);

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
          players[id].kills++;
          console.log(`💀 @${target.uniqueId} defeated by gift attack from @${id}!`);
          setTimeout(() => {
            spawnPlayer(target.uniqueId, target.nickname);
            emitEvent('respawn', {
              uniqueId: target.uniqueId,
              nickname: target.nickname,
              respawnEffect: 'beam_down',
            });
            emitSoundAndSync('respawn', { intensity: 0.5, tier: 'common' });
            emitEvent('gameState', players);
          }, CFG.RESPAWN_DELAY_MS);
        }

        emitGiftAttackAndSync({
          attacker: id, target: target.uniqueId, damage, killed, diamonds,
          effect:    giftEffect,      // laser or meteor (fire)
          intensity: giftIntensity,
          giftColor: diamonds > 100 ? '#FF4500' : '#7afcff',
        });
        emitSoundAndSync(killed ? 'kill' : 'gift', { intensity: giftIntensity, tier: diamonds > 100 ? 'legendary' : 'common' });
        console.log(`🎁 @${id} → @${target.uniqueId} via gift for ${damage} dmg${killed ? ' (KILL!)' : ''}`);
      });
    }

    // Celebration still uses original tier classification for banners
    const giftMeta = classifyGift(diamonds);
    emitEvent('giftEffect', { attacker: id, giftName: e.giftName, diamonds, ...giftMeta });

    setTimeout(() => {
      emitEvent('giftCelebration', {
        attacker: id,
        nickname,
        giftName:  e.giftName,
        diamonds,
        ...giftMeta,
      });
    }, 800);

    emitEvent('gameState', players);
    console.log(`🎁 @${id} sent ${e.giftName} (${diamonds} 💎) [${giftMeta.tier}]`);
  });

  tiktokClient.on('like', (e) => {
    const { id, nickname } = resolveTikTokUser(e);
    if (!id) return;
    if (!players[id]) spawnPlayer(id, nickname);
    awardStats(id, nickname, CFG.LIKE_HP_BOOST, 0);

    if (!likeRateTracker[id]) {
      likeRateTracker[id] = { likes: [], window: 90000 };
    }
    const now = Date.now();
    likeRateTracker[id].likes.push(now);
    likeRateTracker[id].likes = likeRateTracker[id].likes.filter(t => now - t < likeRateTracker[id].window);

    const likeCount  = likeRateTracker[id].likes.length;
    let heartCount   = 1;
    if (likeCount >= 500) heartCount = 3;
    else if (likeCount >= 100) heartCount = 2;

    emitSoundAndSync('heal', { intensity: Math.min(likeCount / 500, 1), tier: 'common' });
    emitEvent('like', {
      uniqueId: id,
      nickname,
      hearts:    heartCount,
      rate:      likeCount,
      intensity: Math.min(likeCount / 500, 1),
      color:     players[id]?.color || '#FF6B6B',
    });
    emitEvent('gameState', players);
  });

  tiktokClient.on('social', (e) => {
    const { id, nickname } = resolveTikTokUser(e);
    if (!id) return;
    if (!players[id]) spawnPlayer(id, nickname);
    awardStats(id, nickname, 0, CFG.SOCIAL_STRENGTH_BOOST);
    emitEvent('gameState', players);
  });

  tiktokClient.on('follow', (e) => {
    const id   = e.user?.uniqueId;
    const nick = e.user?.nickname || id;
    if (!id) return;
    console.log(`❤️  @${nick} followed!`);
    emitSoundAndSync('follow', { intensity: 0.6, tier: 'common' });
    emitEvent('follow', { uniqueId: id, nickname: nick, color: players[id]?.color });
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

function connectToStreamer(username) {
  safeDisconnectClient();
  currentStreamer = username;
  client = new TikTokLive({ uniqueId: currentStreamer, apiKey: API_KEY });
  setupTikTokEvents(client);
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

function getTopPlayers(count = 20) {
  return Object.values(players)
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
  for (const id of Object.keys(players)) {
    if (players[id].lastActive < cutoff) {
      delete players[id];
      logger.info({ player: id }, 'Removed idle player due to inactivity');
    }
  }
  emitEvent('gameState', players);
}, 60_000);

let saveCounter = 0;

function tick() {
  for (const id in players) {
    const p = players[id];
    if (!p.alive) continue;
    p.x += p.vx;
    p.y += p.vy;
    if (p.x < 20 || p.x > 980)  p.vx *= -1;
    if (p.y < 20 || p.y > 1800) p.vy *= -1;
    p.x = Math.max(20, Math.min(980,  p.x));
    p.y = Math.max(20, Math.min(1800, p.y));
  }
  emitEvent('gameState', players);
  try { playerGauge.set(Object.values(players).filter(p => p.alive).length); } catch (_) {}
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