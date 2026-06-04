import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_ROOT = process.env.DISK_PATH || path.join(__dirname, '..');
if (!fs.existsSync(DB_ROOT)) fs.mkdirSync(DB_ROOT, { recursive: true });
const dbPath = path.join(DB_ROOT, 'tiktokbr.db');

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
db.exec(schema);

try {
  db.exec('ALTER TABLE access_codes ADD COLUMN owner_name TEXT');
} catch (_) {}

try {
  db.exec('ALTER TABLE access_codes ADD COLUMN paypal_subscription_id TEXT');
} catch (_) {}

try {
  db.exec('ALTER TABLE access_codes ADD COLUMN room_id TEXT');
} catch (_) {}

try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS room_settings (
      room_id TEXT PRIMARY KEY,
      overlay_settings TEXT DEFAULT '{}',
      audio_config TEXT DEFAULT '{}',
      audio_library TEXT DEFAULT '[]',
      background_filename TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
} catch (_) {}

try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);
  db.prepare('INSERT OR IGNORE INTO app_settings (key, value) VALUES (?, ?)').run('require_room_id', '1');
} catch (_) {}

try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT,
      name TEXT,
      tiktok_username TEXT,
      session_token TEXT,
      is_active INTEGER DEFAULT 1,
      email_verified INTEGER DEFAULT 0,
      email_verification_token TEXT,
      email_verification_expires DATETIME,
      password_reset_token TEXT,
      password_reset_expires DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_login DATETIME
    )
  `);
} catch (_) {}

try {
  db.exec('ALTER TABLE users ADD COLUMN email_verified INTEGER DEFAULT 0');
} catch (_) {}

try {
  db.exec('ALTER TABLE users ADD COLUMN email_verification_token TEXT');
} catch (_) {}

try {
  db.exec('ALTER TABLE users ADD COLUMN email_verification_expires DATETIME');
} catch (_) {}

try {
  db.exec('ALTER TABLE users ADD COLUMN password_reset_token TEXT');
} catch (_) {}

try {
  db.exec('ALTER TABLE users ADD COLUMN password_reset_expires DATETIME');
} catch (_) {}

try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_rooms (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      room_id TEXT UNIQUE NOT NULL,
      room_name TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id)
    )
  `);
} catch (_) {}

try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      paypal_subscription_id TEXT UNIQUE,
      plan_type TEXT,
      status TEXT DEFAULT 'active',
      started_at DATETIME,
      next_billing_date DATETIME,
      expires_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id)
    )
  `);
} catch (_) {}

try {
  db.exec('ALTER TABLE access_codes ADD COLUMN user_id INTEGER');
} catch (_) {}

try {
  db.exec("ALTER TABLE access_codes ADD COLUMN code_type TEXT DEFAULT 'trial'");
} catch (_) {}

try {
  const codesWithoutRoom = db.prepare("SELECT id FROM access_codes WHERE room_id IS NULL OR room_id = ''").all();
  const updateRoom = db.prepare('UPDATE access_codes SET room_id = ? WHERE id = ?');
  const migrateRooms = db.transaction(() => {
    codesWithoutRoom.forEach(row => {
      updateRoom.run(Math.random().toString(36).slice(2, 10), row.id);
    });
  });
  migrateRooms();
} catch (_) {}

// ─── TRIAL & MONETIZATION COLUMNS ──────────────────────────────────────────
try {
  db.exec('ALTER TABLE access_codes ADD COLUMN trial_started DATETIME');
} catch (_) {}

try {
  db.exec('ALTER TABLE access_codes ADD COLUMN trial_days INTEGER DEFAULT 14');
} catch (_) {}

try {
  db.exec("ALTER TABLE access_codes ADD COLUMN subscription_status TEXT DEFAULT 'active'");
} catch (_) {}

try {
  db.exec('ALTER TABLE access_codes ADD COLUMN streamer_name TEXT');
} catch (_) {}

try {
  db.exec('ALTER TABLE access_codes ADD COLUMN tiktok_username TEXT');
} catch (_) {}

// ─── BATTLE STATS TABLE ────────────────────────────────────────────────────
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS battle_stats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code_id INTEGER NOT NULL,
      room_id TEXT,
      total_battles INTEGER DEFAULT 0,
      total_wins INTEGER DEFAULT 0,
      total_kills INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(code_id) REFERENCES access_codes(id)
    )
  `);
} catch (_) {}

// ─── SEED: BETA ACCESS CODES (betatester1–betatester25) ──────────────────────
const insertCode = db.prepare(`
  INSERT OR IGNORE INTO access_codes (code, email, expires_at, trial_started, subscription_status)
  VALUES (?, ?, '2099-12-31 23:59:59', CURRENT_TIMESTAMP, 'active')
`);

const seedBetaCodes = db.transaction(() => {
  for (let i = 1; i <= 25; i++) {
    insertCode.run(`Betatester${i}`, `betatester${i}@tiktokbr.com`);
  }
});

seedBetaCodes();

export default db;