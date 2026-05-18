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
  db.exec('ALTER TABLE access_codes ADD COLUMN paypal_subscription_id TEXT');
} catch (_) {
  // column already exists, ignore
}

// ─── SEED: BETA ACCESS CODE ───────────────────────────────────────────────────
try {
  db.prepare(`
    INSERT OR IGNORE INTO access_codes (code, email, expires_at)
    VALUES ('BETA1', 'beta@tiktokbr.com', '2099-12-31 23:59:59')
  `).run();
} catch (_) {
  // already exists, ignore
}

export default db;