import db from '../db/db.js';

export default function checkTrial(req, res, next) {
  const token = req.cookies?.session_token;
  if (!token) return res.redirect('/login');

  try {
    const row = db.prepare('SELECT * FROM access_codes WHERE session_token = ?').get(token);
    if (!row) return res.redirect('/login');
    if (row.is_revoked) return res.redirect('/paywall?reason=revoked');
    if (new Date(row.expires_at) < new Date()) return res.redirect('/paywall?reason=expired');

    // Check if trial has expired (if trial_started is set)
    if (row.trial_started) {
      const trialStart = new Date(row.trial_started);
      const trialEnd = new Date(trialStart.getTime() + (row.trial_days || 14) * 24 * 60 * 60 * 1000);
      const now = new Date();

      // If trial expired and no active subscription
      if (now > trialEnd && row.subscription_status !== 'active') {
        return res.redirect('/paywall?reason=trial_expired');
      }
    }

    // Check device fingerprint (optional but recommended)
    const fp = req.cookies.fp;
    if (row.fingerprint && (!fp || row.fingerprint !== fp)) {
      return res.redirect('/login?reason=device');
    }

    db.prepare('UPDATE access_codes SET last_seen = CURRENT_TIMESTAMP WHERE id = ?').run(row.id);
    req.accessCode = row;
    next();
  } catch (err) {
    console.error('Trial check error:', err);
    return res.redirect('/login');
  }
}
