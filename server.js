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

// ─── PERSISTENCE ─────────────────────────────────────────────────────────────
const PLAYERS_FILE = path.join(__dirname, 'players.json');
const BG_DIR = path.join(__dirname, 'backgrounds');
const BG_FILE = path.join(BG_DIR, 'current-bg.json');

const DASHBOARD_OWNER_EMAIL = 'mrpipper33@gmail.com';
const DASHBOARD_PASSWORD = 'Lololo90!';
const DASHBOARD_COOKIE_NAME = 'dashboard_auth';
const DASHBOARD_COOKIE_VALUE = Buffer.from(`${DASHBOARD_OWNER_EMAIL}:${DASHBOARD_PASSWORD}`).toString('base64');

function parseCookies(req) {
  const cookieHeader = req.headers.cookie || '';
  return Object.fromEntries(cookieHeader.split(';').map(part => {
    const [name, ...rest] = part.trim().split('=');
    return [name, rest.join('=')];
  }).filter(([name]) => name));
}

function isDashboardAuthed(req) {
  const cookies = parseCookies(req);
  return cookies[DASHBOARD_COOKIE_NAME] === DASHBOARD_COOKIE_VALUE;
}

function loadPlayerStats() {
  try {
    if (fs.existsSync(PLAYERS_FILE)) {
      const saved = JSON.parse(fs.readFileSync(PLAYERS_FILE, 'utf8'));
      for (const id in saved) {
        if (!players[id]) {
          players[id] = { ...saved[id], alive: false, x: 0, y: 0, vx: 0, vy: 0 };
        } else {
          players[id].maxHp    = Math.max(players[id].maxHp,    saved[id].maxHp    || CFG.BASE_HP);
          players[id].strength = Math.max(players[id].strength, saved[id].strength || CFG.BASE_STRENGTH);
          players[id].kills    = saved[id].kills || 0;
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

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const API_KEY = process.env.API_KEY;
let currentStreamer = process.argv[2] || '';

const CFG = {
  BASE_HP:                  100,
  BASE_STRENGTH:             10,
  CHAT_STRENGTH_BOOST:        1,
  LIKE_HP_BOOST:              2,
  SOCIAL_STRENGTH_BOOST:      5,
  GIFT_HP_PER_DIAMOND:        3,
  GIFT_STR_PER_DIAMOND:       1,
  GIFT_MESSAGE_BOOST_MULTIPLIER: 1.5,
  GIFT_MESSAGE_BOOST_DURATION_MS: 45000,
  MESSAGE_LASER_MULTIPLIER:   2,
  ATTACK_VARIANCE:           0.4,
  RESPAWN_DELAY_MS:        30000,
  IDLE_TIMEOUT_MS:        600000,
  RESET_TIMEOUT_MS:       300000,
  SPECIAL_ATTACK_MULTIPLIER:  3,
};

// ─── GAME STATE ───────────────────────────────────────────────────────────────
const players = {};

function spawnPlayer(uniqueId, nickname) {
  if (players[uniqueId]?.alive) return;
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
    color: randomColor(),
    messageBoostExpires: 0,
    forceSpawn: false,
  };
  console.log(`⚔️  Spawned: @${uniqueId} (HP: ${players[uniqueId].hp}, STR: ${players[uniqueId].strength}, Kills: ${players[uniqueId].kills})`);
}

function awardStats(uniqueId, nickname, hpBoost = 0, strBoost = 0) {
  if (!players[uniqueId]) spawnPlayer(uniqueId, nickname);
  const p = players[uniqueId];
  if (!p.alive) return;
  if (hpBoost > 0) {
    p.maxHp += Math.floor(hpBoost * 0.5);
    p.hp = Math.min(p.maxHp, p.hp + hpBoost);
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
    setTimeout(() => {
      spawnPlayer(targetId, target.nickname);
      io.emit('respawn',   { uniqueId: targetId });
      io.emit('gameState', players);
    }, CFG.RESPAWN_DELAY_MS);
  }

  console.log(`⚡ @${attackerId} → @${targetId} for ${dmg} dmg${killed ? ' (KILL!)' : ''}${multiplier > 1 ? ' (SPECIAL!)' : ''}`);
  return { attacker: attackerId, target: targetId, damage: dmg, killed, special: multiplier > 1 };
}

function normalizeName(value) {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function findTarget(mention) {
  const lower = mention.toLowerCase();
  const normalizedMention = normalizeName(mention);
  return Object.values(players).find((p) => {
    const unique = p.uniqueId.toLowerCase();
    const nick = p.nickname.toLowerCase();
    const normalizedNick = normalizeName(p.nickname);
    return unique === lower || nick === lower || normalizedNick === normalizedMention;
  });
}

function randomColor() {
  const palette = ['#FF6B6B','#FFD93D','#6BCB77','#4D96FF','#FF6BB5','#C77DFF','#00C9A7','#FF9F43'];
  return palette[Math.floor(Math.random() * palette.length)];
}

// ─── IDLE CLEANUP ─────────────────────────────────────────────────────────────
setInterval(() => {
  const now        = Date.now();
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
    if (p.x < 20 || p.x > 780) p.vx *= -1;
    if (p.y < 20 || p.y > 460) p.vy *= -1;
    p.x = Math.max(20, Math.min(780, p.x));
    p.y = Math.max(20, Math.min(460, p.y));
  }
  io.emit('gameState', players);
  if (++saveCounter >= 100) { savePlayerStats(); saveCounter = 0; }
}, 100);

// ─── SERVER ───────────────────────────────────────────────────────────────────
const app        = express();
const httpServer = createServer(app);
const io         = new Server(httpServer, { cors: { origin: '*' } });

app.use(express.urlencoded({ extended: false }));
app.use((req, res, next) => {
  if (req.path === '/dashboard.html' || req.path === '/dashboard-login.html') {
    return res.redirect('/dashboard');
  }
  next();
});
app.use(express.static(__dirname));
app.use(express.json());

// Create backgrounds directory if it doesn't exist
if (!fs.existsSync(BG_DIR)) {
  fs.mkdirSync(BG_DIR);
}

// Setup multer for file uploads
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      cb(null, BG_DIR);
    },
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname);
      const name = Date.now() + '-' + Math.random().toString(36).substring(7) + ext;
      cb(null, name);
    }
  }),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB max
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'));
    }
  }
});

// Track overlay connections
let overlayCount = 0;
let currentBackground = null;

// Load current background on startup
function loadCurrentBackground() {
  try {
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
    currentBackground = { filename };
    fs.writeFileSync(BG_FILE, JSON.stringify(currentBackground));
  } catch (err) {
    console.error('Error saving background meta:', err);
  }
}

io.on('connection', (socket) => {
  socket.on('register', ({ type } = {}) => {
    if (type === 'overlay') {
      overlayCount++;
      io.emit('overlayCount', overlayCount);
      // Send current background to new overlay connection
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
app.get('/dashboard/login', (_req, res) => res.sendFile(path.join(__dirname, 'dashboard-login.html')));
app.post('/dashboard/login', (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');

  if (email === DASHBOARD_OWNER_EMAIL && password === DASHBOARD_PASSWORD) {
    res.setHeader('Set-Cookie', `${DASHBOARD_COOKIE_NAME}=${DASHBOARD_COOKIE_VALUE}; Path=/; HttpOnly; Max-Age=86400; SameSite=Lax`);
    return res.redirect('/dashboard');
  }

  return res.status(401).send('Invalid email or password.');
});
app.get('/dashboard/logout', (_req, res) => {
  res.setHeader('Set-Cookie', `${DASHBOARD_COOKIE_NAME}=; Path=/; HttpOnly; Max-Age=0; SameSite=Lax`);
  res.redirect('/dashboard/login');
});
app.get('/dashboard', (req, res) => {
  if (!isDashboardAuthed(req)) {
    return res.redirect('/dashboard/login');
  }
  return res.sendFile(path.join(__dirname, 'dashboard.html'));
});
app.get('/stats',     (_req, res) => res.sendFile(path.join(__dirname, 'stats.html')));
app.get('/state',     (_req, res) => res.json(players));

app.get('/api/status', (_req, res) => {
  res.json({
    username:        currentStreamer,
    connected:       !!(client && client.connected),
    overlayConnected: overlayCount > 0,
    overlayCount,
    playerCount:     Object.values(players).filter(p => p.alive).length,
  });
});

app.post('/api/connect', (req, res) => {
  const { username } = req.body;
  if (!username) return res.json({ success: false, error: 'Username required' });
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
  for (const id in players) players[id].alive = false;
  io.emit('gameState', players);
  res.json({ success: true });
});

// Background routes
app.post('/api/background/upload', (req, res) => {
  console.log('➡️  Received /api/background/upload request');
  upload.single('background')(req, res, (err) => {
    try {
      res.type('application/json');
      // Handle multer errors
      if (err) {
        console.error('Multer error:', err.message);
        return res.status(400).json({ success: false, error: 'Upload failed: ' + err.message });
      }
      
      if (!req.file) {
        console.warn('No file received in upload');
        return res.status(400).json({ success: false, error: 'No file uploaded' });
      }
      
      console.log('📸 File received:', req.file.filename);
      
      // Clean up old background if exists
      if (currentBackground && currentBackground.filename) {
        const oldPath = path.join(BG_DIR, currentBackground.filename);
        try { 
          fs.unlinkSync(oldPath);
          console.log('📸 Deleted old background:', currentBackground.filename);
        } catch (e) {
          console.warn('Could not delete old background:', e.message);
        }
      }
      
      const filename = req.file.filename;
      saveBackgroundMeta(filename);
      io.emit('backgroundChanged', { filename });
      console.log(`📸 Background uploaded: ${filename}`);
      res.json({ success: true, filename });
    } catch (err) {
      console.error('Background upload error:', err);
      res.json({ success: false, error: err.message });
    }
  });
});

app.post('/api/background/clear', (_req, res) => {
  try {
    if (currentBackground && currentBackground.filename) {
      const bgPath = path.join(BG_DIR, currentBackground.filename);
      try { fs.unlinkSync(bgPath); } catch (e) {}
    }
    currentBackground = null;
    try { fs.unlinkSync(BG_FILE); } catch (e) {}
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
  
  // Security check - prevent directory traversal
  if (!filepath.startsWith(BG_DIR)) {
    return res.status(403).send('Forbidden');
  }
  
  if (fs.existsSync(filepath)) {
    res.sendFile(filepath);
  } else {
    res.status(404).send('Not found');
  }
});

// API 404 handler for non-existing endpoints
app.use('/api', (req, res) => {
  res.status(404).json({ success: false, error: `API endpoint not found: ${req.method} ${req.originalUrl}` });
});

// ─── START ────────────────────────────────────────────────────────────────────
httpServer.listen(3000, () => {
  console.log('\n🎮 PvP Game Server running!');
  console.log('   Overlay    → http://localhost:3000/overlay.html');
  console.log('   Dashboard  → http://localhost:3000/dashboard');
  console.log('   Stats      → http://localhost:3000/stats');
  console.log('   State JSON → http://localhost:3000/state\n');
  loadPlayerStats();
  loadCurrentBackground();
  if (currentStreamer) connectToStreamer(currentStreamer);
});

// ─── TIKTOK CLIENT ───────────────────────────────────────────────────────────
let client = null;

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
    const id      = e.user?.uniqueId;
    const nick    = e.user?.nickname || id;
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

    const mentionMatch = comment.match(/@([^\s@.,!?:;]+)/);
    if (mentionMatch) {
      if (!players[id] || !players[id].alive) {
        spawnPlayer(id, nick);
        if (players[id]) players[id].forceSpawn = true;
      }

      const target = findTarget(mentionMatch[1]);
      if (target) {
        const player = players[id];
        const boostActive = player && player.messageBoostExpires > Date.now();
        let multiplier = CFG.MESSAGE_LASER_MULTIPLIER;
        if (boostActive) {
          multiplier *= CFG.GIFT_MESSAGE_BOOST_MULTIPLIER;
        }

        const result = dealDamage(id, target.uniqueId, multiplier);
        if (result) {
          io.emit('attack', result);
          io.emit('commentDamage', { attacker: nick, target: target.nickname, damage: result.damage, comment });
          console.log(`💬 ${nick} lasered @${target.uniqueId} for ${result.damage} hp${boostActive ? ' (gift boost)' : ''}`);
        }
      }
    }

    io.emit('gameState', players);
  });

  tiktokClient.on('gift', (e) => {
    const id       = e.user?.uniqueId;
    const nick     = e.user?.nickname || id;
    const diamonds = (e.diamondCount || 1) * (e.repeatCount || 1);
    if (!id) return;

    const alivePlayers = Object.values(players).filter(p => p.alive);
    const boardHasSpace = alivePlayers.length < 20;
    if (!players[id]) {
      spawnPlayer(id, nick);
    } else if (!players[id].alive && boardHasSpace) {
      spawnPlayer(id, nick);
    }

    awardStats(id, nick, diamonds * CFG.GIFT_HP_PER_DIAMOND, diamonds * CFG.GIFT_STR_PER_DIAMOND);
    if (players[id]) {
      players[id].messageBoostExpires = Date.now() + CFG.GIFT_MESSAGE_BOOST_DURATION_MS;
    }
    
    // Get alive players excluding the gifter
    const aliveTargets = Object.values(players).filter(p => p.alive && p.uniqueId !== id);
    
    // Attack 3 random players with 1hp per diamond
    if (aliveTargets.length > 0) {
      const targetsToAttack = [];
      for (let i = 0; i < 3 && aliveTargets.length > 0; i++) {
        const randomIdx = Math.floor(Math.random() * aliveTargets.length);
        targetsToAttack.push(aliveTargets[randomIdx]);
        aliveTargets.splice(randomIdx, 1);
      }
      
      targetsToAttack.forEach(target => {
        const damage = diamonds; // 1hp per diamond
        target.hp = Math.max(0, target.hp - damage);
        
        let killed = false;
        if (target.hp === 0) {
          killed = true;
        }
        
        // Emit attack event BEFORE changing alive status
        io.emit('giftAttack', { attacker: id, target: target.uniqueId, damage, killed });
        console.log(`🎁 @${id} → @${target.uniqueId} via gift for ${damage} dmg${killed ? ' (KILL!)' : ''}`);
        
        // Now handle the kill
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
    io.emit('giftEffect', { attacker: id, giftName: e.giftName, diamonds });
    console.log(`🎁 @${id} sent ${e.giftName} (${diamonds} 💎) and attacked 3 random players!`);
  });

  tiktokClient.on('like', (e) => {
    const id   = e.user?.uniqueId;
    const nick = e.user?.nickname || id;
    if (!id) return;
    if (!players[id]) spawnPlayer(id, nick);
    awardStats(id, nick, CFG.LIKE_HP_BOOST, 0);
    io.emit('gameState', players);
  });

  tiktokClient.on('social', (e) => {
    const id   = e.user?.uniqueId;
    const nick = e.user?.nickname || id;
    if (!id) return;
    if (!players[id]) spawnPlayer(id, nick);
    awardStats(id, nick, 0, CFG.SOCIAL_STRENGTH_BOOST);
    io.emit('gameState', players);
  });

  tiktokClient.on('error', (err) => console.error('⚠️  TikTok error:', err?.message || err));
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
