import net from 'node:net';
import tls from 'node:tls';
import { URL } from 'node:url';

import dotenv from 'dotenv';
import { Client } from 'pg';

dotenv.config({ path: '.env', quiet: true });

function hasArg(name) {
  return process.argv.includes(name);
}

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : '';
}

function normalizeOrigin(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  return new URL(text).origin;
}

function databaseUrl() {
  return process.env.DATABASE_URL || process.env.PG_CONNECTION_STRING || process.env.PG_CONN_STRING || '';
}

function redactDatabaseUrl(raw) {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.username) url.username = '<user>';
    if (url.password) url.password = '<password>';
    return {
      protocol: url.protocol,
      host: url.hostname,
      port: url.port || '5432',
      database: decodeURIComponent(url.pathname.replace(/^\//, '')) || null,
      sslMode: url.searchParams.get('sslmode') || process.env.PGSSLMODE || null,
      redacted: url.toString(),
    };
  } catch (err) {
    return { invalid: true, error: err.message };
  }
}

function status(ok, warn = false) {
  if (ok) return 'pass';
  return warn ? 'warn' : 'fail';
}

function tcpProbe(host, port, timeoutMs = 8000) {
  return new Promise(resolve => {
    const started = Date.now();
    const socket = net.createConnection({ host, port: Number(port), timeout: timeoutMs });
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ ...result, ms: Date.now() - started });
    };
    socket.once('connect', () => finish({ ok: true }));
    socket.once('timeout', () => finish({ ok: false, reason: 'timeout' }));
    socket.once('error', err => finish({ ok: false, reason: err.code || err.message }));
  });
}

function httpsTlsProbe(host, port = 443, timeoutMs = 8000) {
  return new Promise(resolve => {
    const started = Date.now();
    const socket = tls.connect({ host, port: Number(port), servername: host, timeout: timeoutMs, rejectUnauthorized: true });
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ ...result, ms: Date.now() - started });
    };
    socket.once('secureConnect', () => {
      const cert = socket.getPeerCertificate();
      finish({
        ok: true,
        authorized: socket.authorized,
        protocol: socket.getProtocol(),
        cipher: socket.getCipher()?.name || null,
        certSubject: cert?.subject?.CN || null,
        certValidTo: cert?.valid_to || null,
      });
    });
    socket.once('timeout', () => finish({ ok: false, reason: 'timeout' }));
    socket.once('error', err => finish({ ok: false, reason: err.code || err.message }));
  });
}

function postgresSslRequest(host, port, timeoutMs = 8000) {
  return new Promise(resolve => {
    const started = Date.now();
    const socket = net.createConnection({ host, port: Number(port), timeout: timeoutMs });
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ ...result, ms: Date.now() - started });
    };
    socket.once('connect', () => {
      const request = Buffer.alloc(8);
      request.writeInt32BE(8, 0);
      request.writeInt32BE(80877103, 4);
      socket.write(request);
    });
    socket.once('data', chunk => {
      const byte = chunk.slice(0, 1).toString('utf8');
      finish({ ok: byte === 'S', response: byte || chunk.toString('hex') });
    });
    socket.once('timeout', () => finish({ ok: false, reason: 'timeout' }));
    socket.once('error', err => finish({ ok: false, reason: err.code || err.message }));
    socket.once('end', () => finish({ ok: false, reason: 'remote ended without response' }));
  });
}

function postgresTlsProbe(host, port, timeoutMs = 8000) {
  return new Promise(resolve => {
    const started = Date.now();
    const socket = net.createConnection({ host, port: Number(port), timeout: timeoutMs });
    let settled = false;
    const finish = (result, stream = socket) => {
      if (settled) return;
      settled = true;
      try { stream.destroy(); } catch (_err) {}
      resolve({ ...result, ms: Date.now() - started });
    };
    socket.once('connect', () => {
      const request = Buffer.alloc(8);
      request.writeInt32BE(8, 0);
      request.writeInt32BE(80877103, 4);
      socket.write(request);
    });
    socket.once('data', chunk => {
      if (chunk.slice(0, 1).toString('utf8') !== 'S') {
        finish({ ok: false, stage: 'ssl-request', response: chunk.toString('hex') });
        return;
      }
      socket.removeAllListeners();
      const secure = tls.connect({ socket, servername: host, rejectUnauthorized: true, timeout: timeoutMs });
      secure.once('secureConnect', () => {
        const cert = secure.getPeerCertificate();
        finish({
          ok: true,
          authorized: secure.authorized,
          protocol: secure.getProtocol(),
          cipher: secure.getCipher()?.name || null,
          certSubject: cert?.subject?.CN || null,
          certValidTo: cert?.valid_to || null,
        }, secure);
      });
      secure.once('timeout', () => finish({ ok: false, stage: 'tls', reason: 'timeout' }, secure));
      secure.once('error', err => finish({ ok: false, stage: 'tls', reason: err.code || err.message }, secure));
    });
    socket.once('timeout', () => finish({ ok: false, stage: 'tcp', reason: 'timeout' }));
    socket.once('error', err => finish({ ok: false, stage: 'tcp', reason: err.code || err.message }));
  });
}

async function postgresQueryProbe(raw) {
  if (!raw) return { ok: false, skipped: true, reason: 'database URL is not configured' };
  const client = new Client({
    connectionString: raw,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 8000,
    query_timeout: 8000,
    statement_timeout: 8000,
    application_name: 'intothebattle_connection_diagnostics',
  });
  const started = Date.now();
  try {
    await client.connect();
    const result = await client.query(`
      SELECT
        current_database() AS database,
        current_user AS user_name,
        now() AS server_time
    `);
    return { ok: true, ms: Date.now() - started, ...result.rows[0] };
  } catch (err) {
    return {
      ok: false,
      ms: Date.now() - started,
      code: err.code || null,
      reason: err.message,
    };
  } finally {
    await client.end().catch(() => {});
  }
}

async function httpProbe(baseUrl, pathname, expected = [200]) {
  const started = Date.now();
  try {
    const response = await fetch(`${baseUrl}${pathname}`, { redirect: 'manual' });
    return {
      ok: expected.includes(response.status),
      status: response.status,
      ms: Date.now() - started,
      location: response.headers.get('location') || null,
      contentType: response.headers.get('content-type') || null,
    };
  } catch (err) {
    return { ok: false, ms: Date.now() - started, reason: err.code || err.message };
  }
}

function printLine(entry) {
  const label = entry.label.padEnd(28);
  const icon = entry.status.toUpperCase().padEnd(4);
  const detail = entry.detail ? ` ${entry.detail}` : '';
  console.log(`${icon} ${label}${detail}`);
}

const strict = hasArg('--strict');
const rawDbUrl = databaseUrl();
const redactedDb = redactDatabaseUrl(rawDbUrl);
const baseUrl = normalizeOrigin(argValue('--url') || process.env.PRODUCTION_SMOKE_URL || process.env.APP_BASE_URL || 'https://intothebattle.com');
const appUrl = new URL(baseUrl);
const dbHost = redactedDb?.host;
const dbPort = redactedDb?.port || '5432';

const checks = [];
checks.push({
  label: 'base URL',
  status: status(appUrl.protocol === 'https:'),
  detail: baseUrl,
});

const appTls = await httpsTlsProbe(appUrl.hostname, appUrl.port || 443);
checks.push({
  label: 'app TLS',
  status: status(appTls.ok && appTls.authorized),
  detail: appTls.ok ? `${appTls.protocol}, cert ${appTls.certSubject}, valid to ${appTls.certValidTo}` : appTls.reason,
});

for (const [pathname, expected] of [
  ['/healthz', [200]],
  ['/', [200]],
  ['/api/public/blog-posts?limit=1', [200]],
  ['/api/runtime/diagnostics', [401]],
]) {
  const result = await httpProbe(baseUrl, pathname, expected);
  checks.push({
    label: `HTTP ${pathname}`,
    status: status(result.ok),
    detail: result.ok ? `${result.status} in ${result.ms}ms` : `${result.status || 'error'} ${result.location || result.reason || ''}`.trim(),
  });
}

checks.push({
  label: 'database URL',
  status: status(Boolean(redactedDb && !redactedDb.invalid)),
  detail: redactedDb?.invalid ? redactedDb.error : (redactedDb ? `${redactedDb.host}/${redactedDb.database}` : 'missing'),
});

if (dbHost) {
  const dbTcp = await tcpProbe(dbHost, dbPort);
  checks.push({
    label: 'database TCP',
    status: status(dbTcp.ok),
    detail: dbTcp.ok ? `${dbHost}:${dbPort} in ${dbTcp.ms}ms` : dbTcp.reason,
  });

  const sslRequest = await postgresSslRequest(dbHost, dbPort);
  checks.push({
    label: 'Postgres SSLRequest',
    status: status(sslRequest.ok),
    detail: sslRequest.ok ? `accepted SSL (${sslRequest.response}) in ${sslRequest.ms}ms` : (sslRequest.reason || sslRequest.response),
  });

  const pgTls = await postgresTlsProbe(dbHost, dbPort);
  checks.push({
    label: 'Postgres TLS',
    status: status(pgTls.ok && pgTls.authorized),
    detail: pgTls.ok ? `${pgTls.protocol}, cert ${pgTls.certSubject}, valid to ${pgTls.certValidTo}` : (pgTls.reason || pgTls.stage),
  });
}

const pgQuery = await postgresQueryProbe(rawDbUrl);
checks.push({
  label: 'Postgres auth/query',
  status: status(pgQuery.ok, true),
  detail: pgQuery.ok
    ? `${pgQuery.database} as ${pgQuery.user_name} in ${pgQuery.ms}ms`
    : `${pgQuery.reason || 'skipped'}${pgQuery.skipped ? '' : ' (external DB access may be blocked or credentials may be stale)'}`,
});

console.log(`IntoTheBattle connection diagnostics for ${baseUrl}`);
console.log('');
for (const check of checks) printLine(check);
console.log('');
console.log('Sanitized database target:');
console.log(JSON.stringify(redactedDb, null, 2));

const failures = checks.filter(check => check.status === 'fail');
const warnings = checks.filter(check => check.status === 'warn');
if (strict && (failures.length || warnings.length)) {
  process.exitCode = 1;
}
