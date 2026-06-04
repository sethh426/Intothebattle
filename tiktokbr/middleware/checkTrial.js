import db from '../db/db.js';

function getAuthRecord(token) {
  if (!token) return null;
  const accessCode = db.prepare('SELECT * FROM access_codes WHERE session_token = ?').get(token);
  if (accessCode) return { type: 'code', record: accessCode };
  const user = db.prepare('SELECT * FROM users WHERE session_token = ?').get(token);
  if (user) return { type: 'user', record: user };
  return null;
}

export default function checkTrial(req, res, next) {
  const token = req.cookies?.session_token;
  if (!token) return res.redirect('/login');

  try {
    const auth = getAuthRecord(token);
    if (!auth) return res.redirect('/login');

    if (auth.type === 'code') {
      const row = auth.record;
      if (row.is_revoked) return res.redirect('/paywall?reason=revoked');
      if (new Date(row.expires_at) < new Date()) return res.redirect('/paywall?reason=expired');

      if (row.trial_started) {
        const trialStart = new Date(row.trial_started);
        const trialEnd = new Date(trialStart.getTime() + (row.trial_days || 14) * 24 * 60 * 60 * 1000);
        const now = new Date();
        if (now > trialEnd && row.subscription_status !== 'active') {
          return res.redirect('/paywall?reason=trial_expired');
        }
      }

      const fp = req.cookies.fp;
      if (row.fingerprint && (!fp || row.fingerprint !== fp)) {
        return res.redirect('/login?reason=device');
      }

      db.prepare('UPDATE access_codes SET last_seen = CURRENT_TIMESTAMP WHERE id = ?').run(row.id);
      req.accessCode = row;
    } else {
      const user = auth.record;
      if (!user.is_active) return res.redirect('/paywall?reason=revoked');

      const subscription = db.prepare(
        'SELECT * FROM subscriptions WHERE user_id = ? AND status = ? ORDER BY updated_at DESC LIMIT 1'
      ).get(user.id, 'active');

      if (!subscription) {
        return res.redirect('/paywall?reason=no_subscription');
      }

      db.prepare('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?').run(user.id);
      req.user = user;
      req.subscription = subscription;
    }

    next();
  } catch (err) {
    console.error('Trial check error:', err);
    return res.redirect('/login');
  }
}
