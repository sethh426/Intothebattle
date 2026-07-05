import db from '../db/db.js';
import jwt from 'jsonwebtoken';
import { getE2EAuthRecord } from '../auth/e2eAuth.js';
import { buildUserAccessStatus, trialDaysFromValue } from '../services/entitlements.js';
import { getEffectiveUserSubscription } from '../services/userSubscriptions.js';

function paywallUrl(reason) {
  return `/paywall?reason=${encodeURIComponent(reason || 'subscription_required')}`;
}

function getAuthRecord(token) {
  if (!token) return null;
  const e2eAuth = getE2EAuthRecord(token);
  if (e2eAuth) return e2eAuth;

  const accessCode = db.prepare('SELECT * FROM access_codes WHERE session_token = ?').get(token);
  if (accessCode) return { type: 'code', record: accessCode };
  const user = db.prepare('SELECT * FROM users WHERE session_token = ?').get(token);
  if (user) return { type: 'user', record: user };
  return null;
}

export default function requireAccess(req, res, next) {
  const token = req.cookies.session_token;
  if (!token) return res.redirect('/login');

  const e2eAuth = getE2EAuthRecord(token);
  if (e2eAuth) {
    if (e2eAuth.type === 'user') {
      const accessStatus = buildUserAccessStatus(e2eAuth.record, e2eAuth.subscription || null, {
        trialDays: trialDaysFromValue(process.env.FREE_TRIAL_DAYS, 7),
      });
      if (!accessStatus.accessAllowed) return res.redirect(paywallUrl(accessStatus.reason));
      req.user = e2eAuth.record;
      req.subscription = e2eAuth.subscription || null;
      req.subscriptionStatus = accessStatus;
    } else {
      req.accessCode = e2eAuth.record;
    }
    return next();
  }

  try {
    jwt.verify(token, process.env.JWT_SECRET);
  } catch (_err) {
    return res.redirect('/login?reason=invalid');
  }

  const auth = getAuthRecord(token);
  if (!auth) return res.redirect('/login');

  if (auth.type === 'code') {
    const row = auth.record;
    if (row.is_revoked) return res.redirect('/login?reason=revoked');
    if (new Date(row.expires_at) < new Date()) return res.redirect('/login?reason=expired');

    const fp = req.cookies.fp;
    if (row.fingerprint && (!fp || row.fingerprint !== fp)) {
      return res.redirect('/login?reason=device');
    }

    db.prepare('UPDATE access_codes SET last_seen = CURRENT_TIMESTAMP WHERE id = ?').run(row.id);
    req.accessCode = row;
  } else {
    const user = auth.record;
    if (!user.is_active) return res.redirect('/login?reason=revoked');
    const subscription = auth.subscription || getEffectiveUserSubscription(db, user.id);
    const accessStatus = buildUserAccessStatus(user, subscription, {
      trialDays: trialDaysFromValue(process.env.FREE_TRIAL_DAYS, 7),
    });
    if (!accessStatus.accessAllowed) return res.redirect(paywallUrl(accessStatus.reason));

    db.prepare('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?').run(user.id);
    req.user = user;
    req.subscription = subscription;
    req.subscriptionStatus = accessStatus;
  }

  next();
}
