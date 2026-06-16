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

export function buildLaunchReadinessReport({
  env = process.env,
  storage = null,
  database = null,
  email = null,
  sponsorTools = null,
} = {}) {
  const checks = [];
  const production = env.NODE_ENV === 'production';

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

  addCheck(checks, 'database', 'database-url', 'DATABASE_URL is configured', envPresent(env, 'DATABASE_URL') || env.SKIP_DB === 'true', env.SKIP_DB === 'true' ? 'SKIP_DB=true' : (envPresent(env, 'DATABASE_URL') ? 'Database URL present.' : 'DATABASE_URL unset.'), 'Set DATABASE_URL to managed Postgres.');
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
  addCheck(checks, 'oauth', 'google-redirect', 'Google redirect URI is HTTPS', httpsUrl(env.GOOGLE_OAUTH_REDIRECT_URI), env.GOOGLE_OAUTH_REDIRECT_URI || 'unset', 'Set GOOGLE_OAUTH_REDIRECT_URI=https://www.intothebattle.com/auth/google/callback.');

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
