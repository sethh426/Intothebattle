import Database from 'better-sqlite3';
import path from 'path';

const db = new Database(path.join(process.cwd(), 'tiktokbr', 'tiktokbr.db'));
const sample = db.prepare("SELECT id, code, email, is_revoked, expires_at, room_id, session_token, fingerprint FROM access_codes WHERE code LIKE 'BETATESTER%' OR code LIKE 'Betatester%' LIMIT 10").all();
console.log('sample', sample);
const setting = db.prepare("SELECT key,value FROM app_settings WHERE key='require_room_id'").get();
console.log('setting', setting);
