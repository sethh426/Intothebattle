import '../loadEnv.js';
import db from '../tiktokbr/db/db.js';
import checkTrial from '../tiktokbr/middleware/checkTrial.js';
import { v4 as uuidv4 } from 'uuid';

function formatDbDate(d) {
  return d.toISOString().slice(0,19).replace('T',' ');
}

async function run() {
  const sessionToken = uuidv4();
  const code = `TRIAL-${Math.random().toString(36).slice(2,8).toUpperCase()}`;
  const now = new Date();
  const trialStarted = formatDbDate(now);
  const expiresAt = formatDbDate(new Date(Date.now() + 30 * 24 * 60 * 60 * 1000));

  db.prepare(`INSERT INTO access_codes (code, expires_at, session_token, trial_started, trial_days, subscription_status) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(code, expiresAt, sessionToken, trialStarted, 14, 'trial');

  console.log('Inserted trial code:', code);

  // Mock req/res
  const req = { cookies: { session_token: sessionToken, fp: null } };
  const res = { redirect: (url) => { console.log('middleware redirected to:', url); } };
  const next = () => { console.log('middleware allowed access: next() called'); };

  // Run middleware
  await checkTrial(req, res, next);

  // Now simulate expired trial by updating trial_started to 30 days ago
  const past = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const pastStr = formatDbDate(past);
  db.prepare('UPDATE access_codes SET trial_started = ? WHERE session_token = ?').run(pastStr, sessionToken);
  console.log('Backdated trial_started to:', pastStr);

  await checkTrial(req, res, next);
}

run().catch(err => { console.error('Test failed:', err); process.exit(1); });
