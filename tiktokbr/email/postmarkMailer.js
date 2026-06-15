import postmark from 'postmark';

let cachedClient = null;
let cachedToken = null;

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function normalizeBaseUrl(value) {
  const fallback = `http://localhost:${process.env.PORT || 3000}`;
  try {
    const url = new URL(value || fallback);
    return url.origin;
  } catch (_err) {
    return fallback;
  }
}

function tokenValue() {
  return process.env.POSTMARK_API_TOKEN || process.env.POSTMARK_SERVER_TOKEN || '';
}

function boolEnv(name, fallback = false) {
  const value = process.env[name];
  if (value == null) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

export function getEmailConfig() {
  const appBaseUrl = normalizeBaseUrl(process.env.APP_BASE_URL);
  const host = new URL(appBaseUrl).hostname || 'localhost';
  const from = process.env.EMAIL_FROM || `IntoTheBattle <no-reply@${host}>`;
  return {
    provider: 'postmark',
    token: tokenValue(),
    appBaseUrl,
    from,
    replyTo: process.env.EMAIL_REPLY_TO || process.env.SUPPORT_EMAIL || '',
    messageStream: process.env.POSTMARK_MESSAGE_STREAM || 'outbound',
    disabled: boolEnv('EMAIL_DISABLE_SEND', false),
  };
}

export function getEmailDiagnostics() {
  const config = getEmailConfig();
  return {
    provider: config.provider,
    enabled: Boolean(config.token && !config.disabled),
    disabled: config.disabled,
    apiTokenPresent: Boolean(config.token),
    emailFromPresent: Boolean(config.from),
    emailFromDomain: extractEmailDomain(config.from),
    replyToPresent: Boolean(config.replyTo),
    messageStream: config.messageStream,
    appBaseUrl: config.appBaseUrl,
  };
}

function extractEmailDomain(address) {
  const match = String(address || '').match(/@([^>\s]+)>?$/);
  return match ? match[1].toLowerCase() : null;
}

function getPostmarkClient() {
  const config = getEmailConfig();
  if (!config.token || config.disabled) return null;
  if (!cachedClient || cachedToken !== config.token) {
    cachedClient = new postmark.ServerClient(config.token);
    cachedToken = config.token;
  }
  return cachedClient;
}

export function buildEmailUrl(pathname, params = {}) {
  const config = getEmailConfig();
  const url = new URL(pathname, config.appBaseUrl);
  Object.entries(params).forEach(([key, value]) => {
    if (value != null && value !== '') url.searchParams.set(key, String(value));
  });
  return url.toString();
}

function normalizePostmarkError(err) {
  return {
    message: err?.message || 'Postmark email delivery failed.',
    code: err?.code || err?.ErrorCode || null,
    statusCode: err?.statusCode || err?.status || null,
  };
}

export async function sendTransactionalEmail({
  to,
  subject,
  htmlBody,
  textBody,
  tag,
  metadata = {},
}) {
  const config = getEmailConfig();
  const recipient = String(to || '').trim();
  if (!recipient || !recipient.includes('@')) {
    throw new Error('Email recipient is invalid.');
  }

  if (config.disabled) {
    console.warn({ to: recipient, tag }, 'Email delivery disabled by EMAIL_DISABLE_SEND');
    return { skipped: true, reason: 'disabled' };
  }

  const client = getPostmarkClient();
  if (!client) {
    console.warn({ to: recipient, tag }, 'POSTMARK_API_TOKEN is not configured; email was not sent');
    return { skipped: true, reason: 'missing_postmark_token' };
  }

  const message = {
    From: config.from,
    To: recipient,
    Subject: subject,
    HtmlBody: htmlBody,
    TextBody: textBody,
    MessageStream: config.messageStream,
    Tag: tag,
    Metadata: Object.fromEntries(
      Object.entries(metadata).map(([key, value]) => [key, String(value ?? '')])
    ),
  };
  if (config.replyTo) message.ReplyTo = config.replyTo;

  try {
    const response = await client.sendEmail(message);
    console.info({
      to: recipient,
      tag,
      messageId: response.MessageID,
      submittedAt: response.SubmittedAt,
      messageStream: config.messageStream,
    }, 'Postmark email accepted');
    return {
      skipped: false,
      messageId: response.MessageID,
      submittedAt: response.SubmittedAt,
      providerResponse: response,
    };
  } catch (err) {
    const details = normalizePostmarkError(err);
    console.error({ to: recipient, tag, ...details }, 'Postmark email failed');
    const wrapped = new Error(details.message);
    wrapped.emailDelivery = details;
    throw wrapped;
  }
}

function shell({ preheader, title, intro, actionLabel, actionUrl, footer }) {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>${escapeHtml(title)}</title>
  </head>
  <body style="margin:0;background:#050608;color:#fff8e6;font-family:Inter,Segoe UI,Arial,sans-serif;">
    <div style="display:none;overflow:hidden;line-height:1px;opacity:0;max-height:0;max-width:0;">${escapeHtml(preheader)}</div>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#050608;padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;background:#0b1019;border:1px solid rgba(246,201,91,.24);border-radius:18px;overflow:hidden;">
            <tr>
              <td style="padding:28px 28px 18px;border-bottom:1px solid rgba(255,255,255,.08);">
                <div style="font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:#f6c95b;font-weight:800;">IntoTheBattle</div>
                <h1 style="margin:10px 0 0;font-size:28px;line-height:1.1;color:#fff8e6;">${escapeHtml(title)}</h1>
              </td>
            </tr>
            <tr>
              <td style="padding:28px;">
                <p style="margin:0 0 22px;color:#d9e1ef;font-size:16px;line-height:1.65;">${escapeHtml(intro)}</p>
                <p style="margin:0 0 24px;">
                  <a href="${escapeHtml(actionUrl)}" style="display:inline-block;background:linear-gradient(135deg,#f6c95b,#fff0b9 55%,#ff6a3d);color:#160d02;text-decoration:none;font-weight:900;padding:14px 20px;border-radius:12px;">${escapeHtml(actionLabel)}</a>
                </p>
                <p style="margin:0;color:#8f9aab;font-size:13px;line-height:1.6;">${escapeHtml(footer)}</p>
                <p style="margin:18px 0 0;color:#8f9aab;font-size:12px;line-height:1.6;word-break:break-all;">${escapeHtml(actionUrl)}</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

export async function sendVerificationEmail(user, token) {
  const verifyUrl = buildEmailUrl('/verify-email', { token, email: user.email });
  const name = user.name || user.email;
  const delivery = await sendTransactionalEmail({
    to: user.email,
    subject: 'Verify your IntoTheBattle email',
    tag: 'email-verification',
    metadata: { user_id: user.id || '', flow: 'email_verification' },
    htmlBody: shell({
      preheader: 'Confirm your email to finish setting up IntoTheBattle.',
      title: 'Verify your email',
      intro: `Hi ${name}, confirm this email address to finish setting up your IntoTheBattle creator account.`,
      actionLabel: 'Verify email',
      actionUrl: verifyUrl,
      footer: 'This link expires in 24 hours. If you did not create an IntoTheBattle account, you can ignore this message.',
    }),
    textBody: `Hi ${name},\n\nConfirm this email address to finish setting up your IntoTheBattle creator account:\n${verifyUrl}\n\nThis link expires in 24 hours.`,
  });
  return { ...delivery, url: verifyUrl };
}

export async function sendPasswordResetEmail(user, token) {
  const resetUrl = buildEmailUrl('/reset-password', { token, email: user.email });
  const name = user.name || user.email;
  const delivery = await sendTransactionalEmail({
    to: user.email,
    subject: 'Reset your IntoTheBattle password',
    tag: 'password-reset',
    metadata: { user_id: user.id || '', flow: 'password_reset' },
    htmlBody: shell({
      preheader: 'Use this secure link to reset your IntoTheBattle password.',
      title: 'Reset your password',
      intro: `Hi ${name}, use this secure link to choose a new password for your IntoTheBattle account.`,
      actionLabel: 'Reset password',
      actionUrl: resetUrl,
      footer: 'This link expires in 1 hour. If you did not request a password reset, you can ignore this message.',
    }),
    textBody: `Hi ${name},\n\nUse this secure link to choose a new password for your IntoTheBattle account:\n${resetUrl}\n\nThis link expires in 1 hour.`,
  });
  return { ...delivery, url: resetUrl };
}
