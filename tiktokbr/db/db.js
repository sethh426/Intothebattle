import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Client } from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_ROOT = process.env.DISK_PATH || path.join(__dirname, '..');
if (!fs.existsSync(DB_ROOT)) fs.mkdirSync(DB_ROOT, { recursive: true });

const connectionString = process.env.DATABASE_URL || process.env.PG_CONNECTION_STRING || process.env.PG_CONN_STRING;
if (!connectionString) {
  throw new Error('PostgreSQL connection string is required. Set DATABASE_URL or PG_CONNECTION_STRING.');
}

const client = new Client({ connectionString });

function waitFor(promise) {
  const buffer = new SharedArrayBuffer(4);
  const state = new Int32Array(buffer);
  let result;
  let error;

  promise.then((value) => {
    result = value;
    Atomics.store(state, 0, 1);
    Atomics.notify(state, 0, 1);
  }).catch((err) => {
    error = err;
    Atomics.store(state, 0, 1);
    Atomics.notify(state, 0, 1);
  });

  while (Atomics.load(state, 0) === 0) {
    Atomics.wait(state, 0, 0, 1000);
  }

  if (error) throw error;
  return result;
}

waitFor(client.connect());

function convertPlaceholders(sql) {
  let index = 0;
  return sql.replace(/\?/g, () => `$${++index}`);
}

function normalizeParams(params) {
  if (params == null) return [];
  if (Array.isArray(params)) return params;
  return [params];
}

function prepareStatement() {
  const queryText = arguments.length === 2 ? arguments[1] : arguments[0];
  const sql = convertPlaceholders(queryText);
  const name = `stmt_${Math.random().toString(36).slice(2, 10)}`;

  return {
    get(params) {
      const result = waitFor(client.query({ name, text: sql, values: normalizeParams(params) }));
      return result.rows?.[0];
    },
    all(params) {
      const result = waitFor(client.query({ name, text: sql, values: normalizeParams(params) }));
      return result.rows || [];
    },
    run(params) {
      return waitFor(client.query({ name, text: sql, values: normalizeParams(params) }));
    }
  };
}

const db = {
  prepare: prepareStatement,
  exec(sql) {
    return waitFor(client.query(sql));
  },
  pragma() {
    return null;
  },
  transaction(fn) {
    return (...args) => {
      waitFor(client.query('BEGIN'));
      try {
        const result = fn(...args);
        waitFor(client.query('COMMIT'));
        return result;
      } catch (error) {
        waitFor(client.query('ROLLBACK'));
        throw error;
      }
    };
  }
};

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
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
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
  db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING').run('require_room_id', '1');
} catch (_) {}

try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT,
      name TEXT,
      tiktok_username TEXT,
      session_token TEXT,
      is_active INTEGER DEFAULT 1,
      email_verified INTEGER DEFAULT 0,
      email_verification_token TEXT,
      email_verification_expires TIMESTAMP,
      password_reset_token TEXT,
      password_reset_expires TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      last_login TIMESTAMP
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
  db.exec('ALTER TABLE users ADD COLUMN email_verification_expires TIMESTAMP');
} catch (_) {}

try {
  db.exec('ALTER TABLE users ADD COLUMN password_reset_token TEXT');
} catch (_) {}

try {
  db.exec('ALTER TABLE users ADD COLUMN password_reset_expires TIMESTAMP');
} catch (_) {}

try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_rooms (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      room_id TEXT UNIQUE NOT NULL,
      room_name TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id)
    )
  `);
} catch (_) {}

try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS subscriptions (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      paypal_subscription_id TEXT UNIQUE,
      plan_type TEXT,
      status TEXT DEFAULT 'active',
      started_at TIMESTAMP,
      next_billing_date TIMESTAMP,
      expires_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
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
  db.exec('ALTER TABLE access_codes ADD COLUMN trial_started TIMESTAMP');
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
      id SERIAL PRIMARY KEY,
      code_id INTEGER NOT NULL,
      room_id TEXT,
      total_battles INTEGER DEFAULT 0,
      total_wins INTEGER DEFAULT 0,
      total_kills INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(code_id) REFERENCES access_codes(id)
    )
  `);
} catch (_) {}

try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS room_player_stats (
      room_id TEXT NOT NULL,
      unique_id TEXT NOT NULL,
      nickname TEXT,
      hp INTEGER DEFAULT 300,
      max_hp INTEGER DEFAULT 300,
      strength INTEGER DEFAULT 15,
      kills INTEGER DEFAULT 0,
      kill_streak INTEGER DEFAULT 0,
      last_kill_time INTEGER DEFAULT 0,
      alive INTEGER DEFAULT 0,
      last_active INTEGER,
      color TEXT,
      message_boost_expires INTEGER DEFAULT 0,
      force_spawn INTEGER DEFAULT 0,
      PRIMARY KEY(room_id, unique_id)
    )
  `);
} catch (_) {}

try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS global_player_stats (
      unique_id TEXT PRIMARY KEY,
      nickname TEXT,
      hp INTEGER DEFAULT 300,
      max_hp INTEGER DEFAULT 300,
      strength INTEGER DEFAULT 15,
      kills INTEGER DEFAULT 0,
      last_active INTEGER,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
} catch (_) {}

// ─── SEED: BETA ACCESS CODES (betatester1–betatester25) ──────────────────────
const insertCode = db.prepare(`
  INSERT INTO access_codes (code, email, expires_at, trial_started, subscription_status) ON CONFLICT (code) DO NOTHING
  VALUES (?, ?, '2099-12-31 23:59:59', CURRENT_TIMESTAMP, 'active')
`);

const seedBetaCodes = db.transaction(() => {
  for (let i = 1; i <= 25; i++) {
    insertCode.run(`Betatester${i}`, `betatester${i}@tiktokbr.com`);
  }
});

seedBetaCodes();

export default db;