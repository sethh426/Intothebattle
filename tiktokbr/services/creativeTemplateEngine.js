import { z } from 'zod';
import db from '../db/db.js';

const DEFAULT_PLATFORMS = ['tiktok', 'instagram', 'youtube_shorts', 'linkedin', 'facebook', 'x'];
const PLATFORM_RULES = {
  tiktok: { label: 'TikTok', format: '9:16 vertical', copyLimit: 280, safeZone: { top: 14, bottom: 22, left: 8, right: 8 } },
  instagram: { label: 'Instagram Reels', format: '9:16 vertical', copyLimit: 1200, safeZone: { top: 14, bottom: 22, left: 8, right: 8 } },
  youtube_shorts: { label: 'YouTube Shorts', format: '9:16 vertical', copyLimit: 420, safeZone: { top: 12, bottom: 18, left: 8, right: 8 } },
  linkedin: { label: 'LinkedIn', format: '1:1 square or 4:5 feed', copyLimit: 1100, safeZone: { top: 8, bottom: 8, left: 8, right: 8 } },
  facebook: { label: 'Facebook', format: '4:5 feed or 9:16 reels', copyLimit: 900, safeZone: { top: 10, bottom: 16, left: 8, right: 8 } },
  x: { label: 'X', format: '16:9 or 1:1 feed', copyLimit: 260, safeZone: { top: 6, bottom: 6, left: 6, right: 6 } },
};
const ASSET_TYPES = {
  real_overlay_clip: 'Real overlay clip',
  real_overlay_screenshot: 'Real overlay screenshot',
  sponsor_break_clip: 'Real sponsor break clip',
  dashboard_screenshot: 'Dashboard screenshot',
  product_logo: 'Product logo',
  approved_texture: 'Approved texture/background',
  generated_background: 'Generated background',
};
const APPROVED_PROOF_ASSETS = new Set(['real_overlay_clip', 'real_overlay_screenshot', 'sponsor_break_clip', 'dashboard_screenshot']);
const VIDEO_ASSET_TYPES = new Set(['real_overlay_clip', 'sponsor_break_clip']);
const IMAGE_ASSET_TYPES = new Set(['real_overlay_screenshot', 'dashboard_screenshot', 'product_logo', 'approved_texture', 'generated_background']);
const VIDEO_EXTENSIONS = new Set(['.mp4', '.webm', '.mov', '.m4v']);
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.avif', '.gif']);
const TEMPLATE_DEFINITIONS = [
  {
    key: 'twelve_second_demo',
    label: '12-second product demo',
    audience: 'TikTok LIVE creators',
    goal: 'conversion',
    path: '/signup',
    requiredAssetTypes: ['real_overlay_clip', 'real_overlay_screenshot'],
    hooks: [
      'Turn your TikTok LIVE chat into a playable battle arena.',
      'Your viewers are already chatting. Make them fight inside the stream.',
      'Launch a live battle overlay before your next TikTok LIVE.',
    ],
    proofs: [
      'Comments become attacks, likes become effects, and the overlay reacts live.',
      'Viewers can join, fight, and see the action without leaving the stream.',
      'The streamer gets a playable arena instead of another passive overlay.',
    ],
    ctas: ['Launch your first battle in under 5 minutes.', 'Try the battle overlay free today.'],
  },
  {
    key: 'signup_result',
    label: 'Signup result post',
    audience: 'new creators',
    goal: 'signup',
    path: '/signup',
    requiredAssetTypes: ['real_overlay_screenshot', 'dashboard_screenshot'],
    hooks: [
      'Your TikTok LIVE can become interactive in minutes.',
      'Stop hoping viewers type. Give them something to play.',
      'A better LIVE starts with a battle your chat can control.',
    ],
    proofs: [
      'Set up your room, copy the OBS URL, and test events before going live.',
      'The creator dashboard keeps setup focused on the actions that matter.',
      'The first win is simple: chat sees the battle react instantly.',
    ],
    ctas: ['Start with everything unlocked for 7 days.', 'Create your battle room today.'],
  },
  {
    key: 'sponsor_broadcast',
    label: 'Sponsor broadcast pitch',
    audience: 'brands and partners',
    goal: 'sponsor-lead',
    path: '/sponsors',
    requiredAssetTypes: ['sponsor_break_clip', 'real_overlay_clip'],
    hooks: [
      'Put your brand inside the live battle, not beside it.',
      'Make brand moments feel like a sports broadcast.',
      'Sponsor breaks should feel like part of the show.',
    ],
    proofs: [
      'The break enters with broadcast-style motion, video, and game stats.',
      'Brand moments can appear during natural intermissions in the battle.',
      'The audience stays inside the entertainment instead of staring at a static ad.',
    ],
    ctas: ['Talk to IntoTheBattle about arena placements.', 'See how sponsor moments work.'],
  },
  {
    key: 'player_commands',
    label: 'How players interact',
    audience: 'creator audiences',
    goal: 'education',
    path: '/how-to-play',
    requiredAssetTypes: ['real_overlay_screenshot'],
    hooks: [
      'Your viewers can play with chat commands.',
      'Comments are not just comments anymore.',
      'Let your audience fight with simple commands.',
    ],
    proofs: [
      'Players can attack, change icons, react, and follow the battle from chat.',
      'Simple commands make the overlay feel alive without confusing viewers.',
      'The game explains itself through visible reactions and battle feedback.',
    ],
    ctas: ['Show viewers how to enter the battle.', 'Preview the player commands.'],
  },
  {
    key: 'trial_unlock',
    label: '7-day unlocked trial',
    audience: 'high-intent creators',
    goal: 'trial-start',
    path: '/signup',
    requiredAssetTypes: ['real_overlay_screenshot', 'dashboard_screenshot'],
    hooks: [
      'Get 7 days of the full battle overlay unlocked.',
      'Try the full creator battle setup before paying.',
      'Your first interactive TikTok LIVE starts free.',
    ],
    proofs: [
      'Test overlay events, copy your OBS URL, and run a real battle setup.',
      'The trial is built to help creators launch quickly, not guess.',
      'You get the core experience before deciding what to upgrade.',
    ],
    ctas: ['Start the 7-day unlocked trial.', 'Open your battle room.'],
  },
  {
    key: 'social_proof',
    label: 'Creator proof / recap',
    audience: 'creators comparing tools',
    goal: 'trust',
    path: '/',
    requiredAssetTypes: ['real_overlay_clip', 'real_overlay_screenshot'],
    hooks: [
      'A live chat is more valuable when the audience can affect the show.',
      'Interactive streams create moments viewers remember.',
      'The best overlay is the one your audience wants to play.',
    ],
    proofs: [
      'The battle gives creators visible action, viewer participation, and recap-worthy moments.',
      'Chat activity turns into a game layer creators can show on screen.',
      'The product is built around live engagement, not passive decoration.',
    ],
    ctas: ['See IntoTheBattle in action.', 'Build your first battle room.'],
  },
  {
    key: 'feature_highlight',
    label: 'Feature highlight',
    audience: 'TikTok LIVE creators',
    goal: 'education',
    path: '/home',
    requiredAssetTypes: ['real_overlay_screenshot', 'dashboard_screenshot'],
    hooks: [
      'One overlay can handle chat attacks, likes, gifts, and sponsor moments.',
      'The battle overlay reacts while your audience plays.',
      'Give viewers a reason to keep typing.',
    ],
    proofs: [
      'Events are queued so comments, likes, gifts, attacks, sounds, and breaks do not fight each other.',
      'Creators can test events before going live and keep the overlay room-scoped.',
      'The overlay is designed for repeat play, not one-time novelty.',
    ],
    ctas: ['Try the overlay workflow.', 'Launch a battle test.'],
  },
  {
    key: 'checkout_recovery',
    label: 'Checkout recovery',
    audience: 'trial and checkout users',
    goal: 'recovery',
    path: '/paywall',
    requiredAssetTypes: ['dashboard_screenshot', 'real_overlay_screenshot'],
    hooks: [
      'Your battle room is already waiting.',
      'Finish setup before your next TikTok LIVE.',
      'Do not let the next live be another passive chat.',
    ],
    proofs: [
      'Paid creators unlock custom control while free sessions stay company-supported.',
      'The fastest path is simple: log in, copy the overlay URL, and test events.',
      'Creator Pro gives serious streamers more control over the broadcast experience.',
    ],
    ctas: ['Finish your creator setup.', 'Open the upgrade page.'],
  },
];
const AssetSchema = z.object({
  title: z.string().trim().min(2).max(120),
  assetType: z.enum(Object.keys(ASSET_TYPES)),
  assetUrl: z.string().trim().min(1).max(700),
  source: z.string().trim().max(80).optional().default('manual'),
  approvalStatus: z.enum(['approved', 'draft', 'blocked']).optional().default('approved'),
  notes: z.string().trim().max(500).optional().default(''),
});

function publicBaseUrl() {
  return String(process.env.APP_BASE_URL || 'https://www.intothebattle.com').replace(/\/+$/, '');
}

function cleanText(value = '', max = 220) {
  return String(value || '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function normalizePlatform(platform = '') {
  const key = String(platform || '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '_');
  return PLATFORM_RULES[key] ? key : 'tiktok';
}

function templateByKey(key) {
  return TEMPLATE_DEFINITIONS.find(template => template.key === key) || null;
}

function isValidAssetUrl(value = '') {
  const text = String(value || '').trim();
  if (text.startsWith('/')) return true;
  try {
    const parsed = new URL(text);
    return ['http:', 'https:'].includes(parsed.protocol);
  } catch (_err) {
    return false;
  }
}

function pathnameForAssetUrl(value = '') {
  const text = String(value || '').trim();
  if (!text) return '';
  try {
    return text.startsWith('/') ? new URL(text, publicBaseUrl()).pathname : new URL(text).pathname;
  } catch (_err) {
    return text.split('?')[0].split('#')[0];
  }
}

function fileExtensionForAssetUrl(value = '') {
  const pathname = pathnameForAssetUrl(value).toLowerCase();
  const index = pathname.lastIndexOf('.');
  return index >= 0 ? pathname.slice(index) : '';
}

function parseJsonObject(value = '') {
  try {
    const parsed = JSON.parse(value || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_err) {
    return {};
  }
}

function assetUrlCompatibility(assetUrl = '', assetType = '') {
  const extension = fileExtensionForAssetUrl(assetUrl);
  if (!extension) return { status: 'unknown', note: 'Asset URL has no file extension, so media type cannot be verified from the path.' };
  if (VIDEO_ASSET_TYPES.has(assetType) && !VIDEO_EXTENSIONS.has(extension)) {
    return { status: 'mismatch', note: 'Video templates should use MP4, WebM, MOV, or M4V proof assets.' };
  }
  if (IMAGE_ASSET_TYPES.has(assetType) && !IMAGE_EXTENSIONS.has(extension)) {
    return { status: 'mismatch', note: 'Image templates should use PNG, JPG, WebP, AVIF, or GIF assets.' };
  }
  return { status: 'match', note: '' };
}

function utmUrl(path, platform, templateKey, variantIndex = 0) {
  const fullUrl = new URL(path || '/', publicBaseUrl());
  fullUrl.searchParams.set('utm_source', platform);
  fullUrl.searchParams.set('utm_medium', 'creative_template');
  fullUrl.searchParams.set('utm_campaign', `growth_${templateKey}`);
  fullUrl.searchParams.set('utm_content', `variant_${variantIndex + 1}`);
  return fullUrl.toString();
}

function trimToLimit(value, max) {
  const text = String(value || '').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 3)).replace(/\s+\S*$/, '')}...`;
}

function bodyForBlocks({ hook, proof, cta, url, platform }) {
  const limit = PLATFORM_RULES[platform]?.copyLimit || 700;
  const safeUrl = String(url || '').trim();
  const reservedForUrl = safeUrl ? safeUrl.length + 1 : 0;
  const textLimit = Math.max(40, limit - reservedForUrl);
  const copy = trimToLimit(`${hook}\n\n${proof}\n\n${cta}`, textLimit);
  return trimToLimit(safeUrl ? `${copy}\n${safeUrl}` : copy, limit);
}

function visualDirectionForTemplate(template, assetType = '') {
  const requiresProof = template.goal !== 'education';
  const proofInstruction = APPROVED_PROOF_ASSETS.has(assetType)
    ? 'Use the approved real product asset as the main visual proof.'
    : 'Use only as a supporting texture; this cannot replace real product proof.';
  const directions = {
    twelve_second_demo: 'Show a real battle overlay in motion, tight on chat-to-attack action, with the CTA landing after the kill/sponsor beat.',
    signup_result: 'Show the dashboard setup path and the overlay result together so the promise feels achievable in minutes.',
    sponsor_broadcast: 'Use a sports-broadcast composition: full-screen brand moment, arena frame, stats end-cap, and return-to-battle energy.',
    player_commands: 'Show command examples beside the live overlay reaction, with simple visual callouts for attack, emoji, likes, and gifts.',
    trial_unlock: 'Show the full unlocked creator setup: overlay preview, OBS URL, test event, and ready-to-go checklist.',
    social_proof: 'Show real overlay action with a creator-benefit headline and enough room for a short proof caption.',
    feature_highlight: 'Show the event queue feeling controlled: attacks, likes, gifts, sound, and sponsor moment ordered cleanly.',
    checkout_recovery: 'Show the dashboard ready state and a clear path back to setup, not a generic checkout screen.',
  };
  return {
    primaryVisual: directions[template.key] || 'Use a real IntoTheBattle overlay or dashboard asset as the hero proof.',
    proofInstruction,
    imagePrompt: `${directions[template.key] || 'Create a polished IntoTheBattle growth creative.'} Cyber broadcast style, crisp readable text zones, no fake UI, no unrelated game mockups, brand-safe arena lighting. ${requiresProof ? 'Main visual must be a real overlay, sponsor-break, or dashboard capture.' : 'Supporting generated art is acceptable when the real product asset stays visible.'}`,
  };
}

function hashtagsForCreative(templateKey = '', platform = '') {
  const common = ['#TikTokLIVE', '#CreatorTools', '#LiveStreaming'];
  const templateTags = {
    twelve_second_demo: ['#InteractiveLive', '#StreamerTools'],
    signup_result: ['#StreamerTools', '#OBS'],
    sponsor_broadcast: ['#BrandActivation', '#SportsMarketing'],
    player_commands: ['#InteractiveLive', '#LiveGame'],
    trial_unlock: ['#CreatorTools', '#StreamerTools'],
    social_proof: ['#LiveStreaming', '#AudienceEngagement'],
    feature_highlight: ['#TikTokLIVE', '#CreatorEconomy'],
    checkout_recovery: ['#StreamerTools', '#LiveStreaming'],
  };
  const platformTags = platform === 'linkedin' ? ['#CreatorEconomy'] : [];
  return Array.from(new Set([...common, ...(templateTags[templateKey] || []), ...platformTags])).slice(0, 6).join(' ');
}

function seoKeywordsForCreative(templateKey = '') {
  const keywords = ['TikTok LIVE overlay', 'interactive livestream', 'creator tools', 'battle arena'];
  const extra = {
    sponsor_broadcast: ['brand activation', 'live stream sponsorship', 'broadcast sponsor moments'],
    player_commands: ['TikTok chat commands', 'interactive live game'],
    trial_unlock: ['TikTok live trial', 'OBS overlay setup'],
    checkout_recovery: ['creator pro overlay', 'streamer upgrade'],
  };
  return Array.from(new Set([...keywords, ...(extra[templateKey] || [])])).join(', ');
}

function audienceForTemplate(template) {
  if (template?.key === 'sponsor_broadcast') return 'brands and partner marketers';
  if (template?.key === 'checkout_recovery') return 'trial and checkout users';
  return template?.audience || 'TikTok LIVE creators';
}

function buildBlocks({ template, platform, variantIndex, asset }) {
  const hook = template.hooks[variantIndex % template.hooks.length];
  const proof = template.proofs[(variantIndex + 1) % template.proofs.length];
  const cta = template.ctas[(variantIndex + 2) % template.ctas.length];
  const url = utmUrl(template.path, platform, template.key, variantIndex);
  const assetType = asset?.asset_type || asset?.assetType || '';
  const visualDirection = visualDirectionForTemplate(template, assetType);
  return {
    hook,
    proof,
    cta,
    url,
    assetUrl: asset?.asset_url || asset?.assetUrl || '',
    assetType,
    requiredAssetTypes: template.requiredAssetTypes,
    safeZone: PLATFORM_RULES[platform]?.safeZone || PLATFORM_RULES.tiktok.safeZone,
    textBlocks: [
      { slot: 'hook', time: '0-2s', text: hook },
      { slot: 'proof', time: '2-9s', text: proof },
      { slot: 'cta', time: '9-12s', text: cta },
    ],
    visualDirection,
    hashtags: hashtagsForCreative(template.key, platform),
    seoKeywords: seoKeywordsForCreative(template.key),
    audience: audienceForTemplate(template),
    goal: template.goal,
    frameScript: [
      { time: '0-2s', block: 'hook', text: hook },
      { time: '2-9s', block: 'proof', text: proof },
      { time: '9-12s', block: 'cta', text: cta },
    ],
  };
}

export function listCreativeTemplates() {
  return TEMPLATE_DEFINITIONS.map(template => ({
    ...template,
    requiredAssetLabels: template.requiredAssetTypes.map(type => ASSET_TYPES[type] || type),
  }));
}

export function creativeTemplateOptions() {
  return {
    platforms: DEFAULT_PLATFORMS.map(key => ({ key, ...PLATFORM_RULES[key] })),
    assetTypes: Object.entries(ASSET_TYPES).map(([key, label]) => ({ key, label })),
  };
}

export function runCreativeQualityGate({ templateKey, platform, assetType, assetStatus = 'approved', assetUrl = '', body = '', cta = '', url = '', safeZone = {} } = {}) {
  const template = templateByKey(templateKey);
  const normalizedPlatform = normalizePlatform(platform);
  const rules = PLATFORM_RULES[normalizedPlatform] || PLATFORM_RULES.tiktok;
  const notes = [];
  let score = 100;

  if (!template) {
    notes.push('Unknown template.');
    score -= 40;
  }
  if (!body.trim()) {
    notes.push('Outbound copy is required.');
    score -= 25;
  }
  if (body.length > rules.copyLimit) {
    notes.push(`Copy exceeds ${rules.copyLimit} characters for ${rules.label}.`);
    score -= 25;
  }
  if (url && !body.includes(url)) {
    notes.push('Outbound copy should include the tracked UTM URL.');
    score -= 15;
  }
  if (!cta.trim()) {
    notes.push('CTA is required.');
    score -= 15;
  } else if (body && !body.includes(cta.trim())) {
    notes.push('Outbound copy should include the CTA exactly once for review clarity.');
    score -= 8;
  }
  if (!isValidAssetUrl(url)) {
    notes.push('A valid internal path or http/https UTM URL is required.');
    score -= 20;
  }
  if (template && !template.requiredAssetTypes.includes(assetType)) {
    notes.push(`Template requires one of: ${template.requiredAssetTypes.map(type => ASSET_TYPES[type] || type).join(', ')}.`);
    score -= 25;
  }
  if (template?.goal !== 'education' && !APPROVED_PROOF_ASSETS.has(assetType)) {
    notes.push('Conversion and proof templates must use real overlay, dashboard, or sponsor-break assets.');
    score -= 20;
  }
  if (assetStatus !== 'approved') {
    notes.push('Asset must be approved before this can be used.');
    score -= 20;
  }
  if (assetUrl && !isValidAssetUrl(assetUrl)) {
    notes.push('Asset URL must be a valid internal path or http/https URL.');
    score -= 20;
  }
  if (assetUrl && assetType) {
    const compatibility = assetUrlCompatibility(assetUrl, assetType);
    if (compatibility.status === 'mismatch') {
      notes.push(compatibility.note);
      score -= 35;
    } else if (compatibility.status === 'unknown') {
      notes.push(compatibility.note);
      score -= 5;
    }
  }
  const zone = safeZone || {};
  if (normalizedPlatform !== 'x' && (Number(zone.top) < 10 || Number(zone.bottom) < 16 || Number(zone.left) < 6 || Number(zone.right) < 6)) {
    notes.push('Safe zone is too tight for vertical/social placements.');
    score -= 10;
  }

  const finalScore = Math.max(0, Math.min(100, score));
  return {
    status: finalScore >= 80 && notes.length === 0 ? 'ready' : (finalScore >= 70 ? 'warn' : 'blocked'),
    score: finalScore,
    notes,
  };
}

export function buildCreativeVariantDrafts({ templateKey, platform = 'tiktok', asset = {}, count = 3 } = {}) {
  const template = templateByKey(templateKey);
  if (!template) throw new Error('Creative template not found');
  const normalizedPlatform = normalizePlatform(platform);
  const safeCount = Math.max(1, Math.min(5, Number(count) || 3));
  const rows = [];

  for (let index = 0; index < safeCount; index++) {
    const blocks = buildBlocks({ template, platform: normalizedPlatform, variantIndex: index, asset });
    const body = bodyForBlocks({ hook: blocks.hook, proof: blocks.proof, cta: blocks.cta, url: blocks.url, platform: normalizedPlatform });
    const quality = runCreativeQualityGate({
      templateKey: template.key,
      platform: normalizedPlatform,
      assetType: blocks.assetType,
      assetStatus: asset.approval_status || asset.approvalStatus || 'draft',
      assetUrl: blocks.assetUrl,
      body,
      cta: blocks.cta,
      url: blocks.url,
      safeZone: blocks.safeZone,
    });
    rows.push({
      templateKey: template.key,
      templateLabel: template.label,
      platform: normalizedPlatform,
      format: PLATFORM_RULES[normalizedPlatform].format,
      hook: blocks.hook,
      proof: blocks.proof,
      cta: blocks.cta,
      body,
      utmUrl: blocks.url,
      assetUrl: blocks.assetUrl,
      assetType: blocks.assetType,
      blockJson: JSON.stringify(blocks),
      safeZoneJson: JSON.stringify(blocks.safeZone),
      hashtags: blocks.hashtags,
      seoKeywords: blocks.seoKeywords,
      audience: blocks.audience,
      goal: blocks.goal,
      qualityStatus: quality.status,
      qualityScore: quality.score,
      qualityNotes: quality.notes.join(' '),
    });
  }
  return rows;
}

export function addCreativeAsset(input = {}) {
  const parsed = AssetSchema.safeParse(input);
  if (!parsed.success) throw new Error(parsed.error.issues?.[0]?.message || 'Invalid creative asset');
  const asset = parsed.data;
  if (!isValidAssetUrl(asset.assetUrl)) throw new Error('Asset URL must be an internal path or http/https URL');
  const existing = db.prepare('SELECT id FROM growth_creative_assets WHERE asset_url = ? LIMIT 1').get(asset.assetUrl);
  if (existing) throw new Error('That creative asset URL is already saved');
  db.prepare(`
    INSERT INTO growth_creative_assets (title, asset_type, asset_url, source, approval_status, notes, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run(asset.title, asset.assetType, asset.assetUrl, asset.source, asset.approvalStatus, asset.notes);
}

export function listCreativeAssets({ limit = 40, status = '' } = {}) {
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 40));
  const normalizedStatus = ['approved', 'draft', 'blocked'].includes(status) ? status : '';
  if (normalizedStatus) {
    return db.prepare('SELECT * FROM growth_creative_assets WHERE approval_status = ? ORDER BY updated_at DESC, id DESC LIMIT ?').all(normalizedStatus, safeLimit);
  }
  return db.prepare('SELECT * FROM growth_creative_assets ORDER BY updated_at DESC, id DESC LIMIT ?').all(safeLimit);
}

export function updateCreativeAssetStatus(id, status) {
  const safeId = Number(id);
  const safeStatus = ['approved', 'draft', 'blocked'].includes(status) ? status : '';
  if (!Number.isFinite(safeId) || safeId < 1) throw new Error('Invalid creative asset id');
  if (!safeStatus) throw new Error('Invalid creative asset status');
  db.prepare('UPDATE growth_creative_assets SET approval_status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(safeStatus, safeId);
}

export function generateCreativeVariants({ templateKey, platform, assetId, count = 3 } = {}) {
  const safeAssetId = Number(assetId);
  if (!Number.isFinite(safeAssetId) || safeAssetId < 1) throw new Error('Choose a creative asset');
  const asset = db.prepare('SELECT * FROM growth_creative_assets WHERE id = ?').get(safeAssetId);
  if (!asset) throw new Error('Creative asset not found');
  const drafts = buildCreativeVariantDrafts({ templateKey, platform, asset, count });
  const insert = db.prepare(`
    INSERT INTO growth_creative_variants (
      template_key, platform, format, status, asset_id, asset_url, hook, proof, cta,
      body, utm_url, block_json, safe_zone_json, quality_status, quality_score,
      quality_notes, created_at, updated_at
    ) VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `);
  let inserted = 0;
  let skipped = 0;
  drafts.forEach(draft => {
    const duplicate = db.prepare(`
      SELECT id
      FROM growth_creative_variants
      WHERE template_key = ?
        AND platform = ?
        AND asset_id = ?
        AND body = ?
        AND status != 'skipped'
      LIMIT 1
    `).get(draft.templateKey, draft.platform, safeAssetId, draft.body);
    if (duplicate) {
      skipped++;
      return;
    }
    insert.run(
      draft.templateKey,
      draft.platform,
      draft.format,
      safeAssetId,
      draft.assetUrl,
      draft.hook,
      draft.proof,
      draft.cta,
      draft.body,
      draft.utmUrl,
      draft.blockJson,
      draft.safeZoneJson,
      draft.qualityStatus,
      draft.qualityScore,
      draft.qualityNotes
    );
    inserted++;
  });
  return { count: inserted, skipped, drafts };
}

export function listCreativeVariants({ limit = 50, status = '' } = {}) {
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 50));
  const normalizedStatus = ['draft', 'approved', 'skipped', 'queued'].includes(status) ? status : '';
  const baseQuery = `
    SELECT variants.*, assets.title AS asset_title, assets.asset_type, assets.approval_status AS asset_status
    FROM growth_creative_variants variants
    LEFT JOIN growth_creative_assets assets ON assets.id = variants.asset_id
  `;
  if (normalizedStatus) {
    return db.prepare(`${baseQuery} WHERE variants.status = ? ORDER BY variants.updated_at DESC, variants.id DESC LIMIT ?`).all(normalizedStatus, safeLimit);
  }
  return db.prepare(`${baseQuery} ORDER BY variants.updated_at DESC, variants.id DESC LIMIT ?`).all(safeLimit);
}

export function updateCreativeVariantStatus(id, status) {
  const safeId = Number(id);
  const safeStatus = ['draft', 'approved', 'skipped'].includes(status) ? status : '';
  if (!Number.isFinite(safeId) || safeId < 1) throw new Error('Invalid creative variant id');
  if (!safeStatus) throw new Error('Invalid creative variant status');
  const variant = db.prepare('SELECT * FROM growth_creative_variants WHERE id = ?').get(safeId);
  if (!variant) throw new Error('Creative variant not found');
  if (safeStatus === 'approved' && variant.quality_status === 'blocked') throw new Error('Blocked creative variants cannot be approved');
  db.prepare('UPDATE growth_creative_variants SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(safeStatus, safeId);
}

export function queueCreativeVariantAsMarketingPost(id) {
  const safeId = Number(id);
  if (!Number.isFinite(safeId) || safeId < 1) throw new Error('Invalid creative variant id');
  const variant = db.prepare(`
    SELECT variants.*, assets.asset_type, assets.approval_status AS asset_status
    FROM growth_creative_variants variants
    LEFT JOIN growth_creative_assets assets ON assets.id = variants.asset_id
    WHERE variants.id = ?
  `).get(safeId);
  if (!variant) throw new Error('Creative variant not found');
  if (variant.quality_status === 'blocked') throw new Error('Blocked creative variants cannot be queued');
  if (variant.asset_status !== 'approved') throw new Error('The creative asset must still be approved before queueing');
  if (variant.status !== 'approved') throw new Error('Approve the creative variant before sending it to the marketing queue');

  const template = templateByKey(variant.template_key);
  if (!template) throw new Error('Creative template no longer exists');
  const safeZone = parseJsonObject(variant.safe_zone_json);
  const quality = runCreativeQualityGate({
    templateKey: variant.template_key,
    platform: variant.platform,
    assetType: variant.asset_type,
    assetStatus: variant.asset_status,
    assetUrl: variant.asset_url,
    body: variant.body,
    cta: variant.cta,
    url: variant.utm_url,
    safeZone,
  });
  if (quality.status === 'blocked') {
    db.prepare(`
      UPDATE growth_creative_variants
      SET quality_status = ?, quality_score = ?, quality_notes = ?, status = 'draft', updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(quality.status, quality.score, quality.notes.join(' '), safeId);
    throw new Error('Creative variant failed the latest quality gate and was moved back to draft');
  }

  const campaignDate = new Date().toISOString().slice(0, 10);
  const topicKey = `creative_${variant.id}_${variant.template_key}`;
  const existingPost = db.prepare('SELECT id, status FROM marketing_posts WHERE campaign_date = ? AND platform = ? AND topic_key = ?').get(campaignDate, variant.platform, topicKey);
  if (existingPost && existingPost.status === 'published') throw new Error('This creative has already been published today');
  const blocks = parseJsonObject(variant.block_json);
  const hashtags = blocks.hashtags || hashtagsForCreative(variant.template_key, variant.platform);
  const seoKeywords = blocks.seoKeywords || seoKeywordsForCreative(variant.template_key);
  const audience = blocks.audience || audienceForTemplate(template);
  const goal = blocks.goal || template.goal || 'sales';
  db.prepare(`
    INSERT INTO marketing_posts (
      campaign_date, platform, topic_key, audience, goal, hook, body, cta,
      url, utm_url, hashtags, seo_keywords, scheduled_for, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, 'draft', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(campaign_date, platform, topic_key) DO UPDATE SET
      audience = excluded.audience,
      goal = excluded.goal,
      hook = excluded.hook,
      body = excluded.body,
      cta = excluded.cta,
      url = excluded.url,
      utm_url = excluded.utm_url,
      hashtags = excluded.hashtags,
      seo_keywords = excluded.seo_keywords,
      status = CASE WHEN marketing_posts.status = 'published' THEN marketing_posts.status ELSE 'draft' END,
      updated_at = CURRENT_TIMESTAMP
  `).run(
    campaignDate,
    variant.platform,
    topicKey,
    audience,
    goal,
    variant.hook,
    variant.body,
    variant.cta,
    variant.utm_url,
    variant.utm_url,
    hashtags,
    seoKeywords
  );
  db.prepare(`
    UPDATE growth_creative_variants
    SET status = 'queued',
        quality_status = ?,
        quality_score = ?,
        quality_notes = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(quality.status, quality.score, quality.notes.join(' '), safeId);
}
