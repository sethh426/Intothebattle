import { areTerritoriesAdjacent, getWorldTerritory } from './aetherisCatalog.js';

export const AETHERIS_WAR_RULES = Object.freeze({
  seasonDays: 30,
  mobilizationHours: 6,
  campaignHours: 24,
  roundDurationMs: 10 * 60 * 1000,
  maxRoundsPerSide: 5,
  roundsToWin: 3,
  maxConquests: 3,
  expeditionMinimumScore: 50,
  minimumParticipants: 3,
  reconnectGraceMs: 60 * 1000,
  captureShieldHours: 48,
  defenseShieldHours: 24,
  rematchCooldownHours: 72,
  optOutCooldownDays: 7,
});

export function addHours(dateValue, hours) {
  return new Date(new Date(dateValue).getTime() + hours * 60 * 60 * 1000);
}

export function addDays(dateValue, days) {
  return addHours(dateValue, days * 24);
}

export function campaignPhase(campaign, now = new Date()) {
  if (!campaign) return 'none';
  if (['resolved', 'withdrawn', 'cancelled'].includes(campaign.status)) return campaign.status;
  const time = new Date(now).getTime();
  if (time < new Date(campaign.scoring_starts_at || campaign.scoringStartsAt).getTime()) return 'mobilizing';
  if (time < new Date(campaign.ends_at || campaign.endsAt).getTime()) return 'scoring';
  return 'deadline';
}

export function validateCampaignTarget({
  attackerHoldings = [],
  targetTerritoryId,
  targetClaim = null,
  attackerUserId,
  attackerConquestCount = 0,
  attackerBusy = false,
  defenderBusy = false,
  now = new Date(),
}) {
  const target = getWorldTerritory(targetTerritoryId);
  if (!target) return { ok: false, code: 'UNKNOWN_TERRITORY', message: 'That territory is not part of Aetheris.' };
  if (attackerBusy) return { ok: false, code: 'ATTACKER_BUSY', message: 'Finish your current mobilization before starting another.' };
  if (defenderBusy) return { ok: false, code: 'DEFENDER_BUSY', message: 'That creator is already mobilized in another campaign.' };
  if (attackerConquestCount >= AETHERIS_WAR_RULES.maxConquests) {
    return { ok: false, code: 'HOLDING_CAP', message: 'You already hold the maximum of three conquered territories.' };
  }
  if (targetClaim?.user_id === attackerUserId || targetClaim?.userId === attackerUserId) {
    return { ok: false, code: 'ALREADY_OWNED', message: 'You already control that territory.' };
  }
  if (targetClaim?.claim_type === 'home' || targetClaim?.claimType === 'home') {
    return { ok: false, code: 'HOME_PROTECTED', message: 'Home territories are protected and cannot transfer.' };
  }
  const adjacent = attackerHoldings.some(holding => areTerritoriesAdjacent(holding.territory_id || holding.territoryId || holding.id, targetTerritoryId));
  if (!adjacent) return { ok: false, code: 'NOT_ADJACENT', message: 'You can only mobilize into land adjacent to one of your holdings.' };
  const shieldUntil = targetClaim?.shield_until || targetClaim?.shieldUntil;
  if (shieldUntil && new Date(shieldUntil).getTime() > new Date(now).getTime()) {
    return { ok: false, code: 'SHIELDED', message: 'That territory is protected by a temporary campaign shield.' };
  }
  return { ok: true, target, mode: targetClaim ? 'pvp' : 'expedition' };
}

function cleanParticipantId(value) {
  const id = String(value || '').trim().slice(0, 100);
  return id && !/^server[-_:]/i.test(id) ? id : '';
}

export function contributionEvent(type, payload = {}, source = '') {
  if (source !== 'real') return null;
  const eventType = String(type || '');
  if (['gift', 'giftAttack', 'giftEffect', 'giftCelebration', 'like'].includes(eventType)) return null;

  if (eventType === 'attack' && !payload.giftBoosted && !payload.diamonds) {
    const participantId = cleanParticipantId(payload.attacker || payload.uniqueId || payload.sourceId);
    return participantId ? { participantId, command: true, kill: Boolean(payload.killed), social: false } : null;
  }
  if (eventType === 'playerCommand') {
    const commandType = String(payload.type || '').toLowerCase();
    if (['join', 'help', 'commands', 'team'].includes(commandType)) return null;
    const participantId = cleanParticipantId(payload.sourceId || payload.uniqueId || payload.attacker);
    return participantId ? { participantId, command: true, kill: false, social: false } : null;
  }
  if (eventType === 'follow') {
    const participantId = cleanParticipantId(payload.uniqueId || payload.sourceId);
    return participantId ? { participantId, command: false, kill: false, social: true } : null;
  }
  if (eventType === 'engagementSurge' && ['share', 'repost', 'follow'].includes(String(payload.type || '').toLowerCase())) {
    const participantId = cleanParticipantId(payload.uniqueId || payload.sourceId);
    return participantId ? { participantId, command: false, kill: false, social: true } : null;
  }
  return null;
}

export function applyContribution(participants, event) {
  if (!event?.participantId) return participants;
  const current = participants[event.participantId] || { action: false, commands: 0, kill: false, social: false };
  const next = { ...current, action: true };
  if (event.command) next.commands = Math.min(3, current.commands + 1);
  if (event.kill) next.kill = true;
  if (event.social) next.social = true;
  return { ...participants, [event.participantId]: next };
}

export function participantPoints(contribution = {}) {
  return Math.min(8,
    (contribution.action ? 2 : 0)
    + Math.min(3, Math.max(0, Number(contribution.commands) || 0))
    + (contribution.kill ? 2 : 0)
    + (contribution.social ? 1 : 0));
}

export function scoreRound(participants = {}) {
  const entries = Object.values(participants);
  const participantCount = entries.length;
  const valid = participantCount >= AETHERIS_WAR_RULES.minimumParticipants;
  if (!valid) return { valid: false, score: 0, participantCount, averageContribution: 0 };
  const averageContribution = entries.reduce((sum, contribution) => sum + participantPoints(contribution), 0) / participantCount;
  const score = Math.round(Math.min(100, 20 + 80 * (averageContribution / 8)));
  return { valid: true, score, participantCount, averageContribution };
}

export function compareCampaignRounds(attackerRounds = [], defenderRounds = []) {
  let attackerWins = 0;
  let defenderWins = 0;
  const comparisons = [];
  for (let roundNumber = 1; roundNumber <= AETHERIS_WAR_RULES.maxRoundsPerSide; roundNumber += 1) {
    const attackerScore = Number(attackerRounds.find(round => Number(round.round_number || round.roundNumber) === roundNumber)?.score) || 0;
    const defenderScore = Number(defenderRounds.find(round => Number(round.round_number || round.roundNumber) === roundNumber)?.score) || 0;
    const winner = attackerScore > defenderScore ? 'attacker' : 'defender';
    if (winner === 'attacker') attackerWins += 1;
    else defenderWins += 1;
    comparisons.push({ roundNumber, attackerScore, defenderScore, winner });
  }
  return { attackerWins, defenderWins, winner: attackerWins >= AETHERIS_WAR_RULES.roundsToWin ? 'attacker' : 'defender', comparisons };
}
