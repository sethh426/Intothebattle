import assert from 'node:assert/strict';

import {
  accessTokenForAccount,
  buildTikTokAuthorizationUrl,
  createTikTokOAuthState,
  decryptTikTokToken,
  encryptTikTokToken,
  exchangeTikTokCode,
  fetchTikTokUserInfo,
  getLinkedTikTokAccount,
  markTikTokAccountDisconnected,
  publicTikTokAccount,
  refreshTikTokToken,
  revokeTikTokToken,
  shouldRequireTikTokAccountForLive,
  tiktokOfficialConfig,
  upsertLinkedTikTokAccount,
  verifyTikTokOAuthState,
} from '../tiktokbr/services/tiktokOfficialAuth.js';

const env = {
  NODE_ENV: 'production',
  JWT_SECRET: 'tiktok-oauth-smoke-jwt-secret',
  APP_BASE_URL: 'https://intothebattle.test',
  TIKTOK_CLIENT_KEY: 'client-key-smoke',
  TIKTOK_CLIENT_SECRET: 'client-secret-smoke',
  TIKTOK_APP_ID: 'app-id-smoke',
  TIKTOK_REDIRECT_URI: 'https://intothebattle.test/auth/tiktok/callback',
  TIKTOK_SCOPES: 'user.info.basic,user.info.profile',
  TIKTOK_LIVE_EVENT_PROVIDER: 'legacy',
  TIKTOK_TOKEN_ENCRYPTION_SECRET: 'token-encryption-smoke-secret',
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function fakeDb() {
  const table = new Map();
  return {
    prepare(sql) {
      return {
        get(userId) {
          if (/WHERE user_id = \?/i.test(sql)) {
            const row = table.get(Number(userId));
            return row?.status === 'connected' ? row : null;
          }
          return null;
        },
        run(...params) {
          if (/INSERT INTO tiktok_accounts/i.test(sql)) {
            const [
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
              refreshTokenExpiresAt,
            ] = params;
            table.set(Number(userId), {
              id: 1,
              user_id: Number(userId),
              tiktok_open_id: openId,
              union_id: unionId,
              tiktok_username: tiktokUsername,
              profile_deep_link: profileDeepLink,
              display_name: displayName,
              avatar_url: avatarUrl,
              avatar_large_url: avatarLargeUrl,
              scopes,
              access_token_ciphertext: accessTokenCiphertext,
              refresh_token_ciphertext: refreshTokenCiphertext,
              access_token_expires_at: accessTokenExpiresAt,
              refresh_token_expires_at: refreshTokenExpiresAt,
              status: 'connected',
              connected_at: '2026-07-06 00:00:00',
              updated_at: '2026-07-06 00:00:00',
            });
          }
          if (/UPDATE tiktok_accounts/i.test(sql) && /WHERE user_id = \?/i.test(sql)) {
            const userId = Number(params[1]);
            const row = table.get(userId);
            if (row) {
              row.status = 'disconnected';
              row.disconnect_reason = params[0];
            }
          }
          if (/UPDATE users SET tiktok_username/i.test(sql)) return { rowCount: 1 };
          return { rowCount: 1 };
        },
      };
    },
  };
}

const cfg = tiktokOfficialConfig(env);
assert.equal(cfg.configured, true, 'TikTok official config should be complete');
assert.equal(cfg.provider, 'legacy', 'legacy provider should remain explicit');
assert.equal(shouldRequireTikTokAccountForLive(env), true, 'production with official credentials should require account link by default');
assert.equal(shouldRequireTikTokAccountForLive({ ...env, TIKTOK_REQUIRE_ACCOUNT_LINK_FOR_LIVE: 'false' }), false, 'explicit false should disable live account-link requirement');

const state = createTikTokOAuthState({ userId: 42, next: '/dashboard' }, env);
const statePayload = verifyTikTokOAuthState(state, env);
assert.equal(statePayload.userId, 42, 'state should preserve user id');
assert.equal(statePayload.next, '/dashboard', 'state should preserve safe next path');
assert.equal(verifyTikTokOAuthState(`${state}x`, env), null, 'tampered state should fail');

const authUrl = new URL(buildTikTokAuthorizationUrl(state, env));
assert.equal(authUrl.origin + authUrl.pathname, 'https://www.tiktok.com/v2/auth/authorize/');
assert.equal(authUrl.searchParams.get('client_key'), 'client-key-smoke');
assert.equal(authUrl.searchParams.get('scope'), 'user.info.basic,user.info.profile');
assert.equal(authUrl.searchParams.get('redirect_uri'), 'https://intothebattle.test/auth/tiktok/callback');
assert.equal(authUrl.searchParams.get('state'), state);

const calls = [];
const fetchImpl = async (url, options = {}) => {
  calls.push({ url: String(url), body: String(options.body || '') });
  if (String(url).includes('/v2/oauth/token/') && String(options.body).includes('authorization_code')) {
    return jsonResponse({
      access_token: 'access-token-smoke',
      refresh_token: 'refresh-token-smoke',
      open_id: 'open-id-smoke',
      scope: 'user.info.basic,user.info.profile',
      expires_in: 86400,
      refresh_expires_in: 31536000,
      token_type: 'Bearer',
    });
  }
  if (String(url).includes('/v2/oauth/token/') && String(options.body).includes('refresh_token')) {
    return jsonResponse({
      access_token: 'access-token-refreshed',
      refresh_token: 'refresh-token-refreshed',
      open_id: 'open-id-smoke',
      scope: 'user.info.basic,user.info.profile',
      expires_in: 86400,
      refresh_expires_in: 31536000,
      token_type: 'Bearer',
    });
  }
  if (String(url).includes('/v2/user/info/')) {
    return jsonResponse({
      data: {
        user: {
          open_id: 'open-id-smoke',
          union_id: 'union-id-smoke',
          display_name: 'Smoke Creator',
          username: 'smoke_creator',
          profile_deep_link: 'https://www.tiktok.com/@smoke_creator',
          avatar_url: 'https://example.test/avatar.jpg',
          avatar_large_url: 'https://example.test/avatar-large.jpg',
        },
      },
      error: { code: 'ok', message: '' },
    });
  }
  if (String(url).includes('/v2/oauth/revoke/')) {
    return new Response('', { status: 200 });
  }
  return jsonResponse({ error: 'not_found' }, 404);
};

const token = await exchangeTikTokCode('auth-code-smoke', { env, fetchImpl });
assert.equal(token.open_id, 'open-id-smoke');
assert.match(calls[0].body, /grant_type=authorization_code/);
assert.match(calls[0].body, /client_secret=client-secret-smoke/);

const refreshed = await refreshTikTokToken('refresh-token-smoke', { env, fetchImpl });
assert.equal(refreshed.access_token, 'access-token-refreshed');

const profile = await fetchTikTokUserInfo(token.access_token, { fetchImpl });
assert.equal(profile.display_name, 'Smoke Creator');
assert.equal(profile.username, 'smoke_creator');
const userInfoCall = calls.find(call => String(call.url).includes('/v2/user/info/'));
assert.ok(new URL(userInfoCall.url).searchParams.get('fields').includes('username'), 'profile fetch should request TikTok username');

const encrypted = encryptTikTokToken('secret-token-value', env);
assert.notEqual(encrypted, 'secret-token-value');
assert.equal(decryptTikTokToken(encrypted, env), 'secret-token-value');

const db = fakeDb();
const linked = upsertLinkedTikTokAccount(db, 42, token, profile, env);
assert.equal(linked.tiktok_open_id, 'open-id-smoke');
assert.equal(linked.tiktok_username, 'smoke_creator');
assert.equal(accessTokenForAccount(linked, env), 'access-token-smoke');
assert.equal(publicTikTokAccount(linked).displayName, 'Smoke Creator');
assert.equal(publicTikTokAccount(linked).username, 'smoke_creator');
assert.equal(getLinkedTikTokAccount(db, 42).display_name, 'Smoke Creator');

await revokeTikTokToken(accessTokenForAccount(linked, env), { env, fetchImpl });
assert.match(calls.at(-1).body, /token=access-token-smoke/);
markTikTokAccountDisconnected(db, 42, 'smoke_disconnect');
assert.equal(getLinkedTikTokAccount(db, 42), null, 'disconnected TikTok account should not be public linked account');

console.log('TikTok official auth smoke checks passed');
