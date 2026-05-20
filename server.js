import { TikTokLive } from '@tiktool/live';
import express from 'express';
import cookieParser from 'cookie-parser';
import { createServer } from 'http';
import { Server } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import fs from 'fs';
import multer from 'multer';
import authRoutes from './tiktokbr/routes/auth.js';
import adminRoutes from './tiktokbr/routes/admin.js';
import paypalRoutes from './tiktokbr/routes/paypal.js';
import requireAccess from './tiktokbr/middleware/auth.js';
import db from './tiktokbr/db/db.js';
import jwt from 'jsonwebtoken';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── CONFIG ───────────────────────────────────────────────────────────────────
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
};

// ─── GAME STATE ───────────────────────────────────────────────────────────────
const players = {};

// ─── DIRECTORIES & PATHS ─────────────────────────────────────────────────────
const PLAYERS_FILE   = path.join(__dirname, 'players.json');
const BG_DIR         = path.join(__dirname, 'backgrounds');
const BG_FILE        = path.join(BG_DIR,    'current-bg.json');
const AUDIO_DIR      = path.join(__dirname, 'audio');
const AUDIO_CFG_FILE = path.join(AUDIO_DIR, 'audio-config.json');

// ─── AUDIO STATE ─────────────────────────────────────────────────────────────
const DEFAULT_AUDIO_CONFIG = {
  attack:  null,
  gift:    null,
  kill:    null,
  respawn: null,
  heal:    null,
  follow:  null,
};
let audioConfig  = { ...DEFAULT_AUDIO_CONFIG };
let audioLibrary = [];

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function isSafePath(baseDir, targetPath) {
  const base   = path.resolve(baseDir);
  const target = path.resolve(targetPath);
  return target === base || target.startsWith(base + path.sep);
}

// ─── AUTH ─────────────────────────────────────────────────────────────────────
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

// ─── PERSISTENCE: PLAYERS ────────────────────────────────────────────────────
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
          alive:    false,
          lastActive: Date.now(),
          x: 0, y: 0, vx: 0, vy: 0,
          color: randomColor(),
          messageBoostExpires: 0,
          forceSpawn: false,
        };
      } else {
        players[id].uniqueId = players[id].uniqueId || id;
        players[id].nickname = players[id].nickname || s.nickname || id;
        players[id].maxHp    = Math.max(players[id].maxHp    || CFG.BASE_HP,       s.maxHp    || CFG.BASE_HP);
        players[id].strength = Math.max(players[id].strength || CFG.BASE_STRENGTH, s.strength || CFG.BASE_STRENGTH);
        players[id].kills    = s.kills || players[id].kills || 0;
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
        nickname: players[id].nickname,
        maxHp:    players[id].maxHp,
        strength: players[id].strength,
        kills:    players[id].kills,
      };
    }
    fs.writeFileSync(PLAYERS_FILE, JSON.stringify(toSave, null, 2));
  } catch (err) {
    console.error('Error saving player stats:', err);
  }
}

// ─── PERSISTENCE: BACKGROUND ─────────────────────────────────────────────────
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

// ─── PERSISTENCE: AUDIO ──────────────────────────────────────────────────────
function loadAudioConfig() {
  try {
    ensureDir(AUDIO_DIR);

    if (!fs.existsSync(AUDIO_CFG_FILE)) {
      const repoConfig = path.join(__dirname, 'audio', 'audio-config.json');
      if (fs.existsSync(repoConfig)) {
        fs.copyFileSync(repoConfig, AUDIO_CFG_FILE);
        console.log('🔊 Seeded audio-config.json from repo');
      }
    }

    if (fs.existsSync(AUDIO_CFG_FILE)) {
      const saved  = JSON.parse(fs.readFileSync(AUDIO_CFG_FILE, 'utf8'));
      audioConfig  = { ...DEFAULT_AUDIO_CONFIG, ...(saved.config  || {}) };
      audioLibrary = Array.isArray(saved.library) ? saved.library : [];

      audioLibrary = audioLibrary.filter(entry => {
        const runtimePath = path.join(AUDIO_DIR, entry.filename);
        const repoPath    = path.join(__dirname, 'audio', entry.filename);
        return isSafePath(AUDIO_DIR, runtimePath) &&
          (fs.existsSync(runtimePath) || fs.existsSync(repoPath));
      });

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
      { config: audioConfig, library: audioLibrary }, null, 2
    ));
  } catch (err) {
    console.error('Error saving audio config:', err);
  }
}

// ─── MULTER: BACKGROUND ──────────────────────────────────────────────────────
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

// ─── MULTER: AUDIO ───────────────────────────────────────────────────────────
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

// ─── GAME HELPERS ─────────────────────────────────────────────────────────────
function randomColor() {
  const palette = ['#FF6B6B','#FFD93D','#6BCB77','#4D96FF','#FF6BB5','#C77DFF','#00C9A7','#FF9F43'];
  return palette[Math.floor(Math.random() * palette.length)];
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
    nickname:   nickname || uniqueId,
    hp:         ex?.maxHp    || CFG.BASE_HP,
    maxHp:      ex?.maxHp    || CFG.BASE_HP,
    strength:   ex?.strength || CFG.BASE_STRENGTH,
    alive:      true,
    kills:      ex?.kills    || 0,
    lastActive: Date.now(),
    x:  Math.random() * 760 + 20,
    y:  Math.random() * 380 + 20,
    vx: (Math.random() - 0.5) * 2,
    vy: (Math.random() - 0.5) * 2,
    color:               ex?.color               || randomColor(),
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
    io.emit('heal', { uniqueId, amount: hpBoost });
  }
  p.strength  += strBoost;
  p.lastActive = Date.now();
}

function dealDamage(attackerId, targetId, multiplier = 1) {
  const attacker = players[attackerId];
  const target   = players[targetId];

  if (!attacker?.alive || !target?.alive || attackerId === targetId) return null;

  const dmg = Math.floor(
    attacker.strength * multiplier *
    (1 - CFG.ATTACK_VARIANCE / 2 + Math.random() * CFG.ATTACK_VARIANCE)
  );

  target.hp = Math.max(0, target.hp - dmg);

  let killed = false;

  if (target.hp === 0) {
    target.alive = false;
    attacker.kills++;
    killed = true;
    console.log(`💀 @${targetId} defeated by @${attackerId}!`);
    io.emit('soundEvent', { event: 'kill' });
    setTimeout(() => {
      spawnPlayer(targetId, target.nickname);
      io.emit('respawn',    { uniqueId: targetId });
      io.emit('soundEvent', { event: 'respawn' });
      io.emit('gameState',  players);
    }, CFG.RESPAWN_DELAY_MS);
  }

  console.log(`⚡ @${attackerId} → @${targetId} for ${dmg} dmg${killed ? ' (KILL!)' : ''}${multiplier > 1 ? ' (SPECIAL!)' : ''}`);

  return { attacker: attackerId, target: targetId, damage: dmg, killed, special: multiplier > 1 };
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

function handleMentionAttack(attackerId, attackerNick, comment) {
  const mentions = extractMentions(comment);
  if (!mentions.length) return { handled: false, reason: 'No @mention found' };

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
  let   multiplier  = CFG.MESSAGE_LASER_MULTIPLIER;
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
      io.emit('attack',    result);
      io.emit('soundEvent', { event: 'attack' });
      io.emit('commentDamage', {
        attacker: attackerNick,
        target:   target.nickname,
        damage:   result.damage,
        comment,
      });
      console.log(`💬 ${attackerNick} lasered @${target.uniqueId} for ${result.damage} hp${boostActive ? ' (gift boost)' : ''}`);
      return { handled: true, result, target: target.uniqueId };
    }
  }

  return { handled: false, reason: 'No valid attack target found' };
}

// ─── SERVER ───────────────────────────────────────────────────────────────────
const app        = express();
const httpServer = createServer(app);
const io         = new Server(httpServer, { cors: { origin: '*' } });

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

function parseCookieHeader(header = '') {
  return Object.fromEntries(
    header.split(';').map((part) => {
      const [name, ...rest] = part.trim().split('=');
      return [name, rest.join('=')];
    }).filter(([name]) => name)
  );
}

io.use((socket, next) => {
  const cookies = parseCookieHeader(socket.handshake.headers.cookie || '');
  const token   = cookies.session_token;
  if (!token) return next(new Error('Unauthorized'));
  try {
    jwt.verify(token, process.env.JWT_SECRET);
  } catch (_err) {
    return next(new Error('Unauthorized'));
  }
  const row = db.prepare('SELECT * FROM access_codes WHERE session_token = ?').get(token);
  if (!row || row.is_revoked || new Date(row.expires_at) < new Date()) {
    return next(new Error('Unauthorized'));
  }
  const fp = cookies.fp;
  if (row.fingerprint && (!fp || row.fingerprint !== fp)) {
    return next(new Error('Unauthorized'));
  }
  socket.accessCode = row;
  next();
});

app.use((req, res, next) => {
  if (req.path === '/dashboard.html' || req.path === '/dashboard-login.html') {
    return res.redirect('/dashboard');
  }
  next();
});

app.use(express.static(__dirname));

// ─── AUDIO STATIC SERVE ───────────────────────────────────────────────────────
// Serves uploaded audio files; falls back to any files committed in /audio/
app.use('/audio', (req, res, next) => {
  const filename    = path.basename(req.path);
  const runtimePath = path.join(AUDIO_DIR, filename);
  const repoPath    = path.join(__dirname, 'audio', filename);

  if (!isSafePath(AUDIO_DIR, runtimePath)) return res.status(403).send('Forbidden');
  if (fs.existsSync(runtimePath)) return res.sendFile(runtimePath);
  if (fs.existsSync(repoPath))    return res.sendFile(repoPath);
  next();
}, express.static(AUDIO_DIR));

// ─── SOCKET ───────────────────────────────────────────────────────────────────
let overlayCount = 0;

io.on('connection', (socket) => {
  socket.on('register', ({ type } = {}) => {
    if (type === 'overlay') {
      overlayCount++;
      io.emit('overlayCount', overlayCount);

      // Send current state to the newly connected overlay
      socket.emit('gameState',   players);
      socket.emit('audioConfig', audioConfig);   // ← pushes current assignments
      if (currentBackground) {
        socket.emit('backgroundChanged', { filename: currentBackground.filename });
      }

      socket.on('disconnect', () => {
        overlayCount = Math.max(0, overlayCount - 1);
        io.emit('overlayCount', overlayCount);
      });
    }
  });

  socket.on('layoutUpdate', (settings) => {
    io.emit('layoutUpdate', settings);
  });
});

// ─── ROUTES ───────────────────────────────────────────────────────────────────
app.get('/dashboard/login', (_req, res) => res.sendFile(path.join(__dirname, 'dashboard-login.html')));

app.post('/dashboard/login', (req, res) => {
  const email    = String(req.body.email    || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  if (email === DASHBOARD_OWNER_EMAIL && password === DASHBOARD_PASSWORD) {
    res.setHeader('Set-Cookie', `${DASHBOARD_COOKIE_NAME}=${DASHBOARD_COOKIE_VALUE}; Path=/; HttpOnly; Max-Age=86400; SameSite=Lax`);
    return res.redirect('/dashboard/welcome');
  }
  return res.status(401).send('Invalid email or password.');
});

app.get('/dashboard/logout', (_req, res) => {
  res.setHeader('Set-Cookie', `${DASHBOARD_COOKIE_NAME}=; Path=/; HttpOnly; Max-Age=0; SameSite=Lax`);
  res.redirect('/dashboard/login');
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
  res.redirect('/dashboard/login');
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
  res.redirect('/dashboard/login');
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
  devTestMode:      DEV_TEST_MODE,
}));

app.post('/api/dev/test-mode', (req, res) => {
  const { enabled } = req.body || {};
  if (typeof enabled !== 'boolean') return res.status(400).json({ success: false, error: 'Invalid enabled value' });
  DEV_TEST_MODE = enabled;
  io.emit('devModeChanged', { enabled });
  res.json({ success: true, enabled: DEV_TEST_MODE });
});

app.post('/api/dev/sound', (req, res) => {
  const { type } = req.body || {};
  if (!['laser', 'heal', 'special'].includes(type)) return res.status(400).json({ success: false, error: 'Invalid sound type' });
  io.emit('devSound', { type });
  res.json({ success: true });
});

app.post('/api/dev/sound-settings', (req, res) => {
  const { enabled } = req.body || {};
  if (typeof enabled !== 'boolean') return res.status(400).json({ success: false, error: 'Invalid enabled value' });
  io.emit('soundSettings', { enabled });
  res.json({ success: true });
});

app.post('/api/connect', (req, res) => {
  const { username } = req.body;
  if (!username) return res.json({ success: false, error: 'Username required' });
  if (!API_KEY)  return res.status(500).json({ success: false, error: 'Missing TikTok API_KEY in .env' });
  connectToStreamer(username);
  res.json({ success: true });
});

app.post('/api/reset',          (_req, res) => { disconnectStreamer(); res.json({ success: true }); });
app.post('/api/overlay/reload', (_req, res) => { io.emit('forceReload'); res.json({ success: true }); });

app.post('/api/players/clear', (_req, res) => {
  for (const id in players) { players[id].alive = false; players[id].forceSpawn = false; }
  io.emit('gameState', players);
  res.json({ success: true });
});

// ─── BACKGROUND ROUTES ────────────────────────────────────────────────────────
app.post('/api/background/upload', (req, res) => {
  res.type('application/json');
  ensureDir(BG_DIR);
  upload.single('background')(req, res, (err) => {
    try {
      if (err)       return res.status(400).json({ success: false, error: err.message || 'Background upload failed' });
      if (!req.file) return res.status(400).json({ success: false, error: 'No background image was uploaded.' });
      deleteCurrentBackgroundFile();
      saveBackgroundMeta(req.file.filename);
      io.emit('backgroundChanged', { filename: req.file.filename });
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
    io.emit('backgroundChanged', { filename: null });
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

// ─── AUDIO ROUTES ─────────────────────────────────────────────────────────────
app.get('/api/audio', (_req, res) => {
  res.json({ success: true, library: audioLibrary, config: audioConfig });
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
    io.emit('audioConfig', audioConfig);
    return res.json({ success: true, event, filename: null });
  }
  if (!audioLibrary.some(f => f.filename === filename)) {
    return res.status(404).json({ success: false, error: 'File not found in audio library.' });
  }
  audioConfig[event] = filename;
  saveAudioConfig();
  io.emit('audioConfig', audioConfig);   // ← push updated config live to overlay
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
  if (changed) io.emit('audioConfig', audioConfig);
  console.log(`🗑️ Deleted audio: ${filename}`);
  res.json({ success: true, filename, configUpdated: changed });
});

// ─── DEV TEST ROUTES ──────────────────────────────────────────────────────────
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
      lastActive: Date.now(),
      x: 100 + index * 100, y: 100 + index * 40,
      vx: (Math.random() - 0.5) * 1.5,
      vy: (Math.random() - 0.5) * 1.5,
      color: randomColor(), messageBoostExpires: 0, forceSpawn: true,
    };
  });
  io.emit('gameState', players);
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
  io.emit('gameState', players);
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
  io.emit('gameState', players);

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
        io.emit('respawn',   { uniqueId: target.uniqueId });
        io.emit('gameState', players);
      }, CFG.RESPAWN_DELAY_MS);
    }
    const giftAttack = { attacker: attackerId, target: targetId, damage, killed, diamonds };
    attacksMade.push(giftAttack);
    io.emit('giftAttack',  giftAttack);
    io.emit('soundEvent',  { event: killed ? 'kill' : 'gift' });
  });

  io.emit('giftEffect', { attacker: attackerId, giftName: 'Test Gift', diamonds });
  io.emit('gameState',  players);
  console.log('🧪 Test gift attack sent');
  res.json({ success: true, attacks: attacksMade });
});

// API 404
app.use('/api', (req, res) => {
  res.status(404).json({ success: false, error: `API endpoint not found: ${req.method} ${req.originalUrl}` });
});

// ─── IDLE CLEANUP ─────────────────────────────────────────────────────────────
setInterval(() => {
  const cutoff = Date.now() - CFG.IDLE_TIMEOUT_MS;
  for (const id of Object.keys(players)) {
    if (players[id].lastActive < cutoff) {
      delete players[id];
      console.log(`🪦 Removed idle player: @${id}`);
    }
  }
  io.emit('gameState', players);
}, 60_000);

// ─── MOVEMENT + SAVE LOOP ─────────────────────────────────────────────────────
let saveCounter = 0;

setInterval(() => {
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
  io.emit('gameState', players);
  if (++saveCounter >= 100) { savePlayerStats(); saveCounter = 0; }
}, 100);

// ─── START ────────────────────────────────────────────────────────────────────
httpServer.listen(PORT, () => {
  console.log('\n🎮 PvP Game Server running!');
  console.log(`   Overlay   → http://localhost:${PORT}/overlay.html`);
  console.log(`   Dashboard → http://localhost:${PORT}/dashboard`);
  console.log(`   Stats     → http://localhost:${PORT}/stats`);
  console.log(`   State JSON   → http://localhost:${PORT}/state`);
  console.log(`   Dev Tests  → ${DEV_TEST_MODE ? 'ENABLED' : 'DISABLED'}\n`);

  loadPlayerStats();
  loadCurrentBackground();
  loadAudioConfig();

  if (currentStreamer) connectToStreamer(currentStreamer);
});

// ─── TIKTOK CLIENT ───────────────────────────────────────────────────────────
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
    io.emit('gameState', players);
    io.emit('spawn', { uniqueId: id });
  });

  tiktokClient.on('chat', (e) => {
    console.log('CHAT EVENT:', JSON.stringify(e, null, 2));
    const id      = e.user?.uniqueId;
    const nick    = e.user?.nickname || id;
    const comment = e.comment || '';
    if (!id) return;

    awardStats(id, nick, 0, CFG.CHAT_STRENGTH_BOOST);

    if (/\bspawn\b/i.test(comment)) {
      if (!players[id]?.alive) {
        spawnPlayer(id, nick);
        console.log(`🟢 @${nick} spawned via chat command`);
      }
      if (players[id]) players[id].forceSpawn = true;
    }

    const attackResult = handleMentionAttack(id, nick, comment);
    if (!attackResult.handled && attackResult.reason !== 'No @mention found') {
      console.log(`⚠️ Chat attack not handled: ${attackResult.reason}`);
    }

    io.emit('gameState', players);
  });

  tiktokClient.on('gift', (e) => {
    const id       = e.user?.uniqueId;
    const nick     = e.user?.nickname || id;
    const diamonds = (e.diamondCount || 1) * (e.repeatCount || 1);
    if (!id) return;

    const alivePlayers  = Object.values(players).filter(p => p.alive);
    const boardHasSpace = alivePlayers.length < 20;

    if (!players[id]) spawnPlayer(id, nick);
    else if (!players[id].alive && boardHasSpace) spawnPlayer(id, nick);

    if (players[id]) {
      players[id].forceSpawn = true;
      players[id].lastActive = Date.now();
    }

    awardStats(id, nick, diamonds * CFG.GIFT_HP_PER_DIAMOND, diamonds * CFG.GIFT_STR_PER_DIAMOND);
    if (players[id]) players[id].messageBoostExpires = Date.now() + CFG.GIFT_MESSAGE_BOOST_DURATION_MS;

    io.emit('gameState', players);

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
            io.emit('respawn',    { uniqueId: target.uniqueId });
            io.emit('soundEvent', { event: 'respawn' });
            io.emit('gameState',  players);
          }, CFG.RESPAWN_DELAY_MS);
        }

        io.emit('giftAttack', { attacker: id, target: target.uniqueId, damage, killed, diamonds });
        io.emit('soundEvent', { event: killed ? 'kill' : 'gift' });
        console.log(`🎁 @${id} → @${target.uniqueId} via gift for ${damage} dmg${killed ? ' (KILL!)' : ''}`);
      });
    }

    io.emit('giftEffect', { attacker: id, giftName: e.giftName, diamonds });
    io.emit('gameState',  players);
    console.log(`🎁 @${id} sent ${e.giftName} (${diamonds} 💎) and attacked random players!`);
  });

  tiktokClient.on('like', (e) => {
    const id   = e.user?.uniqueId;
    const nick = e.user?.nickname || id;
    if (!id) return;
    if (!players[id]) spawnPlayer(id, nick);
    awardStats(id, nick, CFG.LIKE_HP_BOOST, 0);
    io.emit('soundEvent', { event: 'heal' });
    io.emit('gameState',  players);
  });

  tiktokClient.on('social', (e) => {
    const id   = e.user?.uniqueId;
    const nick = e.user?.nickname || id;
    if (!id) return;
    if (!players[id]) spawnPlayer(id, nick);
    awardStats(id, nick, 0, CFG.SOCIAL_STRENGTH_BOOST);
    io.emit('gameState', players);
  });

  tiktokClient.on('follow', (e) => {
    const id   = e.user?.uniqueId;
    const nick = e.user?.nickname || id;
    if (!id) return;
    console.log(`❤️  @${nick} followed!`);
    io.emit('soundEvent', { event: 'follow' });
    io.emit('follow', { uniqueId: id, nickname: nick });
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