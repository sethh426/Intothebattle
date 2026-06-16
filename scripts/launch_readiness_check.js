import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { getEmailDiagnostics } from '../tiktokbr/email/postmarkMailer.js';
import { getSponsorMediaToolStatus } from '../tiktokbr/sponsorMediaProcessor.js';
import { buildLaunchReadinessReport } from '../tiktokbr/services/launchReadiness.js';
import { getStorageUsage } from '../tiktokbr/services/storagePolicy.js';

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : '';
}

function hasArg(name) {
  return process.argv.includes(name);
}

function normalizeUrl(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  try {
    return new URL(text).origin;
  } catch (_err) {
    throw new Error(`Invalid URL: ${text}`);
  }
}

async function fetchRemoteReport(baseUrl, token) {
  const url = new URL('/api/runtime/launch-readiness', baseUrl);
  if (token) url.searchParams.set('token', token);
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  const response = await fetch(url, { headers });
  let body;
  try {
    body = await response.json();
  } catch (_err) {
    throw new Error(`Remote readiness endpoint returned ${response.status} but not JSON.`);
  }
  if (!response.ok && !body?.checks) {
    throw new Error(`Remote readiness endpoint returned ${response.status}: ${JSON.stringify(body)}`);
  }
  return body;
}

function localStorageSnapshot() {
  const fallbackRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'intothebattle-launch-check-'));
  const root = process.env.DISK_PATH || fallbackRoot;
  try {
    fs.mkdirSync(root, { recursive: true });
    const probePath = path.join(root, `.launch-check-${Date.now()}.tmp`);
    fs.writeFileSync(probePath, 'ok');
    fs.unlinkSync(probePath);
    return { ok: true, root, usage: getStorageUsage(root) };
  } catch (err) {
    return { ok: false, root, error: err?.message || String(err), usage: getStorageUsage(root) };
  } finally {
    if (!process.env.DISK_PATH) {
      try { fs.rmSync(fallbackRoot, { recursive: true, force: true }); } catch (_err) {}
    }
  }
}

function localDatabaseSnapshot() {
  const skipDb = process.env.SKIP_DB === 'true';
  if (skipDb) return { mode: 'stub', initialized: true };
  if (!process.env.DATABASE_URL) return { mode: 'missing', initialized: false, lastError: 'DATABASE_URL is not set.' };
  return { mode: 'postgres', initialized: true };
}

function renderReport(report, source) {
  const lines = [];
  lines.push(`IntoTheBattle launch readiness (${source})`);
  lines.push(`Summary: ${report.summary?.passed || 0} pass, ${report.summary?.warnings || 0} warn, ${report.summary?.failures || 0} fail`);
  lines.push(`Launch ready: ${report.launchReady ? 'yes' : 'no'}`);
  lines.push('');

  const rank = { fail: 0, warn: 1, pass: 2 };
  const checks = [...(report.checks || [])].sort((a, b) => (rank[a.status] ?? 9) - (rank[b.status] ?? 9));
  for (const check of checks) {
    const status = String(check.status || '').toUpperCase();
    lines.push(`${status.padEnd(4)} [${check.category}] ${check.label}`);
    if (check.details) lines.push(`     ${check.details}`);
    if (check.status !== 'pass' && check.action) lines.push(`     action: ${check.action}`);
  }
  return lines.join('\n');
}

const strict = hasArg('--strict');
const warningsAsErrors = hasArg('--warnings-as-errors');
const remoteBaseUrl = normalizeUrl(argValue('--url') || process.env.LAUNCH_READINESS_URL || '');
const token = argValue('--token') || process.env.LAUNCH_READINESS_TOKEN || process.env.DIAGNOSTICS_TOKEN || '';

try {
  const report = remoteBaseUrl
    ? await fetchRemoteReport(remoteBaseUrl, token)
    : buildLaunchReadinessReport({
        env: process.env,
        storage: localStorageSnapshot(),
        database: localDatabaseSnapshot(),
        email: getEmailDiagnostics(),
        sponsorTools: getSponsorMediaToolStatus(),
      });

  console.log(renderReport(report, remoteBaseUrl || 'local environment'));

  const hasFailures = Number(report.summary?.failures || 0) > 0;
  const hasWarnings = Number(report.summary?.warnings || 0) > 0;
  if ((strict && hasFailures) || (warningsAsErrors && (hasFailures || hasWarnings))) {
    process.exitCode = 1;
  }
} catch (err) {
  console.error(err?.stack || err);
  process.exitCode = 1;
}
