import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import db, { getAsync } from '../db/db.js';

export const USER_SESSION_PURPOSE = 'user_session';
export const ACCESS_CODE_SESSION_PURPOSE = 'access_code_session';
const SESSION_TTL = '90d';

function sessionSecret(secret = process.env.JWT_SECRET) {
  return String(secret || '');
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeAccessCode(value) {
  return String(value || '').trim().toUpperCase();
}

function normalizeUserId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function tokenId() {
  return crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
}

export function createUserSessionToken(payload, secret = process.env.JWT_SECRET) {
  const userId = normalizeUserId(payload?.userId ?? payload?.id);
  const email = normalizeEmail(payload?.email);
  if (!userId || !email) throw new Error('User session tokens require userId and email');
  const id = tokenId();
  return jwt.sign({
    purpose: USER_SESSION_PURPOSE,
    userId,
    email,
    tokenId: id,
    jti: id,
  }, sessionSecret(secret), { expiresIn: SESSION_TTL });
}

export function createAccessCodeSessionToken(rowOrCode, secret = process.env.JWT_SECRET) {
  const code = normalizeAccessCode(typeof rowOrCode === 'object' ? rowOrCode?.code : rowOrCode);
  if (!code) throw new Error('Access-code session tokens require a code');
  const id = tokenId();
  return jwt.sign({
    purpose: ACCESS_CODE_SESSION_PURPOSE,
    code,
    tokenId: id,
    jti: id,
  }, sessionSecret(secret), { expiresIn: SESSION_TTL });
}

export function verifySessionPayload(token, secret = process.env.JWT_SECRET) {
  if (!token || !sessionSecret(secret)) return null;
  try {
    const payload = jwt.verify(token, sessionSecret(secret));
    return payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : null;
  } catch (_err) {
    return null;
  }
}

function payloadPurpose(payload) {
  return String(payload?.purpose || '').trim();
}

function payloadUserId(payload) {
  return normalizeUserId(payload?.userId);
}

function payloadAccessCode(payload) {
  return normalizeAccessCode(payload?.code);
}

function userPayloadMatchesRow(payload, user) {
  if (!payload || !user) return false;
  const purpose = payloadPurpose(payload);
  if (purpose && purpose !== USER_SESSION_PURPOSE) return false;
  if (payloadUserId(payload) !== normalizeUserId(user.id)) return false;
  const email = normalizeEmail(payload.email);
  return !email || email === normalizeEmail(user.email);
}

function accessCodePayloadMatchesRow(payload, row) {
  if (!payload || !row) return false;
  const purpose = payloadPurpose(payload);
  if (purpose && purpose !== ACCESS_CODE_SESSION_PURPOSE) return false;
  const code = payloadAccessCode(payload);
  return Boolean(code && code === normalizeAccessCode(row.code));
}

export function sessionAuthRecordFromPayloadSync(token, payload) {
  const purpose = payloadPurpose(payload);
  const userId = payloadUserId(payload);
  const code = payloadAccessCode(payload);

  if (purpose === USER_SESSION_PURPOSE || (!purpose && userId)) {
    const user = db.prepare('SELECT * FROM users WHERE id = ? AND session_token = ?').get(userId, token);
    return userPayloadMatchesRow(payload, user) ? { type: 'user', record: user } : null;
  }

  if (purpose === ACCESS_CODE_SESSION_PURPOSE || (!purpose && code)) {
    const row = db.prepare('SELECT * FROM access_codes WHERE UPPER(code) = ? AND session_token = ?').get(code, token);
    return accessCodePayloadMatchesRow(payload, row) ? { type: 'code', record: row } : null;
  }

  return null;
}

export async function sessionAuthRecordFromPayloadAsync(token, payload) {
  const purpose = payloadPurpose(payload);
  const userId = payloadUserId(payload);
  const code = payloadAccessCode(payload);

  if (purpose === USER_SESSION_PURPOSE || (!purpose && userId)) {
    const user = await getAsync('SELECT * FROM users WHERE id = ? AND session_token = ?', [userId, token]);
    return userPayloadMatchesRow(payload, user) ? { type: 'user', record: user } : null;
  }

  if (purpose === ACCESS_CODE_SESSION_PURPOSE || (!purpose && code)) {
    const row = await getAsync('SELECT * FROM access_codes WHERE UPPER(code) = ? AND session_token = ?', [code, token]);
    return accessCodePayloadMatchesRow(payload, row) ? { type: 'code', record: row } : null;
  }

  return null;
}

export function getSessionAuthRecord(token, secret = process.env.JWT_SECRET) {
  const payload = verifySessionPayload(token, secret);
  return payload ? sessionAuthRecordFromPayloadSync(token, payload) : null;
}

export async function getSessionAuthRecordAsync(token, secret = process.env.JWT_SECRET) {
  const payload = verifySessionPayload(token, secret);
  return payload ? sessionAuthRecordFromPayloadAsync(token, payload) : null;
}

export function getSessionUserFromToken(token, secret = process.env.JWT_SECRET) {
  const auth = getSessionAuthRecord(token, secret);
  return auth?.type === 'user' ? auth.record : null;
}
