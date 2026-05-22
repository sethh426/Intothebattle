import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.join(__dirname, '..', 'tiktokbr', 'tiktokbr.db');
const db = new Database(dbPath);

function uuid() {
  return 'SAMPLE-' + Math.random().toString(36).slice(2, 10).toUpperCase();
}

const subId = process.argv[2] || uuid();
const email = (process.argv[3] || 'tester@example.com').toLowerCase();
const code  = (process.argv[4] || 'TESTCODE' + Math.floor(Math.random()*9000+1000));
const expiresAt = new Date(Date.now() + 30*24*60*60*1000).toISOString().slice(0,19).replace('T',' ');

console.log('Using DB:', dbPath);
console.log('Inserting subscription:', subId, email, code, expiresAt);

const stmt = db.prepare('INSERT INTO access_codes (code, email, expires_at, paypal_subscription_id, is_revoked) VALUES (?, ?, ?, ?, 0)');
stmt.run(code, email, expiresAt, subId);

console.log('Inserted. Visit /claim?sub=' + encodeURIComponent(subId));
