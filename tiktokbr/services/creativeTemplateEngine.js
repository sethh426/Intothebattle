import { z } from 'zod';
import db from '../db/db.js';

const DEFAULT_PLATFORMS = ['tiktok', 'instagram', 'youtube_shorts', 'linkedin', 'facebook', 'x'];
const PLATFORM_RULES = {
  tiktok: { label: 'TikTok', format: '9:16 vertical', width: 1080, height: 1920, copyLimit: 280, safeZone: { top: 14, bottom: 22, left: 8, right: 8 } },
  instagram: { label: 'Instagram Reels', format: '9:16 vertical', width: 1080, height: 1920, copyLimit: 1200, safeZone: { top: 14, bottom: 22, left: 8, right: 8 } },
  youtube_shorts: { label: 'YouTube Shorts', format: '9:16 vertical', width: 1080, height: 1920, copyLimit: 420, safeZone: { top: 12, bottom: 18, left: 8, right: 8 } },
  linkedin: { label: 'LinkedIn', format: '4:5 feed', width: 1080, height: 1350, copyLimit: 1100, safeZone: { top: 8, bottom: 8, left: 8, right: 8 } },
  facebook: { label: 'Facebook', format: '4:5 feed', width: 1080, height: 1350, copyLimit: 900, safeZone: { top: 10, bottom: 16, left: 8, right: 8 } },
  x: { label: 'X', format: '16:9 feed', width: 1600, height: 900, copyLimit: 260, safeZone: { top: 6, bottom: 6, left: 6, right: 6 } },
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
const BRAND_SYSTEM = {
  name: 'IntoTheBattle',
  tagline: 'TikTok LIVE Battle Overlay',
  logoUrl: '/brand-identity-square.png',
  fallbackLogoUrl: '/intothebattlelogo_logo_only.svg',
  colors: {
    void: '#03040a',
    panel: '#0a1020',
    cyan: '#35e7ff',
    cyanSoft: '#9ff5ff',
    magenta: '#ff2d88',
    gold: '#ffd666',
    cream: '#fff8e6',
    muted: '#a8afbf',
    green: '#77f0a1',
  },
  fonts: {
    headline: 'Black Ops One, Impact, Arial Black, sans-serif',
    body: 'Inter, DM Sans, Arial, sans-serif',
  },
};
const BLANK_DESIGN_TEMPLATES = [
  {
    key: 'blank_brand_starter',
    label: 'Blank Brand Starter',
    format: '9:16 vertical',
    width: 1080,
    height: 1920,
    templateType: 'blank',
    mood: 'custom campaign starter',
    bestFor: 'Any channel that needs a custom build',
    accent: BRAND_SYSTEM.colors.cyan,
    secondary: BRAND_SYSTEM.colors.magenta,
    description: 'The only blank starter: branded frame, logo, safe zones, headline slot, media slot, proof slot, and CTA lane.',
  },
  {
    key: 'battle_clip_video_launch',
    label: '18-Second Battle Clip Video',
    format: '9:16 vertical',
    width: 1080,
    height: 1920,
    templateType: 'branded-video',
    mood: 'homepage conversion demo',
    bestFor: 'TikTok, Reels, Shorts, signup hero',
    accent: BRAND_SYSTEM.colors.cyan,
    secondary: BRAND_SYSTEM.colors.cyan,
    demoUrl: '/battle-clip',
    recommendedAssetType: 'real_overlay_clip',
    headline: 'Turn TikTok LIVE chat into a battle arena',
    mediaLabel: '18-SECOND BATTLE CLIP VIDEO',
    mediaHelper: 'Use the polished /battle-clip loop here',
    bodyCopy: 'Chat. Attacks. Break. Recap.',
    cta: 'Launch your first battle in under 5 minutes',
    description: 'A finished branded vertical template built around the complete demo video we made.',
  },
  {
    key: 'sponsor_broadcast_moment',
    label: 'Sponsor Broadcast Moment',
    format: '16:9 wide',
    width: 1600,
    height: 900,
    templateType: 'branded',
    mood: 'premium partner pitch',
    bestFor: 'Sponsor page, X, YouTube, sales outreach',
    accent: BRAND_SYSTEM.colors.gold,
    secondary: BRAND_SYSTEM.colors.cyan,
    recommendedAssetType: 'sponsor_break_clip',
    headline: 'Brand moments that feel like the show',
    mediaLabel: 'SPONSOR VIDEO FRAME',
    mediaHelper: 'Drop a sponsor break clip or first frame here',
    bodyCopy: 'Video first. Stats end-cap.',
    cta: 'Put your brand inside the battle',
    description: 'A widescreen sports-broadcast creative for sponsor video placements and sales outreach.',
  },
  {
    key: 'creator_signup_conversion',
    label: 'Creator Signup Conversion',
    format: '4:5 feed',
    width: 1080,
    height: 1350,
    templateType: 'branded',
    mood: 'high-intent creator signup',
    bestFor: 'Instagram feed, Facebook, LinkedIn',
    accent: BRAND_SYSTEM.colors.magenta,
    secondary: BRAND_SYSTEM.colors.cyan,
    recommendedAssetType: 'real_overlay_screenshot',
    headline: 'Your viewers can play the stream',
    mediaLabel: 'REAL OVERLAY SCREENSHOT',
    mediaHelper: 'Use a centered overlay screenshot, not a fake mockup',
    bodyCopy: 'Comments attack. Likes spark effects.',
    cta: 'Start 7 days unlocked',
    description: 'A branded conversion template for turning site visitors and social traffic into new creator accounts.',
  },
  {
    key: 'player_command_showcase',
    label: 'Player Command Showcase',
    format: '9:16 vertical',
    width: 1080,
    height: 1920,
    templateType: 'branded',
    mood: 'audience education',
    bestFor: 'TikTok, Reels, Shorts, how-to-play page',
    accent: BRAND_SYSTEM.colors.green,
    secondary: BRAND_SYSTEM.colors.gold,
    recommendedAssetType: 'real_overlay_screenshot',
    headline: 'Type commands. Watch the arena react.',
    mediaLabel: '!FIRE  !LASER  !EMOJI',
    mediaHelper: 'Show command chips beside the real overlay',
    bodyCopy: 'Join. Attack. Support. Return.',
    cta: 'Learn how to play',
    description: 'A branded player-education template for explaining commands without looking like a plain help card.',
  },
];
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
    key: 'complete_battle_demo',
    label: '18-second battle clip video demo',
    featured: true,
    demoUrl: '/battle-clip',
    audience: 'TikTok LIVE creators',
    goal: 'conversion',
    path: '/signup',
    requiredAssetTypes: ['real_overlay_clip', 'real_overlay_screenshot'],
    hooks: [
      'Turn your TikTok LIVE chat into a playable battle arena.',
      'Show creators the full loop: chat, attacks, effects, video break, recap.',
      'Your viewers can fight, react, and create moments inside the stream.',
    ],
    proofs: [
      'The complete demo shows player cards, horde pressure, battle effects, a broadcast-style video break, and stats recap in one loop.',
      'Comments, likes, gifts, follows, shares, and attacks become visible moments instead of passive chat.',
      'The pitch is simple: viewers type, the overlay reacts, the creator gets a show worth sharing.',
    ],
    ctas: ['Launch your first battle in under 5 minutes.', 'Start with everything unlocked for 7 days.'],
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
const CONTENT_GENERATION_PACKS = [
  {
    key: 'battle_clip_launch',
    label: 'Battle Clip Launch Pack',
    goal: 'creator signup',
    description: 'Turns one real overlay clip into a short-form launch set for creators who need to instantly understand the product.',
    recommendedAssetTypes: ['real_overlay_clip'],
    recipes: [
      { templateKey: 'complete_battle_demo', platform: 'tiktok' },
      { templateKey: 'complete_battle_demo', platform: 'instagram' },
      { templateKey: 'complete_battle_demo', platform: 'youtube_shorts' },
      { templateKey: 'social_proof', platform: 'x' },
      { templateKey: 'sponsor_broadcast', platform: 'linkedin' },
    ],
  },
  {
    key: 'overlay_screenshot_conversion',
    label: 'Overlay Screenshot Conversion Pack',
    goal: 'trial signup',
    description: 'Builds conversion, education, and proof posts from a clean screenshot of the real overlay.',
    recommendedAssetTypes: ['real_overlay_screenshot'],
    recipes: [
      { templateKey: 'signup_result', platform: 'tiktok' },
      { templateKey: 'signup_result', platform: 'instagram' },
      { templateKey: 'trial_unlock', platform: 'facebook' },
      { templateKey: 'player_commands', platform: 'youtube_shorts' },
      { templateKey: 'feature_highlight', platform: 'linkedin' },
    ],
  },
  {
    key: 'sponsor_break_sales',
    label: 'Sponsor Break Sales Pack',
    goal: 'partner lead',
    description: 'Packages one real sponsor-break clip into brand-facing placements that sell the broadcast value.',
    recommendedAssetTypes: ['sponsor_break_clip'],
    recipes: [
      { templateKey: 'sponsor_broadcast', platform: 'tiktok' },
      { templateKey: 'sponsor_broadcast', platform: 'instagram' },
      { templateKey: 'sponsor_broadcast', platform: 'linkedin' },
      { templateKey: 'sponsor_broadcast', platform: 'facebook' },
      { templateKey: 'sponsor_broadcast', platform: 'x' },
    ],
  },
  {
    key: 'setup_and_trial',
    label: 'Setup and Trial Pack',
    goal: 'activation',
    description: 'Uses a dashboard screenshot to explain the fast setup path and push high-intent creators into the unlocked trial.',
    recommendedAssetTypes: ['dashboard_screenshot'],
    recipes: [
      { templateKey: 'signup_result', platform: 'linkedin' },
      { templateKey: 'trial_unlock', platform: 'tiktok' },
      { templateKey: 'trial_unlock', platform: 'instagram' },
      { templateKey: 'feature_highlight', platform: 'facebook' },
      { templateKey: 'checkout_recovery', platform: 'x' },
    ],
  },
  {
    key: 'player_education',
    label: 'Player Education Pack',
    goal: 'audience education',
    description: 'Creates command-focused content that teaches viewers how to participate before a creator goes live.',
    recommendedAssetTypes: ['real_overlay_screenshot'],
    recipes: [
      { templateKey: 'player_commands', platform: 'tiktok' },
      { templateKey: 'player_commands', platform: 'instagram' },
      { templateKey: 'player_commands', platform: 'youtube_shorts' },
      { templateKey: 'feature_highlight', platform: 'linkedin' },
      { templateKey: 'social_proof', platform: 'x' },
    ],
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

function contentPackByKey(key) {
  return CONTENT_GENERATION_PACKS.find(pack => pack.key === key) || null;
}

function templateAcceptsAsset(templateKey = '', assetType = '') {
  const template = templateByKey(templateKey);
  return Boolean(template?.requiredAssetTypes?.includes(assetType));
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
    complete_battle_demo: 'Show the full 18-second demo arc: chat command, players, attack effects, horde pressure, broadcast-style video break, centered stats recap, and CTA.',
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
    complete_battle_demo: ['#InteractiveLive', '#StreamerTools', '#TikTokGame'],
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
    complete_battle_demo: ['TikTok live battle demo', 'interactive overlay demo', 'livestream game demo'],
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

function slugify(value = 'creative') {
  return String(value || 'creative')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'creative';
}

function absoluteAssetUrl(value = '') {
  const text = String(value || '').trim();
  if (!text) return '';
  try {
    return text.startsWith('/') ? new URL(text, publicBaseUrl()).toString() : new URL(text).toString();
  } catch (_err) {
    return text;
  }
}

function platformCanvasSpec(platform = 'tiktok') {
  const rules = PLATFORM_RULES[normalizePlatform(platform)] || PLATFORM_RULES.tiktok;
  return {
    platform: normalizePlatform(platform),
    label: rules.label,
    format: rules.format,
    width: rules.width,
    height: rules.height,
    aspectRatio: `${rules.width}:${rules.height}`,
    safeZonePercent: rules.safeZone,
    safeZonePixels: {
      top: Math.round(rules.height * (rules.safeZone.top / 100)),
      bottom: Math.round(rules.height * (rules.safeZone.bottom / 100)),
      left: Math.round(rules.width * (rules.safeZone.left / 100)),
      right: Math.round(rules.width * (rules.safeZone.right / 100)),
    },
  };
}

function headlineForImage(hook = '') {
  return cleanText(hook, 92).replace(/\.$/, '');
}

function seoTitleForCreative(template, hook = '') {
  const hookText = headlineForImage(hook);
  return trimToLimit(`${hookText} | IntoTheBattle`, 68);
}

function seoDescriptionForCreative(template, proof = '', cta = '') {
  const base = `${cleanText(proof, 110)} ${cleanText(cta, 70)}`.trim();
  return trimToLimit(base || `${template.label} for TikTok LIVE creators.`, 156);
}

function altTextForCreative(template, platform, assetType = '') {
  const assetLabel = ASSET_TYPES[assetType] || 'product visual';
  return trimToLimit(`IntoTheBattle ${template.label} creative for ${PLATFORM_RULES[platform]?.label || platform}, using ${assetLabel} to show TikTok LIVE chat becoming a playable battle arena.`, 180);
}

function layoutSpecForCreative({ template, platform, blocks, asset = {} }) {
  const canvas = platformCanvasSpec(platform);
  const isVertical = canvas.height > canvas.width;
  const safe = canvas.safeZonePixels;
  const assetUrl = absoluteAssetUrl(blocks.assetUrl);
  const assetType = blocks.assetType || asset.asset_type || '';
  const proofIsVideo = VIDEO_ASSET_TYPES.has(assetType);
  const logo = {
    placement: isVertical ? 'top-left inside safe zone' : 'top-left broadcast bug',
    url: absoluteAssetUrl(BRAND_SYSTEM.logoUrl),
    fallbackUrl: absoluteAssetUrl(BRAND_SYSTEM.fallbackLogoUrl),
    minSizePx: isVertical ? 78 : 58,
    clearSpacePx: 24,
  };
  return {
    canvas,
    brand: BRAND_SYSTEM,
    logo,
    composition: {
      style: 'premium cyber broadcast, high-contrast, readable in feed, no fake product UI',
      background: 'dark arena gradient with cyan grid lines, magenta energy accents, subtle gold highlight rail',
      proofAsset: {
        url: assetUrl,
        type: assetType,
        treatment: proofIsVideo ? 'use the strongest frame or moving clip as the central proof window' : 'use as central framed proof image',
        fit: 'cover inside safe proof frame; never crop text-heavy UI past the safe zone',
      },
      hierarchy: [
        'Logo and brand trust mark first',
        'Short outcome-driven headline second',
        'Real product proof third',
        'CTA and tracked URL last',
      ],
      layers: [
        { name: 'background', role: 'motion-ready cyber gradient and arena grid' },
        { name: 'proof-frame', role: 'real overlay/dashboard/sponsor visual, centered in safe zone' },
        { name: 'headline', role: 'large high-contrast outcome statement' },
        { name: 'proof-caption', role: 'short product proof line' },
        { name: 'cta', role: 'single action button with UTM URL in copy/brief' },
        { name: 'logo', role: 'IntoTheBattle mark and wordmark visible on every export' },
      ],
    },
    text: {
      headline: headlineForImage(blocks.hook),
      proof: cleanText(blocks.proof, isVertical ? 105 : 130),
      cta: cleanText(blocks.cta, 70),
      badge: template.goal === 'sponsor-lead' ? 'Brand moment' : 'Creator growth',
    },
    export: {
      filenameBase: `${slugify(template.key)}-${platform}-intothebattle`,
      preferredFormats: ['svg', 'png'],
      uploadReady: true,
      notes: [
        'Use the SVG as the editable source of truth.',
        'Export PNG at the canvas size for feed uploads.',
        'Use the JSON brief for captions, SEO copy, alt text, and image-generation prompts.',
      ],
    },
  };
}

function enhanceImagePrompt({ template, platform, blocks, layout }) {
  const canvas = layout.canvas;
  return [
    blocks.visualDirection?.imagePrompt || visualDirectionForTemplate(template, blocks.assetType).imagePrompt,
    `Create a ${canvas.width}x${canvas.height} ${canvas.format} social creative for ${PLATFORM_RULES[platform]?.label || platform}.`,
    `Brand: ${BRAND_SYSTEM.name}, cyber arena broadcast style, colors ${BRAND_SYSTEM.colors.cyan}, ${BRAND_SYSTEM.colors.magenta}, ${BRAND_SYSTEM.colors.gold}, dark premium background.`,
    `Must include visible IntoTheBattle logo/wordmark, one large readable headline: "${layout.text.headline}", and CTA: "${layout.text.cta}".`,
    `Use real product proof asset when supplied: ${blocks.assetUrl || 'none supplied'}. Do not invent unrelated game screens, fake dashboards, fake TikTok UI, or illegible micro text.`,
    `Safe zone: top ${canvas.safeZonePercent.top}%, bottom ${canvas.safeZonePercent.bottom}%, left ${canvas.safeZonePercent.left}%, right ${canvas.safeZonePercent.right}%.`,
  ].join(' ');
}

function buildProductionBlocks({ template, platform, blocks, asset = {}, variantIndex = 0 }) {
  const layout = layoutSpecForCreative({ template, platform, blocks, asset });
  const seoTitle = seoTitleForCreative(template, blocks.hook);
  const seoDescription = seoDescriptionForCreative(template, blocks.proof, blocks.cta);
  return {
    brandKit: {
      name: BRAND_SYSTEM.name,
      tagline: BRAND_SYSTEM.tagline,
      logoUrl: absoluteAssetUrl(BRAND_SYSTEM.logoUrl),
      fallbackLogoUrl: absoluteAssetUrl(BRAND_SYSTEM.fallbackLogoUrl),
      colors: BRAND_SYSTEM.colors,
      fonts: BRAND_SYSTEM.fonts,
    },
    layoutSpec: layout,
    imageGeneration: {
      provider: 'manual_or_connected_image_api',
      prompt: enhanceImagePrompt({ template, platform, blocks, layout }),
      negativePrompt: 'blurry text, fake app screenshots, unrelated games, extra logos, distorted UI, unreadable buttons, cropped safe-zone text, misleading product claims',
      uploadFallback: 'Upload a real overlay screenshot, sponsor-break clip, or dashboard screenshot to the asset vault and regenerate variants.',
    },
    seo: {
      title: seoTitle,
      description: seoDescription,
      altText: altTextForCreative(template, platform, blocks.assetType),
      keywords: blocks.seoKeywords,
      hashtags: blocks.hashtags,
      canonicalUrl: blocks.url,
    },
    downloadables: {
      svg: `/admin/marketing/creative-variants/{id}/download.svg`,
      briefJson: `/admin/marketing/creative-variants/{id}/brief.json`,
      suggestedFilename: `${layout.export.filenameBase}-v${variantIndex + 1}`,
    },
  };
}

function frameScriptForTemplate(template, hook, proof, cta) {
  if (template.key === 'complete_battle_demo') {
    return [
      { time: '0-2.2s', block: 'hook', text: hook },
      { time: '2.2-5.4s', block: 'battle-action', text: 'Show comments creating attacks, player damage, horde pressure, and a visible KO.' },
      { time: '5.4-10.8s', block: 'effect-montage', text: 'Show the official effect set cleanly: laser, beam, neon, fire, sphere, projectile, bullet, railgun, comet, arc, explosion, and gift energy.' },
      { time: '10.8-14.8s', block: 'broadcast-break', text: 'Show the premium video-break moment as part of the battle, not as a generic ad.' },
      { time: '14.8-17.2s', block: 'stats-recap', text: proof },
      { time: '17.2-18s', block: 'cta', text: cta },
    ];
  }
  return [
    { time: '0-2s', block: 'hook', text: hook },
    { time: '2-9s', block: 'proof', text: proof },
    { time: '9-12s', block: 'cta', text: cta },
  ];
}

function buildBlocks({ template, platform, variantIndex, asset }) {
  const hook = template.hooks[variantIndex % template.hooks.length];
  const proof = template.proofs[(variantIndex + 1) % template.proofs.length];
  const cta = template.ctas[(variantIndex + 2) % template.ctas.length];
  const url = utmUrl(template.path, platform, template.key, variantIndex);
  const assetType = asset?.asset_type || asset?.assetType || '';
  const visualDirection = visualDirectionForTemplate(template, assetType);
  const frameScript = frameScriptForTemplate(template, hook, proof, cta);
  const baseBlocks = {
    hook,
    proof,
    cta,
    url,
    assetUrl: asset?.asset_url || asset?.assetUrl || '',
    assetType,
    requiredAssetTypes: template.requiredAssetTypes,
    safeZone: PLATFORM_RULES[platform]?.safeZone || PLATFORM_RULES.tiktok.safeZone,
    textBlocks: frameScript.map(item => ({ slot: item.block, time: item.time, text: item.text })),
    visualDirection,
    hashtags: hashtagsForCreative(template.key, platform),
    seoKeywords: seoKeywordsForCreative(template.key),
    audience: audienceForTemplate(template),
    goal: template.goal,
    frameScript,
  };
  return {
    ...baseBlocks,
    ...buildProductionBlocks({ template, platform, blocks: baseBlocks, asset, variantIndex }),
  };
}

export function listCreativeTemplates() {
  return TEMPLATE_DEFINITIONS.map(template => ({
    ...template,
    requiredAssetLabels: template.requiredAssetTypes.map(type => ASSET_TYPES[type] || type),
  }));
}

export function listContentGenerationPacks() {
  return CONTENT_GENERATION_PACKS.map(pack => {
    const recipes = pack.recipes.map(recipe => {
      const template = templateByKey(recipe.templateKey);
      const platformKey = normalizePlatform(recipe.platform);
      const platform = PLATFORM_RULES[platformKey];
      return {
        ...recipe,
        platform: platformKey,
        platformLabel: platform.label,
        templateLabel: template?.label || recipe.templateKey,
        requiredAssetTypes: template?.requiredAssetTypes || [],
        requiredAssetLabels: (template?.requiredAssetTypes || []).map(type => ASSET_TYPES[type] || type),
      };
    });
    const acceptedAssetTypes = Array.from(new Set(recipes.flatMap(recipe => recipe.requiredAssetTypes)));
    return {
      ...pack,
      recipes,
      acceptedAssetTypes,
      acceptedAssetLabels: acceptedAssetTypes.map(type => ASSET_TYPES[type] || type),
      recommendedAssetLabels: pack.recommendedAssetTypes.map(type => ASSET_TYPES[type] || type),
      platforms: Array.from(new Set(recipes.map(recipe => recipe.platformLabel))),
    };
  });
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

export function generateCreativeContentPack({ packKey, assetId, countPerItem = 1 } = {}) {
  const pack = contentPackByKey(packKey);
  if (!pack) throw new Error('Content pack not found');
  const safeAssetId = Number(assetId);
  if (!Number.isFinite(safeAssetId) || safeAssetId < 1) throw new Error('Choose a creative asset');
  const asset = db.prepare('SELECT * FROM growth_creative_assets WHERE id = ?').get(safeAssetId);
  if (!asset) throw new Error('Creative asset not found');
  if (String(asset.approval_status || '').toLowerCase() !== 'approved') {
    throw new Error('Content packs require an approved creative asset');
  }

  const assetType = asset.asset_type || '';
  const safeCount = Math.max(1, Math.min(3, Number(countPerItem) || 1));
  const items = [];
  const incompatible = [];
  let inserted = 0;
  let skipped = 0;

  for (const recipe of pack.recipes) {
    const template = templateByKey(recipe.templateKey);
    const platform = normalizePlatform(recipe.platform);
    if (!template) {
      incompatible.push({ templateKey: recipe.templateKey, platform, reason: 'Template is not configured.' });
      continue;
    }
    if (!templateAcceptsAsset(template.key, assetType)) {
      incompatible.push({
        templateKey: template.key,
        templateLabel: template.label,
        platform,
        reason: `Needs ${template.requiredAssetTypes.map(type => ASSET_TYPES[type] || type).join(' or ')}.`,
      });
      continue;
    }
    const result = generateCreativeVariants({
      templateKey: template.key,
      platform,
      assetId: safeAssetId,
      count: safeCount,
    });
    inserted += result.count;
    skipped += result.skipped;
    items.push({
      templateKey: template.key,
      templateLabel: template.label,
      platform,
      platformLabel: PLATFORM_RULES[platform]?.label || platform,
      count: result.count,
      skipped: result.skipped,
    });
  }

  if (!items.length) {
    const acceptedAssetTypes = Array.from(new Set(
      pack.recipes.flatMap(recipe => templateByKey(recipe.templateKey)?.requiredAssetTypes || [])
    ));
    throw new Error(`This content pack needs ${acceptedAssetTypes.map(type => ASSET_TYPES[type] || type).join(', ')}. Selected asset is ${ASSET_TYPES[assetType] || assetType || 'unknown'}.`);
  }

  return {
    packKey: pack.key,
    packLabel: pack.label,
    assetId: safeAssetId,
    assetTitle: asset.title || `Asset ${safeAssetId}`,
    count: inserted,
    skipped,
    requestedItems: pack.recipes.length,
    generatedItems: items.length,
    incompatible,
    items,
  };
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

function svgEscape(value = '') {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function wrapWords(value = '', maxChars = 18, maxLines = 4) {
  const words = cleanText(value, 260).split(/\s+/).filter(Boolean);
  const lines = [];
  let current = '';
  words.forEach(word => {
    const next = current ? `${current} ${word}` : word;
    if (next.length > maxChars && current) {
      lines.push(current);
      current = word;
    } else {
      current = next;
    }
  });
  if (current) lines.push(current);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    kept[maxLines - 1] = `${kept[maxLines - 1].replace(/\s+\S*$/, '')}...`.trim();
    return kept;
  }
  return lines;
}

function tspanLines(lines, { x, y, lineHeight, anchor = 'start' }) {
  return lines.map((line, index) => `<tspan x="${x}" y="${y + (index * lineHeight)}" text-anchor="${anchor}">${svgEscape(line)}</tspan>`).join('');
}

function variantQuery(id) {
  const safeId = Number(id);
  if (!Number.isFinite(safeId) || safeId < 1) throw new Error('Invalid creative variant id');
  const variant = db.prepare(`
    SELECT variants.*, assets.title AS asset_title, assets.asset_type, assets.approval_status AS asset_status, assets.notes AS asset_notes
    FROM growth_creative_variants variants
    LEFT JOIN growth_creative_assets assets ON assets.id = variants.asset_id
    WHERE variants.id = ?
  `).get(safeId);
  if (!variant) throw new Error('Creative variant not found');
  return variant;
}

export function buildCreativeProductionPackage(id) {
  const variant = variantQuery(id);
  const blocks = parseJsonObject(variant.block_json);
  const template = templateByKey(variant.template_key);
  if (!template) throw new Error('Creative template no longer exists');
  const platform = normalizePlatform(variant.platform);
  const layoutSpec = blocks.layoutSpec || layoutSpecForCreative({ template, platform, blocks, asset: variant });
  const brandKit = blocks.brandKit || {
    name: BRAND_SYSTEM.name,
    tagline: BRAND_SYSTEM.tagline,
    logoUrl: absoluteAssetUrl(BRAND_SYSTEM.logoUrl),
    fallbackLogoUrl: absoluteAssetUrl(BRAND_SYSTEM.fallbackLogoUrl),
    colors: BRAND_SYSTEM.colors,
    fonts: BRAND_SYSTEM.fonts,
  };
  const seo = blocks.seo || {
    title: seoTitleForCreative(template, variant.hook),
    description: seoDescriptionForCreative(template, variant.proof, variant.cta),
    altText: altTextForCreative(template, platform, variant.asset_type),
    keywords: blocks.seoKeywords || seoKeywordsForCreative(variant.template_key),
    hashtags: blocks.hashtags || hashtagsForCreative(variant.template_key, platform),
    canonicalUrl: variant.utm_url,
  };
  const filenameBase = blocks.downloadables?.suggestedFilename
    || `${slugify(variant.template_key)}-${platform}-intothebattle-${variant.id}`;
  return {
    id: variant.id,
    templateKey: variant.template_key,
    templateLabel: template.label,
    platform,
    format: variant.format || layoutSpec.canvas?.format,
    status: variant.status,
    qualityStatus: variant.quality_status,
    qualityScore: variant.quality_score,
    qualityNotes: variant.quality_notes,
    asset: {
      id: variant.asset_id,
      title: variant.asset_title,
      type: variant.asset_type || blocks.assetType,
      status: variant.asset_status,
      url: absoluteAssetUrl(variant.asset_url || blocks.assetUrl),
      notes: variant.asset_notes || '',
    },
    copy: {
      hook: variant.hook,
      proof: variant.proof,
      cta: variant.cta,
      body: variant.body,
      utmUrl: variant.utm_url,
      frameScript: blocks.frameScript || [],
      textBlocks: blocks.textBlocks || [],
    },
    brandKit,
    layoutSpec,
    imageGeneration: blocks.imageGeneration || {
      provider: 'manual_or_connected_image_api',
      prompt: enhanceImagePrompt({ template, platform, blocks, layout: layoutSpec }),
      negativePrompt: 'blurry text, fake app screenshots, unrelated games, extra logos, distorted UI',
    },
    seo,
    files: {
      svgFilename: `${filenameBase}.svg`,
      briefFilename: `${filenameBase}.brief.json`,
    },
    productionChecklist: [
      'Logo/wordmark visible and inside the safe zone.',
      'Headline sells the viewer outcome, not a feature list.',
      'Real product proof asset is visible when the template is conversion or sponsor focused.',
      'CTA matches the outbound copy.',
      'Alt text, SEO title, SEO description, hashtags, and UTM URL are present.',
      'Export PNG from this SVG at the exact canvas size before uploading to social platforms.',
    ],
  };
}

export function renderCreativeVariantSvg(id) {
  const pkg = buildCreativeProductionPackage(id);
  const canvas = pkg.layoutSpec.canvas || platformCanvasSpec(pkg.platform);
  const colors = BRAND_SYSTEM.colors;
  const width = Number(canvas.width || 1080);
  const height = Number(canvas.height || 1920);
  const isVertical = height > width;
  const margin = isVertical ? Math.round(width * 0.075) : Math.round(width * 0.055);
  const logoSize = isVertical ? 94 : 66;
  const proofX = margin;
  const proofW = width - margin * 2;
  const proofY = isVertical ? Math.round(height * 0.36) : Math.round(height * 0.25);
  const proofH = isVertical ? Math.round(height * 0.29) : Math.round(height * 0.43);
  const headlineY = isVertical ? Math.round(height * 0.16) : Math.round(height * 0.20);
  const headlineSize = isVertical ? Math.round(width * 0.082) : Math.round(width * 0.055);
  const proofTextSize = isVertical ? Math.round(width * 0.036) : Math.round(width * 0.022);
  const ctaY = isVertical ? Math.round(height * 0.82) : Math.round(height * 0.78);
  const headlineLines = wrapWords(pkg.layoutSpec.text?.headline || pkg.copy.hook, isVertical ? 13 : 24, 4);
  const proofLines = wrapWords(pkg.layoutSpec.text?.proof || pkg.copy.proof, isVertical ? 34 : 54, 3);
  const ctaLines = wrapWords(pkg.layoutSpec.text?.cta || pkg.copy.cta, isVertical ? 24 : 38, 2);
  const assetIsImage = IMAGE_ASSET_TYPES.has(pkg.asset.type) && pkg.asset.url;
  const assetLabel = pkg.asset.title || pkg.asset.url || 'Approved product proof asset';
  const headlineBlock = tspanLines(headlineLines, { x: margin, y: headlineY, lineHeight: Math.round(headlineSize * 1.02) });
  const proofBlock = tspanLines(proofLines, { x: margin + 34, y: proofY + proofH + Math.round(proofTextSize * 1.7), lineHeight: Math.round(proofTextSize * 1.35) });
  const ctaBlock = tspanLines(ctaLines, { x: width / 2, y: ctaY + 4, lineHeight: Math.round(proofTextSize * 1.25), anchor: 'middle' });

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${svgEscape(pkg.seo.altText)}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${colors.void}"/>
      <stop offset="0.34" stop-color="#11142b"/>
      <stop offset="0.7" stop-color="#041d2b"/>
      <stop offset="1" stop-color="#28101d"/>
    </linearGradient>
    <linearGradient id="cta" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="${colors.cyan}"/>
      <stop offset="0.54" stop-color="${colors.gold}"/>
      <stop offset="1" stop-color="${colors.magenta}"/>
    </linearGradient>
    <filter id="glow" x="-40%" y="-40%" width="180%" height="180%">
      <feGaussianBlur stdDeviation="12" result="blur"/>
      <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
    <pattern id="grid" width="72" height="72" patternUnits="userSpaceOnUse">
      <path d="M 72 0 L 0 0 0 72" fill="none" stroke="${colors.cyan}" stroke-opacity="0.09" stroke-width="2"/>
    </pattern>
  </defs>
  <rect width="${width}" height="${height}" fill="url(#bg)"/>
  <rect width="${width}" height="${height}" fill="url(#grid)" opacity="0.7"/>
  <circle cx="${Math.round(width * 0.18)}" cy="${Math.round(height * 0.14)}" r="${Math.round(width * 0.36)}" fill="${colors.magenta}" opacity="0.14"/>
  <circle cx="${Math.round(width * 0.88)}" cy="${Math.round(height * 0.28)}" r="${Math.round(width * 0.32)}" fill="${colors.cyan}" opacity="0.13"/>
  <circle cx="${Math.round(width * 0.72)}" cy="${Math.round(height * 0.88)}" r="${Math.round(width * 0.32)}" fill="${colors.gold}" opacity="0.10"/>

  <g transform="translate(${margin}, ${Math.round(margin * 0.9)})">
    <rect width="${logoSize}" height="${logoSize}" rx="${Math.round(logoSize * 0.22)}" fill="#0a1020" stroke="${colors.gold}" stroke-opacity="0.55" stroke-width="3"/>
    <image href="${svgEscape(pkg.brandKit.logoUrl || absoluteAssetUrl(BRAND_SYSTEM.logoUrl))}" x="8" y="8" width="${logoSize - 16}" height="${logoSize - 16}" preserveAspectRatio="xMidYMid meet"/>
    <text x="${logoSize + 18}" y="${Math.round(logoSize * 0.42)}" fill="${colors.cream}" font-family="Arial Black, Arial, sans-serif" font-size="${isVertical ? 32 : 24}" font-weight="900" letter-spacing="1.5">${svgEscape(BRAND_SYSTEM.name.toUpperCase())}</text>
    <text x="${logoSize + 18}" y="${Math.round(logoSize * 0.72)}" fill="${colors.cyanSoft}" font-family="Arial, sans-serif" font-size="${isVertical ? 20 : 15}" font-weight="800" letter-spacing="2">${svgEscape(BRAND_SYSTEM.tagline.toUpperCase())}</text>
  </g>

  <g filter="url(#glow)">
    <text font-family="Arial Black, Impact, Arial, sans-serif" font-size="${headlineSize}" font-weight="900" fill="${colors.cream}" letter-spacing="0">
      ${headlineBlock}
    </text>
  </g>
  <rect x="${proofX}" y="${proofY}" width="${proofW}" height="${proofH}" rx="${isVertical ? 34 : 24}" fill="#07101f" stroke="${colors.cyan}" stroke-opacity="0.42" stroke-width="4"/>
  <rect x="${proofX + 16}" y="${proofY + 16}" width="${proofW - 32}" height="${proofH - 32}" rx="${isVertical ? 24 : 16}" fill="#030813" stroke="${colors.gold}" stroke-opacity="0.30" stroke-width="2"/>
  ${assetIsImage
    ? `<image href="${svgEscape(pkg.asset.url)}" x="${proofX + 20}" y="${proofY + 20}" width="${proofW - 40}" height="${proofH - 40}" preserveAspectRatio="xMidYMid slice" opacity="0.92"/>`
    : `<g transform="translate(${proofX + proofW / 2}, ${proofY + proofH / 2})"><circle r="${Math.round(Math.min(proofW, proofH) * 0.12)}" fill="${colors.cyan}" opacity="0.18"/><path d="M -22 -34 L 44 0 L -22 34 Z" fill="${colors.cyan}" opacity="0.92"/><text x="0" y="${Math.round(proofH * 0.22)}" text-anchor="middle" fill="${colors.muted}" font-family="Arial, sans-serif" font-size="${proofTextSize}" font-weight="800">${svgEscape(assetLabel)}</text></g>`}
  <text x="${margin + 34}" y="${proofY + proofH + Math.round(proofTextSize * 1.7)}" fill="${colors.cyanSoft}" font-family="Arial, sans-serif" font-size="${proofTextSize}" font-weight="800">
    ${proofBlock}
  </text>
  <g>
    <rect x="${Math.round(width * 0.14)}" y="${ctaY - Math.round(proofTextSize * 1.3)}" width="${Math.round(width * 0.72)}" height="${Math.round(proofTextSize * 4)}" rx="${Math.round(proofTextSize * 1.4)}" fill="url(#cta)" filter="url(#glow)"/>
    <text fill="#061018" font-family="Arial Black, Arial, sans-serif" font-size="${Math.round(proofTextSize * 1.18)}" font-weight="900" letter-spacing="0.5">
      ${ctaBlock}
    </text>
  </g>
  <text x="${margin}" y="${height - Math.round(margin * 0.55)}" fill="${colors.muted}" font-family="Arial, sans-serif" font-size="${isVertical ? 20 : 15}" font-weight="700">${svgEscape(pkg.seo.keywords)}</text>
</svg>
`;
}

function blankDesignByKey(key = '') {
  return BLANK_DESIGN_TEMPLATES.find(template => template.key === key) || null;
}

export function listBlankDesignTemplates() {
  return BLANK_DESIGN_TEMPLATES.map(template => ({
    ...template,
    logoUrl: absoluteAssetUrl(BRAND_SYSTEM.logoUrl),
    colors: BRAND_SYSTEM.colors,
    demoHref: template.demoUrl || '',
    downloadSvg: `/admin/marketing/design-templates/${template.key}/download.svg`,
    downloadBrief: `/admin/marketing/design-templates/${template.key}/brief.json`,
  }));
}

export function buildBlankDesignBrief(key = '') {
  const template = blankDesignByKey(key);
  if (!template) throw new Error('Design template not found');
  return {
    ...template,
    brandKit: {
      name: BRAND_SYSTEM.name,
      tagline: BRAND_SYSTEM.tagline,
      logoUrl: absoluteAssetUrl(BRAND_SYSTEM.logoUrl),
      fallbackLogoUrl: absoluteAssetUrl(BRAND_SYSTEM.fallbackLogoUrl),
      colors: BRAND_SYSTEM.colors,
      fonts: BRAND_SYSTEM.fonts,
    },
    usageRules: template.templateType === 'blank'
      ? [
          'Replace the labeled headline, proof, body, and CTA placeholders with final campaign copy.',
          'Drop the product screenshot, sponsor moment, or generated art into the picture/clip frame.',
          'Keep the IntoTheBattle logo visible with clear space.',
          'Use real product screenshots or clips for proof-focused campaigns.',
          'Export at the exact SVG canvas size for upload-ready social assets.',
        ]
      : [
          'Keep the supplied branded headline, proof, and CTA unless the campaign angle changes.',
          'Use the recommended proof asset type so the creative matches the promise.',
          'Keep the IntoTheBattle logo visible with clear space.',
          template.demoUrl ? `Use ${template.demoUrl} as the canonical demo video reference for this design.` : 'Use real product screenshots or clips for proof-focused campaigns.',
          'Export at the exact SVG canvas size for upload-ready social assets.',
        ],
    seoStarter: {
      title: `${template.label} | IntoTheBattle growth creative`,
      description: `${template.description} Use this branded design template for IntoTheBattle social, sponsor, and creator-growth campaigns.`,
      altText: `${template.label} IntoTheBattle cyber arena design template with logo, headline frame, image frame, copy panel, and CTA for ${template.bestFor}.`,
      keywords: 'TikTok LIVE overlay, interactive livestream, creator tools, battle arena, IntoTheBattle',
      canonicalDemoUrl: template.demoUrl ? new URL(template.demoUrl, publicBaseUrl()).toString() : '',
      recommendedAssetType: template.recommendedAssetType || '',
    },
    files: {
      svgFilename: `${template.key}-intothebattle-template.svg`,
      briefFilename: `${template.key}-intothebattle-template.brief.json`,
    },
  };
}

function svgLabel(value = '', x = 0, y = 0, size = 24, color = BRAND_SYSTEM.colors.cyanSoft, anchor = 'start') {
  return `<text x="${x}" y="${y}" text-anchor="${anchor}" fill="${color}" font-family="Arial Black, Arial, sans-serif" font-size="${size}" font-weight="900" letter-spacing="2">${svgEscape(String(value).toUpperCase())}</text>`;
}

function svgHelper(value = '', x = 0, y = 0, size = 18, color = BRAND_SYSTEM.colors.muted, anchor = 'start') {
  return `<text x="${x}" y="${y}" text-anchor="${anchor}" fill="${color}" font-family="Arial, sans-serif" font-size="${size}" font-weight="800" letter-spacing="0.5">${svgEscape(value)}</text>`;
}

function placeholderModules(template, box) {
  const { width, height, accent, secondary } = template;
  const { contentX, contentY, contentW, contentH, margin, vertical } = box;
  const isBlank = template.templateType === 'blank';
  const labelSize = vertical ? 26 : 18;
  const helperSize = vertical ? 20 : 14;
  const radius = vertical ? 22 : 16;
  const inset = vertical ? 40 : 30;
  const headlineH = vertical ? Math.round(height * 0.105) : Math.round(height * 0.13);
  const mediaH = vertical ? Math.round(contentH * 0.44) : Math.round(contentH * 0.50);
  const bodyH = vertical ? Math.round(height * 0.075) : Math.round(height * 0.10);
  const headlineY = Math.max(contentY - headlineH - Math.round(height * 0.028), margin + Math.round(height * 0.12));
  const mediaX = contentX + inset;
  const mediaY = contentY + inset;
  const mediaW = contentW - inset * 2;
  const bodyY = mediaY + mediaH + Math.round(height * 0.025);
  const ctaY = bodyY + bodyH + Math.round(height * 0.024);
  const ctaH = vertical ? 68 : 46;
  const ctaW = vertical ? Math.round(contentW * 0.62) : Math.round(contentW * 0.38);
  const ctaX = contentX + Math.round((contentW - ctaW) / 2);
  const headlineText = isBlank ? 'HEADLINE / HOOK' : (template.headline || 'HEADLINE');
  const headlineHelper = isBlank ? 'Replace with campaign hook' : 'Branded campaign headline';
  const mediaText = isBlank ? 'PICTURE OR VIDEO FRAME' : (template.mediaLabel || 'PRODUCT PROOF FRAME');
  const mediaHelper = isBlank ? 'Drop screenshot, video frame, product image, or generated art here' : (template.mediaHelper || 'Use approved product proof here');
  const bodyText = isBlank ? 'BENEFIT COPY FRAME' : (template.bodyCopy || 'Proof line or campaign benefit');
  const bodyHelper = isBlank ? 'One short proof line, stat, or reason to click' : (template.recommendedAssetType ? `Best asset: ${ASSET_TYPES[template.recommendedAssetType] || template.recommendedAssetType}` : 'Ready-to-post branded copy');
  const ctaText = isBlank ? 'CTA BUTTON' : (template.cta || 'CREATE YOUR BATTLE');
  const extras = {
    blank_brand_starter: `
      <g opacity="0.95">
        <rect x="${mediaX + 22}" y="${mediaY + 22}" width="${Math.round(mediaW * 0.34)}" height="42" rx="21" fill="${accent}" opacity="0.16" stroke="${accent}" stroke-opacity="0.55"/>
        ${svgHelper('LIVE BATTLE', mediaX + 44, mediaY + 50, helperSize, BRAND_SYSTEM.colors.cyanSoft)}
        <rect x="${mediaX + mediaW - Math.round(mediaW * 0.32) - 22}" y="${mediaY + mediaH - 64}" width="${Math.round(mediaW * 0.32)}" height="34" rx="17" fill="${secondary}" opacity="0.18"/>
      </g>
    `,
    battle_clip_video_launch: `
      <g>
        <circle cx="${mediaX + mediaW / 2}" cy="${mediaY + mediaH / 2}" r="${Math.round(Math.min(mediaW, mediaH) * 0.11)}" fill="${accent}" opacity="0.18" filter="url(#soft-glow)"/>
        <path d="M ${mediaX + mediaW / 2 - 24} ${mediaY + mediaH / 2 - 38} L ${mediaX + mediaW / 2 + 52} ${mediaY + mediaH / 2} L ${mediaX + mediaW / 2 - 24} ${mediaY + mediaH / 2 + 38} Z" fill="${BRAND_SYSTEM.colors.cream}" opacity="0.92"/>
        <rect x="${mediaX + 28}" y="${mediaY + mediaH - 78}" width="${mediaW - 56}" height="34" rx="17" fill="#03040a" opacity="0.84"/>
        <rect x="${mediaX + 40}" y="${mediaY + mediaH - 66}" width="${Math.round((mediaW - 80) * 0.62)}" height="10" rx="5" fill="${accent}"/>
        ${svgHelper('0:00 CHAT  0:05 EFFECTS  0:12 BREAK  0:15 RECAP', mediaX + mediaW / 2, mediaY + mediaH - 96, helperSize, BRAND_SYSTEM.colors.cyanSoft, 'middle')}
      </g>
    `,
    sponsor_broadcast_moment: `
      <g>
        <rect x="${contentX + 40}" y="${height - margin - 74}" width="${Math.round(contentW * 0.22)}" height="46" rx="18" fill="${accent}" opacity="0.18" stroke="${accent}" stroke-opacity="0.46"/>
        ${svgHelper('PARTNER', contentX + 62, height - margin - 44, helperSize, BRAND_SYSTEM.colors.gold)}
        <rect x="${contentX + Math.round(contentW * 0.74)}" y="${height - margin - 74}" width="${Math.round(contentW * 0.22)}" height="46" rx="18" fill="${secondary}" opacity="0.16" stroke="${secondary}" stroke-opacity="0.45"/>
        ${svgHelper('ARENA SPOTLIGHT', contentX + Math.round(contentW * 0.76), height - margin - 44, helperSize, BRAND_SYSTEM.colors.cyanSoft)}
      </g>
    `,
    creator_signup_conversion: `
      <g opacity="0.9">
        <circle cx="${contentX + contentW - 78}" cy="${contentY + 76}" r="30" fill="${accent}" opacity="0.18" stroke="${accent}" stroke-opacity="0.62"/>
        ${svgHelper('SIGNUP', contentX + contentW - 118, contentY + 85, helperSize, BRAND_SYSTEM.colors.cream)}
      </g>
    `,
    player_command_showcase: `
      <g>
        ${['!fire', '!laser', '!emoji'].map((label, index) => {
          const chipW = Math.round(contentW * 0.24);
          const chipX = contentX + inset + index * Math.round(contentW * 0.285);
          const chipY = contentY + contentH + Math.round(height * 0.07);
          return `<rect x="${chipX}" y="${chipY}" width="${chipW}" height="${vertical ? 62 : 44}" rx="${vertical ? 22 : 16}" fill="${index === 0 ? accent : index === 1 ? secondary : BRAND_SYSTEM.colors.cyan}" opacity="0.16" stroke="${index === 0 ? accent : index === 1 ? secondary : BRAND_SYSTEM.colors.cyan}" stroke-opacity="0.52"/>${svgHelper(label, chipX + Math.round(chipW / 2), chipY + (vertical ? 39 : 29), helperSize, BRAND_SYSTEM.colors.cream, 'middle')}`;
        }).join('')}
      </g>
    `,
    battle_recap_poster: `
      <g>
        <rect x="${contentX + 64}" y="${contentY + contentH + 62}" width="${Math.round(contentW * 0.32)}" height="74" rx="20" fill="${accent}" opacity="0.16" stroke="${accent}" stroke-opacity="0.50"/>
        <rect x="${contentX + Math.round(contentW * 0.52)}" y="${contentY + contentH + 62}" width="${Math.round(contentW * 0.34)}" height="74" rx="20" fill="${secondary}" opacity="0.16" stroke="${secondary}" stroke-opacity="0.50"/>
        ${svgHelper('KILLS / LIKES', contentX + 92, contentY + contentH + 108, helperSize, BRAND_SYSTEM.colors.gold)}
        ${svgHelper('WINNER / CTA', contentX + Math.round(contentW * 0.55), contentY + contentH + 108, helperSize, BRAND_SYSTEM.colors.cream)}
      </g>
    `,
  }[template.key] || '';

  return `
    <rect x="${contentX}" y="${headlineY}" width="${contentW}" height="${headlineH}" rx="${radius}" fill="#07101d" opacity="0.84" stroke="${secondary}" stroke-opacity="0.42" stroke-width="3"/>
    <path d="M ${contentX + 28} ${headlineY + 26} L ${contentX + Math.round(contentW * 0.28)} ${headlineY + 26}" stroke="${accent}" stroke-width="${vertical ? 8 : 5}" stroke-linecap="round"/>
    ${svgLabel(headlineText, contentX + 34, headlineY + Math.round(headlineH * 0.58), labelSize, BRAND_SYSTEM.colors.cream)}
    ${svgHelper(headlineHelper, contentX + 36, headlineY + Math.round(headlineH * 0.82), helperSize, BRAND_SYSTEM.colors.muted)}

    <rect x="${mediaX}" y="${mediaY}" width="${mediaW}" height="${mediaH}" rx="${radius}" fill="#020712" opacity="0.88" stroke="${accent}" stroke-opacity="0.64" stroke-width="4"/>
    <rect x="${mediaX + 22}" y="${mediaY + 22}" width="${mediaW - 44}" height="${mediaH - 44}" rx="${radius - 6}" fill="none" stroke="${BRAND_SYSTEM.colors.gold}" stroke-opacity="0.23" stroke-width="2" stroke-dasharray="18 15"/>
    ${svgLabel(mediaText, mediaX + mediaW / 2, mediaY + mediaH / 2 - labelSize, labelSize, BRAND_SYSTEM.colors.cyanSoft, 'middle')}
    ${svgHelper(mediaHelper, mediaX + mediaW / 2, mediaY + mediaH / 2 + helperSize, helperSize, BRAND_SYSTEM.colors.muted, 'middle')}
    ${extras}

    <rect x="${mediaX}" y="${bodyY}" width="${mediaW}" height="${bodyH}" rx="${radius}" fill="#081422" opacity="0.86" stroke="${secondary}" stroke-opacity="0.45" stroke-width="3"/>
    ${svgLabel(bodyText, mediaX + 28, bodyY + Math.round(bodyH * 0.46), Math.round(labelSize * 0.82), BRAND_SYSTEM.colors.cream)}
    ${svgHelper(bodyHelper, mediaX + 28, bodyY + Math.round(bodyH * 0.75), helperSize, BRAND_SYSTEM.colors.muted)}

    <rect x="${ctaX}" y="${ctaY}" width="${ctaW}" height="${ctaH}" rx="${Math.round(ctaH / 2)}" fill="url(#template-cta)" filter="url(#soft-glow)"/>
    ${svgLabel(ctaText, ctaX + ctaW / 2, ctaY + Math.round(ctaH * 0.58), Math.round(labelSize * 0.72), '#041014', 'middle')}
  `;
}

function designFrame(template) {
  const { width, height, accent, secondary } = template;
  const vertical = height > width;
  const margin = Math.round(Math.min(width, height) * (vertical ? 0.065 : 0.055));
  const contentX = margin;
  const contentY = vertical ? Math.round(height * 0.26) : Math.round(height * 0.20);
  const contentW = width - margin * 2;
  const contentH = vertical ? Math.round(height * 0.45) : Math.round(height * 0.54);
  const logo = Math.round(Math.min(width, height) * (vertical ? 0.075 : 0.065));
  const logoX = margin;
  const logoY = Math.round(margin * 0.78);
  const wordmarkSize = Math.round(logo * 0.28);
  const details = {
    blank_brand_starter: `
      <path d="M ${margin} ${contentY - 70} L ${width - margin} ${contentY - 70} L ${width - margin - 42} ${contentY - 25} L ${margin + 42} ${contentY - 25} Z" fill="${accent}" opacity="0.14"/>
      <path d="M ${margin + 28} ${contentY + contentH + 80} C ${width * 0.34} ${contentY + contentH + 145}, ${width * 0.66} ${contentY + contentH + 145}, ${width - margin - 28} ${contentY + contentH + 80}" fill="none" stroke="${secondary}" stroke-width="9" stroke-linecap="round" opacity="0.48"/>
      <circle cx="${width * 0.5}" cy="${contentY + contentH * 0.5}" r="${Math.round(contentW * 0.42)}" fill="none" stroke="${accent}" stroke-width="3" stroke-dasharray="18 22" opacity="0.32"/>
    `,
    battle_clip_video_launch: `
      <path d="M ${margin} ${contentY - 70} L ${width - margin} ${contentY - 70} L ${width - margin - 42} ${contentY - 25} L ${margin + 42} ${contentY - 25} Z" fill="${accent}" opacity="0.16"/>
      <path d="M ${margin + 28} ${contentY + contentH + 78} C ${width * 0.32} ${contentY + contentH + 142}, ${width * 0.68} ${contentY + contentH + 142}, ${width - margin - 28} ${contentY + contentH + 78}" fill="none" stroke="${secondary}" stroke-width="9" stroke-linecap="round" opacity="0.44"/>
      <rect x="${margin + 52}" y="${contentY + contentH + 38}" width="${contentW - 104}" height="58" rx="24" fill="#03040a" stroke="${accent}" stroke-opacity="0.30" stroke-width="2"/>
      ${svgHelper('CANONICAL DEMO VIDEO: /battle-clip', width / 2, contentY + contentH + 75, vertical ? 20 : 14, BRAND_SYSTEM.colors.cyanSoft, 'middle')}
    `,
    sponsor_broadcast_moment: `
      <rect x="${margin}" y="${height - margin - 92}" width="${contentW}" height="92" rx="22" fill="#070b15" stroke="${accent}" stroke-opacity="0.44" stroke-width="3"/>
      <path d="M ${width * 0.14} ${height * 0.16} C ${width * 0.32} ${height * 0.05}, ${width * 0.68} ${height * 0.05}, ${width * 0.86} ${height * 0.16}" fill="none" stroke="${accent}" stroke-width="5" opacity="0.42"/>
      <circle cx="${width * 0.5}" cy="${height * 0.5}" r="${Math.round(height * 0.42)}" fill="${accent}" opacity="0.08"/>
    `,
    creator_signup_conversion: `
      <circle cx="${width * 0.5}" cy="${height * 0.5}" r="${Math.round(width * 0.39)}" fill="none" stroke="${accent}" stroke-width="7" opacity="0.32"/>
      <circle cx="${width * 0.5}" cy="${height * 0.5}" r="${Math.round(width * 0.30)}" fill="none" stroke="${secondary}" stroke-width="4" stroke-dasharray="26 18" opacity="0.42"/>
      <path d="M ${margin} ${height - margin - 120} L ${width - margin} ${height - margin - 120}" stroke="${accent}" stroke-width="8" stroke-linecap="round" opacity="0.52"/>
    `,
    player_command_showcase: `
      <rect x="${margin}" y="${contentY + contentH + 34}" width="${contentW}" height="${Math.round(height * 0.14)}" rx="26" fill="#071322" stroke="${secondary}" stroke-opacity="0.35" stroke-width="3"/>
      <rect x="${margin + 28}" y="${contentY + contentH + 62}" width="${Math.round(contentW * 0.28)}" height="${Math.round(height * 0.08)}" rx="18" fill="${accent}" opacity="0.10" stroke="${accent}" stroke-opacity="0.42"/>
      <rect x="${margin + Math.round(contentW * 0.36)}" y="${contentY + contentH + 62}" width="${Math.round(contentW * 0.28)}" height="${Math.round(height * 0.08)}" rx="18" fill="${secondary}" opacity="0.10" stroke="${secondary}" stroke-opacity="0.42"/>
      <rect x="${margin + Math.round(contentW * 0.69)}" y="${contentY + contentH + 62}" width="${Math.round(contentW * 0.24)}" height="${Math.round(height * 0.08)}" rx="18" fill="${BRAND_SYSTEM.colors.cyan}" opacity="0.10" stroke="${BRAND_SYSTEM.colors.cyan}" stroke-opacity="0.42"/>
    `,
  }[template.key] || '';

  return `
    <g transform="translate(${logoX}, ${logoY})">
      <rect width="${logo}" height="${logo}" rx="${Math.round(logo * 0.23)}" fill="#07101d" stroke="${BRAND_SYSTEM.colors.gold}" stroke-opacity="0.58" stroke-width="3"/>
      <circle cx="${Math.round(logo * 0.5)}" cy="${Math.round(logo * 0.5)}" r="${Math.round(logo * 0.31)}" fill="${BRAND_SYSTEM.colors.void}" stroke="${accent}" stroke-opacity="0.75" stroke-width="3"/>
      <path d="M ${Math.round(logo * 0.26)} ${Math.round(logo * 0.64)} L ${Math.round(logo * 0.42)} ${Math.round(logo * 0.36)} L ${Math.round(logo * 0.50)} ${Math.round(logo * 0.48)} L ${Math.round(logo * 0.58)} ${Math.round(logo * 0.36)} L ${Math.round(logo * 0.74)} ${Math.round(logo * 0.64)}" fill="none" stroke="${BRAND_SYSTEM.colors.cream}" stroke-width="${Math.max(3, Math.round(logo * 0.055))}" stroke-linecap="round" stroke-linejoin="round"/>
      <text x="${Math.round(logo * 0.5)}" y="${Math.round(logo * 0.56)}" text-anchor="middle" fill="${BRAND_SYSTEM.colors.gold}" font-family="Arial Black, Arial, sans-serif" font-size="${Math.round(logo * 0.23)}" font-weight="900">ITB</text>
      <text x="${logo + 18}" y="${Math.round(logo * 0.45)}" fill="${BRAND_SYSTEM.colors.cream}" font-family="Arial Black, Arial, sans-serif" font-size="${wordmarkSize}" font-weight="900" letter-spacing="1.5">${svgEscape(BRAND_SYSTEM.name.toUpperCase())}</text>
      <text x="${logo + 18}" y="${Math.round(logo * 0.72)}" fill="${BRAND_SYSTEM.colors.cyanSoft}" font-family="Arial, sans-serif" font-size="${Math.round(wordmarkSize * 0.56)}" font-weight="800" letter-spacing="2">${svgEscape(BRAND_SYSTEM.tagline.toUpperCase())}</text>
    </g>
    ${details}
    <rect x="${contentX}" y="${contentY}" width="${contentW}" height="${contentH}" rx="${vertical ? 34 : 26}" fill="#050a14" opacity="0.78" stroke="${accent}" stroke-opacity="0.48" stroke-width="4"/>
    <rect x="${contentX + 20}" y="${contentY + 20}" width="${contentW - 40}" height="${contentH - 40}" rx="${vertical ? 24 : 18}" fill="#02050d" opacity="0.70" stroke="${BRAND_SYSTEM.colors.gold}" stroke-opacity="0.22" stroke-width="2"/>
    <path d="M ${contentX + 36} ${contentY + 36} L ${contentX + 138} ${contentY + 36}" stroke="${accent}" stroke-width="7" stroke-linecap="round"/>
    <path d="M ${contentX + contentW - 138} ${contentY + contentH - 36} L ${contentX + contentW - 36} ${contentY + contentH - 36}" stroke="${secondary}" stroke-width="7" stroke-linecap="round"/>
    ${placeholderModules(template, { contentX, contentY, contentW, contentH, margin, vertical })}
  `;
}

export function renderBlankDesignSvg(key = '') {
  const template = blankDesignByKey(key);
  if (!template) throw new Error('Design template not found');
  const { width, height, accent, secondary } = template;
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${svgEscape(template.label)} IntoTheBattle design template">
  <defs>
    <linearGradient id="blank-bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${BRAND_SYSTEM.colors.void}"/>
      <stop offset="0.32" stop-color="#12152d"/>
      <stop offset="0.68" stop-color="#041d2d"/>
      <stop offset="1" stop-color="#270a1d"/>
    </linearGradient>
    <linearGradient id="template-cta" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="${BRAND_SYSTEM.colors.cyan}"/>
      <stop offset="0.52" stop-color="${BRAND_SYSTEM.colors.gold}"/>
      <stop offset="1" stop-color="${BRAND_SYSTEM.colors.magenta}"/>
    </linearGradient>
    <radialGradient id="core-glow" cx="50%" cy="44%" r="58%">
      <stop offset="0" stop-color="${accent}" stop-opacity="0.24"/>
      <stop offset="0.48" stop-color="${secondary}" stop-opacity="0.10"/>
      <stop offset="1" stop-color="${BRAND_SYSTEM.colors.void}" stop-opacity="0"/>
    </radialGradient>
    <filter id="soft-glow" x="-40%" y="-40%" width="180%" height="180%">
      <feGaussianBlur stdDeviation="14" result="blur"/>
      <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
    <pattern id="grid" width="76" height="76" patternUnits="userSpaceOnUse">
      <path d="M 76 0 L 0 0 0 76" fill="none" stroke="${accent}" stroke-opacity="0.08" stroke-width="2"/>
    </pattern>
  </defs>
  <rect width="${width}" height="${height}" fill="url(#blank-bg)"/>
  <rect width="${width}" height="${height}" fill="url(#grid)" opacity="0.95"/>
  <rect width="${width}" height="${height}" fill="url(#core-glow)"/>
  <circle cx="${Math.round(width * 0.18)}" cy="${Math.round(height * 0.20)}" r="${Math.round(Math.min(width, height) * 0.30)}" fill="${secondary}" opacity="0.14" filter="url(#soft-glow)"/>
  <circle cx="${Math.round(width * 0.82)}" cy="${Math.round(height * 0.72)}" r="${Math.round(Math.min(width, height) * 0.34)}" fill="${accent}" opacity="0.12" filter="url(#soft-glow)"/>
  <path d="M ${Math.round(width * 0.08)} ${Math.round(height * 0.12)} C ${Math.round(width * 0.28)} ${Math.round(height * 0.02)}, ${Math.round(width * 0.72)} ${Math.round(height * 0.02)}, ${Math.round(width * 0.92)} ${Math.round(height * 0.12)}" fill="none" stroke="${accent}" stroke-width="4" opacity="0.28"/>
  <path d="M ${Math.round(width * 0.08)} ${Math.round(height * 0.88)} C ${Math.round(width * 0.28)} ${Math.round(height * 0.98)}, ${Math.round(width * 0.72)} ${Math.round(height * 0.98)}, ${Math.round(width * 0.92)} ${Math.round(height * 0.88)}" fill="none" stroke="${secondary}" stroke-width="4" opacity="0.24"/>
  ${designFrame(template)}
</svg>
`;
}
