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

// ─── SEED: BETA ACCESS CODES (betatester1–betatester25) ──────────────────────
const insertCode = db.prepare(`
  INSERT OR IGNORE INTO access_codes (code, email, expires_at)
  VALUES (?, ?, '2099-12-31 23:59:59')
`);

const seedBetaCodes = db.transaction(() => {
  for (let i = 1; i <= 25; i++) {
    insertCode.run(`betatester${i}`, `betatester${i}@tiktokbr.com`);
  }
});

seedBetaCodes();

export default db;