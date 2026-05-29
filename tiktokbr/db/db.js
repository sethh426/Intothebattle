import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.join(__dirname, '..', 'tiktokbr.db');

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
  const codesWithoutRoom = db.prepare('SELECT id FROM access_codes WHERE room_id IS NULL').all();
  const updateRoom = db.prepare('UPDATE access_codes SET room_id = ? WHERE id = ?');
  const migrateRooms = db.transaction(() => {
    codesWithoutRoom.forEach(row => {
      updateRoom.run(Math.random().toString(36).slice(2, 10), row.id);
    });
  });
  migrateRooms();
} catch (_) {}

// ─── SEED: BETA ACCESS CODES (betatester1–betatester25) ──────────────────────
const insertCode = db.prepare(`
  INSERT OR IGNORE INTO access_codes (code, email, expires_at)
  VALUES (?, ?, '2099-12-31 23:59:59')
`);

const seedBetaCodes = db.transaction(() => {
  for (let i = 1; i <= 25; i++) {
    insertCode.run(`Betatester${i}`, `betatester${i}@tiktokbr.com`);
  }
});

seedBetaCodes();

export default db;