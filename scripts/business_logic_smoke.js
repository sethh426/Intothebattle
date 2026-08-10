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
import { V1_MODES, V1_PHASES, V1_RULES } from '../tiktokbr/game/v1Rules.js';
import {
  applyV1Damage,
  applyV1Heal,
  applyV1Shield,
  ensureV1Player,
  ensureV1RoomState,
  handleV1ChatAction,
  processV1StatusTicks,
  recordV1Engagement,
  setV1Mode,
  setV1Phase,
} from '../tiktokbr/game/v1Engine.js';
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
import {
  buildAetherisWorldState,
  currentAetherisWorldStatus,
  syncAetherisWorldFromStructures,
} from '../tiktokbr/services/aetherisWorldState.js';
import {
  LIKE_BURST_THRESHOLD,
  updateLikeMilestones,
} from '../tiktokbr/services/engagementMilestones.js';

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
assert.equal(normalizePayPalSubscriptionStatus('PAYMENT_FAILED'), 'payment_failed');
assert.equal(localStatusForPayPalWebhookEvent('BILLING.SUBSCRIPTION.ACTIVATED'), 'active');
assert.equal(localStatusForPayPalWebhookEvent('BILLING.SUBSCRIPTION.SUSPENDED'), 'suspended');
assert.equal(localStatusForPayPalWebhookEvent('BILLING.SUBSCRIPTION.CANCELLED'), 'cancelled');
assert.equal(localStatusForPayPalWebhookEvent('BILLING.SUBSCRIPTION.EXPIRED'), 'expired');
assert.equal(localStatusForPayPalWebhookEvent('BILLING.SUBSCRIPTION.PAYMENT.FAILED'), 'payment_failed');
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
  assert.equal(parseAttackCommand('!attack @nova')?.abilityKey, 'basic');
  assert.equal(parseAttackCommand('!hit @nova')?.damage, 10);
  assert.equal(parseAttackCommand('strike @nova'), null, 'V1 requires explicit command syntax for attacks');
  assert.equal(parseAttackCommand('!fight @boss')?.abilityKey, 'basic');
  assert.equal(parseAttackCommand('!railgun @boss'), null, 'railgun is no longer a chat combat command');
  assert.equal(parseAttackCommand('!nuke @horde'), null, 'nuke is no longer a chat combat command');
  assert.equal(parseAttackCommand('! laser @nova')?.effect, 'laser');
  assert.equal(parseAttackCommand('/ fire @nova')?.effect, 'fire');
  assert.equal(parseAttackCommand('!laser@nova')?.effect, 'laser');
  assert.equal(parseAttackCommand('@nova ! railgun'), null);
  assert.equal(parseAttackCommand('nova @bravo'), null);
  assert.equal(parseAttackCommand('!nova @bravo')?.effect, 'nova');
  assert.equal(parseAttackCommand('!plasma @bravo')?.abilityKey, 'plasma');
  assert.equal(parseAttackCommand('!shield')?.abilityKey, 'shield');
  assert.equal(parseAttackCommand('!heal@bravo')?.abilityKey, 'heal');
  for (const effect of ['laser', 'plasma', 'fire', 'nova']) {
    assert.equal(parseAttackCommand(`!${effect} @bravo`)?.effect, effect, `${effect} should parse as a V1 ability`);
    assert.equal(parseAttackCommand(`${effect} @bravo`), null, `${effect} should require a ! prefix`);
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
  assert.equal(parseUtilityCommand('start'), null, 'bare start should not be a V1 utility command');
  assert.equal(parseUtilityCommand('enter'), null, 'bare enter should not be a V1 utility command');
  assert.equal(parseUtilityCommand('!commands')?.canonical, 'help');
  assert.equal(parseUtilityCommand('!comments')?.canonical, 'help');
  assert.equal(parseUtilityCommand('! command')?.canonical, 'help');
  assert.deepEqual(parseUtilityCommand('@nova !comments'), { canonical: 'help', command: 'comments', rest: '@nova', prefixed: true });
  assert.equal(parseUtilityCommand('!heal@nova'), null, 'heal is now a V1 ability command');
  assert.equal(parseUtilityCommand('@nova !heal'), null, 'heal is now a V1 ability command');
  assert.equal(parseUtilityCommand('! hp @nova'), null);
  assert.equal(parseUtilityCommand('!shield'), null, 'shield is now a V1 ability command');
  assert.equal(parseUtilityCommand('! guard'), null);
  assert.equal(parseUtilityCommand('!protect'), null);
  assert.equal(parseUtilityCommand('!laser@nova'), null, 'attack commands should not parse as utility commands');

  for (const command of DEPRECATED_ATTACK_COMMANDS) {
    assert.equal(PLAYER_ATTACK_COMMANDS[command], undefined, `${command} must not be active`);
    assert.equal(parseAttackCommand(`!${command} @name`), null, `${command} must not parse`);
  }

  const commandText = viewerCommandText();
  for (const expected of ['Any comment, like, follow, share, or gift enters you', 'does not attack randomly', '!attack @name', '@horde', '@boss', '!laser @name', '!plasma @name', '!fire @name', '!nova', '!shield', '!heal @name', '!commands']) {
    assert.ok(commandText.includes(expected), `viewer command text should include ${expected}`);
  }
  assert.equal(commandText.includes('!join'), false, 'viewer command text should not tell viewers to type !join to enter');
  for (const unexpected of ['random 5-damage attack', '!tempest @name', '!rift @name', '!orbital @name']) {
    assert.equal(commandText.includes(unexpected), false, `viewer command text should not include ${unexpected}`);
  }

  const payload = commandBannerShowcasePayload();
  assert.equal(payload.banners.length, 1);
  assert.equal(payload.banners[0].kicker, 'PLAYER COMMANDS');
  assert.ok(payload.banners[0].tickerItems.some(item => item.includes('@horde')));
  assert.equal(payload.banners[0].tickerItems.some(item => /random 5-damage attack/i.test(item)), false);
}

function makeV1TestRoom(mode = V1_MODES.FREE_FOR_ALL) {
  const room = { roomId: 'logic_v1_room', players: {}, recentEvents: [] };
  ensureV1RoomState(room, { mode, now: 1000 });
  setV1Mode(room, mode);
  setV1Phase(room, V1_PHASES.BATTLE, { now: 1000 });
  return room;
}

function testV1RulesEngine() {
  const room = makeV1TestRoom();
  const alpha = ensureV1Player(room, 'alpha', 'Alpha', { now: 1000, source: 'test' });
  const beta = ensureV1Player(room, 'beta', 'Beta', { now: 1000, source: 'test' });
  beta.spawnProtectionUntil = 0;

  const plain = handleV1ChatAction(room, 'alpha', 'Alpha', 'hello chat', { now: 5000, source: 'test', disableCrit: true });
  assert.equal(plain.engagementOnly, true, 'plain chat should only create engagement');
  assert.equal(beta.hp, V1_RULES.maxHp, 'plain chat must not damage another player');
  assert.equal(alpha.battleCharges, 1, 'plain chat can add one battle charge');

  const basic = handleV1ChatAction(room, 'alpha', 'Alpha', '!attack @beta', { now: 9000, source: 'test', allowPlayerTargets: true, disableCrit: true });
  assert.equal(basic.handled, true, 'basic strike should resolve');
  assert.equal(basic.result.damage, 12, 'basic strike should include one +2 battle charge');
  assert.equal(beta.hp, V1_RULES.maxHp - 12, 'basic strike should reduce target HP by exact V1 damage');
  assert.equal(alpha.energy, 7, 'basic strike should grant hit energy after engagement energy');

  const cooldown = handleV1ChatAction(room, 'alpha', 'Alpha', '!attack @beta', { now: 10500, source: 'test', allowPlayerTargets: true, disableCrit: true });
  assert.equal(cooldown.rejected, true, 'ability cooldown should reject repeated basic strikes');
  assert.equal(cooldown.reason, 'ability_cooldown');

  alpha.energy = 100;
  beta.shield = 20;
  const laser = handleV1ChatAction(room, 'alpha', 'Alpha', '!laser @beta', { now: 10000, source: 'test', allowPlayerTargets: true, disableCrit: true });
  assert.equal(laser.result.damage, 5, 'laser should apply 25% shield penetration before absorption');
  assert.equal(laser.result.shieldAbsorbed, 13, 'laser should report shield absorption');
  assert.equal(beta.shield, 7, 'laser should leave partial shield when it is not fully broken');

  const plasma = applyV1Damage(room, 'alpha', 'beta', 'plasma', { now: 20000, source: 'test', disableCrit: true });
  assert.equal(plasma.result.damage, 11, 'plasma should deal double shield damage before health damage');
  assert.equal(beta.shield, 0, 'plasma should remove the remaining shield');

  const fire = applyV1Damage(room, 'alpha', 'beta', 'fire', { now: 31000, source: 'test', disableCrit: true });
  assert.equal(fire.result.damage, 12, 'fire should deal exact initial damage');
  assert.ok(beta.statuses.burn, 'fire should apply a burn status');
  const burnTick = processV1StatusTicks(room, { now: 32000 });
  assert.equal(burnTick.length, 1, 'burn should produce one tick event');
  assert.equal(burnTick[0].damage, 4, 'burn tick should deal exact V1 damage');

  alpha.energy = 100;
  beta.hp = 50;
  const healOne = applyV1Heal(room, 'alpha', 'Alpha', 'beta', { now: 45000, source: 'test' });
  assert.equal(healOne.event.amount, 20, 'first ally heal should restore 20 HP');
  alpha.energy = 100;
  const healTwo = applyV1Heal(room, 'alpha', 'Alpha', 'beta', { now: 58000, source: 'test' });
  assert.equal(healTwo.event.amount, 15, 'healing fatigue should reduce the second heal to 75%');

  alpha.energy = 100;
  const shield = applyV1Shield(room, 'alpha', 'Alpha', { now: 71000, source: 'test' });
  assert.equal(shield.event.shield, 25, 'shield should add 25 barrier points');
  assert.equal(alpha.energy, 80, 'shield should cost 20 energy');

  beta.hp = 5;
  beta.alive = true;
  beta.shield = 0;
  alpha.cooldowns = {};
  const kill = applyV1Damage(room, 'alpha', 'beta', 'laser', { now: 86000, source: 'test', disableCrit: true });
  assert.equal(kill.result.killed, true, 'fatal hit should mark kill');
  assert.equal(beta.alive, false, 'fatal hit should mark target dead');
  assert.equal(beta.respawnAt, 86000 + V1_RULES.respawnDelayMs, 'dead player should get V1 respawn timer');

  const gamma = ensureV1Player(room, 'gamma', 'Gamma', { now: 96000, source: 'test' });
  gamma.spawnProtectionUntil = 0;
  alpha.cooldowns = {};
  alpha.energy = 100;
  const dupA = applyV1Damage(room, 'alpha', 'gamma', 'laser', { now: 97000, source: 'test', disableCrit: true, idempotencyKey: 'same-event' });
  const hpAfterDupA = gamma.hp;
  alpha.cooldowns = {};
  const dupB = applyV1Damage(room, 'alpha', 'gamma', 'laser', { now: 97001, source: 'test', disableCrit: true, idempotencyKey: 'same-event' });
  assert.equal(dupA.handled, true, 'first idempotent event should apply');
  assert.equal(dupB.reason, 'duplicate_event', 'duplicate event IDs should not apply twice');
  assert.equal(gamma.hp, hpAfterDupA, 'duplicate event should leave target HP unchanged');

  const burstTarget = ensureV1Player(room, 'burst-target', 'Burst Target', { now: 100000, source: 'test' });
  burstTarget.spawnProtectionUntil = 0;
  burstTarget.hp = burstTarget.maxHp;
  burstTarget.shield = 0;
  alpha.cooldowns = {};
  alpha.energy = 100;
  const burst = applyV1Damage(room, 'alpha', 'burst-target', 'laser', {
    now: 101000,
    source: 'test',
    allowPlayerTargets: true,
    disableCrit: true,
    damageMultiplier: 20,
  });
  const maxSingleHit = Math.round(V1_RULES.maxHp * V1_RULES.maxPlayerHitPct);
  assert.equal(burst.result.damage, maxSingleHit, 'boosted player hits should be capped to anti-one-shot damage');
  assert.equal(burst.result.damageCapped, true, 'capped burst should mark the event as damage-capped');
  assert.equal(burstTarget.hp, V1_RULES.maxHp - maxSingleHit, 'boosted hit should not wipe a full-HP player');

  const support = ensureV1Player(room, 'support', 'Support', { now: 110000, source: 'test' });
  support.hp = 120;
  support.energy = 0;
  const singleLike = recordV1Engagement(room, 'support', 'Support', 'like', { now: 110500, amount: 1, source: 'test' });
  assert.equal(singleLike.hpRestored, V1_RULES.likeHealMin, 'one accepted like packet should restore visible HP');
  assert.equal(support.hp, 120 + V1_RULES.likeHealMin, 'single like should immediately move HP by the visible minimum');
  const like = recordV1Engagement(room, 'support', 'Support', 'like', { now: 111000, amount: 25, source: 'test' });
  assert.equal(support.maxHp, V1_RULES.maxHp, 'V1 players should use the larger production HP pool');
  assert.ok(like.hpRestored > 0, 'likes should restore visible HP');
  assert.ok(support.hp > 120 + V1_RULES.likeHealMin, 'like engagement should keep moving the HP bar');
  const beforeShareHp = support.hp = 90;
  const share = recordV1Engagement(room, 'support', 'Support', 'share', { now: 112000, source: 'test' });
  assert.equal(share.fullHeal, true, 'shares should be marked as full HP refills');
  assert.equal(support.hp, support.maxHp, 'shares should refill the player to full HP');
  assert.equal(share.hpRestored, support.maxHp - beforeShareHp, 'share payload should report the refill amount');
}

function testArenaPowerUpRules() {
  assert.equal(arenaContributionPoints('comment'), 1, 'comments should score one Power-Up point');
  assert.equal(arenaContributionPoints('chat'), 1, 'chat aliases should score one Power-Up point');
  assert.equal(arenaContributionPoints('like', 20), 1, 'like bursts should use diminishing per-event points');
  assert.equal(arenaContributionPoints('follow'), 10, 'follows should score ten points');
  assert.equal(arenaContributionPoints('share'), 12, 'shares should score twelve points');
  assert.equal(arenaContributionPoints('repost'), 12, 'reposts should score twelve points');
  assert.equal(arenaContributionPoints('gift', 900), 35, 'gift scoring should use capped spectacle tiers');

  assert.equal(parseArenaPowerCommand('!nova @boss'), null, '!nova belongs to the V1 combat ability catalog');
  assert.equal(parseArenaPowerCommand('please !overdrive @horde'), 'overdrive');
  assert.equal(parseArenaPowerCommand('!overdriveX'), null, 'partial Power-Up commands should not parse');
  assert.equal(parseArenaPowerCommand('overdrive'), null, 'Power-Up commands should require a bang prefix');

  assert.equal(arenaPowerMultiplierForRank(1), 1.5);
  assert.equal(arenaPowerMultiplierForRank(2), 1.35);
  assert.equal(arenaPowerMultiplierForRank(3), 1.2);
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
  assert.deepEqual(ranked.map(item => item.multiplier), [1.5, 1.35, 1.2]);
  assert.equal(state.topContributors[0].uniqueId, 'alpha', 'addArenaContribution should refresh top contributors');
}

function testEngagementMilestones() {
  let stats = {};
  let result = updateLikeMilestones(stats, 999);
  stats = result.stats;
  assert.equal(result.total, 999);
  assert.equal(result.fullScreenEffects.length, 0, '999 likes should not trigger a full-screen burst');
  assert.equal(result.milestone, 900, 'standard milestones should still report the latest crossed hundred');

  result = updateLikeMilestones(stats, 1);
  stats = result.stats;
  assert.equal(result.total, 1000);
  assert.deepEqual(result.fullScreenMilestones, [LIKE_BURST_THRESHOLD], '1,000 likes should trigger the first full-screen burst');
  assert.equal(result.fullScreenEffects[0].id, 'likes:1000');
  assert.equal(result.fullScreenEffects[0].effect, 'particleForm');
  assert.equal(result.fullScreenEffects[0].shape, 'heart');
  assert.equal(result.fullScreenEffects[0].text, '+1,000 LIKES');
  assert.equal(result.tier, 'mega');

  result = updateLikeMilestones(stats, 1);
  stats = result.stats;
  assert.equal(result.fullScreenEffects.length, 0, 'the same 1,000-like boundary must not replay after state advances');

  stats.total = 1990;
  result = updateLikeMilestones(stats, 2025);
  assert.deepEqual(result.fullScreenMilestones, [2000, 3000, 4000], 'jumps should queue each newly crossed 1,000-like burst once');
  assert.deepEqual(result.fullScreenEffects.map(effect => effect.id), ['likes:2000', 'likes:3000', 'likes:4000']);
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

function testAetherisWorldState() {
  const structures = buildAetherisStructures('emberfall-forge');
  let world = buildAetherisWorldState('emberfall-forge');
  let status = currentAetherisWorldStatus(world, 'emberfall-forge');
  assert.equal(status.territories.length, 4);
  assert.equal(status.activeTerritory.id, 'emberfall-forge');

  const damaged = damageAetherisStructure(structures, { damage: 840, attackerId: 'raider', attackerNick: 'Raider' });
  world = syncAetherisWorldFromStructures(world, currentAetherisStructureStatus(damaged.state), {
    type: 'damaged',
    at: 1000,
  });
  status = currentAetherisWorldStatus(world, 'emberfall-forge');
  assert.ok(status.activeTerritory.control < 100, 'structure damage should reduce territory control');
  assert.equal(status.activeTerritory.pressure, 100 - status.activeTerritory.control);
  assert.equal(status.events[0].territoryId, 'emberfall-forge');
  assert.ok(status.events[0].delta < 0);

  world = syncAetherisWorldFromStructures(world, currentAetherisStructureStatus(buildAetherisStructures('emberfall-forge')), {
    type: 'reset',
    at: 2000,
  });
  status = currentAetherisWorldStatus(world, 'emberfall-forge');
  assert.equal(status.activeTerritory.control, 100);
  assert.ok(status.events[0].delta > 0);
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
testV1RulesEngine();
testArenaPowerUpRules();
testEngagementMilestones();
testSponsorMediaQualityGate();
testAetherisTerritoryCatalog();
testAetherisStructureState();
testAetherisWorldState();
testLaunchReadinessSponsorMediaGate();
console.log('Business logic smoke checks passed');
