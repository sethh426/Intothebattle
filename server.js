// server.js (corrected)
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
// Streak thresholds for killEvent / streakEvent (Item 13)
STREAK_LABELS: {
3:  { label: 'TRIPLE KILL',   color: '#FFD93D', scale: 1.2 },
5:  { label: 'RAMPAGE',       color: '#FF6B6B', scale: 1.4 },
10: { label: 'UNSTOPPABLE',   color: '#C77DFF', scale: 1.6 },
20: { label: 'GODLIKE',       color: '#FF9F43', scale: 2.0 },
},
// Gift tier thresholds (Item 6 / gift tier system)
GIFT_TIER_LEGENDARY: 1000,
GIFT_TIER_RARE:       100,
GIFT_TIER_UNCOMMON:    20,
// Critical hit threshold — damage fraction of remaining HP (Item 5)
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

// ─────────────────────────────────────────────────────────────────────────────
// CHANGE 1 — CENTRALIZED EVENT DISPATCHER (Item 10: Event Bus)
// All socket emissions now flow through emitEvent(). This replaces scattered
// io.emit() calls and is the foundation every future system plugs into.
// ─────────────────────────────────────────────────────────────────────────────
function emitEvent(type, payload = {}) {
try {
io.emit(type, { ...payload, _ts: Date.now() });
} catch (err) {
logger.error({ err, type }, 'emitEvent failed');
}
}

// ─────────────────────────────────────────────────────────────────────────────
// CHANGE 2 — GIFT TIER CLASSIFIER (feeds Items 5, 6, 20)
// Classifies diamond counts into tiers and selects the matching visual effect.
// ─────────────────────────────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────────────────────
// CHANGE 3 — ATTACK PAYLOAD BUILDER (Item 5: Combat Engine enrichment)
// Centralizes all attack metadata so every emitted attack is cinematic-ready.
// ─────────────────────────────────────────────────────────────────────────────
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
// Visual scaling data
intensity,          // 0–1: drives particle count, screen shake magnitude
critical,           // true when hit removed ≥60% of pre-damage HP
remainingHpPct,     // 0–1: lets overlay show near-death glow on target
// Overlay rendering settings — forwarded from current overlaySettings
shotSpeed:  overlaySettings.shotSpeed  || 1,
shotType:   overlaySettings.shotType   || 'beam',
laserColor: overlaySettings.laserColor || '#7afcff',
};
}

// ─────────────────────────────────────────────────────────────────────────────
// CHANGE 4 — ENRICHED SOUND EVENT (Item 20: Audio Engine)
// soundEvent now carries intensity and tier so the overlay can layer sounds.
// ─────────────────────────────────────────────────────────────────────────────
function emitSoundAndSync(event, { intensity = 0.5, tier = 'common' } = {}) {
emitEvent('soundEvent', { event, intensity, tier });
}

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
killStreak: 0,        // Item 13: streak tracking
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