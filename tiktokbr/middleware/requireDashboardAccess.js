import db, { getAsync, runAsync } from '../db/db.js';
import { getE2EAuthRecord } from '../auth/e2eAuth.js';
import { buildUserAccessStatus, trialDaysFromValue } from '../services/entitlements.js';
import { getEffectiveUserSubscription } from '../services/userSubscriptions.js';

function paywallUrl(reason) {
  return `/paywall?reason=${encodeURIComponent(reason || 'subscription_required')}`;
}

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

export default async function requireDashboardAccess(req, res, next) {
  const token = req.cookies?.session_token;
  if (!token) {
    console.info('Dashboard access: no session token present - redirecting to /login');
    return res.redirect('/login');
  }

  try {
    const auth = await getAuthRecord(token);
    if (!auth) return res.redirect('/login');

    if (auth.type === 'code') {
      const row = auth.record;
      const debugInfo = {
        reasonCheckAt: new Date().toISOString(),
        id: row.id,
        code: row.code,
        is_revoked: row.is_revoked,
        expires_at: row.expires_at,
        subscription_status: row.subscription_status,
        fingerprint_db: row.fingerprint,
        fingerprint_cookie: req.cookies?.fp || null,
      };

      if (row.is_revoked) {
        console.info('Dashboard access -> redirecting to paywall (revoked)', debugInfo);
        return res.redirect('/paywall?reason=revoked');
      }

      if (new Date(row.expires_at) < new Date()) {
        console.info('Dashboard access -> redirecting to paywall (expired)', debugInfo);
        return res.redirect('/paywall?reason=expired');
      }

      const fp = req.cookies.fp;
      if (row.fingerprint && (!fp || row.fingerprint !== fp)) {
        console.info('Dashboard access -> device fingerprint mismatch - redirecting to login', debugInfo);
        return res.redirect('/login?reason=device');
      }

      await runAsync('UPDATE access_codes SET last_seen = CURRENT_TIMESTAMP WHERE id = ?', row.id);
      req.accessCode = row;
    } else {
      const user = auth.record;
      if (!user.is_active) return res.redirect(paywallUrl('revoked'));

      const subscription = auth.subscription || getEffectiveUserSubscription(db, user.id);
      const accessStatus = buildUserAccessStatus(user, subscription, {
        trialDays: trialDaysFromValue(process.env.FREE_TRIAL_DAYS, 7),
      });
      if (!accessStatus.accessAllowed) {
        console.info('Dashboard access -> redirecting to paywall (user access blocked)', {
          userId: user.id,
          reason: accessStatus.reason,
          status: accessStatus.status,
        });
        return res.redirect(paywallUrl(accessStatus.reason));
      }

      await runAsync('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?', user.id);
      req.user = user;
      req.subscription = subscription;
      req.subscriptionStatus = accessStatus;
    }

    next();
  } catch (err) {
    console.error('Dashboard access error:', err);
    return res.redirect('/login');
  }
}
