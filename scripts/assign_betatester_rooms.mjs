import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.join(__dirname, '..', 'tiktokbr', 'tiktokbr.db');
console.log('Opening DB:', dbPath);
const db = new Database(dbPath);
// Ensure column `room_id` exists
const cols = db.prepare("PRAGMA table_info(access_codes)").all();
const hasRoomId = cols.some(c => c.name === 'room_id');
if (!hasRoomId) {
  console.log('Adding missing column `room_id` to access_codes');
  db.exec("ALTER TABLE access_codes ADD COLUMN room_id TEXT");
}

const selectStmt = db.prepare("SELECT id, code, email, room_id FROM access_codes WHERE UPPER(code) LIKE 'BETATESTER%' ORDER BY id");
const rows = selectStmt.all();
if (!rows.length) {
  console.log('No Betatester codes found.');
  process.exit(0);
}

const updateStmt = db.prepare('UPDATE access_codes SET room_id = ? WHERE id = ?');
let updated = 0;

const assignRoom = (id) => Math.random().toString(36).slice(2, 10);

db.transaction(() => {
  for (const r of rows) {
    if (!r.room_id) {
      const room = assignRoom();
      updateStmt.run(room, r.id);
      console.log(`Assigned room ${room} to ${r.code} (${r.email})`);
      updated++;
    } else {
      console.log(`Already has room: ${r.code} -> ${r.room_id}`);
    }
  }
})();

console.log(`Total updated: ${updated}`);
process.exit(0);
