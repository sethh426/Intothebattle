import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const contractPath = path.join(root, 'config', 'route-security-contract.json');
const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const admin = fs.readFileSync(path.join(root, 'tiktokbr', 'routes', 'admin.js'), 'utf8');
const paypal = fs.readFileSync(path.join(root, 'tiktokbr', 'routes', 'paypal.js'), 'utf8');
const authRoutes = fs.readFileSync(path.join(root, 'tiktokbr', 'routes', 'auth.js'), 'utf8');
const sessionAuth = fs.readFileSync(path.join(root, 'tiktokbr', 'services', 'sessionAuth.js'), 'utf8');

function routeLiteral(pathname) {
  return pathname.replace(/:[A-Za-z0-9_]+/g, '');
}

function routeLiteralCandidates(pathname, sourceName) {
  const literal = routeLiteral(pathname);
  const candidates = [literal, pathname];
  if (sourceName === 'admin' && literal.startsWith('/admin')) {
    candidates.push(literal.slice('/admin'.length) || '/');
  }
  if (sourceName === 'admin' && pathname.startsWith('/admin')) {
    candidates.push(pathname.slice('/admin'.length) || '/');
  }
  return candidates;
}

assert.equal(contract.csrfEquivalent?.sameOriginMutationGuard, true, 'route contract must require same-origin mutation guard');
assert.equal(contract.csrfEquivalent?.adminSameSiteCookie, 'strict', 'admin cookies must stay SameSite=strict');
assert.match(server, /Blocked cross-origin state-changing request/, 'server must enforce same-origin state-changing browser requests');
assert.match(server, /function verifyTikTokWebhookSignature/, 'TikTok webhooks must verify TikTok-Signature HMAC');
assert.match(server, /crypto\.timingSafeEqual/, 'TikTok webhook signature comparison must be timing safe');
assert.match(admin, /sameSite:\s*'strict'/, 'admin session cookie must remain SameSite=strict');
assert.match(admin, /requireAdminMutationOrigin/, 'admin router must enforce explicit admin mutation origin checks');
assert.match(paypal, /verifyPayPalWebhook/, 'PayPal webhook must verify provider signatures');
assert.match(server, /function blockInProduction/, 'dev and test routes must have a production block helper');
assert.match(sessionAuth, /USER_SESSION_PURPOSE = 'user_session'/, 'user sessions must carry a typed purpose claim');
assert.match(sessionAuth, /ACCESS_CODE_SESSION_PURPOSE = 'access_code_session'/, 'legacy code sessions must carry a typed purpose claim');
assert.match(sessionAuth, /WHERE id = \? AND session_token = \?/, 'user session lookup must bind the JWT user id and token');
assert.match(sessionAuth, /WHERE UPPER\(code\) = \? AND session_token = \?/, 'access-code session lookup must bind the JWT code and token');
assert.match(sessionAuth, /tokenId:/, 'session tokens must include a unique token id');
assert.match(sessionAuth, /jti:/, 'session tokens must include a JWT id');
assert.match(authRoutes, /function clearCookieVariants/, 'auth routes must clear host-only and domain-scoped cookie variants');
assert.match(authRoutes, /clearSessionCookie\(res\);\s*res\.cookie\('session_token'/, 'session cookie writers must clear old variants before setting a new token');
assert.match(server, /clearCookieVariants\(res, 'session_token', true\)/, 'server-level auth redirects must clear old session cookie variants');
assert.doesNotMatch(server, /logger\.error\(\{\s*err,\s*token\s*\}/, 'auth logs must not include raw session tokens');
assert.match(server, /const TIKTOK_RECENT_PLAYER_RESTORE_ENABLED = process\.env\.TIKTOK_RECENT_PLAYER_RESTORE_ENABLED === 'true'/, 'recent player restore must be opt-in');
assert.match(server, /restoreRecentPlayers:\s*false/, 'TikTok reconnects must not restore old players by default');
assert.doesNotMatch(server, /restoreRecentPlayers:\s*true/, 'TikTok reconnects must not opt into stale player restore');
assert.match(server, /closeSupersededLiveSessions\(room\.roomId, session\.sessionId/, 'new live sessions must close older active room sessions');
assert.doesNotMatch(admin, /DELETE\s+FROM\s+users/i, 'admin routes must not delete user accounts');
assert.doesNotMatch(admin, /action=["']\/admin\/users\/[^"']*delete/i, 'admin UI must not render user account delete forms');
assert.match(admin, /function denyAccountDelete/, 'admin routes must explicitly deny user account deletion attempts');
assert.match(admin, /\/comments\/:id\/delete/, 'admin comment delete route should remain available');
assert.match(admin, /\/blog\/:id\/delete/, 'admin blog delete route should remain available');
assert.match(admin, /\/sponsors\/:id\/delete/, 'admin sponsor creative delete route should remain available');

const endpoints = contract.endpoints || [];
assert.ok(endpoints.length >= 20, 'route contract should cover critical production routes');

for (const endpoint of endpoints) {
  assert.ok(endpoint.method, `contract endpoint is missing method: ${JSON.stringify(endpoint)}`);
  assert.ok(endpoint.path, `contract endpoint is missing path: ${JSON.stringify(endpoint)}`);
  assert.ok(endpoint.access, `${endpoint.method} ${endpoint.path} is missing access policy`);
  assert.ok(endpoint.production, `${endpoint.method} ${endpoint.path} is missing production policy`);

  const source = endpoint.path.startsWith('/admin') ? admin : endpoint.path.includes('/paypal') ? paypal : server;
  const sourceName = endpoint.path.startsWith('/admin') ? 'admin' : endpoint.path.includes('/paypal') ? 'paypal' : 'server';
  const candidates = routeLiteralCandidates(endpoint.path, sourceName);
  assert.ok(candidates.some(literal => source.includes(literal)), `${endpoint.method} ${endpoint.path} is not present in the expected source file`);

  if (endpoint.category === 'admin-mutation') {
    assert.match(endpoint.access, /same-origin-mutation/, `${endpoint.path} must name same-origin mutation protection`);
  }
  if (endpoint.category === 'development') {
    assert.equal(endpoint.production, 'disabled', `${endpoint.path} must be disabled in production`);
  }
  if (endpoint.category === 'overlay' || endpoint.category === 'overlay-media' || endpoint.category === 'overlay-state') {
    assert.match(endpoint.access, /signed-room-overlay-token/, `${endpoint.path} must require a signed room overlay token`);
  }
}

console.log('Route security contract checks passed');
