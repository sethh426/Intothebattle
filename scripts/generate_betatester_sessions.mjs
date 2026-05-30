import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';

dotenv.config({ path: path.join(process.cwd(), '.env') });
const secret = process.env.JWT_SECRET;
if (!secret) {
  console.error('JWT_SECRET not found in .env');
  process.exit(1);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.join(__dirname, '..', 'tiktokbr', 'tiktokbr.db');
console.log('Opening DB:', dbPath);
const db = new Database(dbPath);

const rows = db.prepare("SELECT id, code, email, session_token FROM access_codes WHERE UPPER(code) LIKE 'BETATESTER%' ORDER BY id").all();
if (!rows.length) {
  console.log('No Betatester codes found.');
  process.exit(0);
}

const update = db.prepare('UPDATE access_codes SET session_token = ?, last_seen = CURRENT_TIMESTAMP WHERE id = ?');
let created = 0;

for (const r of rows) {
  if (r.session_token) {
    console.log(`Skipping ${r.code} (${r.email}) — already has session_token`);
    continue;
  }
  const token = jwt.sign({ email: r.email, code: r.code }, secret, { expiresIn: '90d' });
  update.run(token, r.id);
  console.log(`Set session_token for ${r.code} (${r.email})`);
  created++;
}

console.log(`Total session tokens created: ${created}`);
process.exit(0);
