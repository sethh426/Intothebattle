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

console.log(JSON.stringify({
  ok: true,
  facts: facts.length,
  drafts: drafts.length,
  diagnostics,
  growth: growthDiagnostics,
}, null, 2));
