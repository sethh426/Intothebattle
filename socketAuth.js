import cookieParser from 'cookie-parser';
import { getSessionAuthRecord } from './tiktokbr/services/sessionAuth.js';

const cp = cookieParser();

function getAuthRecord(token) {
  return getSessionAuthRecord(token);
}

export default function socketAuth(socket, next) {
  const mockReq = { headers: { cookie: socket.handshake.headers.cookie || '' } };
  cp(mockReq, {}, () => {
    const token = mockReq.cookies?.session_token;
    if (!token) return next(new Error('Unauthorized'));
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
