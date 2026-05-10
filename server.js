import { TikTokLive } from '@tiktool/live';
import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import fs from 'fs';
import multer from 'multer';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const API_KEY = process.env.API_KEY;
const DEV_TEST_MODE = process.env.DEV_TEST_MODE === 'true';
const PORT = process.env.PORT || 3000;

let currentStreamer = process.argv[2] || '';
let client = null;

const CFG = {
  BASE_HP: 300,
  BASE_STRENGTH: 15,
  CHAT_STRENGTH_BOOST: 1,
  LIKE_HP_BOOST: 2,
  SOCIAL_STRENGTH_BOOST: 5,
  GIFT_HP_PER_DIAMOND: 3,
  GIFT_STR_PER_DIAMOND: 1,
  GIFT_MESSAGE_BOOST_MULTIPLIER: 3,
  GIFT_MESSAGE_BOOST_DURATION_MS: 45000,
  MESSAGE_LASER_MULTIPLIER: 1.5,
  ATTACK_VARIANCE: 0.4,
  RESPAWN_DELAY_MS: 60000,
  IDLE_TIMEOUT_MS: 600000,
  RESET_TIMEOUT_MS: 300000,
  SPECIAL_ATTACK_MULTIPLIER: 5,
};

// ─── GAME STATE ───────────────────────────────────────────────────────────────
const players = {};

// ─── PERSISTENCE ─────────────────────────────────────────────────────────────
const PLAYERS_FILE = path.join(__dirname, 'players.json');
const BG_DIR = path.join(__dirname, 'backgrounds');
const BG_FILE = path.join(BG_DIR, 'current-bg.json');

function ensureBackgroundDir() {
  if (!fs.existsSync(BG_DIR)) {
    fs.mkdirSync(BG_DIR, { recursive: true });
  }
}

function isSafePath(baseDir, targetPath) {
  const base = path.resolve(baseDir);
  const target = path.resolve(targetPath);
  return target === base || target.startsWith(base + path.sep);
}

function loadPlayerStats() {
  try {
    if (fs.existsSync(PLAYERS_FILE)) {
      const saved = JSON.parse(fs.readFileSync(PLAYERS_FILE, 'utf8'));

      for (const id in saved) {
        const savedPlayer = saved[id] || {};

        if (!players[id]) {
          players[id] = {
            uniqueId: id,
            nickname: savedPlayer.nickname || id,
            hp: savedPlayer.maxHp || CFG.BASE_HP,
            maxHp: savedPlayer.maxHp || CFG.BASE_HP,
            strength: savedPlayer.strength || CFG.BASE_STRENGTH,
            kills: savedPlayer.kills || 0,
            alive: false,
            lastActive: Date.now(),
            x: 0,
            y: 0,
            vx: 0,
            vy: 0,
            color: randomColor(),
            messageBoostExpires: 0,
            forceSpawn: false,
          };
        } else {
          players[id].uniqueId = players[id].uniqueId || id;
          players[id].nickname = players[id].nickname || savedPlayer.nickname || id;
          players[id].maxHp = Math.max(players[id].maxHp || CFG.BASE_HP, savedPlayer.maxHp || CFG.BASE_HP);
          players[id].strength = Math.max(players[id].strength || CFG.BASE_STRENGTH, savedPlayer.strength || CFG.BASE_STRENGTH);
          players[id].kills = savedPlayer.kills || players[id].kills || 0;
        }
      }

      console.log(`📂 Loaded ${Object.keys(saved).length} saved player stats`);
    }
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
        maxHp: players[id].maxHp,
        strength: players[id].strength,
        kills: players[id].kills,
      };
    }

    fs.writeFileSync(PLAYERS_FILE, JSON.stringify(toSave, null, 2));
  } catch (err) {
    console.error('Error saving player stats:', err);
  }
}

// ─── GAME HELPERS ─────────────────────────────────────────────────────────────
function randomColor() {
  const palette = [
    '#FF6B6B',
    '#FFD93D',
    '#6BCB77',
    '#4D96FF',
    '#FF6BB5',
    '#C77DFF',
    '#00C9A7',
    '#FF9F43',
  ];

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
    nickname: nickname || uniqueId,
    hp: ex?.maxHp || CFG.BASE_HP,
    maxHp: ex?.maxHp || CFG.BASE_HP,
    strength: ex?.strength || CFG.BASE_STRENGTH,
    alive: true,
    kills: ex?.kills || 0,
    lastActive: Date.now(),
    x: Math.random() * 760 + 20,
    y: Math.random() * 380 + 20,
    vx: (Math.random() - 0.5) * 2,
    vy: (Math.random() - 0.5) * 2,
    color: ex?.color || randomColor(),
    messageBoostExpires: ex?.messageBoostExpires || 0,
    forceSpawn: ex?.forceSpawn || false,
  };

  console.log(
    `⚔️  Spawned: @${uniqueId} (HP: ${players[uniqueId].hp}, STR: ${players[uniqueId].strength}, Kills: ${players[uniqueId].kills})`
  );
}

function awardStats(uniqueId, nickname, hpBoost = 0, strBoost = 0) {
  if (!uniqueId) return;

  if (!players[uniqueId]) {
    spawnPlayer(uniqueId, nickname);
  }

  const p = players[uniqueId];

  if (!p || !p.alive) return;

  if (hpBoost > 0) {
    p.maxHp += Math.floor(hpBoost * 0.5);
    p.hp = Math.min(p.maxHp, p.hp + hpBoost);
  }

  p.strength += strBoost;
  p.lastActive = Date.now();
}

function dealDamage(attackerId, targetId, multiplier = 1) {
  const attacker = players[attackerId];
  const target = players[targetId];

  if (!attacker?.alive || !target?.alive || attackerId === targetId) return null;

  const dmg = Math.floor(
    attacker.strength *
      multiplier *
      (1 - CFG.ATTACK_VARIANCE / 2 + Math.random() * CFG.ATTACK_VARIANCE)
  );

  target.hp = Math.max(0, target.hp - dmg);

  let killed = false;

  if (target.hp === 0) {
    target.alive = false;
    attacker.kills++;
    killed = true;

    console.log(`💀 @${targetId} defeated by @${attackerId}!`);

    setTimeout(() => {
      spawnPlayer(targetId, target.nickname);
      io.emit('respawn', { uniqueId: targetId });
      io.emit('gameState', players);
    }, CFG.RESPAWN_DELAY_MS);
  }

  console.log(
    `⚡ @${attackerId} → @${targetId} for ${dmg} dmg${killed ? ' (KILL!)' : ''}${multiplier > 1 ? ' (SPECIAL!)' : ''}`
  );

  return {
    attacker: attackerId,
    target: targetId,
    damage: dmg,
    killed,
    special: multiplier > 1,
  };
}

function normalizeName(value = '') {
  return String(value).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function findTarget(mention) {
  const lower = String(mention || '').toLowerCase();
  const normalizedMention = normalizeName(mention);

  return Object.values(players).find((p) => {
    const unique = String(p.uniqueId || '').toLowerCase();
    const nick = String(p.nickname || '').toLowerCase();
    const normalizedUnique = normalizeName(p.uniqueId || '');
    const normalizedNick = normalizeName(p.nickname || '');

    return (
      unique === lower ||
      nick === lower ||
      normalizedUnique === normalizedMention ||
      normalizedNick === normalizedMention
    );
  });
}

function cleanMention(rawMention = '') {
  return String(rawMention)
    .trim()
    .replace(/^@+/, '')
    .replace(/^[^\w.]+/, '')
    .replace(/[^\w.]+$/g, '');
}

function extractMentions(comment = '') {
  return [...String(comment).matchAll(/@([^\s@]+)/g)]
    .map((match) => cleanMention(match[1]))
    .filter(Boolean);
}

function handleMentionAttack(attackerId, attackerNick, comment) {
  const mentions = extractMentions(comment);

  if (!mentions.length) {
    return {
      handled: false,
      reason: 'No @mention found',
    };
  }

  if (!players[attackerId] || !players[attackerId].alive) {
    spawnPlayer(attackerId, attackerNick);

    if (players[attackerId]) {
      players[attackerId].forceSpawn = true;
    }
  }

  if (players[attackerId]) {
    players[attackerId].lastActive = Date.now();
    players[attackerId].forceSpawn = true;
  }

  const attacker = players[attackerId];
  const boostActive = attacker && attacker.messageBoostExpires > Date.now();

  let multiplier = CFG.MESSAGE_LASER_MULTIPLIER;

  if (boostActive) {
    multiplier *= CFG.GIFT_MESSAGE_BOOST_MULTIPLIER;
  }

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

    if (!players[target.uniqueId] || !players[target.uniqueId].alive) {
      spawnPlayer(target.uniqueId, target.nickname);

      if (players[target.uniqueId]) {
        players[target.uniqueId].forceSpawn = true;
      }
    }

    const result = dealDamage(attackerId, target.uniqueId, multiplier);

    if (result) {
      io.emit('attack', result);

      io.emit('commentDamage', {
        attacker: attackerNick,
        target: target.nickname,
        damage: result.damage,
        comment,
      });

      console.log(
        `💬 ${attackerNick} lasered @${target.uniqueId} for ${result.damage} hp${boostActive ? ' (gift boost)' : ''}`
      );

      return {
        handled: true,
        result,
        target: target.uniqueId,
      };
    }
  }

  return {
    handled: false,
    reason: 'No valid attack target found',
  };
}

// ─── SERVER ───────────────────────────────────────────────────────────────────
const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: '*' } });

app.use(express.static(__dirname));
app.use(express.json());

// ─── BACKGROUND SETUP ─────────────────────────────────────────────────────────
ensureBackgroundDir();

const ALLOWED_BACKGROUND_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);
const ALLOWED_BACKGROUND_MIMES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
]);

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      ensureBackgroundDir();
      cb(null, BG_DIR);
    },
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname || '').toLowerCase();
      const safeExt = ALLOWED_BACKGROUND_EXTS.has(ext) ? ext : '.png';
      const name = `background-${Date.now()}-${Math.random().toString(36).slice(2)}${safeExt}`;
      cb(null, name);
    },
  }),
  limits: {
    fileSize: 10 * 1024 * 1024,
  },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    const mime = file.mimetype;

    const extAllowed = ALLOWED_BACKGROUND_EXTS.has(ext);
    const mimeAllowed = ALLOWED_BACKGROUND_MIMES.has(mime);

    if (extAllowed && mimeAllowed) {
      return cb(null, true);
    }

    return cb(new Error('Invalid background type. Please upload JPG, PNG, GIF, or WEBP only.'));
  },
});

let overlayCount = 0;
let currentBackground = null;

function loadCurrentBackground() {
  try {
    ensureBackgroundDir();

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
    ensureBackgroundDir();
    currentBackground = { filename };
    fs.writeFileSync(BG_FILE, JSON.stringify(currentBackground, null, 2));
  } catch (err) {
    console.error('Error saving background meta:', err);
  }
}

function deleteCurrentBackgroundFile() {
  if (!currentBackground || !currentBackground.filename) return;

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

// ─── SOCKET CONNECTIONS ───────────────────────────────────────────────────────
io.on('connection', (socket) => {
  socket.on('register', ({ type } = {}) => {
    if (type === 'overlay') {
      overlayCount++;
      io.emit('overlayCount', overlayCount);

      socket.emit('gameState', players);

      if (currentBackground) {
        socket.emit('backgroundChanged', { filename: currentBackground.filename });
      }

      socket.on('disconnect', () => {
        overlayCount = Math.max(0, overlayCount - 1);
        io.emit('overlayCount', overlayCount);
      });
    }
  });
});

// ─── ROUTES ───────────────────────────────────────────────────────────────────
app.get('/dashboard', (_req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});

app.get('/stats', (_req, res) => {
  res.sendFile(path.join(__dirname, 'stats.html'));
});

app.get('/state', (_req, res) => {
  res.json(players);
});

app.get('/api/status', (_req, res) => {
  res.json({
    username: currentStreamer,
    connected: !!(client && client.connected),
    overlayConnected: overlayCount > 0,
    overlayCount,
    playerCount: Object.values(players).filter((p) => p.alive).length,
    background: currentBackground,
  });
});

app.post('/api/connect', (req, res) => {
  const { username } = req.body;

  if (!username) {
    return res.json({ success: false, error: 'Username required' });
  }

  connectToStreamer(username);
  res.json({ success: true });
});

app.post('/api/reset', (_req, res) => {
  disconnectStreamer();
  res.json({ success: true });
});

app.post('/api/overlay/reload', (_req, res) => {
  io.emit('forceReload');
  res.json({ success: true });
});

app.post('/api/players/clear', (_req, res) => {
  for (const id in players) {
    players[id].alive = false;
    players[id].forceSpawn = false;
  }

  io.emit('gameState', players);
  res.json({ success: true });
});

// ─── BACKGROUND ROUTES ────────────────────────────────────────────────────────
app.post('/api/background/upload', (req, res) => {
  res.type('application/json');
  ensureBackgroundDir();

  upload.single('background')(req, res, (err) => {
    try {
      if (err) {
        console.error('Background upload validation error:', err.message);

        return res.status(400).json({
          success: false,
          error: err.message || 'Background upload failed',
        });
      }

      if (!req.file) {
        return res.status(400).json({
          success: false,
          error: 'No background image was uploaded.',
        });
      }

      deleteCurrentBackgroundFile();

      const filename = req.file.filename;

      saveBackgroundMeta(filename);
      io.emit('backgroundChanged', { filename });

      console.log(`📸 Background uploaded: ${filename}`);

      return res.json({
        success: true,
        filename,
        url: `/background/${filename}`,
      });
    } catch (uploadErr) {
      console.error('Background upload error:', uploadErr);

      return res.status(500).json({
        success: false,
        error: uploadErr.message || 'Server error during background upload',
      });
    }
  });
});

app.post('/api/background/clear', (_req, res) => {
  try {
    deleteCurrentBackgroundFile();

    currentBackground = null;

    try {
      if (fs.existsSync(BG_FILE)) {
        fs.unlinkSync(BG_FILE);
      }
    } catch (_e) {}

    io.emit('backgroundChanged', { filename: null });

    console.log('📸 Background cleared');

    res.json({ success: true });
  } catch (err) {
    console.error('Background clear error:', err);
    res.json({ success: false, error: err.message });
  }
});

app.get('/background/:filename', (req, res) => {
  const filename = req.params.filename;
  const filepath = path.join(BG_DIR, filename);

  if (!isSafePath(BG_DIR, filepath)) {
    return res.status(403).send('Forbidden');
  }

  if (!fs.existsSync(filepath)) {
    return res.status(404).send('Background not found');
  }

  return res.sendFile(filepath);
});

// ─── DEV TEST ROUTES ──────────────────────────────────────────────────────────
function requireDevTestMode(_req, res, next) {
  if (!DEV_TEST_MODE) {
    return res.status(403).json({
      success: false,
      error: 'Developer test mode is disabled',
    });
  }

  next();
}

function ensureTestPlayers() {
  const testPlayers = [
    { id: 'test_alpha', nick: 'Alpha' },
    { id: 'test_bravo', nick: 'Bravo' },
    { id: 'test_charlie', nick: 'Charlie' },
    { id: 'test_delta', nick: 'Delta' },
    { id: 'test_echo', nick: 'Echo' },
  ];

  testPlayers.forEach((item, index) => {
    players[item.id] = {
      uniqueId: item.id,
      nickname: item.nick,
      hp: CFG.BASE_HP,
      maxHp: CFG.BASE_HP,
      strength: CFG.BASE_STRENGTH,
      alive: true,
      kills: 0,
      lastActive: Date.now(),
      x: 100 + index * 100,
      y: 100 + index * 40,
      vx: (Math.random() - 0.5) * 1.5,
      vy: (Math.random() - 0.5) * 1.5,
      color: randomColor(),
      messageBoostExpires: 0,
      forceSpawn: true,
    };
  });

  io.emit('gameState', players);
}

app.get('/api/test/status', (_req, res) => {
  res.json({ enabled: DEV_TEST_MODE });
});

app.post('/api/test/spawn', requireDevTestMode, (_req, res) => {
  ensureTestPlayers();

  console.log('🧪 Test players spawned');

  res.json({ success: true });
});

app.post('/api/test/attack', requireDevTestMode, (_req, res) => {
  ensureTestPlayers();

  const result = handleMentionAttack('test_alpha', 'Alpha', '@test_bravo');

  io.emit('gameState', players);

  res.json({
    success: true,
    result,
  });
});

app.post('/api/test/gift', requireDevTestMode, (_req, res) => {
  ensureTestPlayers();

  const attackerId = 'test_charlie';
  const diamonds = 25;
  const targets = ['test_alpha', 'test_bravo', 'test_delta'];
  const attacksMade = [];

  awardStats(
    attackerId,
    players[attackerId].nickname,
    diamonds * CFG.GIFT_HP_PER_DIAMOND,
    diamonds * CFG.GIFT_STR_PER_DIAMOND
  );

  if (players[attackerId]) {
    players[attackerId].messageBoostExpires = Date.now() + CFG.GIFT_MESSAGE_BOOST_DURATION_MS;
  }

  io.emit('gameState', players);

  targets.forEach((targetId) => {
    const target = players[targetId];

    if (!target || !target.alive) return;

    const damage = diamonds;

    target.hp = Math.max(0, target.hp - damage);

    let killed = false;

    if (target.hp === 0) {
      killed = true;
      target.alive = false;
      players[attackerId].kills++;

      setTimeout(() => {
        spawnPlayer(target.uniqueId, target.nickname);
        io.emit('respawn', { uniqueId: target.uniqueId });
        io.emit('gameState', players);
      }, CFG.RESPAWN_DELAY_MS);
    }

    const giftAttack = {
      attacker: attackerId,
      target: targetId,
      damage,
      killed,
      diamonds,
    };

    attacksMade.push(giftAttack);
    io.emit('giftAttack', giftAttack);
  });

  io.emit('giftEffect', {
    attacker: attackerId,
    giftName: 'Test Gift',
    diamonds,
  });

  io.emit('gameState', players);

  console.log('🧪 Test gift attack sent');

  res.json({ success: true, attacks: attacksMade });
});

// API 404 handler for non-existing endpoints
app.use('/api', (req, res) => {
  res.status(404).json({
    success: false,
    error: `API endpoint not found: ${req.method} ${req.originalUrl}`,
  });
});

// ─── IDLE CLEANUP ─────────────────────────────────────────────────────────────
setInterval(() => {
  const now = Date.now();
  const deleteTime = now - CFG.IDLE_TIMEOUT_MS;

  for (const id of Object.keys(players)) {
    const p = players[id];

    if (p.lastActive < deleteTime) {
      delete players[id];
      console.log(`🪦 Removed idle player: @${id}`);
    }
  }

  io.emit('gameState', players);
}, 60_000);

// ─── MOVEMENT UPDATE ─────────────────────────────────────────────────────────
let saveCounter = 0;

setInterval(() => {
  for (const id in players) {
    const p = players[id];

    if (!p.alive) continue;

    p.x += p.vx;
    p.y += p.vy;

    if (p.x < 20 || p.x > 980) p.vx *= -1;
    if (p.y < 20 || p.y > 1800) p.vy *= -1;

    p.x = Math.max(20, Math.min(980, p.x));
    p.y = Math.max(20, Math.min(1800, p.y));
  }

  io.emit('gameState', players);

  if (++saveCounter >= 100) {
    savePlayerStats();
    saveCounter = 0;
  }
}, 100);

// ─── START ────────────────────────────────────────────────────────────────────
httpServer.listen(PORT, () => {
  console.log('\n🎮 PvP Game Server running!');
  console.log(`   Overlay    → http://localhost:${PORT}/overlay.html`);
  console.log(`   Dashboard  → http://localhost:${PORT}/dashboard`);
  console.log(`   Stats      → http://localhost:${PORT}/stats`);
  console.log(`   State JSON → http://localhost:${PORT}/state`);
  console.log(`   Dev Tests  → ${DEV_TEST_MODE ? 'ENABLED' : 'DISABLED'}\n`);

  loadPlayerStats();
  loadCurrentBackground();

  if (currentStreamer) {
    connectToStreamer(currentStreamer);
  }
});

// ─── TIKTOK CLIENT ───────────────────────────────────────────────────────────
function setupTikTokEvents(tiktokClient) {
  tiktokClient.on('connected', () => {
    console.log(`✅ Connected to @${currentStreamer}'s LIVE stream\n`);
  });

  tiktokClient.on('member', (e) => {
    const id = e.user?.uniqueId;
    const nick = e.user?.nickname || id;

    if (!id) return;

    spawnPlayer(id, nick);

    if (players[id]) {
      players[id].alive = true;
    }

    io.emit('gameState', players);
    io.emit('spawn', { uniqueId: id });
  });

  tiktokClient.on('chat', (e) => {
      console.log('CHAT EVENT:', JSON.stringify(e, null, 2));
  const id = e.user?.uniqueId;
    const id = e.user?.uniqueId;
    const nick = e.user?.nickname || id;
    const comment = e.comment || '';

    if (!id) return;

    awardStats(id, nick, 0, CFG.CHAT_STRENGTH_BOOST);

    const normalizedComment = comment.toLowerCase();
    const wantsSpawn = /\bspawn\b/.test(normalizedComment);

    if (wantsSpawn) {
      if (!players[id] || !players[id].alive) {
        spawnPlayer(id, nick);
        console.log(`🟢 @${nick} spawned via chat command`);
      }

      if (players[id]) {
        players[id].forceSpawn = true;
      }
    }

    const attackResult = handleMentionAttack(id, nick, comment);

    if (!attackResult.handled && attackResult.reason !== 'No @mention found') {
      console.log(`⚠️ Chat attack not handled: ${attackResult.reason}`);
    }

    io.emit('gameState', players);
  });

  tiktokClient.on('gift', (e) => {
    const id = e.user?.uniqueId;
    const nick = e.user?.nickname || id;
    const diamonds = (e.diamondCount || 1) * (e.repeatCount || 1);

    if (!id) return;

    const alivePlayers = Object.values(players).filter((p) => p.alive);
    const boardHasSpace = alivePlayers.length < 20;

    if (!players[id]) {
      spawnPlayer(id, nick);
    } else if (!players[id].alive && boardHasSpace) {
      spawnPlayer(id, nick);
    }

    if (players[id]) {
      players[id].forceSpawn = true;
      players[id].lastActive = Date.now();
    }

    awardStats(id, nick, diamonds * CFG.GIFT_HP_PER_DIAMOND, diamonds * CFG.GIFT_STR_PER_DIAMOND);

    if (players[id]) {
      players[id].messageBoostExpires = Date.now() + CFG.GIFT_MESSAGE_BOOST_DURATION_MS;
    }

    io.emit('gameState', players);

    const aliveTargets = Object.values(players).filter((p) => p.alive && p.uniqueId !== id);

    if (aliveTargets.length > 0) {
      const targetsToAttack = [];

      for (let i = 0; i < 3 && aliveTargets.length > 0; i++) {
        const randomIdx = Math.floor(Math.random() * aliveTargets.length);
        targetsToAttack.push(aliveTargets[randomIdx]);
        aliveTargets.splice(randomIdx, 1);
      }

      targetsToAttack.forEach((target) => {
        const damage = diamonds;

        target.hp = Math.max(0, target.hp - damage);

        let killed = false;

        if (target.hp === 0) {
          killed = true;
        }

        io.emit('giftAttack', {
          attacker: id,
          target: target.uniqueId,
          damage,
          killed,
          diamonds,
        });

        console.log(`🎁 @${id} → @${target.uniqueId} via gift for ${damage} dmg${killed ? ' (KILL!)' : ''}`);

        if (killed) {
          target.alive = false;
          players[id].kills++;

          console.log(`💀 @${target.uniqueId} defeated by gift attack from @${id}!`);

          setTimeout(() => {
            spawnPlayer(target.uniqueId, target.nickname);
            io.emit('respawn', { uniqueId: target.uniqueId });
            io.emit('gameState', players);
          }, CFG.RESPAWN_DELAY_MS);
        }
      });
    }

    io.emit('gameState', players);

    io.emit('giftEffect', {
      attacker: id,
      giftName: e.giftName,
      diamonds,
    });

    console.log(`🎁 @${id} sent ${e.giftName} (${diamonds} 💎) and attacked random players!`);
  });

  tiktokClient.on('like', (e) => {
    const id = e.user?.uniqueId;
    const nick = e.user?.nickname || id;

    if (!id) return;

    if (!players[id]) {
      spawnPlayer(id, nick);
    }

    awardStats(id, nick, CFG.LIKE_HP_BOOST, 0);

    io.emit('gameState', players);
  });

  tiktokClient.on('social', (e) => {
    const id = e.user?.uniqueId;
    const nick = e.user?.nickname || id;

    if (!id) return;

    if (!players[id]) {
      spawnPlayer(id, nick);
    }

    awardStats(id, nick, 0, CFG.SOCIAL_STRENGTH_BOOST);

    io.emit('gameState', players);
  });

  tiktokClient.on('error', (err) => {
    console.error('⚠️  TikTok error:', err?.message || err);
  });
}

function safeDisconnectClient() {
  if (!client) return;

  try {
    if (client.ws) {
      client.ws.onerror = () => {};
      client.ws.onclose = () => {};
    }

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

  client.connect().catch((err) => {
    console.error('❌ Could not connect:', err?.message || err);
    console.error('   Make sure @' + currentStreamer + ' is currently LIVE on TikTok');
    client = null;
  });
}

function disconnectStreamer() {
  safeDisconnectClient();
  currentStreamer = '';
}