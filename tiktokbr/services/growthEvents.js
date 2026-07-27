import crypto from 'crypto';
import { Analytics } from '@segment/analytics-node';
import { z } from 'zod';
import db from '../db/db.js';

const CANONICAL_EVENTS = new Set([
  'page_viewed',
  'signup_viewed',
  'signup_cta_clicked',
  'signup_intent_captured',
  'account_created',
  'trial_started',
  'dashboard_opened',
  'setup_started',
  'overlay_url_copied',
  'rehearsal_started',
  'tiktok_connected',
  'first_real_player_seen',
  'paywall_viewed',
  'subscription_started',
  // Aetheris world globe -- coarse engagement signals only (not per-frame/per-drag
  // noise), gathered to evaluate the v0.6 asset-pipeline investment decision.
  'world_globe_viewed',
  'world_globe_intro_completed',
  'world_globe_interacted',
]);

const EventSchema = z.object({
  eventName: z.string().max(80),
  eventId: z.string().max(160).optional().default(''),
  anonymousId: z.string().max(120).optional().default(''),
  consent: z.object({
    analytics: z.boolean().optional().default(false),
    ads: z.boolean().optional().default(false),
    state: z.string().max(40).optional().default('unknown'),
  }).optional().default({}),
  user: z.object({
    id: z.union([z.string(), z.number()]).optional(),
    email: z.string().email().optional(),
    name: z.string().max(120).optional().default(''),
  }).optional().default({}),
  roomId: z.string().max(80).optional().default(''),
  properties: z.record(z.string(), z.unknown()).optional().default({}),
  attribution: z.record(z.string(), z.unknown()).optional().default({}),
  context: z.record(z.string(), z.unknown()).optional().default({}),
});

let segmentClient = null;

function cleanText(value = '', max = 240) {
  return String(value || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function cleanKey(value = '', max = 80) {
  return cleanText(value, max).replace(/[^a-zA-Z0-9_.:-]/g, '_').slice(0, max);
}

function growthTrackingEnabled() {
  return process.env.GROWTH_TRACKING_ENABLED === 'true' || process.env.GROWTH_API_SYNC_ENABLED === 'true';
}

function segmentWriteKey() {
  return cleanText(process.env.SEGMENT_WRITE_KEY || '', 240);
}

function segmentBrowserWriteKey() {
  return cleanText(process.env.SEGMENT_BROWSER_WRITE_KEY || '', 240);
}

function getSegmentClient() {
  const writeKey = segmentWriteKey();
  if (!writeKey) return null;
  if (!segmentClient) segmentClient = new Analytics({ writeKey, flushAt: 1 });
  return segmentClient;
}

function hashValue(value = '') {
  const text = String(value || '').trim();
  if (!text) return '';
  return crypto.createHash('sha256').update(text).digest('hex');
}

function safeJson(value = {}) {
  const seen = new WeakSet();
  return JSON.stringify(value || {}, (_key, nestedValue) => {
    if (typeof nestedValue === 'bigint') return String(nestedValue);
    if (typeof nestedValue === 'function' || typeof nestedValue === 'symbol') return undefined;
    if (nestedValue && typeof nestedValue === 'object') {
      if (seen.has(nestedValue)) return undefined;
      seen.add(nestedValue);
    }
    if (typeof nestedValue === 'string') return cleanText(nestedValue, 1000);
    return nestedValue;
  }).slice(0, 12000);
}

function parseCookie(header = '') {
  return String(header || '').split(';').reduce((acc, part) => {
    const index = part.indexOf('=');
    if (index < 0) return acc;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) acc[key] = decodeURIComponent(value);
    return acc;
  }, {});
}

function consentFromCookie(req) {
  const cookies = req?.cookies || parseCookie(req?.get?.('cookie') || '');
  const state = cleanText(cookies.itb_growth_consent || '', 40).toLowerCase();
  return {
    analytics: state === 'granted',
    ads: state === 'granted',
    state: state || 'unknown',
  };
}

function anonymousIdFromRequest(req) {
  const cookies = req?.cookies || parseCookie(req?.get?.('cookie') || '');
  return cleanKey(cookies.itb_growth_anon || '', 120);
}

function attributionFromRequest(req, inputAttribution = {}) {
  const query = req?.query || {};
  const headers = {
    referrer: req?.get?.('referer') || '',
    userAgent: req?.get?.('user-agent') || '',
  };
  return {
    utm_source: cleanText(inputAttribution.utm_source || inputAttribution.utmSource || query.utm_source || '', 80).toLowerCase(),
    utm_medium: cleanText(inputAttribution.utm_medium || inputAttribution.utmMedium || query.utm_medium || '', 80).toLowerCase(),
    utm_campaign: cleanText(inputAttribution.utm_campaign || inputAttribution.utmCampaign || query.utm_campaign || '', 160),
    utm_content: cleanText(inputAttribution.utm_content || inputAttribution.utmContent || query.utm_content || '', 160),
    ttclid: cleanText(inputAttribution.ttclid || query.ttclid || '', 240),
    landing_path: cleanText(inputAttribution.landing_path || inputAttribution.landingPath || req?.originalUrl || req?.url || req?.path || '', 500),
    referrer: cleanText(inputAttribution.referrer || headers.referrer, 500),
    user_agent: cleanText(inputAttribution.user_agent || inputAttribution.userAgent || headers.userAgent, 500),
  };
}

function requestContext(req) {
  if (!req) return {};
  return {
    path: cleanText(req.originalUrl || req.url || req.path || '', 500),
    referrer: cleanText(req.get?.('referer') || '', 500),
    userAgent: cleanText(req.get?.('user-agent') || '', 500),
    ipHash: hashValue(req.ip || req.socket?.remoteAddress || ''),
  };
}

function normalizeConsent(consent = {}) {
  const state = cleanText(consent.state || '', 40).toLowerCase();
  const analytics = Boolean(consent.analytics);
  const ads = Boolean(consent.ads);
  if (analytics || ads) return { analytics, ads, state: state || 'granted' };
  if (state === 'denied' || state === 'granted') return { analytics: state === 'granted', ads: state === 'granted', state };
  return { analytics: false, ads: false, state: state || 'unknown' };
}

function stableEventId(eventName, seed = '') {
  const source = cleanText(seed || `${eventName}:${Date.now()}:${crypto.randomUUID()}`, 500);
  return `${eventName}:${hashValue(source).slice(0, 32)}`;
}

function insertGrowthEvent(row) {
  const result = db.prepare(`
    INSERT INTO growth_events (
      event_name, event_id, anonymous_id, user_id, user_email, room_id,
      consent_state, eligible_for_segment, segment_status, segment_detail,
      properties_json, attribution_json, path, referrer, user_agent, ip_hash, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(event_id) DO NOTHING
  `).run(
    row.eventName,
    row.eventId,
    row.anonymousId,
    row.userId,
    row.userEmail,
    row.roomId,
    row.consentState,
    row.eligibleForSegment ? 1 : 0,
    row.segmentStatus,
    row.segmentDetail,
    safeJson(row.properties),
    safeJson(row.attribution),
    row.path,
    row.referrer,
    row.userAgent,
    row.ipHash
  );
  return Number(result?.rowCount ?? result?.changes ?? 0) > 0;
}

function updateSegmentStatus(eventId, status, detail = '') {
  try {
    db.prepare(`
      UPDATE growth_events
      SET segment_status = ?, segment_detail = ?
      WHERE event_id = ?
    `).run(status, cleanText(detail, 500), eventId);
  } catch (_err) {}
}

async function forwardToSegment(row) {
  const analytics = getSegmentClient();
  if (!analytics) {
    updateSegmentStatus(row.eventId, 'skipped', 'missing_segment_write_key');
    return { status: 'skipped', reason: 'missing_segment_write_key' };
  }

  const userId = row.userId || row.userEmail || undefined;
  const anonymousId = row.anonymousId || undefined;
  const properties = {
    ...row.properties,
    event_id: row.eventId,
    consent_state: row.consentState,
    room_id: row.roomId || undefined,
    attribution: row.attribution,
    source: 'intothebattle_growth_engine',
    paid_channel: 'tiktok',
  };

  if (userId || row.userEmail) {
    analytics.identify({
      userId: userId || row.userEmail,
      anonymousId,
      traits: {
        email: row.userEmail || undefined,
        name: row.properties?.name || undefined,
        roomId: row.roomId || undefined,
      },
    });
  }
  analytics.track({
    userId,
    anonymousId,
    event: row.eventName,
    properties,
    context: {
      ip: row.ipHash ? undefined : undefined,
      userAgent: row.userAgent || undefined,
    },
  });
  updateSegmentStatus(row.eventId, 'queued', 'Segment identify/track queued');
  return { status: 'queued' };
}

export function growthEventDiagnostics() {
  return {
    enabled: growthTrackingEnabled(),
    segmentConfigured: Boolean(segmentWriteKey()),
    segmentBrowserConfigured: Boolean(segmentBrowserWriteKey()),
    paidChannel: 'tiktok',
    canonicalEvents: Array.from(CANONICAL_EVENTS),
  };
}

export function publicGrowthConfig() {
  const enabled = growthTrackingEnabled();
  return {
    enabled,
    segmentBrowserWriteKey: enabled ? segmentBrowserWriteKey() || null : null,
    paidChannel: 'tiktok',
    consentRequired: true,
  };
}

export async function recordGrowthEvent(input = {}, req = null) {
  const body = input?.body && typeof input.body === 'object' ? input.body : input;
  const parsed = EventSchema.safeParse({
    ...body,
    eventName: cleanKey(body.eventName || body.event_name || '', 80),
    eventId: cleanText(body.eventId || body.event_id || '', 160),
    anonymousId: cleanKey(body.anonymousId || body.anonymous_id || anonymousIdFromRequest(req), 120),
    consent: body.consent || consentFromCookie(req),
    attribution: {
      ...attributionFromRequest(req, body.attribution || {}),
      ...(body.attribution || {}),
    },
  });

  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues?.[0]?.message || 'Invalid growth event payload' };
  }

  const event = parsed.data;
  if (!CANONICAL_EVENTS.has(event.eventName)) {
    return { ok: false, error: 'Unsupported growth event' };
  }

  const consent = normalizeConsent(event.consent);
  const context = { ...requestContext(req), ...event.context };
  const userId = event.user?.id == null ? '' : cleanText(event.user.id, 80);
  const userEmail = cleanText(event.user?.email || '', 254).toLowerCase();
  const eventId = event.eventId || stableEventId(event.eventName, `${event.eventName}:${userId || userEmail || event.anonymousId}:${event.roomId}:${context.path}`);
  const eligibleForSegment = growthTrackingEnabled() && consent.analytics && consent.ads;
  const row = {
    eventName: event.eventName,
    eventId,
    anonymousId: event.anonymousId,
    userId,
    userEmail,
    roomId: cleanText(event.roomId, 80),
    consentState: consent.state,
    eligibleForSegment,
    segmentStatus: eligibleForSegment ? 'pending' : 'skipped',
    segmentDetail: eligibleForSegment ? '' : `consent:${consent.state}`,
    properties: event.properties || {},
    attribution: attributionFromRequest(req, event.attribution || {}),
    path: cleanText(context.path || '', 500),
    referrer: cleanText(context.referrer || '', 500),
    userAgent: cleanText(context.userAgent || '', 500),
    ipHash: cleanText(context.ipHash || '', 80),
  };

  let stored = false;
  try {
    stored = insertGrowthEvent(row);
  } catch (err) {
    return { ok: false, error: err?.message || 'Unable to store growth event' };
  }

  if (!eligibleForSegment) {
    return { ok: true, stored, forwarded: false, reason: row.segmentDetail, eventId };
  }

  const segment = await forwardToSegment(row);
  return { ok: true, stored, forwarded: segment.status === 'queued', segment, eventId };
}

export async function recordServerGrowthEvent(req, eventName, options = {}) {
  return recordGrowthEvent({
    eventName,
    eventId: options.eventId || stableEventId(eventName, options.stableKey || ''),
    anonymousId: options.anonymousId || anonymousIdFromRequest(req),
    consent: options.consent || consentFromCookie(req),
    user: options.user || {},
    roomId: options.roomId || '',
    properties: options.properties || {},
    attribution: options.attribution || {},
  }, req);
}
