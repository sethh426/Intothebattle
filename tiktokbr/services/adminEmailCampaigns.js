import { sendTransactionalEmail } from '../email/postmarkMailer.js';

const ADMIN_EMAIL_TAG = 'admin-account-announcement';
const MAX_SUBJECT_LENGTH = 140;
const MAX_BODY_LENGTH = 5000;
const MAX_CTA_LABEL_LENGTH = 80;

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function cleanWhitespace(value = '') {
  return String(value || '').replace(/[\t ]+/g, ' ').trim();
}

function normalizeMessage(value = '') {
  return String(value || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

export function normalizeAdminAnnouncementEmail(value = '') {
  const email = String(value || '').trim().toLowerCase().slice(0, 254);
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return '';
  return email;
}

export function normalizeAdminAnnouncementCtaUrl(value = '') {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (raw.startsWith('/') && !raw.startsWith('//') && !raw.includes('\\')) return raw.slice(0, 500);
  try {
    const url = new URL(raw);
    if (url.protocol === 'https:') return url.toString().slice(0, 500);
  } catch (_err) {}
  return null;
}

export function validateAdminAnnouncementPayload(body = {}) {
  const subject = cleanWhitespace(body.subject || '').slice(0, MAX_SUBJECT_LENGTH + 20);
  const message = normalizeMessage(body.message || '').slice(0, MAX_BODY_LENGTH + 200);
  const ctaLabel = cleanWhitespace(body.ctaLabel || '').slice(0, MAX_CTA_LABEL_LENGTH + 20);
  const rawCtaUrl = String(body.ctaUrl || '').trim();
  const ctaUrl = normalizeAdminAnnouncementCtaUrl(rawCtaUrl);
  const errors = [];

  if (subject.length < 4 || subject.length > MAX_SUBJECT_LENGTH) {
    errors.push(`Subject must be 4-${MAX_SUBJECT_LENGTH} characters.`);
  }
  if (message.length < 20 || message.length > MAX_BODY_LENGTH) {
    errors.push(`Message must be 20-${MAX_BODY_LENGTH} characters.`);
  }
  if ((ctaLabel && !rawCtaUrl) || (!ctaLabel && rawCtaUrl)) {
    errors.push('CTA label and CTA URL must be filled together.');
  }
  if (ctaLabel.length > MAX_CTA_LABEL_LENGTH) {
    errors.push(`CTA label must be ${MAX_CTA_LABEL_LENGTH} characters or fewer.`);
  }
  if (ctaUrl === null) {
    errors.push('CTA URL must be https:// or a same-site relative path.');
  }

  return {
    ok: errors.length === 0,
    errors,
    payload: {
      subject,
      message,
      ctaLabel,
      ctaUrl: ctaUrl || '',
    },
  };
}

export function listAdminAnnouncementRecipients(database) {
  const rows = database.prepare(`
    SELECT id, email, name
    FROM users
    WHERE COALESCE(is_active, 1) <> 0
    ORDER BY id ASC
  `).all();
  const seen = new Set();
  const recipients = [];
  for (const row of rows || []) {
    const email = normalizeAdminAnnouncementEmail(row.email);
    if (!email || seen.has(email)) continue;
    seen.add(email);
    recipients.push({
      userId: row.id,
      email,
      name: cleanWhitespace(row.name || ''),
    });
  }
  return recipients;
}

function buildAnnouncementHtml({ subject, message, ctaLabel = '', ctaUrl = '' } = {}) {
  const paragraphs = normalizeMessage(message)
    .split(/\n{2,}/)
    .map(part => part.split('\n').map(line => escapeHtml(line)).join('<br>'))
    .map(part => `<p style="margin:0 0 18px;color:#d9e1ef;font-size:16px;line-height:1.65;">${part}</p>`)
    .join('');
  const cta = ctaLabel && ctaUrl
    ? `<p style="margin:4px 0 24px;"><a href="${escapeHtml(ctaUrl)}" style="display:inline-block;background:linear-gradient(135deg,#f6c95b,#fff0b9 55%,#ff6a3d);color:#160d02;text-decoration:none;font-weight:900;padding:14px 20px;border-radius:12px;">${escapeHtml(ctaLabel)}</a></p>`
    : '';

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>${escapeHtml(subject)}</title>
  </head>
  <body style="margin:0;background:#050608;color:#fff8e6;font-family:Inter,Segoe UI,Arial,sans-serif;">
    <div style="display:none;overflow:hidden;line-height:1px;opacity:0;max-height:0;max-width:0;">${escapeHtml(subject)}</div>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#050608;padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;background:#0b1019;border:1px solid rgba(246,201,91,.24);border-radius:18px;overflow:hidden;">
            <tr>
              <td style="padding:28px 28px 18px;border-bottom:1px solid rgba(255,255,255,.08);">
                <div style="font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:#f6c95b;font-weight:800;">IntoTheBattle</div>
                <h1 style="margin:10px 0 0;font-size:28px;line-height:1.1;color:#fff8e6;">${escapeHtml(subject)}</h1>
              </td>
            </tr>
            <tr>
              <td style="padding:28px;">
                ${paragraphs}
                ${cta}
                <p style="margin:20px 0 0;color:#8f9aab;font-size:12px;line-height:1.6;">You are receiving this account announcement because you have an IntoTheBattle account.</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

function buildAnnouncementText({ message, ctaLabel = '', ctaUrl = '' } = {}) {
  return [normalizeMessage(message), ctaLabel && ctaUrl ? `${ctaLabel}: ${ctaUrl}` : '', 'You are receiving this account announcement because you have an IntoTheBattle account.']
    .filter(Boolean)
    .join('\n\n');
}

function normalizeCampaignForEmail(campaign = {}) {
  return {
    ...campaign,
    message: campaign.message || campaign.body || '',
    ctaLabel: campaign.ctaLabel || campaign.cta_label || '',
    ctaUrl: campaign.ctaUrl || campaign.cta_url || '',
  };
}

export async function sendAdminAccountAnnouncement(campaign, delivery, options = {}) {
  const sendEmail = options.sendEmail || sendTransactionalEmail;
  const normalizedCampaign = normalizeCampaignForEmail(campaign);
  return sendEmail({
    to: delivery.email,
    subject: normalizedCampaign.subject,
    tag: ADMIN_EMAIL_TAG,
    metadata: {
      campaign_id: normalizedCampaign.id,
      user_id: delivery.user_id || delivery.userId || '',
    },
    htmlBody: buildAnnouncementHtml(normalizedCampaign),
    textBody: buildAnnouncementText(normalizedCampaign),
  });
}

function insertCampaign(database, payload, recipientCount) {
  return database.prepare(`
    INSERT INTO admin_email_campaigns (
      subject, body, cta_label, cta_url, status, recipient_count, queued_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    RETURNING *
  `).get(
    payload.subject,
    payload.message,
    payload.ctaLabel || null,
    payload.ctaUrl || null,
    recipientCount > 0 ? 'queued' : 'completed',
    recipientCount
  );
}

export function createAdminEmailCampaign(database, payload, recipients) {
  const create = database.transaction(() => {
    const campaign = insertCampaign(database, payload, recipients.length);
    const insertDelivery = database.prepare(`
      INSERT INTO admin_email_deliveries (campaign_id, user_id, email, status, created_at)
      VALUES (?, ?, ?, 'pending', CURRENT_TIMESTAMP)
    `);
    for (const recipient of recipients) {
      insertDelivery.run(campaign.id, recipient.userId, recipient.email);
    }
    return campaign;
  });
  return create();
}

export function listAdminEmailCampaigns(database, limit = 20) {
  return database.prepare(`
    SELECT *
    FROM admin_email_campaigns
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `).all(Math.max(1, Math.min(50, Number(limit) || 20)));
}

export function getAdminEmailCampaign(database, campaignId) {
  return database.prepare('SELECT * FROM admin_email_campaigns WHERE id = ?').get(campaignId);
}

function recomputeCampaignCounts(database, campaignId) {
  const counts = database.prepare(`
    SELECT
      COUNT(*) FILTER (WHERE status = 'sent') AS sent_count,
      COUNT(*) FILTER (WHERE status = 'skipped') AS skipped_count,
      COUNT(*) FILTER (WHERE status = 'failed') AS failed_count,
      COUNT(*) FILTER (WHERE status = 'pending') AS pending_count
    FROM admin_email_deliveries
    WHERE campaign_id = ?
  `).get(campaignId) || {};
  const pending = Number(counts.pending_count) || 0;
  const failed = Number(counts.failed_count) || 0;
  const status = pending > 0 ? 'sending' : failed > 0 ? 'completed_with_errors' : 'completed';
  database.prepare(`
    UPDATE admin_email_campaigns
    SET sent_count = ?,
        skipped_count = ?,
        failed_count = ?,
        status = ?,
        completed_at = CASE WHEN ? = 0 THEN COALESCE(completed_at, CURRENT_TIMESTAMP) ELSE completed_at END,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(Number(counts.sent_count) || 0, Number(counts.skipped_count) || 0, failed, status, pending, campaignId);
  return { ...counts, pending_count: pending, failed_count: failed, status };
}

export function retryAdminEmailCampaignFailures(database, campaignId) {
  const campaign = getAdminEmailCampaign(database, campaignId);
  if (!campaign) return { ok: false, error: 'Campaign not found.' };
  const result = database.prepare(`
    UPDATE admin_email_deliveries
    SET status = 'pending',
        error_message = NULL,
        updated_at = CURRENT_TIMESTAMP
    WHERE campaign_id = ?
      AND status IN ('failed', 'skipped')
  `).run(campaignId);
  database.prepare(`
    UPDATE admin_email_campaigns
    SET status = 'queued',
        completed_at = NULL,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(campaignId);
  return { ok: true, count: Number(result?.rowCount ?? result?.changes ?? 0) };
}

let processing = false;

export async function processAdminEmailQueue(database, options = {}) {
  if (processing && !options.force) return { skipped: true, reason: 'already_processing' };
  processing = true;
  const sendAnnouncement = options.sendAnnouncement || sendAdminAccountAnnouncement;
  const batchSize = Math.max(1, Math.min(50, Number(options.batchSize) || 20));
  const summary = { campaigns: 0, attempted: 0, sent: 0, skipped: 0, failed: 0 };
  try {
    const campaigns = database.prepare(`
      SELECT *
      FROM admin_email_campaigns
      WHERE status IN ('queued', 'sending')
      ORDER BY queued_at ASC, id ASC
      LIMIT 3
    `).all();
    for (const campaign of campaigns || []) {
      summary.campaigns += 1;
      database.prepare(`
        UPDATE admin_email_campaigns
        SET status = 'sending',
            started_at = COALESCE(started_at, CURRENT_TIMESTAMP),
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(campaign.id);
      const deliveries = database.prepare(`
        SELECT *
        FROM admin_email_deliveries
        WHERE campaign_id = ?
          AND status = 'pending'
        ORDER BY id ASC
        LIMIT ?
      `).all(campaign.id, batchSize);
      for (const delivery of deliveries || []) {
        summary.attempted += 1;
        try {
          const result = await sendAnnouncement(campaign, delivery, options);
          if (result?.skipped) {
            summary.skipped += 1;
            database.prepare(`
              UPDATE admin_email_deliveries
              SET status = 'skipped',
                  attempts = COALESCE(attempts, 0) + 1,
                  error_message = ?,
                  last_attempt_at = CURRENT_TIMESTAMP,
                  updated_at = CURRENT_TIMESTAMP
              WHERE id = ?
            `).run(result.reason || 'skipped', delivery.id);
          } else {
            summary.sent += 1;
            database.prepare(`
              UPDATE admin_email_deliveries
              SET status = 'sent',
                  attempts = COALESCE(attempts, 0) + 1,
                  provider_message_id = ?,
                  sent_at = CURRENT_TIMESTAMP,
                  last_attempt_at = CURRENT_TIMESTAMP,
                  updated_at = CURRENT_TIMESTAMP
              WHERE id = ?
            `).run(result?.messageId || result?.providerResponse?.MessageID || '', delivery.id);
          }
        } catch (err) {
          summary.failed += 1;
          database.prepare(`
            UPDATE admin_email_deliveries
            SET status = 'failed',
                attempts = COALESCE(attempts, 0) + 1,
                error_message = ?,
                last_attempt_at = CURRENT_TIMESTAMP,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
          `).run(String(err?.message || err || 'Email delivery failed').slice(0, 500), delivery.id);
        }
      }
      const counts = recomputeCampaignCounts(database, campaign.id);
      if (counts.pending_count > 0 && !options.disableReschedule) {
        scheduleAdminEmailQueue(database, { ...options, delayMs: Number(options.nextDelayMs) || 1000 });
      }
    }
    return summary;
  } finally {
    processing = false;
  }
}

export function scheduleAdminEmailQueue(database, options = {}) {
  const delayMs = Math.max(0, Number(options.delayMs) || 0);
  const timer = setTimeout(() => {
    processAdminEmailQueue(database, options).catch(err => {
      console.warn('Admin email queue processing failed:', err?.message || err);
    });
  }, delayMs);
  if (typeof timer.unref === 'function') timer.unref();
  return timer;
}

export {
  buildAnnouncementHtml,
  buildAnnouncementText,
};
