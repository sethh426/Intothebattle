function present(value) {
  return String(value || '').trim().length > 0;
}

function looksLikePlaceholder(value) {
  const text = String(value || '').trim();
  return /^<[^>]+>$/.test(text) || /^(your|replace|changeme|todo)[-_a-z0-9\s:]*$/i.test(text);
}

function addCheck(checks, category, id, label, passed, details = '', action = '', severity = 'fail') {
  checks.push({
    category,
    id,
    label,
    status: passed ? 'pass' : severity,
    details,
    action,
  });
}

function httpsUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:';
  } catch (_err) {
    return false;
  }
}

function envPresent(env, name) {
  return present(env[name]) && !looksLikePlaceholder(env[name]);
}

function urlPresent(env, name) {
  if (!envPresent(env, name)) return false;
  try {
    const url = new URL(env[name]);
    return ['http:', 'https:'].includes(url.protocol);
  } catch (_err) {
    return false;
  }
}

function recentIsoDatePresent(env, name, maxAgeDays = 30) {
  if (!envPresent(env, name)) return false;
  const date = new Date(env[name]);
  if (Number.isNaN(date.getTime())) return false;
  const maxAgeMs = Math.max(1, Number(maxAgeDays) || 30) * 24 * 60 * 60 * 1000;
  return date.getTime() <= Date.now() && Date.now() - date.getTime() <= maxAgeMs;
}

export function buildLaunchReadinessReport({
  env = process.env,
  storage = null,
  database = null,
  email = null,
  sponsorTools = null,
} = {}) {
  const checks = [];
  const production = env.NODE_ENV === 'production';
  const productionInstanceCount = Math.max(1, Number(env.PRODUCTION_INSTANCE_COUNT || env.WEB_CONCURRENCY || 1) || 1);

  addCheck(
    checks,
    'runtime',
    'node-env',
    'NODE_ENV is production',
    production,
    `Current NODE_ENV: ${env.NODE_ENV || 'unset'}`,
    'Set NODE_ENV=production on Render before public launch.',
    'warn'
  );
  addCheck(checks, 'runtime', 'app-base-url', 'APP_BASE_URL is HTTPS', httpsUrl(env.APP_BASE_URL), env.APP_BASE_URL || 'unset', 'Set APP_BASE_URL=https://intothebattle.com.');
  addCheck(checks, 'runtime', 'jwt-secret', 'JWT_SECRET is configured', envPresent(env, 'JWT_SECRET'), 'Required for sessions, OAuth state, and secure claims.', 'Set a long random JWT_SECRET.');
  addCheck(checks, 'runtime', 'api-key', 'TikTok API_KEY is configured', envPresent(env, 'API_KEY'), 'Required for live TikTok connection.', 'Set API_KEY in production.');
  addCheck(checks, 'runtime', 'diagnostics-token', 'DIAGNOSTICS_TOKEN is configured', envPresent(env, 'DIAGNOSTICS_TOKEN'), 'Protects launch diagnostics in production.', 'Set DIAGNOSTICS_TOKEN to a long random value.');
  addCheck(checks, 'overlay', 'overlay-secret', 'OVERLAY_TOKEN_SECRET is configured', envPresent(env, 'OVERLAY_TOKEN_SECRET'), 'JWT_SECRET fallback exists, but a separate overlay secret is safer.', 'Set OVERLAY_TOKEN_SECRET.', 'warn');
  addCheck(checks, 'tiktok-official', 'tiktok-client-key', 'TikTok client key is configured', envPresent(env, 'TIKTOK_CLIENT_KEY') || envPresent(env, 'TIKTOK_CLIENT_ID'), 'Required for official TikTok Login Kit account linking.', 'Set TIKTOK_CLIENT_KEY from TikTok Developer Portal.', production ? 'fail' : 'warn');
  addCheck(checks, 'tiktok-official', 'tiktok-client-secret', 'TikTok client secret is configured', envPresent(env, 'TIKTOK_CLIENT_SECRET'), 'Server-side OAuth token exchange requires the client secret.', 'Set TIKTOK_CLIENT_SECRET only on the server.', production ? 'fail' : 'warn');
  addCheck(checks, 'tiktok-official', 'tiktok-app-id', 'TikTok app ID is recorded', envPresent(env, 'TIKTOK_APP_ID'), env.TIKTOK_APP_ID || 'unset', 'Set TIKTOK_APP_ID for app review/admin traceability.', 'warn');
  addCheck(checks, 'tiktok-official', 'tiktok-redirect-uri', 'TikTok redirect URI is HTTPS', httpsUrl(env.TIKTOK_REDIRECT_URI), env.TIKTOK_REDIRECT_URI || 'unset', 'Set TIKTOK_REDIRECT_URI=https://intothebattle.com/auth/tiktok/callback and register it in Login Kit.', production ? 'fail' : 'warn');
  const tiktokScopes = String(env.TIKTOK_SCOPES || 'user.info.basic,user.info.profile').split(',').map(scope => scope.trim());
  addCheck(checks, 'tiktok-official', 'tiktok-scopes', 'TikTok scopes include account identity and username', tiktokScopes.includes('user.info.basic') && tiktokScopes.includes('user.info.profile'), env.TIKTOK_SCOPES || 'default user.info.basic,user.info.profile', 'Request user.info.basic and user.info.profile so linked accounts can provide the handle used by LIVE connect.', 'warn');
  addCheck(checks, 'tiktok-official', 'tiktok-live-provider-explicit', 'TikTok LIVE event provider is explicit', ['legacy', 'official', 'disabled'].includes(String(env.TIKTOK_LIVE_EVENT_PROVIDER || '').toLowerCase()), `TIKTOK_LIVE_EVENT_PROVIDER=${env.TIKTOK_LIVE_EVENT_PROVIDER || 'unset/default legacy'}`, 'Set TIKTOK_LIVE_EVENT_PROVIDER=legacy until TikTok grants an official real-time LIVE event API.', production ? 'fail' : 'warn');
  addCheck(checks, 'tiktok-official', 'tiktok-token-encryption', 'TikTok token encryption secret is configured', envPresent(env, 'TIKTOK_TOKEN_ENCRYPTION_SECRET') || envPresent(env, 'JWT_SECRET'), envPresent(env, 'TIKTOK_TOKEN_ENCRYPTION_SECRET') ? 'Dedicated encryption secret configured.' : 'Using JWT_SECRET fallback.', 'Set a dedicated TIKTOK_TOKEN_ENCRYPTION_SECRET for stored TikTok tokens.', 'warn');

  addCheck(
    checks,
    'database',
    'database-url',
    'DATABASE_URL is configured',
    envPresent(env, 'DATABASE_URL') || (!production && env.SKIP_DB === 'true'),
    env.SKIP_DB === 'true' ? 'SKIP_DB=true' : (envPresent(env, 'DATABASE_URL') ? 'Database URL present.' : 'DATABASE_URL unset.'),
    'Set DATABASE_URL to managed Postgres.'
  );
  addCheck(
    checks,
    'database',
    'database-not-stubbed',
    'Production database is not stubbed',
    !(production && env.SKIP_DB === 'true'),
    `SKIP_DB=${env.SKIP_DB || 'unset'}`,
    'Never run production with SKIP_DB=true.',
    'fail'
  );
  if (database) {
    addCheck(checks, 'database', 'database-ready', 'Database initialized', database.mode === 'stub' || Boolean(database.initialized), database.lastError || database.mode || '', 'Fix Postgres connection or migrations.');
  }

  const emailEnabled = Boolean(email?.enabled);
  addCheck(checks, 'email', 'postmark-enabled', 'Postmark email is enabled', emailEnabled, email ? `From domain: ${email.emailFromDomain || 'unknown'}, stream: ${email.messageStream || 'unset'}` : 'Email diagnostics unavailable.', 'Verify POSTMARK_API_TOKEN, EMAIL_FROM, and POSTMARK_MESSAGE_STREAM.');
  addCheck(checks, 'email', 'email-from-domain', 'EMAIL_FROM is not a placeholder', email ? Boolean(email.emailFromPresent && !email.emailFromLooksPlaceholder) : envPresent(env, 'EMAIL_FROM'), env.EMAIL_FROM || '', 'Use IntoTheBattle <no-reply@intothebattle.com>.');

  addCheck(checks, 'payments', 'paypal-client-id', 'PayPal client ID is configured', envPresent(env, 'PAYPAL_CLIENT_ID'), 'Required for the PayPal checkout button.', 'Set PAYPAL_CLIENT_ID.');
  addCheck(checks, 'payments', 'paypal-client-secret', 'PayPal client secret is configured', envPresent(env, 'PAYPAL_CLIENT_SECRET'), 'Required to verify subscriptions server-side.', 'Set PAYPAL_CLIENT_SECRET.');
  addCheck(checks, 'payments', 'paypal-plan-id', 'PayPal plan ID is configured', envPresent(env, 'PAYPAL_PLAN_ID') || envPresent(env, 'PAYPAL_SUBSCRIPTION_PLAN_ID'), env.PAYPAL_PLAN_ID || env.PAYPAL_SUBSCRIPTION_PLAN_ID || 'unset', 'Set PAYPAL_PLAN_ID to the live subscription plan.');
  addCheck(checks, 'payments', 'paypal-webhook-id', 'PayPal webhook ID is configured', envPresent(env, 'PAYPAL_WEBHOOK_ID'), 'Required to verify PayPal webhooks.', 'Set PAYPAL_WEBHOOK_ID from the live app webhook.');
  addCheck(checks, 'payments', 'paypal-live-mode', 'PayPal is in live mode', String(env.PAYPAL_MODE || '').toLowerCase() === 'live', `PAYPAL_MODE=${env.PAYPAL_MODE || 'unset'}`, 'Set PAYPAL_MODE=live before launch.', production ? 'fail' : 'warn');

  addCheck(checks, 'oauth', 'google-client-id', 'Google client ID is configured', envPresent(env, 'GOOGLE_CLIENT_ID'), 'Required for Google login.', 'Set GOOGLE_CLIENT_ID.');
  addCheck(checks, 'oauth', 'google-client-secret', 'Google client secret is configured', envPresent(env, 'GOOGLE_CLIENT_SECRET'), 'Required for Google login.', 'Set GOOGLE_CLIENT_SECRET.');
  addCheck(checks, 'oauth', 'google-redirect', 'Google redirect URI is HTTPS', httpsUrl(env.GOOGLE_OAUTH_REDIRECT_URI), env.GOOGLE_OAUTH_REDIRECT_URI || 'unset', 'Set GOOGLE_OAUTH_REDIRECT_URI=https://intothebattle.com/auth/google/callback.');

  addCheck(
    checks,
    'observability',
    'sentry-dsn',
    'Error monitoring is configured',
    envPresent(env, 'SENTRY_DSN'),
    envPresent(env, 'SENTRY_DSN') ? 'Configured.' : 'unset',
    'Configure Sentry or an equivalent error monitor before production launch.',
    production ? 'fail' : 'warn'
  );
  addCheck(
    checks,
    'observability',
    'metrics-token',
    'Metrics scraping is protected and configured',
    envPresent(env, 'METRICS_TOKEN'),
    envPresent(env, 'METRICS_TOKEN') ? 'Configured.' : 'unset',
    'Set METRICS_TOKEN and wire a trusted metrics scraper.',
    production ? 'fail' : 'warn'
  );
  addCheck(
    checks,
    'operations',
    'support-contact',
    'Support contact is configured',
    envPresent(env, 'SUPPORT_EMAIL') || envPresent(env, 'EMAIL_REPLY_TO'),
    env.SUPPORT_EMAIL || env.EMAIL_REPLY_TO || 'unset',
    'Set SUPPORT_EMAIL or EMAIL_REPLY_TO for customer recovery paths.',
    production ? 'fail' : 'warn'
  );
  addCheck(
    checks,
    'operations',
    'incident-runbook',
    'Incident runbook is published',
    urlPresent(env, 'INCIDENT_RUNBOOK_URL') || urlPresent(env, 'LAUNCH_RUNBOOK_URL'),
    env.INCIDENT_RUNBOOK_URL || env.LAUNCH_RUNBOOK_URL || 'unset',
    'Publish an incident/deploy rollback runbook URL.',
    production ? 'fail' : 'warn'
  );
  addCheck(
    checks,
    'operations',
    'alert-route',
    'Operations alert route is configured',
    envPresent(env, 'OPERATIONS_ALERT_EMAIL') || urlPresent(env, 'ALERT_WEBHOOK_URL') || urlPresent(env, 'SENTRY_DSN'),
    env.OPERATIONS_ALERT_EMAIL || env.ALERT_WEBHOOK_URL || (envPresent(env, 'SENTRY_DSN') ? 'SENTRY_DSN configured' : 'unset'),
    'Configure an error/uptime alert route.',
    production ? 'fail' : 'warn'
  );
  addCheck(
    checks,
    'operations',
    'backup-restore',
    'Backup restore drill is recent',
    recentIsoDatePresent(env, 'BACKUP_RESTORE_VERIFIED_AT', env.BACKUP_RESTORE_MAX_AGE_DAYS || 30),
    env.BACKUP_RESTORE_VERIFIED_AT || 'unset',
    'Set BACKUP_RESTORE_VERIFIED_AT after a successful restore drill within the configured window.',
    production ? 'fail' : 'warn'
  );
  addCheck(
    checks,
    'realtime',
    'redis-scaling-configured',
    'Realtime scaling adapter is configured',
    !production || productionInstanceCount === 1 || (envPresent(env, 'REDIS_URL') && String(env.ENABLE_REDIS_ADAPTER || '').toLowerCase() === 'true'),
    `instances=${productionInstanceCount}, REDIS_URL=${envPresent(env, 'REDIS_URL') ? 'present' : 'unset'}, ENABLE_REDIS_ADAPTER=${env.ENABLE_REDIS_ADAPTER || 'unset'}`,
    'Set PRODUCTION_INSTANCE_COUNT=1 for single-instance deploys, or configure REDIS_URL and ENABLE_REDIS_ADAPTER=true for multi-instance realtime scaling.',
    production ? 'fail' : 'warn'
  );

  if (storage) {
    addCheck(checks, 'storage', 'storage-writable', 'Persistent storage is writable', Boolean(storage.ok), storage.error || storage.root || '', 'Fix DISK_PATH and persistent disk mount.');
    const usage = storage.usage || storage;
    if (usage?.capacity?.availableBytes != null) {
      addCheck(checks, 'storage', 'storage-free-space', 'Storage has available space', usage.capacity.availableBytes > 5 * 1024 * 1024, `${usage.capacity.humanAvailable} available`, 'Increase Render disk or remove old media.', 'warn');
    }
    if (usage?.configuredLimitBytes) {
      addCheck(checks, 'storage', 'storage-under-limit', 'Storage usage is under configured limit', usage.bytes < usage.configuredLimitBytes * 0.9, `${usage.humanBytes} of ${usage.humanConfiguredLimit}`, 'Clean media or raise STORAGE_LIMIT_MB.', 'warn');
    }
  }

  if (sponsorTools) {
    addCheck(checks, 'media', 'ffprobe-available', 'ffprobe is available for video metadata', Boolean(sponsorTools.ffprobeAvailable), sponsorTools.ffprobe || 'missing', 'Install FFmpeg/ffprobe or configure FFPROBE_PATH.', 'warn');
    addCheck(checks, 'media', 'ffmpeg-available', 'FFmpeg is available for video normalization', Boolean(sponsorTools.ffmpegAvailable), sponsorTools.ffmpeg || 'missing', 'Install FFmpeg or configure FFMPEG_PATH.', 'warn');
    const strictMediaGate = env.SPONSOR_STRICT_MEDIA_GATE == null ? production : String(env.SPONSOR_STRICT_MEDIA_GATE).toLowerCase() !== 'false';
    addCheck(checks, 'media', 'sponsor-media-gate', 'Sponsor video quality gate is enabled', strictMediaGate, `SPONSOR_STRICT_MEDIA_GATE=${env.SPONSOR_STRICT_MEDIA_GATE || (production ? 'default true' : 'default relaxed')}`, 'Keep SPONSOR_STRICT_MEDIA_GATE=true for production sponsor playback.', production ? 'fail' : 'warn');
  }

  const failures = checks.filter(check => check.status === 'fail');
  const warnings = checks.filter(check => check.status === 'warn');
  return {
    ok: failures.length === 0,
    launchReady: failures.length === 0 && warnings.length === 0,
    checkedAt: new Date().toISOString(),
    summary: {
      total: checks.length,
      passed: checks.filter(check => check.status === 'pass').length,
      warnings: warnings.length,
      failures: failures.length,
    },
    checks,
  };
}
