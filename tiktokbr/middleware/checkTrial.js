import { getAsync, runAsync } from '../db/db.js';
import { getE2EAuthRecord } from '../auth/e2eAuth.js';

async function getAuthRecord(token) {
  if (!token) return null;
  const e2eAuth = getE2EAuthRecord(token);
  if (e2eAuth) return e2eAuth;

  const accessCode = await getAsync('SELECT * FROM access_codes WHERE session_token = ?', token);
  if (accessCode) return { type: 'code', record: accessCode };
  const user = await getAsync('SELECT * FROM users WHERE session_token = ?', token);
  if (user) return { type: 'user', record: user };
  return null;
}

export default async function checkTrial(req, res, next) {
  const token = req.cookies?.session_token;
  if (!token) {
    console.info('checkTrial: no session token present — redirecting to /login');
    return res.redirect('/login');
  }

  try {
    const auth = await getAuthRecord(token);
    if (!auth) return res.redirect('/login');

    if (auth.type === 'code') {
      const row = auth.record;
      // Log key access_code fields to help debug unexpected paywall redirects
      const debugInfo = {
        reasonCheckAt: new Date().toISOString(),
        id: row.id,
        code: row.code,
        is_revoked: row.is_revoked,
        expires_at: row.expires_at,
        trial_started: row.trial_started,
        trial_days: row.trial_days,
        subscription_status: row.subscription_status,
        fingerprint_db: row.fingerprint,
        fingerprint_cookie: req.cookies?.fp || null,
      };

      if (row.is_revoked) {
        console.info('checkTrial -> redirecting to paywall (revoked)', debugInfo);
        return res.redirect('/paywall?reason=revoked');
      }

      if (new Date(row.expires_at) < new Date()) {
        console.info('checkTrial -> redirecting to paywall (expired)', debugInfo);
        return res.redirect('/paywall?reason=expired');
      }

      if (row.trial_started) {
        const trialStart = new Date(row.trial_started);
        const trialEnd = new Date(trialStart.getTime() + (row.trial_days || 14) * 24 * 60 * 60 * 1000);
        const now = new Date();
        if (now > trialEnd && row.subscription_status !== 'active') {
          console.info('checkTrial -> redirecting to paywall (trial_expired)', { ...debugInfo, trialEnd: trialEnd.toISOString(), now: now.toISOString() });
          return res.redirect('/paywall?reason=trial_expired');
        }
      }

      const fp = req.cookies.fp;
      if (row.fingerprint && (!fp || row.fingerprint !== fp)) {
        console.info('checkTrial -> device fingerprint mismatch — redirecting to login', debugInfo);
        return res.redirect('/login?reason=device');
      }

      await runAsync('UPDATE access_codes SET last_seen = CURRENT_TIMESTAMP WHERE id = ?', row.id);
      req.accessCode = row;
    } else {
      const user = auth.record;
      if (!user.is_active) return res.redirect('/paywall?reason=revoked');

      const subscription = await getAsync(
        'SELECT * FROM subscriptions WHERE user_id = ? AND status IN (\'active\',\'trial\') ORDER BY updated_at DESC LIMIT 1',
        user.id
      );

      if (!subscription) {
        console.info('checkTrial -> user has no subscription; redirecting to paywall', { userId: user.id, email: user.email || null });
        return res.redirect('/paywall?reason=no_subscription');
      }

      if (subscription.status === 'trial') {
        const trialExpiresAt = subscription.expires_at ? new Date(subscription.expires_at) : null;
        const now = new Date();
        if (!trialExpiresAt || now > trialExpiresAt) {
          console.info('checkTrial -> user trial expired; redirecting to paywall', { userId: user.id, email: user.email || null, expires_at: subscription.expires_at });
          return res.redirect('/paywall?reason=trial_expired');
        }
      }

      await runAsync('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?', user.id);
      req.user = user;
      req.subscription = subscription;
    }

    next();
  } catch (err) {
    console.error('Trial check error:', err);
    return res.redirect('/login');
  }
}
