process.env.SKIP_DB = process.env.SKIP_DB || 'true';
process.env.APP_BASE_URL = process.env.APP_BASE_URL || 'https://www.intothebattle.com';

const {
  buildMarketingPostDrafts,
  listRecentMarketingVisits,
  marketingAutomationDiagnostics,
  marketingPerformanceSummary,
  recordMarketingVisit,
  readSiteMarketingFacts,
} = await import('../tiktokbr/services/marketingAutomation.js');
const {
  growthIntegrationDiagnostics,
  syncLeadToGrowthApis,
} = await import('../tiktokbr/services/growthIntegrations.js');
const {
  buildBlankDesignBrief,
  buildCreativeVariantDrafts,
  creativeTemplateOptions,
  listContentGenerationPacks,
  listBattleDemoContentAssets,
  listBlankDesignTemplates,
  listCreativeTemplates,
  renderBlankDesignSvg,
  runCreativeQualityGate,
  saveBattleDemoContentAssets,
} = await import('../tiktokbr/services/creativeTemplateEngine.js');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function parseTimeWindowSeconds(value) {
  const match = String(value || '').match(/^(\d+(?:\.\d+)?)s?-(\d+(?:\.\d+)?)s$/);
  if (!match) return null;
  return Number(match[2]) - Number(match[1]);
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
assert(diagnostics.autoPostEnabled === false, 'Auto-post scheduler should be disabled by default');
assert(diagnostics.autoPostReady === false, 'Auto-post should not be ready without explicit env gates');
assert(Number.isFinite(diagnostics.autoPostIntervalMs), 'Diagnostics must report auto-post interval');
assert(Number.isFinite(diagnostics.autoPostLimit), 'Diagnostics must report auto-post batch limit');
assert(Number.isFinite(diagnostics.dueApprovedCount), 'Diagnostics must report due approved post count');

const trackedVisit = recordMarketingVisit({
  utmSource: 'tiktok',
  utmMedium: 'social',
  utmCampaign: 'smoke',
  utmContent: 'demo',
  path: '/signup?utm_source=tiktok',
});
assert(trackedVisit.recorded === true, 'UTM tracking should accept valid campaign visits');
const ignoredVisit = recordMarketingVisit({ path: '/signup' });
assert(ignoredVisit.recorded === false, 'UTM tracking should ignore visits without UTM fields');
const performance = marketingPerformanceSummary({ days: 14 });
assert(Number.isFinite(performance.visits), 'Performance summary must report visit count');
assert(Array.isArray(performance.topSources), 'Performance summary must include top sources');
assert(Array.isArray(listRecentMarketingVisits({ limit: 5 })), 'Recent marketing visits must return an array');

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
assert(
  creativeTemplates.some(template => template.key === 'complete_battle_demo' && /24-second/i.test(template.label)),
  'Creative template library must include the complete 24-second battle demo'
);

const creativeOptions = creativeTemplateOptions();
assert(creativeOptions.assetTypes.some(type => type.key === 'real_overlay_clip'), 'Creative options must include real overlay clips');
assert(creativeOptions.assetTypes.some(type => type.key === 'generated_background'), 'Creative options must include generated backgrounds for non-proof use');

const battleDemoAssets = listBattleDemoContentAssets();
assert(battleDemoAssets.length >= 8, 'Battle demo content folder must expose each slide and clip as individual assets');
assert(battleDemoAssets.every(asset => asset.folderKey === '24-second-battle-demo'), 'Every battle demo asset must belong to the canonical folder');
assert(battleDemoAssets.some(asset => asset.key === 'sphere-slide' && asset.assetUrl.includes('asset=sphere-slide')), 'Battle demo folder must include a direct sphere slide asset URL');
assert(battleDemoAssets.some(asset => asset.key === 'comet-slide' && asset.assetUrl.includes('asset=comet-slide')), 'Battle demo folder must include a direct comet slide asset URL');
assert(battleDemoAssets.some(asset => asset.key === 'broadcast-break-clip' && asset.assetType === 'sponsor_break_clip'), 'Battle demo folder must include a sponsor break clip asset');
const savedDemoAsset = saveBattleDemoContentAssets(['laser-ko-slide']);
assert(savedDemoAsset.inserted === 1 && savedDemoAsset.skipped === 0, 'Saving a single battle demo asset should insert it once');

const contentPacks = listContentGenerationPacks();
assert(contentPacks.length >= 5, 'Expected guided content generation packs');
assert(contentPacks.every(pack => pack.recipes?.length >= 4), 'Every content pack must include a multi-platform recipe');
assert(contentPacks.every(pack => pack.acceptedAssetLabels?.length && pack.recommendedAssetLabels?.length), 'Content packs must explain accepted and recommended assets');
assert(
  contentPacks.some(pack => pack.key === 'sponsor_break_sales' && pack.recipes.some(recipe => recipe.templateKey === 'sponsor_broadcast')),
  'Sponsor sales pack must generate sponsor broadcast creative'
);
assert(
  contentPacks.some(pack => pack.key === 'battle_clip_launch' && pack.recipes.some(recipe => recipe.templateKey === 'complete_battle_demo')),
  'Battle clip launch pack must use the complete battle demo template'
);

const blankDesigns = listBlankDesignTemplates();
assert(blankDesigns.length === 5, 'Expected five design templates');
assert(blankDesigns.filter(design => design.templateType === 'blank').length === 1, 'Design library must include exactly one blank starter');
assert(blankDesigns.filter(design => design.templateType !== 'blank').length === 4, 'All non-blank designs must be fully branded campaign templates');
assert(
  blankDesigns.some(design => design.key === 'battle_clip_video_launch' && design.demoHref === '/media/remotion/growth-battle-demo-vertical.mp4' && design.templateType === 'branded-video'),
  'Design library must include the branded battle clip video template'
);
assert(blankDesigns.every(design => design.width > 0 && design.height > 0 && design.downloadSvg && design.downloadBrief), 'Design templates must include dimensions and downloads');
for (const design of blankDesigns) {
  const brief = buildBlankDesignBrief(design.key);
  const svg = renderBlankDesignSvg(design.key);
  assert(brief.brandKit?.logoUrl && brief.seoStarter?.altText, 'Design brief must include brand and SEO starter data');
  assert(svg.includes('<svg') && svg.includes('INTOTHEBATTLE'), 'Design SVG must render branded SVG output');
  if (design.templateType !== 'blank') {
    assert(svg.includes(design.headline.toUpperCase().slice(0, 18)), 'Branded design SVG must include finished campaign copy');
  }
}

const creativeDrafts = buildCreativeVariantDrafts({
  templateKey: 'complete_battle_demo',
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
assert(
  creativeDrafts.every(draft => {
    const blocks = JSON.parse(draft.blockJson);
    return blocks.frameScript?.length === 8
      && blocks.frameScript.some(block => block.block === 'laser-ko-slide')
      && blocks.frameScript.some(block => block.block === 'sphere-slide')
      && blocks.frameScript.some(block => block.block === 'comet-slide')
      && blocks.frameScript[5]?.block === 'broadcast-break'
      && blocks.textBlocks?.some(block => block.time === '20.2-22.2s')
      && blocks.frameScript.every(block => parseTimeWindowSeconds(block.time) >= 1.8);
  }),
  'Complete battle demo variants must include readable 24-second battle, effects, break, recap, and CTA timing'
);
assert(
  creativeDrafts.every(draft => {
    const blocks = JSON.parse(draft.blockJson);
    return blocks.brandKit?.logoUrl
      && blocks.layoutSpec?.canvas?.width
      && blocks.layoutSpec?.logo?.placement
      && blocks.imageGeneration?.prompt
      && blocks.seo?.title
      && blocks.downloadables?.suggestedFilename;
  }),
  'Creative variants must include branded production package fields'
);
assert(
  creativeOptions.platforms.every(platform => Number.isFinite(platform.width) && Number.isFinite(platform.height)),
  'Every creative platform must declare export dimensions'
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
  contentPacks: contentPacks.length,
  blankDesigns: blankDesigns.length,
  creativeDrafts: creativeDrafts.length,
}, null, 2));
