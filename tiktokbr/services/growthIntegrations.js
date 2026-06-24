import { Analytics } from '@segment/analytics-node';
import { Client as HubSpotClient } from '@hubspot/api-client';
import { z } from 'zod';
import db from '../db/db.js';

const LeadSchema = z.object({
  email: z.string().email().max(254),
  name: z.string().max(120).optional().default(''),
  tiktokUsername: z.string().max(80).optional().default(''),
  source: z.string().max(80).optional().default('signup'),
  lastPath: z.string().max(220).optional().default(''),
  lifecycleStage: z.string().max(40).optional().default('lead'),
  eventName: z.string().max(120).optional().default('Signup Intent Captured'),
  properties: z.record(z.string(), z.unknown()).optional().default({}),
});

let hubspotClient = null;
let segmentClient = null;

function cleanText(value = '', max = 180) {
  return String(value || '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function enabled() {
  return process.env.GROWTH_API_SYNC_ENABLED === 'true';
}

function hubspotToken() {
  return String(process.env.HUBSPOT_PRIVATE_APP_TOKEN || '').trim();
}

function segmentWriteKey() {
  return String(process.env.SEGMENT_WRITE_KEY || '').trim();
}

function getHubSpotClient() {
  const token = hubspotToken();
  if (!token) return null;
  if (!hubspotClient) {
    hubspotClient = new HubSpotClient({
      accessToken: token,
      numberOfApiCallRetries: 2,
    });
  }
  return hubspotClient;
}

function getSegmentClient() {
  const writeKey = segmentWriteKey();
  if (!writeKey) return null;
  if (!segmentClient) {
    segmentClient = new Analytics({ writeKey, flushAt: 1 });
  }
  return segmentClient;
}

function recordGrowthApiEvent(provider, eventType, subjectEmail, status, detail = '') {
  try {
    db.prepare(`
      INSERT INTO growth_api_events (provider, event_type, subject_email, status, detail, created_at)
      VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `).run(provider, eventType, subjectEmail || '', status, cleanText(detail, 400));
  } catch (_err) {}
}

function splitName(name = '') {
  const parts = cleanText(name, 120).split(' ').filter(Boolean);
  return {
    firstname: parts[0] || '',
    lastname: parts.length > 1 ? parts.slice(1).join(' ') : '',
  };
}

function hubspotProperties(lead) {
  const { firstname, lastname } = splitName(lead.name);
  const properties = {
    email: lead.email,
    lifecyclestage: cleanText(lead.lifecycleStage, 40) || 'lead',
  };
  if (firstname) properties.firstname = firstname;
  if (lastname) properties.lastname = lastname;

  const optionalMappings = [
    [process.env.HUBSPOT_SOURCE_PROPERTY, cleanText(lead.source, 80)],
    [process.env.HUBSPOT_LAST_PATH_PROPERTY, cleanText(lead.lastPath, 220)],
    [process.env.HUBSPOT_TIKTOK_PROPERTY, cleanText(lead.tiktokUsername, 80).replace(/^@+/, '')],
  ];
  optionalMappings.forEach(([propertyName, value]) => {
    const safeProperty = cleanText(propertyName, 80).replace(/[^a-zA-Z0-9_]/g, '');
    if (safeProperty && value) properties[safeProperty] = value;
  });

  return properties;
}

async function syncHubSpotLead(lead) {
  const client = getHubSpotClient();
  if (!client) return { provider: 'hubspot', status: 'skipped', reason: 'missing_token' };

  const properties = hubspotProperties(lead);
  const search = await client.crm.contacts.searchApi.doSearch({
    filterGroups: [{
      filters: [{
        propertyName: 'email',
        operator: 'EQ',
        value: lead.email,
      }],
    }],
    properties: ['email'],
    limit: 1,
  });

  const existing = search?.results?.[0];
  if (existing?.id) {
    await client.crm.contacts.basicApi.update(existing.id, { properties });
    recordGrowthApiEvent('hubspot', lead.eventName, lead.email, 'updated', `contact:${existing.id}`);
    return { provider: 'hubspot', status: 'updated', id: existing.id };
  }

  const created = await client.crm.contacts.basicApi.create({ properties });
  recordGrowthApiEvent('hubspot', lead.eventName, lead.email, 'created', `contact:${created?.id || ''}`);
  return { provider: 'hubspot', status: 'created', id: created?.id || null };
}

async function syncSegmentLead(lead) {
  const analytics = getSegmentClient();
  if (!analytics) return { provider: 'segment', status: 'skipped', reason: 'missing_write_key' };

  const userId = lead.email;
  const traits = {
    email: lead.email,
    name: lead.name || undefined,
    tiktokUsername: lead.tiktokUsername || undefined,
    source: lead.source,
    lastPath: lead.lastPath,
    lifecycleStage: lead.lifecycleStage,
  };
  const properties = {
    source: lead.source,
    lastPath: lead.lastPath,
    tiktokUsername: lead.tiktokUsername || undefined,
    ...lead.properties,
  };

  analytics.identify({ userId, traits });
  analytics.track({ userId, event: lead.eventName, properties });
  recordGrowthApiEvent('segment', lead.eventName, lead.email, 'queued', 'identify+track queued');
  return { provider: 'segment', status: 'queued' };
}

export function growthIntegrationDiagnostics() {
  const providers = [];
  if (hubspotToken()) providers.push('hubspot');
  if (segmentWriteKey()) providers.push('segment');
  return {
    enabled: enabled(),
    hubspotConfigured: Boolean(hubspotToken()),
    hubspotCustomPropertiesConfigured: Boolean(process.env.HUBSPOT_SOURCE_PROPERTY || process.env.HUBSPOT_LAST_PATH_PROPERTY || process.env.HUBSPOT_TIKTOK_PROPERTY),
    segmentConfigured: Boolean(segmentWriteKey()),
    providers,
  };
}

export async function syncLeadToGrowthApis(input = {}) {
  const parsed = LeadSchema.safeParse({
    ...input,
    email: String(input.email || '').trim().toLowerCase(),
    name: cleanText(input.name, 120),
    tiktokUsername: cleanText(input.tiktokUsername, 80).replace(/^@+/, ''),
    source: cleanText(input.source, 80) || 'signup',
    lastPath: String(input.lastPath || '').startsWith('/') ? cleanText(input.lastPath, 220) : '',
  });

  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues?.[0]?.message || 'Invalid growth lead payload',
      providers: [],
    };
  }

  const lead = parsed.data;
  const diagnostics = growthIntegrationDiagnostics();
  if (!diagnostics.enabled) {
    recordGrowthApiEvent('growth', lead.eventName, lead.email, 'skipped', 'GROWTH_API_SYNC_ENABLED is not true');
    return { ok: true, skipped: true, reason: 'disabled', providers: diagnostics.providers };
  }

  const results = [];
  for (const sync of [syncHubSpotLead, syncSegmentLead]) {
    try {
      results.push(await sync(lead));
    } catch (err) {
      const provider = sync === syncHubSpotLead ? 'hubspot' : 'segment';
      recordGrowthApiEvent(provider, lead.eventName, lead.email, 'failed', err?.message || String(err));
      results.push({ provider, status: 'failed', error: err?.message || String(err) });
    }
  }

  const failed = results.filter(result => result.status === 'failed').length;
  return {
    ok: failed === 0,
    skipped: results.every(result => result.status === 'skipped'),
    providers: results,
  };
}
