import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import db from './tiktokbr/db/db.js';

const cp = cookieParser();

function getAuthRecord(token) {
  const row = db.prepare('SELECT * FROM access_codes WHERE session_token = ?').get(token);
  if (row) return { type: 'code', record: row };
  const user = db.prepare('SELECT * FROM users WHERE session_token = ?').get(token);
  if (user) return { type: 'user', record: user };
  return null;
}

export default function socketAuth(socket, next) {
  const mockReq = { headers: { cookie: socket.handshake.headers.cookie || '' } };
  cp(mockReq, {}, () => {
    const token = mockReq.cookies?.session_token;
    if (!token) return next(new Error('Unauthorized'));
    try {
      jwt.verify(token, process.env.JWT_SECRET);
    } catch (_) {
      return next(new Error('Unauthorized'));
    }

    const auth = getAuthRecord(token);
    if (!auth) return next(new Error('Unauthorized'));

    if (auth.type === 'code') {
      const row = auth.record;
      if (row.is_revoked || new Date(row.expires_at) < new Date()) {
        return next(new Error('Unauthorized'));
      }
      const fp = mockReq.cookies?.fp;
      if (row.fingerprint && (!fp || row.fingerprint !== fp)) {
        return next(new Error('Unauthorized'));
      }
      socket.accessCode = row;
    } else {
      const user = auth.record;
      if (!user.is_active) return next(new Error('Unauthorized'));
      socket.user = user;
    }

    next();
  });
}