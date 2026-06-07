import db from '../tiktokbr/db/db.js';

function uuid() {
  return 'SAMPLE-' + Math.random().toString(36).slice(2, 10).toUpperCase();
}

const subId = process.argv[2] || uuid();
const email = (process.argv[3] || 'tester@example.com').toLowerCase();
const code  = (process.argv[4] || 'TESTCODE' + Math.floor(Math.random()*9000+1000));
const expiresAt = new Date(Date.now() + 30*24*60*60*1000).toISOString().slice(0,19).replace('T',' ');

console.log('Inserting subscription:', subId, email, code, expiresAt);

db.prepare('INSERT INTO access_codes (code, email, expires_at, paypal_subscription_id, is_revoked) VALUES (?, ?, ?, ?, 0)').run(code, email, expiresAt, subId);

console.log('Inserted. Visit /claim?sub=' + encodeURIComponent(subId));
