import assert from 'node:assert/strict';
import {
  createAdminEmailCampaign,
  listAdminAnnouncementRecipients,
  processAdminEmailQueue,
  retryAdminEmailCampaignFailures,
  validateAdminAnnouncementPayload,
} from '../tiktokbr/services/adminEmailCampaigns.js';

class FakeAdminEmailDb {
  constructor({ users = [] } = {}) {
    this.users = users.map(user => ({ ...user }));
    this.campaigns = [];
    this.deliveries = [];
    this.nextCampaignId = 1;
    this.nextDeliveryId = 1;
  }

  transaction(fn) {
    return (...args) => fn(...args);
  }

  prepare(sql) {
    const normalized = String(sql || '').replace(/\s+/g, ' ').trim();
    return {
      get: (...args) => this.get(normalized, args),
      all: (...args) => this.all(normalized, args),
      run: (...args) => this.run(normalized, args),
    };
  }

  all(sql, args) {
    if (sql.includes('FROM users') && sql.includes('COALESCE(is_active, 1) <> 0')) {
      return this.users
        .filter(user => Number(user.is_active ?? 1) !== 0)
        .sort((a, b) => Number(a.id) - Number(b.id));
    }
    if (sql.includes('FROM admin_email_campaigns') && sql.includes("status IN ('queued', 'sending')")) {
      return this.campaigns
        .filter(campaign => ['queued', 'sending'].includes(campaign.status))
        .sort((a, b) => a.id - b.id)
        .slice(0, 3);
    }
    if (sql.includes('FROM admin_email_campaigns')) {
      return [...this.campaigns].sort((a, b) => b.id - a.id).slice(0, Number(args[0]) || 20);
    }
    if (sql.includes('FROM admin_email_deliveries') && sql.includes("status = 'pending'")) {
      const [campaignId, limit] = args;
      return this.deliveries
        .filter(delivery => Number(delivery.campaign_id) === Number(campaignId) && delivery.status === 'pending')
        .sort((a, b) => a.id - b.id)
        .slice(0, Number(limit) || 20);
    }
    throw new Error(`Unhandled all SQL: ${sql}`);
  }

  get(sql, args) {
    if (sql.startsWith('INSERT INTO admin_email_campaigns')) {
      const [subject, body, ctaLabel, ctaUrl, status, recipientCount] = args;
      const campaign = {
        id: this.nextCampaignId++,
        subject,
        body,
        message: body,
        cta_label: ctaLabel,
        cta_url: ctaUrl,
        ctaLabel,
        ctaUrl,
        status,
        recipient_count: recipientCount,
        sent_count: 0,
        skipped_count: 0,
        failed_count: 0,
        created_at: new Date().toISOString(),
      };
      this.campaigns.push(campaign);
      return campaign;
    }
    if (sql.includes('FROM admin_email_campaigns WHERE id = ?')) {
      return this.campaigns.find(campaign => Number(campaign.id) === Number(args[0])) || null;
    }
    if (sql.includes('COUNT(*) FILTER') && sql.includes('FROM admin_email_deliveries')) {
      const campaignId = Number(args[0]);
      const rows = this.deliveries.filter(delivery => Number(delivery.campaign_id) === campaignId);
      return {
        sent_count: rows.filter(row => row.status === 'sent').length,
        skipped_count: rows.filter(row => row.status === 'skipped').length,
        failed_count: rows.filter(row => row.status === 'failed').length,
        pending_count: rows.filter(row => row.status === 'pending').length,
      };
    }
    throw new Error(`Unhandled get SQL: ${sql}`);
  }

  run(sql, args) {
    if (sql.startsWith('INSERT INTO admin_email_deliveries')) {
      const [campaignId, userId, email] = args;
      this.deliveries.push({
        id: this.nextDeliveryId++,
        campaign_id: campaignId,
        user_id: userId,
        email,
        status: 'pending',
        attempts: 0,
      });
      return { rowCount: 1 };
    }
    if (sql.includes("SET status = 'sending'")) {
      const campaign = this.campaigns.find(row => Number(row.id) === Number(args[0]));
      if (campaign) campaign.status = 'sending';
      return { rowCount: campaign ? 1 : 0 };
    }
    if (sql.includes("SET status = 'sent'")) {
      const [providerMessageId, deliveryId] = args;
      return this.updateDelivery(deliveryId, { status: 'sent', provider_message_id: providerMessageId });
    }
    if (sql.includes("SET status = 'skipped'")) {
      const [errorMessage, deliveryId] = args;
      return this.updateDelivery(deliveryId, { status: 'skipped', error_message: errorMessage });
    }
    if (sql.includes("SET status = 'failed'")) {
      const [errorMessage, deliveryId] = args;
      return this.updateDelivery(deliveryId, { status: 'failed', error_message: errorMessage });
    }
    if (sql.includes("SET status = 'pending'") && sql.includes("status IN ('failed', 'skipped')")) {
      const campaignId = Number(args[0]);
      let count = 0;
      for (const delivery of this.deliveries) {
        if (Number(delivery.campaign_id) === campaignId && ['failed', 'skipped'].includes(delivery.status)) {
          delivery.status = 'pending';
          delivery.error_message = null;
          count += 1;
        }
      }
      return { rowCount: count };
    }
    if (sql.includes('SET sent_count = ?')) {
      const [sent, skipped, failed, status, _pending, campaignId] = args;
      const campaign = this.campaigns.find(row => Number(row.id) === Number(campaignId));
      if (campaign) {
        Object.assign(campaign, {
          sent_count: sent,
          skipped_count: skipped,
          failed_count: failed,
          status,
          completed_at: status === 'sending' ? null : new Date().toISOString(),
        });
      }
      return { rowCount: campaign ? 1 : 0 };
    }
    if (sql.includes("SET status = 'queued'")) {
      const campaign = this.campaigns.find(row => Number(row.id) === Number(args[0]));
      if (campaign) campaign.status = 'queued';
      return { rowCount: campaign ? 1 : 0 };
    }
    throw new Error(`Unhandled run SQL: ${sql}`);
  }

  updateDelivery(deliveryId, patch) {
    const delivery = this.deliveries.find(row => Number(row.id) === Number(deliveryId));
    if (!delivery) return { rowCount: 0 };
    Object.assign(delivery, patch, { attempts: Number(delivery.attempts || 0) + 1 });
    return { rowCount: 1 };
  }
}

const validation = validateAdminAnnouncementPayload({
  subject: 'Important account update',
  message: 'This is a service announcement for your IntoTheBattle account.',
  ctaLabel: 'Open dashboard',
  ctaUrl: '/dashboard',
});
assert.equal(validation.ok, true);
assert.equal(validateAdminAnnouncementPayload({ subject: 'Bad', message: 'Too short' }).ok, false);
assert.equal(validateAdminAnnouncementPayload({ subject: 'Valid subject', message: 'This is long enough to validate.', ctaUrl: 'http://bad.example' }).ok, false);

const db = new FakeAdminEmailDb({
  users: [
    { id: 1, email: 'Alpha@Example.com', name: 'Alpha', is_active: 1 },
    { id: 2, email: 'alpha@example.com', name: 'Duplicate', is_active: 1 },
    { id: 3, email: 'disabled@example.com', name: 'Disabled', is_active: 0 },
    { id: 4, email: 'not-an-email', name: 'Invalid', is_active: 1 },
    { id: 5, email: 'bravo@example.com', name: 'Bravo', is_active: null },
  ],
});

const recipients = listAdminAnnouncementRecipients(db);
assert.deepEqual(recipients.map(row => row.email), ['alpha@example.com', 'bravo@example.com']);

const campaign = createAdminEmailCampaign(db, validation.payload, recipients);
assert.equal(campaign.recipient_count, 2);
assert.equal(db.deliveries.length, 2);

const sent = [];
const summary = await processAdminEmailQueue(db, {
  force: true,
  batchSize: 10,
  sendAnnouncement: async (_campaign, delivery) => {
    sent.push(delivery.email);
    if (delivery.email === 'bravo@example.com') return { skipped: true, reason: 'disabled' };
    return { messageId: `msg-${delivery.id}` };
  },
});
assert.deepEqual(sent, ['alpha@example.com', 'bravo@example.com']);
assert.equal(summary.sent, 1);
assert.equal(summary.skipped, 1);
assert.equal(db.campaigns[0].sent_count, 1);
assert.equal(db.campaigns[0].skipped_count, 1);

const retry = retryAdminEmailCampaignFailures(db, campaign.id);
assert.equal(retry.ok, true);
assert.equal(retry.count, 1);
assert.equal(db.deliveries.filter(row => row.status === 'pending').length, 1);

console.log('Admin email campaign smoke checks passed');
