process.env.SKIP_DB = process.env.SKIP_DB || 'true';
process.env.APP_BASE_URL = process.env.APP_BASE_URL || 'https://www.intothebattle.com';

const {
  buildMarketingPostDrafts,
  marketingAutomationDiagnostics,
  readSiteMarketingFacts,
} = await import('../tiktokbr/services/marketingAutomation.js');
const {
  growthIntegrationDiagnostics,
  syncLeadToGrowthApis,
} = await import('../tiktokbr/services/growthIntegrations.js');
const {
  buildCreativeVariantDrafts,
  creativeTemplateOptions,
  listCreativeTemplates,
  runCreativeQualityGate,
} = await import('../tiktokbr/services/creativeTemplateEngine.js');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const facts = readSiteMarketingFacts();
assert(facts.length >= 3, 'Expected marketing facts from public site pages');
assert(facts.every(fact => fact.title && fact.url), 'Every marketing fact must include title and URL');

const drafts = buildMarketingPostDrafts({
  date: '2026-06-23',
  platforms: ['x', 'linkedin', 'youtube_shorts'],
});

assert(drafts.length === 3, 'Expected one draft per configured platform');
assert(drafts.every(draft => draft.body.includes('utm_source=')), 'Drafts must include UTM-tagged links');
assert(
  drafts.every(draft => draft.body.includes('TikTok LIVE') && /battle|arena|fight/i.test(draft.body)),
  'Drafts must sell the product outcome'
);
assert(drafts.find(draft => draft.platform === 'x').body.length <= 260, 'X draft must stay within the platform cap');

const diagnostics = marketingAutomationDiagnostics();
assert(Array.isArray(diagnostics.platforms), 'Diagnostics must report configured platforms');

const growthDiagnostics = growthIntegrationDiagnostics();
assert(growthDiagnostics.enabled === false, 'Growth API sync should be disabled by default');
const growthDryRun = await syncLeadToGrowthApis({
  email: 'growth-smoke@example.com',
  name: 'Growth Smoke',
  tiktokUsername: 'growth_smoke',
  source: 'smoke-test',
  lastPath: '/signup',
});
assert(growthDryRun.ok === true && growthDryRun.skipped === true, 'Disabled growth API sync should skip safely');

const creativeTemplates = listCreativeTemplates();
assert(creativeTemplates.length >= 7, 'Expected a complete creative template library');
assert(creativeTemplates.every(template => template.requiredAssetLabels?.length), 'Every template must define asset requirements');

const creativeOptions = creativeTemplateOptions();
assert(creativeOptions.assetTypes.some(type => type.key === 'real_overlay_clip'), 'Creative options must include real overlay clips');
assert(creativeOptions.assetTypes.some(type => type.key === 'generated_background'), 'Creative options must include generated backgrounds for non-proof use');

const creativeDrafts = buildCreativeVariantDrafts({
  templateKey: 'twelve_second_demo',
  platform: 'tiktok',
  asset: {
    asset_url: '/assets/demo-overlay.mp4',
    asset_type: 'real_overlay_clip',
    approval_status: 'approved',
  },
  count: 2,
});
assert(creativeDrafts.length === 2, 'Expected requested creative variant count');
assert(creativeDrafts.every(draft => draft.qualityStatus !== 'blocked'), 'Approved proof assets should create usable variants');
assert(creativeDrafts.every(draft => draft.body.includes('utm_source=tiktok')), 'Creative variants must include UTM links');
assert(
  creativeDrafts.every(draft => JSON.parse(draft.blockJson).visualDirection?.imagePrompt),
  'Creative variants must include visual direction for image/video automation'
);
assert(
  creativeDrafts.every(draft => JSON.parse(draft.blockJson).hashtags && JSON.parse(draft.blockJson).seoKeywords),
  'Creative variants must include hashtags and SEO metadata'
);

const blockedCreative = runCreativeQualityGate({
  templateKey: 'twelve_second_demo',
  platform: 'tiktok',
  assetType: 'generated_background',
  assetStatus: 'draft',
  body: 'Turn your TikTok LIVE chat into a playable battle arena.',
  cta: 'Launch your first battle in under 5 minutes.',
  url: 'https://www.intothebattle.com/signup?utm_source=tiktok',
  safeZone: { top: 14, bottom: 22, left: 8, right: 8 },
});
assert(blockedCreative.status === 'blocked', 'Conversion templates must block unapproved generated assets');

const mismatchedMedia = runCreativeQualityGate({
  templateKey: 'sponsor_broadcast',
  platform: 'tiktok',
  assetType: 'sponsor_break_clip',
  assetStatus: 'approved',
  assetUrl: '/assets/sponsor-still.png',
  body: 'Make brand moments feel like a sports broadcast.\n\nSee how sponsor moments work.\nhttps://www.intothebattle.com/sponsors?utm_source=tiktok',
  cta: 'See how sponsor moments work.',
  url: 'https://www.intothebattle.com/sponsors?utm_source=tiktok',
  safeZone: { top: 14, bottom: 22, left: 8, right: 8 },
});
assert(mismatchedMedia.status === 'blocked', 'Video templates must block image-looking proof assets');

console.log(JSON.stringify({
  ok: true,
  facts: facts.length,
  drafts: drafts.length,
  diagnostics,
  growth: growthDiagnostics,
  creativeTemplates: creativeTemplates.length,
  creativeDrafts: creativeDrafts.length,
}, null, 2));
