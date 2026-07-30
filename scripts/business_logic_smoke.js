import assert from 'node:assert/strict';
import {
  buildUserAccessStatus,
  buildPlanEntitlements,
  isBetaTesterAccessCode,
  isPaidAccessCode,
  isPaidAuthRecord,
} from '../tiktokbr/services/entitlements.js';
import {
  isSubscriptionAccessActive,
  isSubscriptionAccessBlocked,
  localStatusForPayPalWebhookEvent,
  normalizePayPalSubscriptionStatus,
} from '../tiktokbr/services/billingPolicy.js';
import { extractIconEmojiCommand } from '../tiktokbr/services/chatCommands.js';
import { extractLiveCommentText } from '../tiktokbr/services/liveEventText.js';
import {
  DEPRECATED_ATTACK_COMMANDS,
  PLAYER_ATTACK_COMMANDS,
  commandBannerShowcasePayload,
  parseAttackCommand,
  parseUtilityCommand,
  viewerCommandText,
} from '../tiktokbr/services/playerCommands.js';
import {
  addArenaContribution,
  arenaContributionPoints,
  arenaPowerMultiplierForRank,
  nextArenaPowerAttack,
  parseArenaPowerCommand,
  rankArenaContributors,
} from '../tiktokbr/services/arenaPowerUp.js';
import { buildLaunchReadinessReport } from '../tiktokbr/services/launchReadiness.js';
import { evaluateSponsorMediaQuality } from '../tiktokbr/sponsorMediaProcessor.js';
import {
  DEFAULT_AETHERIS_TERRITORY_ID,
  getAetherisTerritory,
  listAetherisTerritories,
  normalizeAetherisTerritoryId,
} from '../tiktokbr/services/aetherisTerritories.js';
import {
  buildAetherisStructures,
  currentAetherisStructureStatus,
  damageAetherisStructure,
  normalizeAetherisStructures,
  repairAetherisStructures,
} from '../tiktokbr/services/aetherisStructures.js';

function testEntitlements() {
  assert.equal(
    isPaidAccessCode({
      subscription_status: 'active',
      code_type: 'trial',
      is_revoked: 0,
      is_promo: 0,
    }),
    false,
    'plain active trial codes must not unlock paid controls'
  );

  assert.equal(
    isPaidAccessCode({
      subscription_status: 'active',
      paypal_subscription_id: 'I-123',
      is_revoked: 0,
      is_promo: 0,
    }),
    true,
    'PayPal-linked codes should be paid'
  );

  assert.equal(
    isPaidAccessCode({
      code_type: 'creator_pro',
      is_revoked: '0',
      is_promo: '0',
    }),
    true,
    'creator_pro code types should be paid'
  );

  assert.equal(
    isPaidAccessCode({
      code_type: 'paid',
      is_revoked: '1',
    }),
    false,
    'revoked paid codes should not be paid'
  );

  const freePlan = buildPlanEntitlements({
    type: 'code',
    record: { subscription_status: 'active', code_type: 'trial' },
  });
  assert.deepEqual(freePlan, {
    tier: 'free',
    planName: 'Free',
    canUseCreatorSponsors: false,
    platformSponsorManaged: true,
    betaTester: false,
  });

  assert.equal(
    isBetaTesterAccessCode({
      code_type: 'beta-tester',
      is_revoked: 0,
      is_promo: 0,
    }),
    true,
    'beta-tester access-code types should be recognized'
  );

  const betaPlan = buildPlanEntitlements({
    type: 'code',
    record: { subscription_status: 'active', code_type: 'beta-tester' },
  });
  assert.deepEqual(betaPlan, {
    tier: 'beta',
    planName: 'Beta Tester',
    canUseCreatorSponsors: true,
    platformSponsorManaged: false,
    betaTester: true,
  });

  const paidAuth = { type: 'user', record: { id: 7 } };
  assert.equal(
    isPaidAuthRecord(paidAuth, {
      getLatestUserSubscription: () => ({ status: 'active' }),
    }),
    true,
    'active user subscriptions should be paid'
  );
  assert.equal(
    isPaidAuthRecord(paidAuth, {
      getLatestUserSubscription: () => ({
        status: 'trialing',
        expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      }),
    }),
    true,
    'active full-access user trials should unlock creator controls'
  );
  assert.equal(
    isPaidAuthRecord(paidAuth, {
      getLatestUserSubscription: () => ({
        status: 'trialing',
        expires_at: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
      }),
    }),
    false,
    'expired user trials should not unlock creator controls'
  );
  assert.equal(
    isPaidAuthRecord(paidAuth, {
      getLatestUserSubscription: () => ({ status: 'suspended' }),
    }),
    false,
    'suspended user subscriptions should not be paid'
  );

  const trialPlan = buildPlanEntitlements(paidAuth, {
    getLatestUserSubscription: () => ({
      status: 'trialing',
      expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    }),
  });
  assert.deepEqual(trialPlan, {
    tier: 'trial',
    planName: '7-Day Full Access',
    canUseCreatorSponsors: true,
    platformSponsorManaged: false,
    betaTester: false,
  });

  const now = new Date('2026-07-04T12:00:00.000Z');
  const hours = value => value * 60 * 60 * 1000;
  const accountCreatedAgo = agoMs => new Date(now.getTime() - agoMs).toISOString();

  const activeTrialAccess = buildUserAccessStatus(
    { id: 101, is_active: 1, created_at: accountCreatedAgo(hours((6 * 24) + 23)) },
    null,
    { now, trialDays: 7 }
  );
  assert.equal(activeTrialAccess.accessAllowed, true, 'account created 6 days 23 hours ago should remain allowed');
  assert.equal(activeTrialAccess.tier, 'trial', 'active account-age fallback should be a trial');

  const boundaryTrialAccess = buildUserAccessStatus(
    { id: 102, is_active: 1, created_at: accountCreatedAgo(hours(7 * 24)) },
    null,
    { now, trialDays: 7 }
  );
  assert.equal(boundaryTrialAccess.accessAllowed, false, 'account should be blocked exactly 168 hours after creation');
  assert.equal(boundaryTrialAccess.reason, 'trial_expired', 'exact account-age boundary should use trial_expired');

  const oldPaidAccess = buildUserAccessStatus(
    { id: 103, is_active: 1, created_at: accountCreatedAgo(hours(14 * 24)) },
    { status: 'active', plan_type: 'Creator Pro' },
    { now, trialDays: 7 }
  );
  assert.equal(oldPaidAccess.accessAllowed, true, 'old accounts with active paid subscriptions should be allowed');
  assert.equal(oldPaidAccess.tier, 'paid', 'active paid subscriptions should remain paid after trial age');

  const cappedFutureTrialAccess = buildUserAccessStatus(
    { id: 104, is_active: 1, created_at: accountCreatedAgo(hours(14 * 24)) },
    {
      status: 'trialing',
      plan_type: '7-Day Full Access',
      started_at: accountCreatedAgo(hours(1 * 24)),
      expires_at: new Date(now.getTime() + hours(6 * 24)).toISOString(),
    },
    { now, trialDays: 7 }
  );
  assert.equal(cappedFutureTrialAccess.accessAllowed, false, 'future trial rows must not extend beyond account creation plus 7 days');
  assert.equal(cappedFutureTrialAccess.reason, 'trial_expired', 'account-age capped trial should ask for the trial paywall');

  const legacyNoRowActive = buildUserAccessStatus(
    { id: 105, is_active: 1, created_at: accountCreatedAgo(hours(2 * 24)) },
    null,
    { now, trialDays: 7 }
  );
  assert.equal(legacyNoRowActive.accessAllowed, true, 'legacy accounts without subscription rows should be allowed within seven days');

  const legacyNoRowExpired = buildUserAccessStatus(
    { id: 106, is_active: 1, created_at: accountCreatedAgo(hours(8 * 24)) },
    null,
    { now, trialDays: 7 }
  );
  assert.equal(legacyNoRowExpired.accessAllowed, false, 'legacy accounts without subscription rows should be blocked after seven days');
  assert.equal(legacyNoRowExpired.reason, 'trial_expired');
}

function testBillingPolicy() {
  assert.equal(normalizePayPalSubscriptionStatus('ACTIVE'), 'active');
  assert.equal(normalizePayPalSubscriptionStatus('APPROVAL_PENDING'), 'pending');
  assert.equal(normalizePayPalSubscriptionStatus('SUSPENDED'), 'suspended');
  assert.equal(localStatusForPayPalWebhookEvent('BILLING.SUBSCRIPTION.ACTIVATED'), 'active');
  assert.equal(localStatusForPayPalWebhookEvent('BILLING.SUBSCRIPTION.SUSPENDED'), 'suspended');
  assert.equal(localStatusForPayPalWebhookEvent('BILLING.SUBSCRIPTION.CANCELLED'), 'cancelled');
  assert.equal(localStatusForPayPalWebhookEvent('BILLING.SUBSCRIPTION.EXPIRED'), 'expired');
  assert.equal(isSubscriptionAccessActive('active'), true);
  assert.equal(isSubscriptionAccessActive('pending'), false);
  assert.equal(isSubscriptionAccessBlocked('suspended'), true);
  assert.equal(isSubscriptionAccessBlocked('pending'), false);
}

function testChatIconCommands() {
  assert.equal(extractIconEmojiCommand('!🌟'), '🌟');
  assert.equal(extractIconEmojiCommand('!emoji🔱'), '🔱');
  assert.equal(extractIconEmojiCommand('!emoji 🔱'), '🔱');
  assert.equal(extractIconEmojiCommand('! emoji 🔱'), '🔱');
  assert.equal(extractIconEmojiCommand('/emoji 🔱'), '🔱');
  assert.equal(extractIconEmojiCommand('/ emoji 🔱'), '🔱');
  assert.equal(extractIconEmojiCommand('  !emoji   🔱  extra text'), '🔱');

  assert.equal(extractIconEmojiCommand('🌟'), '');
  assert.equal(extractIconEmojiCommand('emoji 🔱'), '');
  assert.equal(extractIconEmojiCommand('!emoji'), '');
  assert.equal(extractIconEmojiCommand('!emojifoo'), '');
  assert.equal(extractIconEmojiCommand('!join'), '');
  assert.equal(extractIconEmojiCommand('!shield'), '');
}

function testLiveCommentTextExtraction() {
  assert.equal(extractLiveCommentText({ comment: ' hello arena ' }), 'hello arena');
  assert.equal(extractLiveCommentText({ comment: { text: ' @nova ' } }), '@nova');
  assert.equal(extractLiveCommentText({ message: { content: 'regular chat' } }), 'regular chat');
  assert.equal(extractLiveCommentText({ comment: { text: { value: 'nested chat' } } }), 'nested chat');
  assert.equal(extractLiveCommentText({ comment: { gift: 'rose' } }), '');
  assert.equal(extractLiveCommentText({ comment: {} }), '');
  assert.equal(extractLiveCommentText({ comment: '[object Object]' }), '');
  assert.equal(extractLiveCommentText({ comment: [{ value: '' }, { text: 'array chat' }] }), 'array chat');
}

function testPlayerCommandCatalog() {
  assert.equal(parseAttackCommand('!attack @nova')?.effect, 'laser');
  assert.equal(parseAttackCommand('!hit @nova')?.multiplier, 1.5);
  assert.equal(parseAttackCommand('strike @nova')?.description, 'STRIKE');
  assert.equal(parseAttackCommand('!fight @boss')?.effect, 'laser');
  assert.equal(parseAttackCommand('!railgun @boss')?.effect, 'railgun');
  assert.equal(parseAttackCommand('!nuke @horde')?.effect, 'explosion');
  assert.equal(parseAttackCommand('! laser @nova')?.effect, 'laser');
  assert.equal(parseAttackCommand('/ fire @nova')?.effect, 'fire');
  assert.equal(parseAttackCommand('!laser@nova')?.effect, 'laser');
  assert.equal(parseAttackCommand('@nova ! railgun')?.effect, 'railgun');
  assert.equal(parseAttackCommand('nova @bravo')?.effect, 'pulse');
  assert.equal(parseAttackCommand('!nova @bravo')?.effect, 'pulse');
  assert.equal(parseAttackCommand('!sphere @bravo')?.effect, 'sphere');
  assert.equal(parseAttackCommand('!projectile @bravo')?.effect, 'projectile');
  assert.equal(parseAttackCommand('!boom @bravo')?.effect, 'explosion');
  assert.equal(parseAttackCommand('!nuke @bravo')?.effect, 'explosion');
  for (const effect of ['prism', 'plasma', 'cryo', 'ion', 'sonic', 'gravity', 'glitch', 'orbital', 'drone', 'shard']) {
    assert.equal(parseAttackCommand(`!${effect} @bravo`)?.effect, effect, `${effect} should parse as a direct attack effect`);
    assert.equal(parseAttackCommand(`${effect} @bravo`)?.effect, effect, `${effect} should parse without a ! prefix when a target exists`);
  }
  assert.equal(parseAttackCommand('@nova'), null, 'bare mention should not parse as a NOVA command');
  assert.equal(parseAttackCommand('hello @nova'), null, 'mention target text should not be scanned as command text');
  assert.equal(parseAttackCommand('this is fire', { explicitOnly: true }), null, 'plain comments should not become full-power commands');
  assert.equal(parseAttackCommand('!fire', { explicitOnly: true })?.effect, 'fire');
  assert.equal(parseAttackCommand('! fire', { explicitOnly: true })?.effect, 'fire');

  assert.deepEqual(parseUtilityCommand('!join'), { canonical: 'join', command: 'join', rest: '', prefixed: true });
  assert.deepEqual(parseUtilityCommand('! join'), { canonical: 'join', command: 'join', rest: '', prefixed: true });
  assert.deepEqual(parseUtilityCommand('/join'), { canonical: 'join', command: 'join', rest: '', prefixed: true });
  assert.deepEqual(parseUtilityCommand('/ join'), { canonical: 'join', command: 'join', rest: '', prefixed: true });
  assert.equal(parseUtilityCommand('start')?.canonical, 'join');
  assert.equal(parseUtilityCommand('enter')?.canonical, 'join');
  assert.equal(parseUtilityCommand('!commands')?.canonical, 'help');
  assert.equal(parseUtilityCommand('!comments')?.canonical, 'help');
  assert.equal(parseUtilityCommand('! command')?.canonical, 'help');
  assert.deepEqual(parseUtilityCommand('@nova !comments'), { canonical: 'help', command: 'comments', rest: '@nova', prefixed: true });
  assert.deepEqual(parseUtilityCommand('!heal@nova'), { canonical: 'heal', command: 'heal', rest: '@nova', prefixed: true });
  assert.deepEqual(parseUtilityCommand('@nova !heal'), { canonical: 'heal', command: 'heal', rest: '@nova', prefixed: true });
  assert.equal(parseUtilityCommand('! hp @nova')?.canonical, 'heal');
  assert.equal(parseUtilityCommand('!shield')?.canonical, 'shield');
  assert.equal(parseUtilityCommand('! guard')?.canonical, 'shield');
  assert.equal(parseUtilityCommand('!protect')?.canonical, 'shield');
  assert.equal(parseUtilityCommand('!laser@nova'), null, 'attack commands should not parse as utility commands');

  for (const command of DEPRECATED_ATTACK_COMMANDS) {
    assert.equal(PLAYER_ATTACK_COMMANDS[command], undefined, `${command} must not be active`);
    assert.equal(parseAttackCommand(`!${command} @name`), null, `${command} must not parse`);
  }

  const commandText = viewerCommandText();
  for (const expected of ['Any comment, like, follow, share, or gift enters you', '!attack @name', '@horde', '@boss', '!shield', '!heal @name', '!commands', '!comments']) {
    assert.ok(commandText.includes(expected), `viewer command text should include ${expected}`);
  }
  assert.equal(commandText.includes('!join'), false, 'viewer command text should not tell viewers to type !join to enter');
  for (const expected of ['@name', 'enters you and sends a random 5-damage attack', '!prism @name', '!plasma @name', '!orbital @name']) {
    assert.ok(commandText.includes(expected), `viewer command text should include ${expected}`);
  }

  const payload = commandBannerShowcasePayload();
  assert.equal(payload.banners.length, 1);
  assert.equal(payload.banners[0].kicker, 'PLAYER COMMANDS');
  assert.ok(payload.banners[0].tickerItems.some(item => item.includes('@horde')));
}

function testArenaPowerUpRules() {
  assert.equal(arenaContributionPoints('comment'), 1, 'comments should score one Power-Up point');
  assert.equal(arenaContributionPoints('chat'), 1, 'chat aliases should score one Power-Up point');
  assert.equal(arenaContributionPoints('like', 20), 5, 'like bursts should cap at five points per event');
  assert.equal(arenaContributionPoints('follow'), 12, 'follows should score twelve points');
  assert.equal(arenaContributionPoints('share'), 10, 'shares should score ten points');
  assert.equal(arenaContributionPoints('repost'), 20, 'reposts should score twenty points');
  assert.equal(arenaContributionPoints('gift', 900), 500, 'gift scoring should cap at five hundred points');

  assert.equal(parseArenaPowerCommand('!nova @boss'), 'nova');
  assert.equal(parseArenaPowerCommand('please !overdrive @horde'), 'overdrive');
  assert.equal(parseArenaPowerCommand('!overdriveX'), null, 'partial Power-Up commands should not parse');
  assert.equal(parseArenaPowerCommand('overdrive'), null, 'Power-Up commands should require a bang prefix');

  assert.equal(arenaPowerMultiplierForRank(1), 4.25);
  assert.equal(arenaPowerMultiplierForRank(2), 3.55);
  assert.equal(arenaPowerMultiplierForRank(3), 3.0);
  assert.equal(arenaPowerMultiplierForRank(4), 0);

  assert.equal(nextArenaPowerAttack(0).label, 'NOVA');
  assert.equal(nextArenaPowerAttack(1).effect, 'railgun');
  assert.equal(nextArenaPowerAttack(4).label, 'NOVA', 'Power-Up attack rotation should wrap');

  const players = {
    alpha: { uniqueId: 'alpha', nickname: 'Alpha' },
    beta: { uniqueId: 'beta', nickname: 'Beta' },
    gamma: { uniqueId: 'gamma', nickname: 'Gamma' },
    delta: { uniqueId: 'delta', nickname: 'Delta' },
  };
  const state = { active: true, contributors: {}, topContributors: [] };
  addArenaContribution(state, players, { uniqueId: 'alpha', nickname: 'Alpha', type: 'gift', amount: 90, now: 10 });
  addArenaContribution(state, players, { uniqueId: 'beta', nickname: 'Beta', type: 'repost', amount: 1, now: 20 });
  addArenaContribution(state, players, { uniqueId: 'gamma', nickname: 'Gamma', type: 'follow', amount: 1, now: 30 });
  addArenaContribution(state, players, { uniqueId: 'delta', nickname: 'Delta', type: 'comment', amount: 1, now: 40 });

  const ranked = rankArenaContributors(state.contributors, players, 3);
  assert.deepEqual(ranked.map(item => item.uniqueId), ['alpha', 'beta', 'gamma']);
  assert.deepEqual(ranked.map(item => item.rank), [1, 2, 3]);
  assert.deepEqual(ranked.map(item => item.multiplier), [4.25, 3.55, 3.0]);
  assert.equal(state.topContributors[0].uniqueId, 'alpha', 'addArenaContribution should refresh top contributors');
}

function testSponsorMediaQualityGate() {
  const tools = { ffmpegAvailable: false, ffprobeAvailable: true };
  const goodMp4 = evaluateSponsorMediaQuality({
    file: { filename: 'brand.mp4', size: 8 * 1024 * 1024, mimetype: 'video/mp4' },
    metadata: {
      filename: 'brand.mp4',
      fileSize: 8 * 1024 * 1024,
      mimeType: 'video/mp4',
      durationSeconds: 20,
      width: 1920,
      height: 1080,
      videoCodec: 'h264',
      audioCodec: 'aac',
    },
    tools,
    strict: true,
  });
  assert.equal(goodMp4.status, 'ready', 'OBS-safe MP4 creative should pass quality gate');

  const tooLong = evaluateSponsorMediaQuality({
    file: { filename: 'long.mp4', size: 8 * 1024 * 1024, mimetype: 'video/mp4' },
    metadata: { filename: 'long.mp4', fileSize: 8 * 1024 * 1024, mimeType: 'video/mp4', durationSeconds: 180, width: 1920, height: 1080, videoCodec: 'h264', audioCodec: 'aac' },
    tools,
    strict: true,
  });
  assert.equal(tooLong.status, 'blocked', 'over-long sponsor creative should be blocked');

  const productionWebmWithoutFfmpeg = evaluateSponsorMediaQuality({
    file: { filename: 'clip.webm', size: 8 * 1024 * 1024, mimetype: 'video/webm' },
    metadata: { filename: 'clip.webm', fileSize: 8 * 1024 * 1024, mimeType: 'video/webm', durationSeconds: 20, width: 1280, height: 720, videoCodec: 'vp9', audioCodec: 'opus' },
    tools,
    strict: true,
  });
  assert.equal(productionWebmWithoutFfmpeg.status, 'blocked', 'strict production gate should block non-normalized WebM');
  assert.ok(productionWebmWithoutFfmpeg.blockers.some(message => /H\.264|Non-MP4/.test(message)));

  const warningOnly = evaluateSponsorMediaQuality({
    file: { filename: 'square.mp4', size: 8 * 1024 * 1024, mimetype: 'video/mp4' },
    metadata: { filename: 'square.mp4', fileSize: 8 * 1024 * 1024, mimeType: 'video/mp4', durationSeconds: 40, width: 1080, height: 1080, videoCodec: 'h264', audioCodec: 'aac' },
    tools,
    strict: true,
  });
  assert.equal(warningOnly.status, 'warn', 'non-ideal but playable creative should warn instead of block');
}

function testAetherisTerritoryCatalog() {
  const territories = listAetherisTerritories();
  assert.ok(territories.length >= 4, 'Aetheris should expose enough creator territory choices');
  assert.equal(normalizeAetherisTerritoryId('STORMGLASS-COAST'), 'stormglass-coast');
  assert.equal(normalizeAetherisTerritoryId('unknown'), DEFAULT_AETHERIS_TERRITORY_ID);
  assert.deepEqual(new Set(territories.map(territory => territory.id)).size, territories.length, 'territory ids should be unique');
  assert.ok(territories.every(territory => territory.palette?.primary && territory.structurePlan?.frontline), 'territories should include render palette and structure hooks');

  const selected = getAetherisTerritory('verdant-crown');
  selected.palette.primary = '#000000';
  assert.equal(getAetherisTerritory('verdant-crown').palette.primary, '#77f0a1', 'territory payloads should be cloned before mutation');
}

function testAetherisStructureState() {
  const state = buildAetherisStructures('emberfall-forge');
  const status = currentAetherisStructureStatus(state, 'emberfall-forge');
  assert.equal(status.territoryId, 'emberfall-forge');
  assert.equal(status.structures.length, 3, 'Aetheris should expose three live structure objectives');
  assert.equal(status.aggregate.standing, 3, 'new structure state should start fully standing');
  assert.ok(status.structures.some(structure => structure.name === 'Iron gate'), 'structure state should use territory structure names');

  const damaged = damageAetherisStructure(state, { damage: 120, attackerId: 'alpha', attackerNick: 'Alpha' });
  assert.equal(damaged.damaged, true, 'structure damage should apply to the first standing objective');
  assert.equal(damaged.target.type, 'frontline');
  assert.equal(damaged.target.hp, damaged.beforeHp - 120);
  assert.equal(damaged.aggregate.hp, status.aggregate.hp - 120);

  const repaired = repairAetherisStructures(damaged.state, { amount: 75 });
  assert.equal(repaired.repaired, true, 'structure repair should apply to a damaged objective');
  assert.equal(repaired.target.type, 'frontline');
  assert.equal(repaired.target.hp, damaged.target.hp + 75);
  assert.equal(repaired.aggregate.hp, damaged.aggregate.hp + 75);

  const switched = normalizeAetherisStructures(damaged.state, 'stormglass-coast');
  assert.equal(switched.territoryId, 'stormglass-coast', 'territory changes should reset structure state');
  assert.ok(switched.structures.some(structure => structure.name === 'Breaker wall'), 'reset structures should follow the new territory plan');
  assert.equal(switched.aggregate.hp, switched.aggregate.maxHp, 'new territory structures should reset to full HP');
}

function testLaunchReadinessSponsorMediaGate() {
  const report = buildLaunchReadinessReport({
    env: {
      NODE_ENV: 'production',
      SPONSOR_STRICT_MEDIA_GATE: 'false',
    },
    sponsorTools: {
      ffmpegAvailable: true,
      ffmpeg: 'ffmpeg',
      ffprobeAvailable: true,
      ffprobe: 'ffprobe',
    },
  });
  const gateCheck = report.checks.find(check => check.id === 'sponsor-media-gate');
  assert.equal(gateCheck?.status, 'fail', 'launch readiness should fail production when sponsor media gate is disabled');
}

testEntitlements();
testBillingPolicy();
testChatIconCommands();
testLiveCommentTextExtraction();
testPlayerCommandCatalog();
testArenaPowerUpRules();
testSponsorMediaQualityGate();
testAetherisTerritoryCatalog();
testAetherisStructureState();
testLaunchReadinessSponsorMediaGate();
console.log('Business logic smoke checks passed');
