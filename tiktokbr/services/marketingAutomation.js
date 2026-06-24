import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import db from '../db/db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..', '..');

const DEFAULT_PLATFORMS = ['x', 'linkedin', 'facebook', 'instagram', 'tiktok', 'youtube_shorts'];
const PLATFORM_LIMITS = {
  x: 260,
  linkedin: 1100,
  facebook: 900,
  instagram: 1200,
  tiktok: 280,
  youtube_shorts: 420,
  reddit: 900,
};
const PLATFORM_LABELS = {
  x: 'X',
  linkedin: 'LinkedIn',
  facebook: 'Facebook',
  instagram: 'Instagram',
  tiktok: 'TikTok',
  youtube_shorts: 'YouTube Shorts',
  reddit: 'Reddit',
};
const SITE_PAGES = [
  { key: 'home', file: 'home.html', url: '/', fallbackTitle: 'Turn TikTok LIVE chat into a playable battle arena' },
  { key: 'signup', file: 'signup.html', url: '/signup', fallbackTitle: 'Launch your first battle overlay in under 5 minutes' },
  { key: 'how_to_play', file: 'how-to-play.html', url: '/how-to-play', fallbackTitle: 'Show viewers how to play with chat commands' },
  { key: 'sponsors', file: 'sponsors.html', url: '/sponsors', fallbackTitle: 'Put brands inside live battle moments' },
  { key: 'paywall', file: 'paywall.html', url: '/paywall', fallbackTitle: 'Unlock custom brand control and premium overlay tools' },
];

function publicBaseUrl() {
  return String(process.env.APP_BASE_URL || 'https://www.intothebattle.com').replace(/\/+$/, '');
}

function cleanText(value = '', max = 300) {
  return String(value || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function cleanSentence(value = '') {
  const text = cleanText(value, 220).replace(/[.?!]+$/g, '');
  return text || 'IntoTheBattle turns TikTok LIVE chat into a playable battle arena';
}

function firstMatch(text, patterns = []) {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return cleanText(match[1], 260);
  }
  return '';
}

function isoDate(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return new Date().toISOString().slice(0, 10);
  return date.toISOString().slice(0, 10);
}

function scheduledForDate(dateKey, platformIndex = 0) {
  const date = new Date(`${dateKey}T14:00:00.000Z`);
  date.setUTCMinutes(platformIndex * 25);
  return date.toISOString();
}

function normalizePlatform(value = '') {
  const platform = String(value || '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '_');
  return PLATFORM_LABELS[platform] ? platform : '';
}

function configuredPlatforms() {
  const raw = process.env.MARKETING_PLATFORMS || DEFAULT_PLATFORMS.join(',');
  const platforms = raw.split(',').map(normalizePlatform).filter(Boolean);
  return platforms.length ? Array.from(new Set(platforms)) : DEFAULT_PLATFORMS;
}

function hashtagsForTopic(topic) {
  const tags = ['#TikTokLIVE', '#LiveStreaming', '#CreatorTools'];
  if (topic.key === 'how_to_play') tags.push('#InteractiveLive');
  if (topic.key === 'sponsors') tags.push('#BrandActivation');
  if (topic.key === 'signup') tags.push('#StreamerTools');
  return tags.slice(0, 5);
}

function utmUrl(url, platform, dateKey, topicKey) {
  const fullUrl = new URL(url, publicBaseUrl());
  fullUrl.searchParams.set('utm_source', platform);
  fullUrl.searchParams.set('utm_medium', 'social');
  fullUrl.searchParams.set('utm_campaign', `daily_sales_${dateKey.replace(/-/g, '')}`);
  fullUrl.searchParams.set('utm_content', topicKey);
  return fullUrl.toString();
}

function trimToPlatform(text, platform) {
  const max = PLATFORM_LIMITS[platform] || 700;
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 3)).replace(/\s+\S*$/, '')}...`;
}

function platformLimit(platform) {
  return PLATFORM_LIMITS[normalizePlatform(platform)] || 700;
}

export function marketingPlatformCharacterLimit(platform) {
  return platformLimit(platform);
}

function ensureHttpUrl(value, fallback = '') {
  const text = String(value || '').trim();
  if (!text) return fallback;
  try {
    const parsed = new URL(text);
    if (!['http:', 'https:'].includes(parsed.protocol)) return fallback;
    return parsed.toString();
  } catch (_err) {
    return fallback;
  }
}

function normalizeScheduledFor(value, fallback = null) {
  const text = String(value || '').trim();
  if (!text) return fallback;
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return fallback;
  return date.toISOString();
}

function validateMarketingPostRow(row, nextStatus = row?.status) {
  if (!row) throw new Error('Marketing post not found');
  const status = String(nextStatus || '').toLowerCase();
  if (status !== 'approved' && status !== 'published') return;
  const body = String(row.body || '').trim();
  const url = ensureHttpUrl(row.utm_url || row.url, '');
  if (!body) throw new Error('Marketing post body is required before approval');
  if (!url) throw new Error('Marketing post needs a valid http/https URL before approval');
  if (!normalizeScheduledFor(row.scheduled_for, null)) throw new Error('Marketing post needs a valid scheduled time before approval');
  if (body.length > platformLimit(row.platform)) throw new Error(`Marketing post is over the ${platformLimit(row.platform)} character limit for ${row.platform}`);
}

function composePlatformContent({ body, cta, url, tags, platform }) {
  const max = PLATFORM_LIMITS[platform] || 700;
  const tagText = tags.length ? `\n\n${tags.join(' ')}` : '';
  const required = `\n\n${cta}\n${url}`;
  const bodyBudget = Math.max(40, max - required.length - tagText.length);
  const trimmedBody = trimToPlatform(body, platform).length > bodyBudget
    ? `${body.slice(0, Math.max(0, bodyBudget - 3)).replace(/\s+\S*$/, '')}...`
    : body;
  const withTags = `${trimmedBody}${required}${tagText}`;
  if (withTags.length <= max) return withTags;
  const withoutTags = `${trimmedBody}${required}`;
  if (withoutTags.length <= max) return withoutTags;
  const tinyBodyBudget = Math.max(24, max - required.length - 1);
  return `${body.slice(0, Math.max(0, tinyBodyBudget - 3)).replace(/\s+\S*$/, '')}...${required}`;
}

export function readSiteMarketingFacts() {
  return SITE_PAGES.map(page => {
    const filepath = path.join(ROOT_DIR, page.file);
    let html = '';
    try {
      html = fs.readFileSync(filepath, 'utf8');
    } catch (_err) {}
    const title = firstMatch(html, [
      /<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/i,
      /<title>(.*?)<\/title>/i,
      /<h1[^>]*>(.*?)<\/h1>/i,
    ]) || page.fallbackTitle;
    const description = firstMatch(html, [
      /<meta\s+name=["']description["']\s+content=["']([^"']+)["']/i,
      /<meta\s+property=["']og:description["']\s+content=["']([^"']+)["']/i,
      /<p[^>]*>(.*?)<\/p>/i,
    ]) || 'IntoTheBattle turns TikTok LIVE chat into a playable battle arena for creators.';
    const h1 = firstMatch(html, [/<h1[^>]*>(.*?)<\/h1>/i]) || title;
    return {
      key: page.key,
      url: `${publicBaseUrl()}${page.url}`,
      title,
      h1,
      description,
    };
  });
}

function topicFromFact(fact, index) {
  const outcomes = [
    'turn viewers into active players',
    'make TikTok LIVE chat easier to understand on screen',
    'give creators a cleaner battle overlay they can test before going live',
    'make brand moments feel like part of the show',
    'help streamers launch a battle arena quickly',
  ];
  return {
    ...fact,
    outcome: outcomes[index % outcomes.length],
    keywords: ['TikTok LIVE overlay', 'interactive livestream', 'battle arena', 'creator tools'],
  };
}

export function buildMarketingPostDrafts({ date = new Date(), platforms = configuredPlatforms() } = {}) {
  const dateKey = isoDate(date);
  const facts = readSiteMarketingFacts().map(topicFromFact);
  return platforms.flatMap((platform, platformIndex) => {
    const topic = facts[platformIndex % facts.length];
    const tags = hashtagsForTopic(topic);
    const url = utmUrl(topic.url, platform, dateKey, topic.key);
    const hook = platform === 'linkedin'
      ? `Creators do not need another passive overlay.`
      : `Turn TikTok LIVE chat into a playable battle arena.`;
    let body;
    if (platform === 'x') {
      body = `${hook} Viewers comment, attack, and join the fight in real time.`;
    } else if (platform === 'tiktok' || platform === 'youtube_shorts') {
      body = `${hook} ${cleanSentence(topic.h1)}. Viewers comment, attack, react, and follow along in a real-time arena.`;
    } else {
      body = `${hook}\n\n${cleanSentence(topic.description)}.\n\nThe outcome: ${topic.outcome}.`;
    }
    const cta = topic.key === 'signup'
      ? 'Launch your first overlay in under 5 minutes.'
      : 'See IntoTheBattle in action.';
    const content = composePlatformContent({ body, cta, url, tags, platform });
    return [{
      campaignDate: dateKey,
      platform,
      platformLabel: PLATFORM_LABELS[platform] || platform,
      topicKey: topic.key,
      audience: platform === 'linkedin' ? 'creator economy operators and sponsors' : 'TikTok LIVE creators',
      goal: 'sales',
      hook,
      body: content,
      cta,
      url: topic.url,
      utmUrl: url,
      hashtags: tags.join(' '),
      seoKeywords: topic.keywords.join(', '),
      scheduledFor: scheduledForDate(dateKey, platformIndex),
    }];
  });
}

export function ensureMarketingPostsForDate({ date = new Date(), platforms = configuredPlatforms(), force = false } = {}) {
  const drafts = buildMarketingPostDrafts({ date, platforms });
  const rows = [];
  const insert = db.prepare(`
    INSERT INTO marketing_posts (
      campaign_date, platform, topic_key, audience, goal, hook, body, cta,
      url, utm_url, hashtags, seo_keywords, scheduled_for, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(campaign_date, platform, topic_key) DO UPDATE SET
      audience = CASE WHEN ? THEN excluded.audience ELSE marketing_posts.audience END,
      goal = CASE WHEN ? THEN excluded.goal ELSE marketing_posts.goal END,
      hook = CASE WHEN ? THEN excluded.hook ELSE marketing_posts.hook END,
      body = CASE WHEN ? THEN excluded.body ELSE marketing_posts.body END,
      cta = CASE WHEN ? THEN excluded.cta ELSE marketing_posts.cta END,
      url = CASE WHEN ? THEN excluded.url ELSE marketing_posts.url END,
      utm_url = CASE WHEN ? THEN excluded.utm_url ELSE marketing_posts.utm_url END,
      hashtags = CASE WHEN ? THEN excluded.hashtags ELSE marketing_posts.hashtags END,
      seo_keywords = CASE WHEN ? THEN excluded.seo_keywords ELSE marketing_posts.seo_keywords END,
      scheduled_for = CASE WHEN ? THEN excluded.scheduled_for ELSE marketing_posts.scheduled_for END,
      updated_at = CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE marketing_posts.updated_at END
  `);
  for (const draft of drafts) {
    insert.run(
      draft.campaignDate,
      draft.platform,
      draft.topicKey,
      draft.audience,
      draft.goal,
      draft.hook,
      draft.body,
      draft.cta,
      draft.url,
      draft.utmUrl,
      draft.hashtags,
      draft.seoKeywords,
      draft.scheduledFor,
      force,
      force,
      force,
      force,
      force,
      force,
      force,
      force,
      force,
      force,
      force
    );
    rows.push(draft);
  }
  return { date: isoDate(date), count: rows.length, drafts: rows };
}

export function listMarketingPosts({ limit = 40, status = '', date = '' } = {}) {
  const safeLimit = Math.max(1, Math.min(200, Number(limit) || 40));
  const filters = [];
  const params = [];
  if (status) {
    filters.push('status = ?');
    params.push(status);
  }
  if (date) {
    filters.push('campaign_date = ?');
    params.push(isoDate(date));
  }
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  return db.prepare(`
    SELECT *
    FROM marketing_posts
    ${where}
    ORDER BY scheduled_for DESC, id DESC
    LIMIT ?
  `).all(...params, safeLimit);
}

export function listMarketingPublishEvents({ limit = 30 } = {}) {
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 30));
  return db.prepare(`
    SELECT events.*, posts.topic_key, posts.utm_url
    FROM marketing_publish_events events
    LEFT JOIN marketing_posts posts ON posts.id = events.marketing_post_id
    ORDER BY events.created_at DESC, events.id DESC
    LIMIT ?
  `).all(safeLimit);
}

export function updateMarketingPostDraft(id, patch = {}) {
  const safeId = Number(id);
  if (!Number.isFinite(safeId) || safeId < 1) throw new Error('Invalid marketing post id');
  const existing = db.prepare('SELECT * FROM marketing_posts WHERE id = ?').get(safeId);
  if (!existing) throw new Error('Marketing post not found');
  if (String(existing.status || '').toLowerCase() === 'published') throw new Error('Published marketing posts cannot be edited');

  const limit = platformLimit(existing.platform);
  const body = String(patch.body || '').replace(/\r\n/g, '\n').trim();
  if (!body) throw new Error('Marketing post body is required');
  if (body.length > limit) throw new Error(`Marketing post is over the ${limit} character limit for ${existing.platform}`);

  const nextUrl = ensureHttpUrl(patch.utmUrl || patch.utm_url || existing.utm_url || existing.url, '');
  if (!nextUrl) throw new Error('Marketing post needs a valid http/https URL');

  const scheduledFor = normalizeScheduledFor(patch.scheduledFor || patch.scheduled_for || existing.scheduled_for, null);
  if (!scheduledFor) throw new Error('Marketing post needs a valid scheduled time');

  db.prepare(`
    UPDATE marketing_posts
    SET body = ?,
        cta = ?,
        utm_url = ?,
        hashtags = ?,
        seo_keywords = ?,
        scheduled_for = ?,
        status = 'draft',
        error_message = '',
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(
    body,
    cleanText(patch.cta || existing.cta || '', 180),
    nextUrl,
    cleanText(patch.hashtags || existing.hashtags || '', 220),
    cleanText(patch.seoKeywords || patch.seo_keywords || existing.seo_keywords || '', 260),
    scheduledFor,
    safeId
  );
}

export function updateMarketingPostStatus(id, status, errorMessage = '') {
  const safeId = Number(id);
  const allowed = new Set(['draft', 'approved', 'published', 'failed', 'skipped']);
  if (!Number.isFinite(safeId) || safeId < 1) throw new Error('Invalid marketing post id');
  if (!allowed.has(status)) throw new Error('Invalid marketing post status');
  const row = db.prepare('SELECT * FROM marketing_posts WHERE id = ?').get(safeId);
  validateMarketingPostRow(row, status);
  db.prepare(`
    UPDATE marketing_posts
    SET status = ?,
        error_message = ?,
        published_at = CASE WHEN ? = 'published' THEN CURRENT_TIMESTAMP ELSE published_at END,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(status, errorMessage || '', status, safeId);
}

function recordMarketingPublishEvent(postId, platform, eventType, detail = '') {
  try {
    db.prepare(`
      INSERT INTO marketing_publish_events (marketing_post_id, platform, event_type, detail, created_at)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    `).run(Number(postId) || null, platform || '', eventType, detail || '');
  } catch (_err) {}
}

function webhookForPlatform(platform) {
  const key = `MARKETING_WEBHOOK_${String(platform || '').toUpperCase()}`;
  return process.env[key] || process.env.MARKETING_OUTBOUND_WEBHOOK_URL || '';
}

export function marketingAutomationDiagnostics() {
  const platforms = configuredPlatforms();
  return {
    enabled: process.env.MARKETING_AUTOMATION_ENABLED === 'true',
    dryRun: process.env.MARKETING_DRY_RUN !== 'false',
    platforms,
    configuredWebhooks: platforms.filter(platform => Boolean(webhookForPlatform(platform))),
  };
}

export async function publishApprovedMarketingPosts({ limit = 10, dryRun = process.env.MARKETING_DRY_RUN !== 'false' } = {}) {
  const diagnostics = marketingAutomationDiagnostics();
  const rows = db.prepare(`
    SELECT *
    FROM marketing_posts
    WHERE status = 'approved'
      AND scheduled_for <= CURRENT_TIMESTAMP
    ORDER BY scheduled_for ASC, id ASC
    LIMIT ?
  `).all(Math.max(1, Math.min(50, Number(limit) || 10)));
  const result = { attempted: rows.length, published: 0, skipped: 0, failed: 0, dryRun: Boolean(dryRun), items: [] };

  for (const row of rows) {
    const platform = normalizePlatform(row.platform);
    const webhookUrl = webhookForPlatform(platform);
    const payload = {
      id: row.id,
      platform,
      platformLabel: PLATFORM_LABELS[platform] || platform,
      content: row.body,
      url: row.utm_url || row.url,
      campaignDate: row.campaign_date,
      topicKey: row.topic_key,
      scheduledFor: row.scheduled_for,
      hashtags: row.hashtags,
      seoKeywords: row.seo_keywords,
    };

    if (dryRun || !diagnostics.enabled) {
      result.skipped++;
      recordMarketingPublishEvent(row.id, platform, 'dry_run', diagnostics.enabled ? 'Dry run is enabled' : 'Marketing automation is disabled');
      result.items.push({ id: row.id, platform, status: 'dry_run', payload });
      continue;
    }

    if (!webhookUrl) {
      result.failed++;
      updateMarketingPostStatus(row.id, 'failed', `No webhook configured for ${platform}`);
      recordMarketingPublishEvent(row.id, platform, 'failed', 'No webhook configured');
      result.items.push({ id: row.id, platform, status: 'failed', error: 'missing_webhook' });
      continue;
    }

    try {
      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!response.ok) throw new Error(`Webhook returned ${response.status}`);
      updateMarketingPostStatus(row.id, 'published');
      recordMarketingPublishEvent(row.id, platform, 'published', `Webhook returned ${response.status}`);
      result.published++;
      result.items.push({ id: row.id, platform, status: 'published' });
    } catch (err) {
      result.failed++;
      updateMarketingPostStatus(row.id, 'failed', err?.message || 'Publish failed');
      recordMarketingPublishEvent(row.id, platform, 'failed', err?.message || 'Publish failed');
      result.items.push({ id: row.id, platform, status: 'failed', error: err?.message || String(err) });
    }
  }

  return result;
}
