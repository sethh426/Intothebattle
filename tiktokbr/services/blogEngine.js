import db from '../db/db.js';
import { readSiteMarketingFacts } from './marketingAutomation.js';

const ALLOWED_STATUSES = new Set(['draft', 'queued', 'published', 'archived']);
const ALLOWED_SOURCES = new Set(['manual', 'site-context']);

function clampNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function safeString(value = '') {
  return String(value || '').replace(/\r\n/g, '\n').trim();
}

function htmlEscape(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function normalizeSlug(value, fallback = 'blog-post') {
  const raw = safeString(value)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-');
  return raw || fallback;
}

function truncate(value, maxLength) {
  const trimmed = safeString(value);
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, Math.max(0, maxLength - 3)).replace(/\s+\S*$/, '')}...`;
}

function sanitizeText(value = '', maxLength = 260) {
  return truncate(
    safeString(value)
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' '),
    maxLength
  );
}

function sanitizeRichText(value = '') {
  return htmlEscape(value).replace(/\n{2,}/g, '</p><p>').replace(/\n/g, '<br />') || '';
}

function normalizeStatus(value, fallback = 'draft') {
  const normalized = safeString(value).toLowerCase();
  return ALLOWED_STATUSES.has(normalized) ? normalized : fallback;
}

function normalizeSource(value, fallback = 'manual') {
  const normalized = safeString(value).toLowerCase();
  return ALLOWED_SOURCES.has(normalized) ? normalized : fallback;
}

function nowISO() {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

function ensureLimitSafe(limit, fallback = 10, max = 30) {
  return clampNumber(limit, fallback, 1, max);
}

function mapPost(row) {
  if (!row) return null;
  return {
    id: row.id,
    slug: row.slug,
    title: row.title || 'Untitled',
    summary: row.summary || '',
    contentHtml: row.content_html || '',
    status: row.status || 'draft',
    source: row.source || 'manual',
    sourceKey: row.source_key || '',
    seoTitle: row.seo_title || row.title || '',
    seoDescription: row.seo_description || '',
    seoKeywords: row.seo_keywords || '',
    publishedAt: row.published_at || null,
    writefreelyPostId: row.writefreely_post_id || '',
    writefreelyPostUrl: row.writefreely_post_url || '',
    writefreelyLastPushAt: row.writefreely_last_push_at || null,
    writefreelyLastPushError: row.writefreely_last_push_error || '',
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
}

function nextAvailableSlug(baseSlug) {
  const cleanBase = normalizeSlug(baseSlug, 'blog-post');
  let candidate = cleanBase;
  let attempt = 0;

  while (db.prepare('SELECT 1 FROM local_blog_posts WHERE slug = ?').get(candidate)) {
    attempt += 1;
    candidate = `${cleanBase}-${attempt}`;
    if (attempt > 20) {
      candidate = `${cleanBase}-${nowISO().replace(/\D/g, '')}`;
      break;
    }
  }
  return candidate;
}

function nextAvailableSlugForId(baseSlug, ignoreId = null) {
  const cleanBase = normalizeSlug(baseSlug, 'blog-post');
  let candidate = cleanBase;
  let attempt = 0;

  while (true) {
    const row = db.prepare(`
      SELECT id FROM local_blog_posts WHERE slug = ? LIMIT 1
    `).get(candidate);
    if (!row || (ignoreId && row.id === ignoreId)) break;
    attempt += 1;
    candidate = `${cleanBase}-${attempt}`;
    if (attempt > 20) {
      candidate = `${cleanBase}-${nowISO().replace(/\D/g, '')}`;
      break;
    }
  }

  return candidate;
}

function buildContextPost(fact, index = 0) {
  const title = sanitizeText(fact.title || 'IntoTheBattle feature update', 130);
  const summary = sanitizeText(fact.description || `A guide on ${title}`, 170);
  const seoTitle = `${title} | IntoTheBattle`;
  const seoDescription = truncate(`${summary} Learn how to use the platform in real TikTok LIVE battles.`, 210);
  const seoKeywords = sanitizeText(`IntoTheBattle, TikTok LIVE, battle arena, chatbot commands, creator overlay, ${fact.key || 'blog'}`, 280);
  const contentHtml = `
    <p>${htmlEscape(summary)}.</p>
    <h2>What this page covers</h2>
    <ul>
      <li>${htmlEscape(sanitizeText(`How ${title} works for TikTok LIVE creators.`, 180))}</li>
      <li>${htmlEscape('How to apply this in your next stream setup flow.')}</li>
      <li>${htmlEscape(`Why this feature improves viewer attention on ${fact.url ? 'your public page' : 'your stream'}.`)}</li>
    </ul>
    <p>Read more on: <a href="${htmlEscape(fact.url || '/')}" target="_blank" rel="noopener noreferrer">${htmlEscape(fact.url || '/')}</a>.</p>
    <p>This is a generated draft from live site context and is ready for SEO review before publishing.</p>
  `.replace(/\s+/g, ' ').trim();

  return {
    slug: `${normalizeSlug(fact.key || fact.url || `post-${index + 1}`, 'feature-update')}-${nowISO().slice(0, 10)}`,
    title,
    summary,
    contentHtml,
    status: 'draft',
    source: 'site-context',
    sourceKey: String(fact.key || fact.url || index),
    seoTitle,
    seoDescription,
    seoKeywords,
  };
}

export function listBlogPosts({
  limit = 12,
  status = '',
  source = '',
  query = '',
  sort = 'published',
  offset = 0,
} = {}) {
  const safeLimit = ensureLimitSafe(limit, 12, 60);
  const safeOffset = clampNumber(offset, 0, 0, 10000);
  const filters = [];
  const params = [];

  if (status) {
    filters.push('status = ?');
    params.push(normalizeStatus(status, ''));
  }
  if (source) {
    filters.push('source = ?');
    params.push(normalizeSource(source, 'manual'));
  }
  if (query) {
    filters.push('(title ILIKE ? OR summary ILIKE ? OR seo_keywords ILIKE ?)');
    const token = `%${truncate(safeString(query), 120)}%`;
    params.push(token, token, token);
  }
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';

  const orderBy = sort === 'updated'
    ? 'updated_at DESC, created_at DESC'
    : 'COALESCE(published_at, created_at) DESC, created_at DESC';

  return db.prepare(`
    SELECT
      id, slug, title, summary, content_html, status, source, source_key,
      seo_title, seo_description, seo_keywords, published_at, writefreely_post_id,
      writefreely_post_url, writefreely_last_push_at, writefreely_last_push_error,
      created_at, updated_at
    FROM local_blog_posts
    ${where}
    ORDER BY ${orderBy}
    LIMIT ? OFFSET ?
  `).all(...params, safeLimit, safeOffset).map(mapPost);
}

export function getBlogPostBySlug(slug) {
  return mapPost(db.prepare(`
    SELECT
      id, slug, title, summary, content_html, status, source, source_key,
      seo_title, seo_description, seo_keywords, published_at, writefreely_post_id,
      writefreely_post_url, writefreely_last_push_at, writefreely_last_push_error,
      created_at, updated_at
    FROM local_blog_posts
    WHERE slug = ?
    LIMIT 1
  `).get(normalizeSlug(String(slug || ''), 'blog-post')));
}

export function getBlogPostById(id) {
  const safeId = Number(id);
  if (!Number.isFinite(safeId) || safeId <= 0) return null;
  return mapPost(db.prepare(`
    SELECT
      id, slug, title, summary, content_html, status, source, source_key,
      seo_title, seo_description, seo_keywords, published_at, writefreely_post_id,
      writefreely_post_url, writefreely_last_push_at, writefreely_last_push_error,
      created_at, updated_at
    FROM local_blog_posts
    WHERE id = ?
    LIMIT 1
  `).get(safeId));
}

export function createBlogPost(input = {}) {
  const title = sanitizeText(input.title || input.seoTitle || 'New update', 140);
  const summary = sanitizeText(input.summary || 'Creator-focused update from IntoTheBattle.', 260);
  const contentHtml = sanitizeRichText(input.contentHtml || input.content || '');
  const status = normalizeStatus(input.status, 'draft');
  const source = normalizeSource(input.source, 'manual');
  const slug = nextAvailableSlug(
    sanitizeText(normalizeSlug(input.slug || title, `${title} ${nowISO().slice(0, 10)}`), 150)
  );

  db.prepare(`
    INSERT INTO local_blog_posts (
      slug, title, summary, content_html, status, source, source_key,
      seo_title, seo_description, seo_keywords, published_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run(
    slug,
    title,
    summary,
    contentHtml,
    status,
    source,
    sanitizeText(input.sourceKey || ''),
    sanitizeText(input.seoTitle || title, 170),
    sanitizeText(input.seoDescription || summary, 240),
    sanitizeText(input.seoKeywords || 'TikTok LIVE, IntoTheBattle, live streaming', 280),
    input.publishedAt || null
  );

  return getBlogPostBySlug(slug);
}

export function updateBlogPost(id, input = {}) {
  const safeId = Number(id);
  if (!Number.isFinite(safeId) || safeId <= 0) throw new Error('Invalid blog post id');

  const post = getBlogPostById(safeId);
  if (!post) throw new Error('Blog post not found');
  const updateSlug = post.source === 'manual' && input.slug ? normalizeSlug(input.slug, post.slug) : post.slug;
  const title = sanitizeText(input.title || post.title, 140);
  const summary = sanitizeText(input.summary || post.summary, 260);
  const contentHtml = sanitizeRichText(input.contentHtml || input.content || post.contentHtml);
  const status = normalizeStatus(input.status || post.status, post.status);
  const publishedAt = input.publishedAt || post.publishedAt || null;

  db.prepare(`
    UPDATE local_blog_posts
    SET
      slug = ?,
      title = ?,
      summary = ?,
      content_html = ?,
      status = ?,
      seo_title = ?,
      seo_description = ?,
      seo_keywords = ?,
      published_at = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(
    nextAvailableSlugForId(updateSlug, safeId),
    title,
    summary,
    contentHtml,
    status,
    sanitizeText(input.seoTitle || post.seoTitle || title, 170),
    sanitizeText(input.seoDescription || post.seoDescription || summary, 240),
    sanitizeText(input.seoKeywords || post.seoKeywords, 280),
    publishedAt,
    safeId
  );

  return getBlogPostById(safeId);
}

export function setBlogPostStatus(id, status) {
  const safeId = Number(id);
  const normalizedStatus = normalizeStatus(status, 'draft');
  if (!Number.isFinite(safeId) || safeId <= 0) throw new Error('Invalid blog post id');

  db.prepare('UPDATE local_blog_posts SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run(normalizedStatus, safeId);
  return getBlogPostById(safeId);
}

export function deleteBlogPost(id) {
  const safeId = Number(id);
  if (!Number.isFinite(safeId) || safeId <= 0) throw new Error('Invalid blog post id');
  const post = getBlogPostById(safeId);
  if (!post) throw new Error('Blog post not found');
  db.prepare('DELETE FROM local_blog_posts WHERE id = ?').run(safeId);
  return post;
}

export function generateBlogDraftsFromSiteContext({ force = false } = {}) {
  const facts = readSiteMarketingFacts();
  const created = [];
  const skipped = [];
  const updated = [];

  for (let i = 0; i < facts.length; i += 1) {
    const draft = buildContextPost(facts[i], i);
    const existing = getBlogPostBySlug(draft.slug);

    if (existing && existing.source !== 'site-context') {
      skipped.push({ slug: draft.slug, reason: 'manual-post-with-same-slug' });
      continue;
    }
    if (existing && !force && existing.status !== 'draft') {
      skipped.push({ slug: draft.slug, reason: `preserved-${existing.status}` });
      continue;
    }

    if (existing) {
      updateBlogPost(existing.id, {
        title: draft.title,
        summary: draft.summary,
        contentHtml: draft.contentHtml,
        status: force ? 'draft' : existing.status,
        seoTitle: draft.seoTitle,
        seoDescription: draft.seoDescription,
        seoKeywords: draft.seoKeywords,
        publishedAt: existing.publishedAt,
      });
      updated.push(draft.slug);
      continue;
    }

    createBlogPost({
      slug: draft.slug,
      title: draft.title,
      summary: draft.summary,
      contentHtml: draft.contentHtml,
      status: 'draft',
      source: 'site-context',
      sourceKey: draft.sourceKey,
      seoTitle: draft.seoTitle,
      seoDescription: draft.seoDescription,
      seoKeywords: draft.seoKeywords,
    });
    created.push(draft.slug);
  }

  return { created, updated, skipped, count: facts.length };
}

export function writefreelyPublishConfig() {
  const webhookUrl = safeString(process.env.WRITEFREELY_POST_WEBHOOK_URL);
  const dashboardUrl = safeString(process.env.WRITEFREELY_MANUAL_POST_DASHBOARD_URL);
  const apiToken = safeString(process.env.WRITEFREELY_API_TOKEN);
  return {
    webhookUrl,
    dashboardUrl: dashboardUrl || '',
    apiToken,
    enabled: Boolean(webhookUrl),
  };
}

function renderWritefreelyPayload(post, sourceUrl = '') {
  return {
    title: post.title,
    slug: post.slug,
    summary: post.summary,
    content: post.contentHtml,
    seo_title: post.seoTitle,
    seo_description: post.seoDescription,
    seo_keywords: post.seoKeywords,
    source_url: sourceUrl || `${post.sourceKey || ''}`,
  };
}

export async function pushBlogPostToWritefreely(postId) {
  const post = getBlogPostById(postId);
  if (!post) return { ok: false, error: 'Post not found' };

  const cfg = writefreelyPublishConfig();
  if (!cfg.enabled) return { ok: false, error: 'WRITEFREELY_POST_WEBHOOK_URL is not configured' };

  try {
    const response = await fetch(cfg.webhookUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(cfg.apiToken ? { authorization: `Bearer ${cfg.apiToken}` } : {}),
      },
      body: JSON.stringify(renderWritefreelyPayload(post)),
    });
    const payload = await response.text().catch(() => '');
    if (!response.ok) throw new Error(payload || `WriteFreely webhook returned status ${response.status}`);
    db.prepare(`
      UPDATE local_blog_posts
      SET
        writefreely_last_push_at = CURRENT_TIMESTAMP,
        writefreely_last_push_error = '',
        writefreely_post_url = COALESCE(NULLIF(writefreely_post_url, ''), ?)
      WHERE id = ?
    `).run(cfg.webhookUrl, post.id);
    return { ok: true, status: response.status };
  } catch (err) {
    const errorText = err?.message || 'WriteFreely publish failed';
    db.prepare(`
      UPDATE local_blog_posts
      SET
        writefreely_last_push_at = CURRENT_TIMESTAMP,
        writefreely_last_push_error = ?
      WHERE id = ?
    `).run(errorText.slice(0, 500), post.id);
    return { ok: false, error: errorText };
  }
}
