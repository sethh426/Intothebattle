import db from '../db/db.js';
import jwt from 'jsonwebtoken';

export default function requireAccess(req, res, next) {
  const token = req.cookies.session_token;
  if (!token) return res.redirect('/login');

  try {
    jwt.verify(token, process.env.JWT_SECRET);
  } catch (_err) {
    return res.redirect('/login?reason=invalid');
  }

  const row = db.prepare('SELECT * FROM access_codes WHERE session_token = ?').get(token);
  if (!row) return res.redirect('/login');
  if (row.is_revoked) return res.redirect('/login?reason=revoked');
  if (new Date(row.expires_at) < new Date()) return res.redirect('/login?reason=expired');

  const fp = req.cookies.fp;
  if (row.fingerprint && (!fp || row.fingerprint !== fp)) {
    return res.redirect('/login?reason=device');
  }

  db.prepare('UPDATE access_codes SET last_seen = CURRENT_TIMESTAMP WHERE id = ?').run(row.id);
  req.accessCode = row;
  next();
}
