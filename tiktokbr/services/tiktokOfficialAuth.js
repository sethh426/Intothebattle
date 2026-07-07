import crypto from 'crypto';
import jwt from 'jsonwebtoken';

const AUTHORIZE_URL = 'https://www.tiktok.com/v2/auth/authorize/';
const TOKEN_URL = 'https://open.tiktokapis.com/v2/oauth/token/';
const REVOKE_URL = 'https://open.tiktokapis.com/v2/oauth/revoke/';
const USER_INFO_URL = 'https://open.tiktokapis.com/v2/user/info/';
const DEFAULT_SCOPES = 'user.info.basic,user.info.profile';
const BASIC_USER_FIELDS = 'open_id,union_id,avatar_url,avatar_url_100,avatar_large_url,display_name';
const USER_FIELDS = `${BASIC_USER_FIELDS},username,profile_deep_link`;
const PROVIDERS = new Set(['legacy', 'official', 'disabled']);

function present(value) {
  return String(value || '').trim().length > 0;
}

function cleanText(value, max = 1000) {
  return String(value || '').trim().slice(0, max);
}

function baseUrl(env = process.env) {
  return String(env.APP_BASE_URL || `http://localhost:${env.PORT || 3000}`).replace(/\/$/, '');
}

export function tiktokRedirectUri(env = process.env) {
  return cleanText(env.TIKTOK_REDIRECT_URI || `${baseUrl(env)}/auth/tiktok/callback`, 512);
}

export function tiktokScopes(env = process.env) {
  const configured = cleanText(env.TIKTOK_SCOPES || DEFAULT_SCOPES, 500);
  return configured || DEFAULT_SCOPES;
}

export function tiktokLiveEventProvider(env = process.env) {
  const provider = cleanText(env.TIKTOK_LIVE_EVENT_PROVIDER || 'legacy', 40).toLowerCase();
  return PROVIDERS.has(provider) ? provider : 'legacy';
}

export function normalizeOfficialTikTokUsername(value = '') {
  const text = String(value || '').trim().replace(/^@+/, '');
  return /^[A-Za-z0-9._-]{2,64}$/.test(text) ? text : '';
}

export function deriveTikTokUsername(profile = {}) {
  const direct = normalizeOfficialTikTokUsername(profile.username || profile.unique_id || profile.uniqueId || profile.tiktok_username);
  if (direct) return direct;
  const deepLink = String(profile.profile_deep_link || '').trim();
  if (!deepLink) return '';
  try {
    const url = new URL(deepLink);
    const match = url.pathname.match(/\/@([A-Za-z0-9._-]{2,64})(?:\/|$)/);
    return normalizeOfficialTikTokUsername(match?.[1] || '');
  } catch (_err) {
    const match = deepLink.match(/@([A-Za-z0-9._-]{2,64})(?:[/?#]|$)/);
    return normalizeOfficialTikTokUsername(match?.[1] || '');
  }
}

export function tiktokOfficialConfig(env = process.env) {
  const clientKey = cleanText(env.TIKTOK_CLIENT_KEY || env.TIKTOK_CLIENT_ID, 256);
  const clientSecret = cleanText(env.TIKTOK_CLIENT_SECRET, 512);
  const appId = cleanText(env.TIKTOK_APP_ID, 128);
  const redirectUri = tiktokRedirectUri(env);
  const scopes = tiktokScopes(env);
  const provider = tiktokLiveEventProvider(env);
  return {
    configured: Boolean(clientKey && clientSecret && redirectUri),
    clientKey,
    clientSecret,
    appId,
    redirectUri,
    scopes,
    provider,
    requireAccountForLive: shouldRequireTikTokAccountForLive(env),
  };
}

export function shouldRequireTikTokAccountForLive(env = process.env) {
  const explicit = cleanText(env.TIKTOK_REQUIRE_ACCOUNT_LINK_FOR_LIVE, 16).toLowerCase();
  if (['true', '1', 'yes'].includes(explicit)) return true;
  if (['false', '0', 'no'].includes(explicit)) return false;
  return env.NODE_ENV === 'production' && Boolean(env.TIKTOK_CLIENT_KEY && env.TIKTOK_CLIENT_SECRET);
}

export function createTikTokOAuthState({ userId, next = '/dashboard' } = {}, env = process.env) {
  if (!env.JWT_SECRET) throw new Error('JWT_SECRET is required for TikTok OAuth state');
  return jwt.sign({
    purpose: 'tiktok_oauth',
    nonce: crypto.randomBytes(16).toString('hex'),
    userId: Number(userId) || null,
    next: String(next || '/dashboard').startsWith('/') ? String(next || '/dashboard') : '/dashboard',
  }, env.JWT_SECRET, { expiresIn: '10m' });
}

export function verifyTikTokOAuthState(state, env = process.env) {
  if (!state || !env.JWT_SECRET) return null;
  try {
    const payload = jwt.verify(String(state), env.JWT_SECRET);
    return payload?.purpose === 'tiktok_oauth' ? payload : null;
  } catch (_err) {
    return null;
  }
}

export function buildTikTokAuthorizationUrl(state, env = process.env) {
  const cfg = tiktokOfficialConfig(env);
  if (!cfg.configured) throw new Error('TikTok OAuth is not configured');
  const params = new URLSearchParams({
    client_key: cfg.clientKey,
    response_type: 'code',
    scope: cfg.scopes,
    redirect_uri: cfg.redirectUri,
    state,
  });
  const disableAutoAuth = cleanText(env.TIKTOK_DISABLE_AUTO_AUTH, 8);
  if (disableAutoAuth) params.set('disable_auto_auth', disableAutoAuth);
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

function formBody(values = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value != null && value !== '') params.set(key, String(value));
  }
  return params;
}

async function parseJsonResponse(response, fallbackMessage) {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = body.error_description || body.message || body.error || fallbackMessage;
    const err = new Error(message);
    err.status = response.status;
    err.payload = body;
    throw err;
  }
  return body;
}

export async function exchangeTikTokCode(code, { env = process.env, fetchImpl = fetch } = {}) {
  const cfg = tiktokOfficialConfig(env);
  if (!cfg.configured) throw new Error('TikTok OAuth is not configured');
  const response = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cache-Control': 'no-cache' },
    body: formBody({
      client_key: cfg.clientKey,
      client_secret: cfg.clientSecret,
      code,
      grant_type: 'authorization_code',
      redirect_uri: cfg.redirectUri,
    }),
  });
  const token = await parseJsonResponse(response, 'TikTok token exchange failed');
  if (!token.access_token || !token.open_id) throw new Error('TikTok token response was incomplete');
  return token;
}

export async function refreshTikTokToken(refreshToken, { env = process.env, fetchImpl = fetch } = {}) {
  const cfg = tiktokOfficialConfig(env);
  if (!cfg.configured) throw new Error('TikTok OAuth is not configured');
  const response = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cache-Control': 'no-cache' },
    body: formBody({
      client_key: cfg.clientKey,
      client_secret: cfg.clientSecret,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
  });
  const token = await parseJsonResponse(response, 'TikTok token refresh failed');
  if (!token.access_token || !token.open_id) throw new Error('TikTok refresh response was incomplete');
  return token;
}

export async function revokeTikTokToken(accessToken, { env = process.env, fetchImpl = fetch } = {}) {
  const cfg = tiktokOfficialConfig(env);
  if (!cfg.configured || !accessToken) return { skipped: true };
  const response = await fetchImpl(REVOKE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cache-Control': 'no-cache' },
    body: formBody({
      client_key: cfg.clientKey,
      client_secret: cfg.clientSecret,
      token: accessToken,
    }),
  });
  if (!response.ok) await parseJsonResponse(response, 'TikTok token revoke failed');
  return { skipped: false };
}

async function requestTikTokUserInfo(accessToken, fields, fetchImpl = fetch) {
  if (!accessToken) throw new Error('TikTok access token is required');
  const url = new URL(USER_INFO_URL);
  url.searchParams.set('fields', fields);
  const response = await fetchImpl(url.toString(), {
    method: 'GET',
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const body = await parseJsonResponse(response, 'TikTok profile fetch failed');
  const user = body?.data?.user || {};
  if (!user.open_id) throw new Error('TikTok profile response did not include open_id');
  return user;
}

export async function fetchTikTokUserInfo(accessToken, { fetchImpl = fetch } = {}) {
  try {
    return await requestTikTokUserInfo(accessToken, USER_FIELDS, fetchImpl);
  } catch (err) {
    const payloadText = JSON.stringify(err?.payload || {});
    if (err?.status === 401 || /scope|authorized|permission/i.test(payloadText)) {
      return requestTikTokUserInfo(accessToken, BASIC_USER_FIELDS, fetchImpl);
    }
    throw err;
  }
}

function encryptionKey(env = process.env) {
  const secret = env.TIKTOK_TOKEN_ENCRYPTION_SECRET || env.JWT_SECRET || '';
  return crypto.createHash('sha256').update(String(secret)).digest();
}

export function encryptTikTokToken(value, env = process.env) {
  const text = String(value || '');
  if (!text) return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(env), iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
}

export function decryptTikTokToken(value, env = process.env) {
  const text = String(value || '');
  if (!text) return '';
  const [version, ivText, tagText, encryptedText] = text.split(':');
  if (version !== 'v1' || !ivText || !tagText || !encryptedText) return '';
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(env), Buffer.from(ivText, 'base64'));
  decipher.setAuthTag(Buffer.from(tagText, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedText, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

function sqlDateFromNow(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value <= 0) return null;
  return new Date(Date.now() + value * 1000).toISOString().slice(0, 19).replace('T', ' ');
}

export function publicTikTokAccount(row = null) {
  if (!row || row.status !== 'connected') return null;
  return {
    linked: true,
    openId: row.tiktok_open_id || '',
    unionId: row.union_id || '',
    username: row.tiktok_username || '',
    profileDeepLink: row.profile_deep_link || '',
    displayName: row.display_name || '',
    avatarUrl: row.avatar_url || row.avatar_large_url || '',
    scopes: row.scopes || '',
    connectedAt: row.connected_at || row.created_at || null,
    updatedAt: row.updated_at || null,
  };
}

export function getLinkedTikTokAccount(db, userId) {
  if (!db || !userId) return null;
  return db.prepare("SELECT * FROM tiktok_accounts WHERE user_id = ? AND status = 'connected' ORDER BY updated_at DESC LIMIT 1").get(userId);
}

export function upsertLinkedTikTokAccount(db, userId, token, profile, env = process.env) {
  if (!db || !userId || !token?.open_id) throw new Error('Cannot store TikTok account without user and open_id');
  const openId = cleanText(profile?.open_id || token.open_id, 255);
  const unionId = cleanText(profile?.union_id || '', 255);
  const displayName = cleanText(profile?.display_name || '', 255);
  const tiktokUsername = deriveTikTokUsername(profile);
  const profileDeepLink = cleanText(profile?.profile_deep_link || '', 1000);
  const avatarUrl = cleanText(profile?.avatar_url || profile?.avatar_url_100 || '', 1000);
  const avatarLargeUrl = cleanText(profile?.avatar_large_url || profile?.avatar_url || '', 1000);
  const scopes = cleanText(token.scope || '', 1000);
  const accessTokenCiphertext = encryptTikTokToken(token.access_token, env);
  const refreshTokenCiphertext = encryptTikTokToken(token.refresh_token, env);
  const accessTokenExpiresAt = sqlDateFromNow(token.expires_in);
  const refreshTokenExpiresAt = sqlDateFromNow(token.refresh_expires_in);

  db.prepare(`
    INSERT INTO tiktok_accounts (
      user_id, tiktok_open_id, union_id, display_name, avatar_url, avatar_large_url, scopes,
      tiktok_username, profile_deep_link,
      access_token_ciphertext, refresh_token_ciphertext, access_token_expires_at, refresh_token_expires_at,
      status, connected_at, disconnected_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'connected', CURRENT_TIMESTAMP, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT (user_id) DO UPDATE SET
      tiktok_open_id = excluded.tiktok_open_id,
      union_id = excluded.union_id,
      display_name = excluded.display_name,
      avatar_url = excluded.avatar_url,
      avatar_large_url = excluded.avatar_large_url,
      scopes = excluded.scopes,
      tiktok_username = excluded.tiktok_username,
      profile_deep_link = excluded.profile_deep_link,
      access_token_ciphertext = excluded.access_token_ciphertext,
      refresh_token_ciphertext = excluded.refresh_token_ciphertext,
      access_token_expires_at = excluded.access_token_expires_at,
      refresh_token_expires_at = excluded.refresh_token_expires_at,
      status = 'connected',
      connected_at = CURRENT_TIMESTAMP,
      disconnected_at = NULL,
      updated_at = CURRENT_TIMESTAMP
  `).run(
    userId,
    openId,
    unionId,
    displayName,
    avatarUrl,
    avatarLargeUrl,
    scopes,
    tiktokUsername,
    profileDeepLink,
    accessTokenCiphertext,
    refreshTokenCiphertext,
    accessTokenExpiresAt,
    refreshTokenExpiresAt
  );
  if (tiktokUsername) {
    db.prepare('UPDATE users SET tiktok_username = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(tiktokUsername, userId);
  }
  return getLinkedTikTokAccount(db, userId);
}

export function markTikTokAccountDisconnected(db, userId, reason = 'user_disconnect') {
  if (!db || !userId) return null;
  db.prepare(`
    UPDATE tiktok_accounts
    SET status = 'disconnected',
        disconnect_reason = ?,
        disconnected_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
    WHERE user_id = ? AND status = 'connected'
  `).run(cleanText(reason, 120), userId);
  return null;
}

export function markTikTokOpenIdDisconnected(db, openId, reason = 'authorization_removed') {
  if (!db || !openId) return null;
  db.prepare(`
    UPDATE tiktok_accounts
    SET status = 'disconnected',
        disconnect_reason = ?,
        disconnected_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
    WHERE tiktok_open_id = ? AND status = 'connected'
  `).run(cleanText(reason, 120), cleanText(openId, 255));
  return null;
}

export function accessTokenForAccount(row, env = process.env) {
  return decryptTikTokToken(row?.access_token_ciphertext || '', env);
}
