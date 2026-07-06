import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import db from '../db/db.js';
import { readSiteMarketingFacts } from './marketingAutomation.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

const ALLOWED_STATUSES = new Set(['draft', 'queued', 'published', 'archived']);
const ALLOWED_SOURCES = new Set(['manual', 'site-context']);
const SAFE_CONTENT_TAGS = new Set(['p', 'br', 'h2', 'h3', 'h4', 'ul', 'ol', 'li', 'strong', 'b', 'em', 'i', 'code', 'pre', 'blockquote', 'a']);
const GENERATED_DRAFT_NOTICE = 'This is a generated draft from live site context and is ready for SEO review before publishing.';

function clampNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function safeString(value = '') {
  return String(value || '').replace(/\r\n/g, '\n').trim();
}

function isLocalWritefreelyUrl(value = '') {
  try {
    const parsed = new URL(value);
    return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(parsed.hostname)
      || parsed.hostname.endsWith('.localhost');
  } catch (_err) {
    return false;
  }
}

function parseWritefreelyCredentialsText(value = '') {
  const text = String(value || '');
  const usernameMatch = text.match(/^\s*(?:username|user|alias)\s*[:=]\s*(\S+)\s*$/im);
  const passwordMatch = text.match(/^\s*(?:password|pass)\s*[:=]\s*(.+?)\s*$/im);
  let username = safeString(usernameMatch?.[1] || '');
  let password = safeString(passwordMatch?.[1] || '');

  if (!username || !password) {
    const pairLine = text
      .split(/\r?\n/)
      .map(line => line.match(/^\s*([^:\s]+)\s*:\s*(.+?)\s*$/))
      .find((match) => {
        const key = String(match?.[1] || '').toLowerCase();
        return match && !['url', 'login', 'username', 'user', 'alias', 'password', 'pass'].includes(key);
      });
    if (pairLine) {
      username = username || safeString(pairLine[1]);
      password = password || safeString(pairLine[2]);
    }
  }

  return { username, password };
}

function readLocalWritefreelyCredentials(apiUrl = '') {
  const disabledByEnv = ['1', 'true', 'yes'].includes(safeString(process.env.WRITEFREELY_DISABLE_LOCAL_CREDENTIALS).toLowerCase());
  if (disabledByEnv) {
    return { username: '', password: '', source: 'disabled-by-env', path: '' };
  }
  if (!isLocalWritefreelyUrl(apiUrl)) {
    return { username: '', password: '', source: 'none', path: '' };
  }

  const credentialsPath = process.env.WRITEFREELY_LOCAL_CREDENTIALS_PATH
    ? path.resolve(process.env.WRITEFREELY_LOCAL_CREDENTIALS_PATH)
    : path.join(REPO_ROOT, 'writefreely', 'ADMIN_CREDENTIALS.txt');

  try {
    const credentials = parseWritefreelyCredentialsText(fs.readFileSync(credentialsPath, 'utf8'));
    if (!credentials.username || !credentials.password) {
      return { username: '', password: '', source: 'unreadable-local-admin-file', path: credentialsPath };
    }
    return { ...credentials, source: 'local-admin-file', path: credentialsPath };
  } catch (_err) {
    return { username: '', password: '', source: 'missing-local-admin-file', path: credentialsPath };
  }
}

function htmlEscape(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function decodeHtmlEntities(value = '') {
  return String(value)
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function hasHtmlTags(value = '') {
  return /<\/?[a-z][\s\S]*>/i.test(String(value || ''));
}

function safeHref(value = '') {
  const href = decodeHtmlEntities(value).trim();
  if (!href) return '';
  if (href.startsWith('/') || href.startsWith('#')) return href;
  try {
    const parsed = new URL(href);
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed.toString() : '';
  } catch (_err) {
    return '';
  }
}

function sanitizeHtmlSubset(value = '') {
  return String(value || '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\s+style\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/<\/?([a-z0-9]+)([^>]*)>/gi, (match, rawTag, attrs = '') => {
      const tag = String(rawTag || '').toLowerCase();
      const closing = /^<\//.test(match);
      if (!SAFE_CONTENT_TAGS.has(tag)) return '';
      if (closing) return tag === 'br' ? '' : `</${tag}>`;
      if (tag === 'br') return '<br />';
      if (tag === 'a') {
        const hrefMatch = String(attrs).match(/\s+href\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i);
        const href = safeHref(hrefMatch?.[2] || hrefMatch?.[3] || hrefMatch?.[4] || '');
        if (!href) return '<a>';
        return `<a href="${htmlEscape(href)}" target="_blank" rel="noopener noreferrer">`;
      }
      return `<${tag}>`;
    })
    .replace(/\n{3,}/g, '\n\n')
    .trim();
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
    decodeHtmlEntities(safeString(value))
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' '),
    maxLength
  );
}

function sanitizeRichText(value = '') {
  const text = safeString(value);
  if (!text) return '';
  if (hasHtmlTags(text)) return stripGeneratedDraftNotice(sanitizeHtmlSubset(text));
  return stripGeneratedDraftNotice(`<p>${htmlEscape(text).replace(/\n{2,}/g, '</p><p>').replace(/\n/g, '<br />')}</p>`);
}

function stripGeneratedDraftNotice(value = '') {
  return String(value || '')
    .replace(new RegExp(`<p>\\s*${GENERATED_DRAFT_NOTICE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*</p>`, 'gi'), '')
    .replace(new RegExp(GENERATED_DRAFT_NOTICE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '')
    .replace(/\s{2,}/g, ' ')
    .trim();
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

function normalizePublishedAt(value, status = 'draft') {
  if (value) return value;
  return status === 'published' ? nowISO() : null;
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
    contentHtml: stripGeneratedDraftNotice(row.content_html || ''),
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
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
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
    normalizePublishedAt(input.publishedAt, status)
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
  const publishedAt = normalizePublishedAt(input.publishedAt || post.publishedAt, status);

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

  db.prepare(`
    UPDATE local_blog_posts
    SET
      status = ?,
      published_at = CASE
        WHEN ? = 'published' AND published_at IS NULL THEN CURRENT_TIMESTAMP
        ELSE published_at
      END,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(normalizedStatus, normalizedStatus, safeId);
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
  const apiUrl = safeString(
    process.env.WRITEFREELY_API_URL
      || process.env.WRITEFREELY_URL
      || process.env.WRITEFREELY_PUBLIC_URL
      || 'http://localhost:8080/'
  ).replace(/\/+$/, '');
  const publicUrl = safeString(process.env.WRITEFREELY_PUBLIC_URL || apiUrl).replace(/\/+$/, '');
  const collectionAlias = normalizeSlug(
    process.env.WRITEFREELY_COLLECTION_ALIAS
      || process.env.WRITEFREELY_COLLECTION
      || process.env.WRITEFREELY_USERNAME
      || 'owner',
    'owner'
  );
  const configuredUsername = safeString(process.env.WRITEFREELY_USERNAME);
  const configuredPassword = safeString(process.env.WRITEFREELY_PASSWORD);
  const apiToken = safeString(process.env.WRITEFREELY_API_TOKEN);
  const hasConfiguredCredentials = Boolean(configuredUsername && configuredPassword);
  const localCredentials = !hasConfiguredCredentials
    ? readLocalWritefreelyCredentials(apiUrl)
    : { username: '', password: '', source: 'not-needed', path: '' };
  const username = hasConfiguredCredentials ? configuredUsername : localCredentials.username;
  const password = hasConfiguredCredentials ? configuredPassword : localCredentials.password;
  const credentialSource = apiToken
    ? 'api-token'
    : hasConfiguredCredentials
      ? 'env-username-password'
      : (username && password)
        ? localCredentials.source
        : 'none';
  const webhookToken = safeString(process.env.WRITEFREELY_POST_WEBHOOK_TOKEN || process.env.WRITEFREELY_API_TOKEN);
  const directEnabled = Boolean(apiUrl && (apiToken || (username && password)));
  const webhookEnabled = Boolean(webhookUrl);
  const singleUser = process.env.WRITEFREELY_SINGLE_USER == null
    ? true
    : !['0', 'false', 'no'].includes(safeString(process.env.WRITEFREELY_SINGLE_USER).toLowerCase());
  return {
    webhookUrl,
    dashboardUrl: dashboardUrl || '',
    apiUrl,
    publicUrl,
    collectionAlias,
    username,
    password,
    apiToken,
    webhookToken,
    directEnabled,
    webhookEnabled,
    singleUser,
    hasApiToken: Boolean(apiToken),
    hasCredentials: Boolean(username && password),
    credentialSource,
    localCredentialSource: localCredentials.source,
    localCredentialPath: localCredentials.path,
    publishMethod: directEnabled ? 'direct-api' : (webhookEnabled ? 'webhook' : 'disabled'),
    enabled: directEnabled || webhookEnabled,
  };
}

function markdownInline(value = '') {
  return decodeHtmlEntities(String(value || '').replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

export function buildWritefreelyPostBody(post = {}) {
  const html = stripGeneratedDraftNotice(safeString(post.contentHtml || post.content || ''));
  if (!html) return safeString(post.summary || '');
  if (!hasHtmlTags(html)) return decodeHtmlEntities(html);

  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>\s*<p[^>]*>/gi, '\n\n')
    .replace(/<\/?p[^>]*>/gi, '\n\n')
    .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, (_match, text) => `\n\n## ${markdownInline(text)}\n\n`)
    .replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, (_match, text) => `\n\n### ${markdownInline(text)}\n\n`)
    .replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, (_match, text) => `\n\n#### ${markdownInline(text)}\n\n`)
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_match, text) => `- ${markdownInline(text)}\n`)
    .replace(/<\/?ul[^>]*>|<\/?ol[^>]*>/gi, '\n')
    .replace(/<a\s+[^>]*href\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi, (_match, _raw, quoted, singleQuoted, bare, label) => {
      const href = safeHref(quoted || singleQuoted || bare || '');
      const text = markdownInline(label);
      return href ? `[${text || href}](${href})` : text;
    })
    .replace(/<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi, (_match, _tag, text) => `**${markdownInline(text)}**`)
    .replace(/<(em|i)[^>]*>([\s\S]*?)<\/\1>/gi, (_match, _tag, text) => `_${markdownInline(text)}_`)
    .replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_match, text) => `\`${markdownInline(text)}\``)
    .replace(/<[^>]+>/g, ' ')
    .split('\n')
    .map(line => decodeHtmlEntities(line).replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function renderWritefreelyPayload(post, sourceUrl = '') {
  return {
    title: post.title,
    slug: post.slug,
    summary: post.summary,
    content: buildWritefreelyPostBody(post),
    contentHtml: stripGeneratedDraftNotice(post.contentHtml || ''),
    seo_title: post.seoTitle,
    seo_description: post.seoDescription,
    seo_keywords: post.seoKeywords,
    source_url: sourceUrl || `${post.sourceKey || ''}`,
  };
}

function writefreelyApiUrl(cfg, endpoint) {
  const base = cfg.apiUrl || 'http://localhost:8080';
  const safeEndpoint = String(endpoint || '').startsWith('/') ? endpoint : `/${endpoint || ''}`;
  return `${base}${safeEndpoint}`;
}

async function readWritefreelyResponse(response) {
  const text = await response.text().catch(() => '');
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch (_err) {
    return { raw: text };
  }
}

function writefreelyError(payload, fallback) {
  return payload?.error_msg || payload?.error || payload?.raw || fallback;
}

async function writefreelyApiRequest(cfg, endpoint, { method = 'GET', token = '', body = null } = {}) {
  const response = await fetch(writefreelyApiUrl(cfg, endpoint), {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Token ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const payload = await readWritefreelyResponse(response);
  if (!response.ok || Number(payload?.code || response.status) >= 400) {
    throw new Error(writefreelyError(payload, `WriteFreely API returned status ${response.status}`));
  }
  return payload?.data ?? payload;
}

async function getWritefreelyAccessToken(cfg) {
  if (cfg.apiToken) return cfg.apiToken;
  if (!cfg.username || !cfg.password) {
    throw new Error('Set WRITEFREELY_API_TOKEN or WRITEFREELY_USERNAME and WRITEFREELY_PASSWORD.');
  }
  const data = await writefreelyApiRequest(cfg, '/api/auth/login', {
    method: 'POST',
    body: { alias: cfg.username, pass: cfg.password },
  });
  const token = safeString(data?.access_token);
  if (!token) throw new Error('WriteFreely login did not return an access token.');
  return token;
}

function writefreelyPostApiPayload(post, includeSlug = true) {
  const payload = {
    title: post.title,
    body: buildWritefreelyPostBody(post),
  };
  if (includeSlug) payload.slug = post.slug;
  if (post.publishedAt) {
    const created = new Date(post.publishedAt);
    if (!Number.isNaN(created.getTime())) payload.created = created.toISOString();
  }
  return payload;
}

function writefreelyPostUrl(data = {}, cfg, fallbackSlug = '') {
  if (data.url) return data.url;
  const slug = data.slug || fallbackSlug;
  if (slug && cfg.publicUrl && cfg.singleUser) {
    return `${cfg.publicUrl}/${encodeURIComponent(slug)}`;
  }
  if (slug && cfg.publicUrl && cfg.collectionAlias) {
    return `${cfg.publicUrl}/${encodeURIComponent(cfg.collectionAlias)}/${encodeURIComponent(slug)}`;
  }
  return data.id && cfg.publicUrl ? `${cfg.publicUrl}/${encodeURIComponent(data.id)}` : '';
}

async function findWritefreelyPostBySlug(cfg, token, slug) {
  if (!slug) return null;
  try {
    return await writefreelyApiRequest(
      cfg,
      `/api/collections/${encodeURIComponent(cfg.collectionAlias)}/posts/${encodeURIComponent(slug)}`,
      { token }
    );
  } catch (_err) {
    return null;
  }
}

async function pushViaDirectWritefreelyApi(post, cfg) {
  const token = await getWritefreelyAccessToken(cfg);
  const existing = post.writefreelyPostId
    ? { id: post.writefreelyPostId }
    : await findWritefreelyPostBySlug(cfg, token, post.slug);
  const endpoint = existing?.id
    ? `/api/posts/${encodeURIComponent(existing.id)}`
    : `/api/collections/${encodeURIComponent(cfg.collectionAlias)}/posts`;
  const data = await writefreelyApiRequest(cfg, endpoint, {
    method: 'POST',
    token,
    body: writefreelyPostApiPayload(post, !existing?.id),
  });

  return {
    ok: true,
    status: 200,
    method: 'direct-api',
    postId: data?.id || existing?.id || '',
    postUrl: writefreelyPostUrl(data || existing, cfg, post.slug),
  };
}

async function pushViaWebhook(post, cfg) {
  const response = await fetch(cfg.webhookUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(cfg.webhookToken ? { authorization: `Bearer ${cfg.webhookToken}` } : {}),
    },
    body: JSON.stringify(renderWritefreelyPayload(post)),
  });
  const payload = await readWritefreelyResponse(response);
  if (!response.ok) {
    throw new Error(writefreelyError(payload, `WriteFreely webhook returned status ${response.status}`));
  }
  const data = payload?.data || payload || {};
  return {
    ok: true,
    status: response.status,
    method: 'webhook',
    postId: data.id || data.postId || data.post_id || '',
    postUrl: data.url || data.postUrl || data.post_url || cfg.webhookUrl,
  };
}

function recordWritefreelyPushSuccess(post, result) {
  db.prepare(`
    UPDATE local_blog_posts
    SET
      status = 'published',
      published_at = COALESCE(published_at, CURRENT_TIMESTAMP),
      writefreely_last_push_at = CURRENT_TIMESTAMP,
      writefreely_last_push_error = '',
      writefreely_post_id = COALESCE(NULLIF(?, ''), writefreely_post_id),
      writefreely_post_url = COALESCE(NULLIF(?, ''), writefreely_post_url),
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(result.postId || '', result.postUrl || '', post.id);
}

export async function pushBlogPostToWritefreely(postId) {
  const post = getBlogPostById(postId);
  if (!post) return { ok: false, error: 'Post not found' };

  const cfg = writefreelyPublishConfig();
  if (!cfg.enabled) {
    return {
      ok: false,
      error: 'Configure WRITEFREELY_API_TOKEN or WRITEFREELY_USERNAME/WRITEFREELY_PASSWORD. Legacy WRITEFREELY_POST_WEBHOOK_URL is also supported.',
    };
  }

  try {
    const result = cfg.directEnabled
      ? await pushViaDirectWritefreelyApi(post, cfg)
      : await pushViaWebhook(post, cfg);
    recordWritefreelyPushSuccess(post, result);
    return result;
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
