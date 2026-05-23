import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import db from './tiktokbr/db/db.js';

const cp = cookieParser();

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
    const row = db.prepare('SELECT * FROM access_codes WHERE session_token = ?').get(token);
    if (!row || row.is_revoked || new Date(row.expires_at) < new Date()) {
      return next(new Error('Unauthorized'));
    }
    const fp = mockReq.cookies?.fp;
    if (row.fingerprint && (!fp || row.fingerprint !== fp)) {
      return next(new Error('Unauthorized'));
    }
    socket.accessCode = row;
    next();
  });
}