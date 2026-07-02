import assert from 'node:assert/strict';

import { getEmailDiagnostics } from '../tiktokbr/email/postmarkMailer.js';
import { buildLaunchReadinessReport } from '../tiktokbr/services/launchReadiness.js';

function productionEnv(overrides = {}) {
  return {
    NODE_ENV: 'production',
    APP_BASE_URL: 'https://intothebattle.com',
    API_KEY: 'tiktok-live-api-key',
    JWT_SECRET: 'long-session-secret',
    OVERLAY_TOKEN_SECRET: 'long-overlay-secret',
    DIAGNOSTICS_TOKEN: 'diagnostics-token',
    METRICS_TOKEN: 'metrics-token',
    DATABASE_URL: 'postgres://user:pass@db.example.com/intothebattle',
    SKIP_DB: 'false',
    POSTMARK_API_TOKEN: 'postmark-token',
    POSTMARK_MESSAGE_STREAM: 'outbound',
    EMAIL_FROM: 'IntoTheBattle <no-reply@intothebattle.com>',
    EMAIL_REPLY_TO: 'support@intothebattle.com',
    PAYPAL_CLIENT_ID: 'paypal-client',
    PAYPAL_CLIENT_SECRET: 'paypal-secret',
    PAYPAL_MODE: 'live',
    PAYPAL_PLAN_ID: 'P-COMPANYSTANDARD',
    PAYPAL_WEBHOOK_ID: 'WH-COMPANYSTANDARD',
    GOOGLE_CLIENT_ID: 'google-client',
    GOOGLE_CLIENT_SECRET: 'google-secret',
    GOOGLE_OAUTH_REDIRECT_URI: 'https://intothebattle.com/auth/google/callback',
    SPONSOR_STRICT_MEDIA_GATE: 'true',
    SENTRY_DSN: 'https://public@example.ingest.sentry.io/1',
    SUPPORT_EMAIL: 'support@intothebattle.com',
    INCIDENT_RUNBOOK_URL: 'https://intothebattle.com/admin/runbooks/incident-response',
    OPERATIONS_ALERT_EMAIL: 'ops@intothebattle.com',
    BACKUP_RESTORE_VERIFIED_AT: new Date().toISOString(),
    REDIS_URL: 'redis://redis.example.com:6379',
    ENABLE_REDIS_ADAPTER: 'true',
    ...overrides,
  };
}

function reportFor(env) {
  const previousEnv = { ...process.env };
  Object.assign(process.env, env);
  try {
    return buildLaunchReadinessReport({
      env,
      storage: {
        ok: true,
        root: '/var/data',
        usage: {
          capacity: { availableBytes: 20 * 1024 * 1024 * 1024, humanAvailable: '20 GB' },
        },
      },
      database: { mode: 'postgres', initialized: true },
      email: getEmailDiagnostics(),
      sponsorTools: {
        ffmpegAvailable: true,
        ffmpeg: 'ffmpeg',
        ffprobeAvailable: true,
        ffprobe: 'ffprobe',
      },
    });
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in previousEnv)) delete process.env[key];
    }
    Object.assign(process.env, previousEnv);
  }
}

function statusById(report, id) {
  return report.checks.find(check => check.id === id)?.status || 'missing';
}

const readyReport = reportFor(productionEnv());
assert.equal(readyReport.summary.failures, 0, `production-ready fixture should have no failures:\n${JSON.stringify(readyReport.checks, null, 2)}`);
assert.equal(readyReport.summary.warnings, 0, `production-ready fixture should have no warnings:\n${JSON.stringify(readyReport.checks, null, 2)}`);
assert.equal(readyReport.launchReady, true, 'production-ready fixture should be launch ready');

const missingOpsReport = reportFor(productionEnv({
  SENTRY_DSN: '',
  METRICS_TOKEN: '',
  INCIDENT_RUNBOOK_URL: '',
  OPERATIONS_ALERT_EMAIL: '',
  BACKUP_RESTORE_VERIFIED_AT: '',
}));
assert.equal(statusById(missingOpsReport, 'sentry-dsn'), 'fail');
assert.equal(statusById(missingOpsReport, 'metrics-token'), 'fail');
assert.equal(statusById(missingOpsReport, 'incident-runbook'), 'fail');
assert.equal(statusById(missingOpsReport, 'alert-route'), 'fail');
assert.equal(statusById(missingOpsReport, 'backup-restore'), 'fail');

const stubDbReport = reportFor(productionEnv({ DATABASE_URL: '', SKIP_DB: 'true' }));
assert.equal(statusById(stubDbReport, 'database-url'), 'fail');
assert.equal(statusById(stubDbReport, 'database-not-stubbed'), 'fail');

const staleBackupReport = reportFor(productionEnv({
  BACKUP_RESTORE_VERIFIED_AT: new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString(),
}));
assert.equal(statusById(staleBackupReport, 'backup-restore'), 'fail');

const missingRedisForScaleReport = reportFor(productionEnv({
  PRODUCTION_INSTANCE_COUNT: '2',
  REDIS_URL: '',
  ENABLE_REDIS_ADAPTER: 'false',
}));
assert.equal(statusById(missingRedisForScaleReport, 'redis-scaling-configured'), 'fail');

console.log('Production readiness contract checks passed');
