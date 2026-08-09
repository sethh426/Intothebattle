import assert from 'node:assert/strict';

process.env.SKIP_DB = 'true';

const { AetherisWarService } = await import('../tiktokbr/services/aetherisWarService.js');
const { AETHERIS_TERRITORIES, validateAetherisCatalog } = await import('../tiktokbr/services/aetherisCatalog.js');
const { contributionEvent, scoreRound } = await import('../tiktokbr/services/aetherisWarRules.js');

const catalogValidation = validateAetherisCatalog();
assert.equal(catalogValidation.ok, true, catalogValidation.errors.join('\n'));
assert.equal(AETHERIS_TERRITORIES.length, 100);

const service = new AetherisWarService({ useMemory: true });
const attacker = { userId: 1, roomId: 'room-one', handle: 'creator_one' };
const defender = { userId: 2, roomId: 'room-two', handle: 'creator_two' };
assert.equal(service.optIn(attacker).ok, true);
assert.equal(service.optIn(defender).ok, true);

const attackerHome = AETHERIS_TERRITORIES[0];
const frontier = AETHERIS_TERRITORIES.find(territory => attackerHome.neighbors.includes(territory.id));
assert(frontier);
const defenderHome = AETHERIS_TERRITORIES.find(territory =>
  frontier.neighbors.includes(territory.id) && territory.id !== attackerHome.id,
);
assert(defenderHome);

assert.equal(service.selectHome({ ...attacker, territoryId: attackerHome.id }).ok, true);
assert.equal(service.selectHome({ ...defender, territoryId: defenderHome.id }).ok, true);

const expedition = service.declareCampaign({ ...attacker, territoryId: frontier.id });
assert.equal(expedition.ok, true);
assert.equal(expedition.campaign.mode, 'expedition');
const expeditionRound = service.startRound({
  campaignId: expedition.campaign.id,
  userId: attacker.userId,
  roomId: attacker.roomId,
  now: new Date(Date.now() + 7 * 60 * 60 * 1000),
});
assert.equal(expeditionRound.ok, true);

for (const participantId of ['alpha', 'bravo', 'charlie']) {
  for (let index = 0; index < 3; index += 1) {
    service.recordRoomEvent(attacker.roomId, 'attack', { attacker: participantId, killed: index === 0 }, 'real');
  }
  service.recordRoomEvent(attacker.roomId, 'follow', { uniqueId: participantId }, 'real');
}
const expeditionResult = service.finishRoundForRoom(attacker.roomId, 'test_complete');
assert.equal(expeditionResult.ok, true);
assert.equal(expeditionResult.result.score, 100);
assert.equal(service.activeClaim(frontier.id)?.user_id, attacker.userId);
service.activeClaim(frontier.id).shield_until = new Date(Date.now() - 1000).toISOString();

const protectedHomeAttempt = service.declareCampaign({ ...attacker, territoryId: defenderHome.id });
assert.equal(protectedHomeAttempt.code, 'HOME_PROTECTED');

const campaign = service.declareCampaign({ ...defender, territoryId: frontier.id });
assert.equal(campaign.ok, true);
assert.equal(campaign.campaign.mode, 'pvp');
assert.equal(campaign.campaign.originTerritoryId, defenderHome.id);

assert.equal(contributionEvent('giftAttack', { attacker: 'alpha', killed: true }, 'real'), null);
assert.equal(contributionEvent('attack', { attacker: 'alpha' }, 'demo'), null);
assert.deepEqual(scoreRound({ alpha: { action: true, commands: 3, kill: true, social: true } }), {
  valid: false,
  score: 0,
  participantCount: 1,
  averageContribution: 0,
});

console.log('Aetheris war logic smoke passed: canonical adjacency, opt-in homes, expedition capture, PvP targeting, protected homes, and normalized scoring.');
