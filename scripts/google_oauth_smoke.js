import assert from 'node:assert/strict';

process.env.SKIP_DB = 'true';
process.env.JWT_SECRET = 'google-oauth-smoke-secret';

const {
  createOAuthState,
  fetchGoogleProfile,
  getCookieOptions,
  getGoogleRedirectUri,
  getGoogleTokenUrl,
  getGoogleUserInfoUrl,
  getOAuthStatePayload,
  getSharedCookieDomain,
} = await import('../tiktokbr/routes/auth.js');

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const configuredRedirect = getGoogleRedirectUri(null, {
  GOOGLE_OAUTH_REDIRECT_URI: ' https://intothebattle.com/auth/google/callback ',
});
assert.equal(configuredRedirect, 'https://intothebattle.com/auth/google/callback');

const forwardedReq = {
  protocol: 'http',
  get(name) {
    const headers = {
      'x-forwarded-host': 'www.intothebattle.com',
      'x-forwarded-proto': 'https',
    };
    return headers[String(name).toLowerCase()] || '';
  },
};
assert.equal(
  getGoogleRedirectUri(forwardedReq, {}),
  'https://www.intothebattle.com/auth/google/callback',
  'Google redirect fallback should respect forwarded production host/protocol'
);

assert.equal(getGoogleTokenUrl({}), 'https://oauth2.googleapis.com/token');
assert.equal(getGoogleUserInfoUrl({}), 'https://openidconnect.googleapis.com/v1/userinfo');

assert.equal(
  getSharedCookieDomain({
    APP_BASE_URL: 'https://www.intothebattle.com',
    GOOGLE_OAUTH_REDIRECT_URI: 'https://intothebattle.com/auth/google/callback',
  }),
  'intothebattle.com',
  'apex/www Google OAuth should share the state/session cookie domain'
);
assert.equal(
  getSharedCookieDomain({ COOKIE_DOMAIN: '.example.com', APP_BASE_URL: 'https://www.example.com' }),
  'example.com',
  'explicit cookie domain should be normalized'
);
assert.equal(
  getSharedCookieDomain({ APP_BASE_URL: 'http://localhost:3000' }),
  '',
  'localhost should keep host-only cookies'
);
assert.deepEqual(
  getCookieOptions(true, {
    NODE_ENV: 'production',
    APP_BASE_URL: 'https://www.intothebattle.com',
    GOOGLE_OAUTH_REDIRECT_URI: 'https://intothebattle.com/auth/google/callback',
  }),
  {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: true,
    domain: 'intothebattle.com',
  }
);

const safeState = createOAuthState('/dashboard?welcome=1');
assert.equal(getOAuthStatePayload(safeState).next, '/dashboard?welcome=1');
const unsafeState = createOAuthState('https://evil.example/dashboard');
assert.equal(
  getOAuthStatePayload(unsafeState).next,
  '/dashboard?welcome=1',
  'Google OAuth state should reject absolute redirect targets'
);
assert.equal(getOAuthStatePayload(`${safeState}x`), null, 'tampered Google OAuth state should fail');

let userInfoCall = null;
const profile = await fetchGoogleProfile('profile-token-smoke', {
  env: { GOOGLE_OAUTH_USERINFO_URL: 'https://identity.test/userinfo' },
  fetchImpl: async (url, options = {}) => {
    userInfoCall = { url: String(url), authorization: options.headers?.Authorization };
    return jsonResponse({
      email: 'Creator@Example.COM',
      email_verified: true,
      name: 'Smoke Creator',
    });
  },
});
assert.equal(userInfoCall.url, 'https://identity.test/userinfo');
assert.equal(userInfoCall.authorization, 'Bearer profile-token-smoke');
assert.equal(profile.email, 'Creator@Example.COM');
assert.equal(profile.email_verified, true);

console.log('Google OAuth smoke checks passed');
