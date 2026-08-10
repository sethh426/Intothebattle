import {
  V1_ABILITIES,
  V1_MODES,
  V1_PHASES,
  V1_RULES,
  extractV1Mentions,
  normalizeV1Mode,
  normalizeV1Name,
  normalizeV1Phase,
  parseV1ChatCommand,
} from './v1Rules.js';

const SYSTEM_TARGETS = Object.freeze({
  horde: new Set(['horde', 'thehorde', '__horde__']),
  boss: new Set(['boss', 'raidboss', 'waveboss', '__boss__']),
});

export function createV1PlayerRecord(input = {}) {
  const now = Number(input.now) || Date.now();
  const maxHp = Math.max(1, Math.round(Number(input.maxHp) || V1_RULES.maxHp));
  return {
    uniqueId: String(input.uniqueId || input.id || '').trim(),
    nickname: String(input.nickname || input.name || input.uniqueId || input.id || 'Player').trim(),
    hp: Math.max(1, Math.min(maxHp, Math.round(Number(input.hp) || maxHp))),
    maxHp,
    shield: Math.max(0, Math.min(V1_RULES.maxShield, Math.round(Number(input.shield) || 0))),
    maxShield: V1_RULES.maxShield,
    energy: Math.max(0, Math.min(V1_RULES.maxEnergy, Math.round(Number(input.energy) || V1_RULES.startingEnergy))),
    maxEnergy: V1_RULES.maxEnergy,
    cooldowns: { ...(input.cooldowns && typeof input.cooldowns === 'object' ? input.cooldowns : {}) },
    statuses: { ...(input.statuses && typeof input.statuses === 'object' ? input.statuses : {}) },
    battleCharges: Math.max(0, Math.min(V1_RULES.battleChargeMax, Math.round(Number(input.battleCharges) || 0))),
    battleChargeExpiresAt: Math.max(0, Number(input.battleChargeExpiresAt) || 0),
    healFatigue: Array.isArray(input.healFatigue) ? input.healFatigue.slice(-4) : [],
    alive: input.alive !== false,
    strength: V1_RULES.basicDamage,
    kills: Math.max(0, Math.round(Number(input.kills) || 0)),
    assists: Math.max(0, Math.round(Number(input.assists) || 0)),
    deaths: Math.max(0, Math.round(Number(input.deaths) || 0)),
    score: Math.max(0, Math.round(Number(input.score) || 0)),
    damageDealt: Math.max(0, Math.round(Number(input.damageDealt) || 0)),
    damageTaken: Math.max(0, Math.round(Number(input.damageTaken) || 0)),
    healingDone: Math.max(0, Math.round(Number(input.healingDone) || 0)),
    shieldingDone: Math.max(0, Math.round(Number(input.shieldingDone) || 0)),
    objectiveScore: Math.max(0, Math.round(Number(input.objectiveScore) || 0)),
    engagementScore: Math.max(0, Math.round(Number(input.engagementScore) || 0)),
    killStreak: Math.max(0, Math.round(Number(input.killStreak) || 0)),
    lastKillTime: Math.max(0, Number(input.lastKillTime) || 0),
    firstSeenAt: Math.max(0, Number(input.firstSeenAt) || now),
    lastActive: now,
    respawnAt: Math.max(0, Number(input.respawnAt) || 0),
    spawnProtectionUntil: Math.max(0, Number(input.spawnProtectionUntil) || now + V1_RULES.spawnProtectionMs),
    source: input.source || 'test',
    x: Number.isFinite(Number(input.x)) ? Number(input.x) : Math.random() * 760 + 20,
    y: Number.isFinite(Number(input.y)) ? Number(input.y) : Math.random() * 380 + 20,
    vx: Number.isFinite(Number(input.vx)) ? Number(input.vx) : (Math.random() - 0.5) * 2,
    vy: Number.isFinite(Number(input.vy)) ? Number(input.vy) : (Math.random() - 0.5) * 2,
    color: input.color || '',
    teamId: input.teamId || '',
    teamName: input.teamName || '',
    teamColor: input.teamColor || '',
    iconEmoji: input.iconEmoji || '',
    forceSpawn: input.forceSpawn !== false,
    v1: true,
  };
}

export function normalizeV1Player(player, options = {}) {
  if (!player || typeof player !== 'object') return null;
  const now = Number(options.now) || Date.now();
  const wasV1 = player.v1 === true;
  const previousMaxHp = Math.max(1, Math.round(Number(player.maxHp) || V1_RULES.maxHp));
  if (!wasV1 || previousMaxHp !== V1_RULES.maxHp) {
    const previousHp = player.alive === false
      ? 0
      : Math.max(1, Math.min(previousMaxHp, Math.round(Number(player.hp) || previousMaxHp)));
    const hpRatio = player.alive === false ? 0 : Math.max(0, Math.min(1, previousHp / previousMaxHp));
    player.maxHp = V1_RULES.maxHp;
    player.hp = player.alive === false
      ? 0
      : Math.max(1, Math.min(V1_RULES.maxHp, Math.round(V1_RULES.maxHp * hpRatio)));
  }
  player.maxShield = V1_RULES.maxShield;
  player.strength = V1_RULES.basicDamage;
  player.shield = Math.max(0, Math.min(V1_RULES.maxShield, Math.round(Number(player.shield) || 0)));
  player.energy = Math.max(0, Math.min(V1_RULES.maxEnergy, Math.round(Number(player.energy) || 0)));
  player.maxEnergy = V1_RULES.maxEnergy;
  player.cooldowns = player.cooldowns && typeof player.cooldowns === 'object' ? player.cooldowns : {};
  player.statuses = player.statuses && typeof player.statuses === 'object' ? player.statuses : {};
  player.battleCharges = Math.max(0, Math.min(V1_RULES.battleChargeMax, Math.round(Number(player.battleCharges) || 0)));
  player.battleChargeExpiresAt = Math.max(0, Number(player.battleChargeExpiresAt) || 0);
  player.healFatigue = Array.isArray(player.healFatigue) ? player.healFatigue.slice(-4) : [];
  player.score = Math.max(0, Math.round(Number(player.score) || 0));
  player.damageDealt = Math.max(0, Math.round(Number(player.damageDealt) || 0));
  player.damageTaken = Math.max(0, Math.round(Number(player.damageTaken) || 0));
  player.healingDone = Math.max(0, Math.round(Number(player.healingDone) || 0));
  player.shieldingDone = Math.max(0, Math.round(Number(player.shieldingDone) || 0));
  player.objectiveScore = Math.max(0, Math.round(Number(player.objectiveScore) || 0));
  player.engagementScore = Math.max(0, Math.round(Number(player.engagementScore) || 0));
  player.assists = Math.max(0, Math.round(Number(player.assists) || 0));
  player.deaths = Math.max(0, Math.round(Number(player.deaths) || 0));
  player.spawnProtectionUntil = Math.max(0, Number(player.spawnProtectionUntil) || 0);
  player.respawnAt = Math.max(0, Number(player.respawnAt) || 0);
  player.lastActive = now;
  player.v1 = true;
  expireV1TimedState(player, now);
  return player;
}

export function ensureV1RoomState(room, options = {}) {
  if (!room) return null;
  const mode = normalizeV1Mode(options.mode || room.v1Game?.mode || room.overlaySettings?.battleMode);
  const now = Number(options.now) || Date.now();
  if (!room.v1Game || typeof room.v1Game !== 'object') {
    room.v1Game = {
      version: 1,
      mode,
      phase: normalizeV1Phase(options.phase || V1_PHASES.BATTLE),
      phaseEndsAt: 0,
      roundId: '',
      sequence: 0,
      recentEvents: [],
      processedEventIds: {},
      arenaPower: {
        meter: 0,
        active: false,
        countdownEndsAt: 0,
        endsAt: 0,
        contributors: {},
        topContributors: [],
      },
      createdAt: now,
      updatedAt: now,
    };
  }
  room.v1Game.mode = mode;
  room.v1Game.phase = normalizeV1Phase(options.phase || room.v1Game.phase);
  room.v1Game.updatedAt = now;
  return room.v1Game;
}

export function setV1Mode(room, mode) {
  const state = ensureV1RoomState(room, { mode });
  if (!state) return V1_MODES.HORDE_SURVIVAL;
  state.mode = normalizeV1Mode(mode);
  return state.mode;
}

export function startV1Round(room, options = {}) {
  const now = Number(options.now) || Date.now();
  const mode = normalizeV1Mode(options.mode || room?.overlaySettings?.battleMode || room?.v1Game?.mode);
  const state = ensureV1RoomState(room, { mode, phase: V1_PHASES.LOBBY, now });
  const roundId = options.roundId || `v1-${room?.roomId || 'room'}-${now}`;
  state.roundId = roundId;
  state.phase = V1_PHASES.LOBBY;
  state.phaseEndsAt = now + V1_RULES.lobbyMs;
  state.battleStartsAt = state.phaseEndsAt;
  state.battleEndsAt = state.battleStartsAt + V1_RULES.battleMs;
  state.finalEndsAt = state.battleEndsAt + V1_RULES.finalEventMs;
  state.resultsEndsAt = state.finalEndsAt + V1_RULES.resultsMs;
  state.recentEvents = [];
  state.arenaPower = {
    meter: 0,
    active: false,
    countdownEndsAt: 0,
    endsAt: 0,
    contributors: {},
    topContributors: [],
  };
  state.updatedAt = now;
  return state;
}

export function setV1Phase(room, phase, options = {}) {
  const now = Number(options.now) || Date.now();
  const state = ensureV1RoomState(room, { now });
  state.phase = normalizeV1Phase(phase);
  state.phaseEndsAt = Math.max(0, Number(options.phaseEndsAt) || 0);
  state.updatedAt = now;
  return state;
}

export function isV1CombatPhase(room) {
  const phase = normalizeV1Phase(room?.v1Game?.phase || V1_PHASES.BATTLE);
  return phase === V1_PHASES.BATTLE || phase === V1_PHASES.FINAL_EVENT;
}

export function ensureV1Player(room, uniqueId, nickname, options = {}) {
  if (!room?.players || !uniqueId) return null;
  ensureV1RoomState(room, options);
  const now = Number(options.now) || Date.now();
  const id = String(uniqueId).trim();
  const existing = room.players[id];
  if (existing) {
    if (nickname) existing.nickname = nickname;
    if (options.source && (!existing.source || options.source === 'real')) existing.source = options.source;
    existing.alive = options.revive === true ? true : existing.alive !== false;
    existing.forceSpawn = options.forceSpawn !== false;
    return normalizeV1Player(existing, { now });
  }
  room.players[id] = createV1PlayerRecord({
    uniqueId: id,
    nickname,
    source: options.source,
    color: options.color,
    iconEmoji: options.iconEmoji,
    now,
  });
  return room.players[id];
}

function publicPlayerLabel(player, fallback = '') {
  return String(player?.nickname || player?.uniqueId || fallback || 'Player').replace(/^@+/, '');
}

function v1Event(room, type, payload = {}, now = Date.now()) {
  const state = ensureV1RoomState(room, { now });
  state.sequence = (Number(state.sequence) || 0) + 1;
  const event = {
    id: `${state.roundId || 'v1'}-${state.sequence}`,
    type,
    roundId: state.roundId || '',
    mode: state.mode,
    phase: state.phase,
    createdAt: now,
    ...payload,
  };
  state.recentEvents = [event, ...(state.recentEvents || [])].slice(0, 80);
  return event;
}

function v1IdempotencyKey(options = {}) {
  const key = String(options.idempotencyKey || options.eventId || '').trim();
  return key ? key.slice(0, 160) : '';
}

function duplicateV1Action(room, key, ability, now = Date.now()) {
  if (!key) return null;
  const state = ensureV1RoomState(room, { now });
  const existing = state?.processedEventIds?.[key];
  if (!existing) return null;
  return {
    handled: false,
    rejected: true,
    duplicate: true,
    reason: 'duplicate_event',
    abilityKey: ability?.key || '',
    result: existing,
    id: existing.id || key,
  };
}

function rememberV1Action(room, key, event, now = Date.now()) {
  if (!key || !event) return event;
  const state = ensureV1RoomState(room, { now });
  event.id = key;
  state.processedEventIds = state.processedEventIds && typeof state.processedEventIds === 'object' ? state.processedEventIds : {};
  state.processedEventIds[key] = event;
  return event;
}

function expireV1TimedState(player, now = Date.now()) {
  if (!player) return;
  if (player.battleChargeExpiresAt && player.battleChargeExpiresAt <= now) {
    player.battleCharges = 0;
    player.battleChargeExpiresAt = 0;
  }
  if (player.shieldUntil && player.shieldUntil <= now) {
    player.shieldUntil = 0;
    player.shield = 0;
  }
  if (Array.isArray(player.healFatigue)) {
    player.healFatigue = player.healFatigue.filter(ts => now - Number(ts) <= V1_ABILITIES.heal.fatigueWindowMs).slice(-4);
  }
}

function addEnergy(player, amount) {
  const before = Math.max(0, Number(player.energy) || 0);
  player.energy = Math.max(0, Math.min(V1_RULES.maxEnergy, before + Math.round(Number(amount) || 0)));
  return player.energy - before;
}

function restoreHp(player, amount) {
  if (!player?.alive) return 0;
  const maxHp = Math.max(1, Math.round(Number(player.maxHp) || V1_RULES.maxHp));
  const before = Math.max(0, Math.min(maxHp, Math.round(Number(player.hp) || 0)));
  player.hp = Math.max(0, Math.min(maxHp, before + Math.round(Number(amount) || 0)));
  return player.hp - before;
}

function restoreToFullHp(player) {
  if (!player?.alive) return 0;
  const maxHp = Math.max(1, Math.round(Number(player.maxHp) || V1_RULES.maxHp));
  const before = Math.max(0, Math.min(maxHp, Math.round(Number(player.hp) || 0)));
  player.hp = maxHp;
  return player.hp - before;
}

function aliveV1Players(room) {
  return Object.values(room?.players || {})
    .map(player => normalizeV1Player(player))
    .filter(player => player?.alive && player.uniqueId);
}

export function resolveV1Target(room, token = '', options = {}) {
  const raw = String(token || '').trim().replace(/^@+/, '');
  const normalized = normalizeV1Name(raw);
  if (!raw && options.allowSelf && options.attackerId) {
    const self = room?.players?.[options.attackerId];
    return self ? { type: 'player', player: self, id: self.uniqueId, nickname: publicPlayerLabel(self) } : null;
  }
  if (SYSTEM_TARGETS.boss.has(normalized)) return { type: 'boss', id: '__BOSS__', nickname: 'Void Colossus' };
  if (SYSTEM_TARGETS.horde.has(normalized)) return { type: 'horde', id: '__HORDE__', nickname: 'The Horde' };

  const exactId = Object.values(room?.players || {}).find(player => String(player?.uniqueId || '').toLowerCase() === raw.toLowerCase());
  if (exactId) return { type: 'player', player: exactId, id: exactId.uniqueId, nickname: publicPlayerLabel(exactId) };

  const exactUsername = Object.values(room?.players || {}).find(player => String(player?.uniqueId || '').toLowerCase() === raw.toLowerCase());
  if (exactUsername) return { type: 'player', player: exactUsername, id: exactUsername.uniqueId, nickname: publicPlayerLabel(exactUsername) };

  const normalizedMatches = Object.values(room?.players || {}).filter(player => (
    normalizeV1Name(player?.uniqueId || '') === normalized ||
    normalizeV1Name(player?.nickname || '') === normalized
  ));
  if (normalizedMatches.length === 1) {
    const player = normalizedMatches[0];
    return { type: 'player', player, id: player.uniqueId, nickname: publicPlayerLabel(player) };
  }

  return null;
}

function canTargetPlayerInMode(mode) {
  return mode === V1_MODES.FREE_FOR_ALL;
}

function cooldownRemaining(player, key, now) {
  return Math.max(0, Math.round(Number(player.cooldowns?.[key]) || 0) - now);
}

function rejectAction(room, attacker, ability, reason, detail = {}, now = Date.now()) {
  return {
    handled: true,
    rejected: true,
    reason,
    abilityKey: ability?.key || '',
    event: v1Event(room, 'actionRejected', {
      uniqueId: attacker?.uniqueId || '',
      nickname: publicPlayerLabel(attacker),
      abilityKey: ability?.key || '',
      reason,
      ...detail,
    }, now),
  };
}

function checkActionReady(room, attacker, ability, now) {
  if (!attacker?.alive) return rejectAction(room, attacker, ability, 'player_defeated', {}, now);
  if (!isV1CombatPhase(room) && ability?.key !== 'shield' && ability?.key !== 'heal') {
    return rejectAction(room, attacker, ability, 'round_not_in_combat', { phase: room?.v1Game?.phase || '' }, now);
  }
  const globalRemaining = cooldownRemaining(attacker, 'global', now);
  if (globalRemaining > 0) return rejectAction(room, attacker, ability, 'global_cooldown', { cooldownMs: globalRemaining }, now);
  const remaining = cooldownRemaining(attacker, ability.key, now);
  if (remaining > 0) return rejectAction(room, attacker, ability, 'ability_cooldown', { cooldownMs: remaining }, now);
  if (Number(attacker.energy) < Number(ability.energyCost || 0)) {
    return rejectAction(room, attacker, ability, 'not_enough_energy', {
      energy: Math.round(Number(attacker.energy) || 0),
      energyCost: ability.energyCost || 0,
    }, now);
  }
  return null;
}

function spendAbilityCost(attacker, ability, now) {
  attacker.energy = Math.max(0, Math.round(Number(attacker.energy) || 0) - Math.round(Number(ability.energyCost) || 0));
  attacker.cooldowns[ability.key] = now + Math.max(0, Math.round(Number(ability.cooldownMs) || 0));
  attacker.cooldowns.global = now + V1_RULES.globalCooldownMs;
  if (attacker.spawnProtectionUntil && attacker.spawnProtectionUntil > now) attacker.spawnProtectionUntil = 0;
}

function consumeBattleCharges(attacker, now) {
  expireV1TimedState(attacker, now);
  const charges = Math.max(0, Math.min(V1_RULES.battleChargeMax, Math.round(Number(attacker.battleCharges) || 0)));
  attacker.battleCharges = 0;
  attacker.battleChargeExpiresAt = 0;
  return charges;
}

function critMultiplier(options = {}) {
  if (options.forceCrit === true) return V1_RULES.critMultiplier;
  if (options.disableCrit === true) return 1;
  return Math.random() < V1_RULES.critChance ? V1_RULES.critMultiplier : 1;
}

export function capV1PlayerHitDamage(target, damage, options = {}) {
  const incomingDamage = Math.max(0, Math.round(Number(damage) || 0));
  if (!target || options.bypassPlayerHitCap === true || incomingDamage <= 0) {
    return {
      damage: incomingDamage,
      damageCapped: false,
      uncappedDamage: incomingDamage,
      damageCap: 0,
    };
  }
  const maxHp = Math.max(1, Math.round(Number(target.maxHp) || V1_RULES.maxHp));
  const damageCap = Math.max(1, Math.round(maxHp * V1_RULES.maxPlayerHitPct));
  const cappedDamage = Math.min(incomingDamage, damageCap);
  return {
    damage: cappedDamage,
    damageCapped: cappedDamage < incomingDamage,
    uncappedDamage: incomingDamage,
    damageCap,
  };
}

export function applyV1Damage(room, attackerId, targetId, abilityKey = 'basic', options = {}) {
  const now = Number(options.now) || Date.now();
  const ability = V1_ABILITIES[abilityKey] || V1_ABILITIES.basic;
  const idempotencyKey = v1IdempotencyKey(options);
  const duplicate = duplicateV1Action(room, idempotencyKey, ability, now);
  if (duplicate) return duplicate;
  const attacker = ensureV1Player(room, attackerId, options.attackerNick || attackerId, { now, source: options.source });
  const target = room?.players?.[targetId] ? normalizeV1Player(room.players[targetId], { now }) : null;
  if (!attacker || !target || attacker.uniqueId === targetId) {
    return rejectAction(room, attacker, ability, 'invalid_target', { target: targetId || '' }, now);
  }
  if (!target.alive) return rejectAction(room, attacker, ability, 'target_defeated', { target: targetId }, now);
  if (target.spawnProtectionUntil && target.spawnProtectionUntil > now) {
    return rejectAction(room, attacker, ability, 'target_spawn_protected', {
      target: targetId,
      protectedMs: target.spawnProtectionUntil - now,
    }, now);
  }
  const ready = options.bypassCost === true ? null : checkActionReady(room, attacker, ability, now);
  if (ready) return ready;

  if (options.bypassCost !== true) spendAbilityCost(attacker, ability, now);
  let baseDamage = Math.max(1, Math.round(Number(options.fixedDamage) || Number(ability.damage) || V1_RULES.basicDamage));
  let chargeBonus = 0;
  if (ability.key === 'basic') {
    const charges = consumeBattleCharges(attacker, now);
    chargeBonus = charges * V1_RULES.battleChargeDamage;
    baseDamage += chargeBonus;
    addEnergy(attacker, V1_RULES.successfulBasicEnergy);
  }
  const crit = critMultiplier(options);
  const uncappedRawDamage = Math.max(1, Math.round(baseDamage * crit * (Number(options.damageMultiplier) || 1)));
  const damageLimit = capV1PlayerHitDamage(target, uncappedRawDamage, options);
  const rawDamage = damageLimit.damage;
  const preHp = Math.max(0, Number(target.hp) || 0);
  const preShield = Math.max(0, Number(target.shield) || 0);

  let shieldAbsorbed = 0;
  let healthDamage = rawDamage;
  if (preShield > 0) {
    const penetration = Math.max(0, Math.min(1, Number(ability.shieldPenetration) || 0));
    const penetrated = Math.round(rawDamage * penetration);
    const shieldFacingDamage = Math.max(0, rawDamage - penetrated);
    const shieldMultiplier = Math.max(1, Number(ability.shieldDamageMultiplier) || 1);
    const shieldHit = Math.round(shieldFacingDamage * shieldMultiplier);
    shieldAbsorbed = Math.min(preShield, shieldHit);
    target.shield = Math.max(0, preShield - shieldAbsorbed);
    const equivalentAbsorb = Math.round(shieldAbsorbed / shieldMultiplier);
    healthDamage = Math.max(0, penetrated + shieldFacingDamage - equivalentAbsorb);
  }

  target.hp = Math.max(0, preHp - healthDamage);
  target.damageTaken += healthDamage;
  target.lastActive = now;
  attacker.damageDealt += healthDamage;
  attacker.score += healthDamage + (shieldAbsorbed > 0 ? Math.ceil(shieldAbsorbed / 2) : 0);
  if (healthDamage > 0) addEnergy(attacker, V1_RULES.successfulHitEnergy);

  if (ability.key === 'fire') {
    target.statuses.burn = {
      sourceId: attacker.uniqueId,
      sourceNick: publicPlayerLabel(attacker),
      tickDamage: ability.burnDamage,
      remainingTicks: ability.burnTicks,
      nextTickAt: now + ability.burnTickMs,
      tickMs: ability.burnTickMs,
      effect: 'fire',
    };
  }

  const killed = target.hp <= 0;
  if (killed) {
    target.alive = false;
    target.deaths += 1;
    target.killStreak = 0;
    target.respawnAt = now + V1_RULES.respawnDelayMs;
    attacker.kills += 1;
    attacker.killStreak = (Number(attacker.killStreak) || 0) + 1;
    attacker.lastKillTime = now;
    attacker.score += 50;
  }

  const event = rememberV1Action(room, idempotencyKey, v1Event(room, 'attack', {
    attacker: attacker.uniqueId,
    attackerNick: publicPlayerLabel(attacker),
    target: target.uniqueId,
    targetNick: publicPlayerLabel(target),
    abilityKey: ability.key,
    commandDescription: ability.description,
    damage: healthDamage,
    rawDamage,
    uncappedDamage: damageLimit.uncappedDamage,
    damageCap: damageLimit.damageCap,
    damageCapped: damageLimit.damageCapped,
    baseDamage,
    chargeBonus,
    critical: crit > 1,
    shielded: shieldAbsorbed > 0,
    shieldAbsorbed,
    shieldRemaining: Math.round(Number(target.shield) || 0),
    energy: Math.round(Number(attacker.energy) || 0),
    energyCost: ability.energyCost || 0,
    killed,
    effect: ability.effect,
    special: ability.key !== 'basic',
    poweredDamage: false,
    remainingHpPct: Math.max(0, Number(target.hp) || 0) / Math.max(1, Number(target.maxHp) || V1_RULES.maxHp),
  }, now), now);

  return {
    handled: true,
    result: {
      ...event,
      intensity: Math.min(1, Math.max(0.28, rawDamage / V1_RULES.maxHp)),
      shotType: ability.effect,
      laserColor: options.laserColor || '',
    },
    target: target.uniqueId,
  };
}

export function applyV1Shield(room, attackerId, nickname, options = {}) {
  const now = Number(options.now) || Date.now();
  const ability = V1_ABILITIES.shield;
  const idempotencyKey = v1IdempotencyKey(options);
  const duplicate = duplicateV1Action(room, idempotencyKey, ability, now);
  if (duplicate) return duplicate;
  const player = ensureV1Player(room, attackerId, nickname, { now, source: options.source });
  const ready = checkActionReady(room, player, ability, now);
  if (ready) return ready;
  spendAbilityCost(player, ability, now);
  const before = Math.max(0, Number(player.shield) || 0);
  player.shield = Math.min(V1_RULES.maxShield, before + ability.shieldAmount);
  player.shieldUntil = now + ability.durationMs;
  player.shieldingDone += Math.max(0, player.shield - before);
  player.score += Math.max(0, player.shield - before);
  return {
    handled: true,
    stop: true,
    event: rememberV1Action(room, idempotencyKey, v1Event(room, 'shield', {
      type: 'shield',
      uniqueId: player.uniqueId,
      nickname: publicPlayerLabel(player),
      shield: player.shield,
      shieldAdded: Math.max(0, player.shield - before),
      shieldUntil: player.shieldUntil,
      durationMs: ability.durationMs,
      cooldownMs: ability.cooldownMs,
      energy: player.energy,
      message: `${publicPlayerLabel(player)} raised a shield`,
    }, now), now),
  };
}

export function applyV1Heal(room, healerId, nickname, targetToken = '', options = {}) {
  const now = Number(options.now) || Date.now();
  const ability = V1_ABILITIES.heal;
  const idempotencyKey = v1IdempotencyKey(options);
  const duplicate = duplicateV1Action(room, idempotencyKey, ability, now);
  if (duplicate) return duplicate;
  const healer = ensureV1Player(room, healerId, nickname, { now, source: options.source });
  const ready = checkActionReady(room, healer, ability, now);
  if (ready) return ready;
  const targetRef = targetToken
    ? resolveV1Target(room, targetToken, { attackerId: healerId })
    : { type: 'player', player: healer, id: healer.uniqueId, nickname: publicPlayerLabel(healer) };
  if (!targetRef || targetRef.type !== 'player' || !targetRef.player?.alive) {
    return rejectAction(room, healer, ability, 'invalid_heal_target', { target: targetToken || '' }, now);
  }
  const target = normalizeV1Player(targetRef.player, { now });
  spendAbilityCost(healer, ability, now);
  target.healFatigue = target.healFatigue.filter(ts => now - Number(ts) <= ability.fatigueWindowMs).slice(-3);
  const fatigueIndex = Math.min(target.healFatigue.length, ability.fatigueSteps.length - 1);
  const fatigueMultiplier = ability.fatigueSteps[fatigueIndex] || 0.25;
  const base = target.uniqueId === healer.uniqueId ? ability.selfAmount : ability.allyAmount;
  const amount = Math.max(1, Math.round(base * fatigueMultiplier));
  const before = Math.max(0, Number(target.hp) || 0);
  target.hp = Math.min(Number(target.maxHp) || V1_RULES.maxHp, before + amount);
  target.healFatigue.push(now);
  const healed = Math.max(0, target.hp - before);
  healer.healingDone += healed;
  healer.score += healed * 2;
  return {
    handled: true,
    stop: true,
    event: rememberV1Action(room, idempotencyKey, v1Event(room, 'heal', {
      type: 'heal',
      uniqueId: target.uniqueId,
      nickname: publicPlayerLabel(target),
      sourceId: healer.uniqueId,
      sourceNick: publicPlayerLabel(healer),
      amount: healed,
      requestedAmount: amount,
      fatigueMultiplier,
      hp: target.hp,
      maxHp: target.maxHp,
      energy: healer.energy,
      message: target.uniqueId === healer.uniqueId
        ? `${publicPlayerLabel(healer)} recovered HP`
        : `${publicPlayerLabel(healer)} healed ${publicPlayerLabel(target)}`,
    }, now), now),
  };
}

export function applyV1Nova(room, attackerId, nickname, options = {}) {
  const now = Number(options.now) || Date.now();
  const ability = V1_ABILITIES.nova;
  const attacker = ensureV1Player(room, attackerId, nickname, { now, source: options.source });
  const ready = checkActionReady(room, attacker, ability, now);
  if (ready) return ready;
  const mode = normalizeV1Mode(room?.v1Game?.mode);
  const candidates = aliveV1Players(room)
    .filter(player => player.uniqueId !== attacker.uniqueId)
    .filter(player => canTargetPlayerInMode(mode) || options.allowPlayerTargets === true)
    .sort((a, b) => (Number(a.hp) || 0) - (Number(b.hp) || 0))
    .slice(0, ability.maxTargets);
  if (!candidates.length) return rejectAction(room, attacker, ability, 'no_nova_targets', {}, now);
  spendAbilityCost(attacker, ability, now);
  const attacks = candidates.map(target => applyV1Damage(room, attacker.uniqueId, target.uniqueId, ability.key, {
    now: now + 1,
    fixedDamage: ability.damage,
    disableCrit: true,
    bypassCost: true,
    allowPlayerTargets: true,
  })).filter(result => result?.handled && !result.rejected);
  return {
    handled: attacks.length > 0,
    multi: true,
    result: attacks[0]?.result || null,
    attacks,
  };
}

export function prepareV1SystemAttack(room, attackerId, nickname, abilityKey = 'basic', targetRef = null, options = {}) {
  const now = Number(options.now) || Date.now();
  const ability = V1_ABILITIES[abilityKey] || V1_ABILITIES.basic;
  const idempotencyKey = v1IdempotencyKey(options);
  const duplicate = duplicateV1Action(room, idempotencyKey, ability, now);
  if (duplicate) return duplicate;
  const attacker = ensureV1Player(room, attackerId, nickname, { now, source: options.source });
  const ready = checkActionReady(room, attacker, ability, now);
  if (ready) return ready;
  spendAbilityCost(attacker, ability, now);
  let baseDamage = Math.max(1, Math.round(Number(ability.damage) || V1_RULES.basicDamage));
  let chargeBonus = 0;
  if (ability.key === 'basic') {
    const charges = consumeBattleCharges(attacker, now);
    chargeBonus = charges * V1_RULES.battleChargeDamage;
    baseDamage += chargeBonus;
    addEnergy(attacker, V1_RULES.successfulBasicEnergy);
  }
  const crit = critMultiplier(options);
  const damage = Math.max(1, Math.round(baseDamage * crit * (Number(options.damageMultiplier) || 1)));
  addEnergy(attacker, V1_RULES.successfulHitEnergy);
  attacker.damageDealt += damage;
  attacker.objectiveScore += targetRef?.type === 'boss' || targetRef?.type === 'horde' ? damage : 0;
  attacker.score += damage + (targetRef?.type === 'boss' || targetRef?.type === 'horde' ? damage : 0);
  return {
    handled: true,
    result: rememberV1Action(room, idempotencyKey, v1Event(room, 'systemAttack', {
      attacker: attacker.uniqueId,
      attackerNick: publicPlayerLabel(attacker),
      target: targetRef?.id || '',
      targetNick: targetRef?.nickname || '',
      targetType: targetRef?.type || 'system',
      abilityKey: ability.key,
      commandDescription: ability.description,
      damage,
      rawDamage: damage,
      baseDamage,
      chargeBonus,
      critical: crit > 1,
      energy: Math.round(Number(attacker.energy) || 0),
      energyCost: ability.energyCost || 0,
      effect: ability.effect,
      special: ability.key !== 'basic',
      poweredDamage: false,
    }, now), now),
    target: targetRef?.id || '',
    systemTarget: targetRef,
  };
}

export function recordV1Engagement(room, uniqueId, nickname, type = 'comment', options = {}) {
  const now = Number(options.now) || Date.now();
  const player = ensureV1Player(room, uniqueId, nickname, { now, source: options.source });
  if (!player) return null;
  const engagementType = String(type || 'comment').toLowerCase();
  let energyGained = 0;
  let hpRestored = 0;
  let fullHeal = false;
  if (engagementType === 'comment' || engagementType === 'chat') {
    const last = Number(player.lastCommentEnergyAt) || 0;
    if (now - last >= V1_RULES.commentEnergyCooldownMs) {
      energyGained = addEnergy(player, V1_RULES.commentEnergy);
      player.lastCommentEnergyAt = now;
    }
    player.battleCharges = Math.min(V1_RULES.battleChargeMax, Math.max(0, Number(player.battleCharges) || 0) + 1);
    player.battleChargeExpiresAt = now + V1_RULES.battleChargeExpiresMs;
  } else if (engagementType === 'like') {
    const amount = Math.max(1, Math.round(Number(options.amount) || 1));
    energyGained = addEnergy(player, Math.min(5, amount));
    hpRestored = restoreHp(
      player,
      Math.min(
        V1_RULES.likeHealMax,
        Math.max(V1_RULES.likeHealMin, Math.ceil(amount / Math.max(1, V1_RULES.likeHealPerHp)))
      )
    );
  } else if (engagementType === 'follow') {
    energyGained = addEnergy(player, V1_RULES.followEnergy);
    hpRestored = restoreHp(player, V1_RULES.followSelfHeal);
  } else if (['share', 'repost', 'social'].includes(engagementType)) {
    const isRepost = engagementType === 'repost';
    energyGained = addEnergy(player, isRepost ? V1_RULES.repostEnergy : V1_RULES.shareEnergy);
    if (isRepost) {
      hpRestored = restoreHp(player, V1_RULES.repostSelfHeal);
    } else if (V1_RULES.shareSelfFullHeal) {
      hpRestored = restoreToFullHp(player);
      fullHeal = true;
    }
    player.battleCharges = Math.min(V1_RULES.battleChargeMax, Math.max(0, Number(player.battleCharges) || 0) + 1);
    player.battleChargeExpiresAt = now + V1_RULES.battleChargeExpiresMs;
  } else if (engagementType === 'gift') {
    const amount = Math.max(1, Math.round(Number(options.amount) || 1));
    energyGained = addEnergy(player, Math.min(20, Math.max(4, amount)));
    hpRestored = restoreHp(
      player,
      Math.min(
        V1_RULES.giftHealMax,
        Math.max(V1_RULES.giftHealMin, Math.ceil(amount / Math.max(1, V1_RULES.giftHealPerDiamond)))
      )
    );
  }
  player.engagementScore += V1_RULES.commentScore;
  player.score += V1_RULES.commentScore;
  return v1Event(room, 'engagement', {
    uniqueId: player.uniqueId,
    nickname: publicPlayerLabel(player),
    engagementType,
    energyGained,
    energy: player.energy,
    hpRestored,
    hp: player.hp,
    maxHp: player.maxHp,
    fullHeal,
    battleCharges: player.battleCharges,
  }, now);
}

export function handleV1ChatAction(room, attackerId, nickname, comment, options = {}) {
  const now = Number(options.now) || Date.now();
  ensureV1RoomState(room, options);
  const command = parseV1ChatCommand(comment);
  const mentions = extractV1Mentions(comment);
  let engagement = null;
  if (command.type === 'comment') {
    engagement = recordV1Engagement(room, attackerId, nickname, 'comment', { now, source: options.source });
  } else {
    ensureV1Player(room, attackerId, nickname, { now, source: options.source });
  }

  if (command.type === 'comment') {
    return {
      handled: false,
      engagementOnly: true,
      reason: 'comment_engagement_only',
      engagement,
      command,
    };
  }

  if (command.type === 'unknown') {
    return {
      handled: false,
      rejected: true,
      reason: 'unknown_command',
      engagement,
      command,
    };
  }

  if (command.type !== 'ability') {
    return {
      handled: false,
      utility: true,
      reason: 'utility_command',
      engagement,
      command,
    };
  }

  const ability = command.ability;
  if (ability.key === 'shield') return applyV1Shield(room, attackerId, nickname, { now, source: options.source });
  if (ability.key === 'heal') return applyV1Heal(room, attackerId, nickname, mentions[0] || '', { now, source: options.source });
  if (ability.key === 'nova') return applyV1Nova(room, attackerId, nickname, { now, source: options.source, allowPlayerTargets: options.allowPlayerTargets });

  const targetToken = mentions[0] || '';
  if (!targetToken) {
    return rejectAction(room, room.players?.[attackerId], ability, 'target_required', {}, now);
  }
  const target = resolveV1Target(room, targetToken, { attackerId });
  if (!target) {
    return rejectAction(room, room.players?.[attackerId], ability, 'target_not_found', { target: targetToken }, now);
  }
  if (target.type === 'player') {
    const mode = normalizeV1Mode(room?.v1Game?.mode);
    if (!canTargetPlayerInMode(mode) && options.allowPlayerTargets !== true) {
      return rejectAction(room, room.players?.[attackerId], ability, 'player_target_disabled_in_mode', { mode, target: target.id }, now);
    }
    return applyV1Damage(room, attackerId, target.id, ability.key, {
      now,
      source: options.source,
      attackerNick: nickname,
      allowPlayerTargets: options.allowPlayerTargets,
      disableCrit: options.disableCrit,
      forceCrit: options.forceCrit,
      damageMultiplier: options.damageMultiplier,
    });
  }
  return {
    handled: true,
    systemTarget: target,
    abilityKey: ability.key,
    ability,
    engagement,
    command,
  };
}

export function processV1StatusTicks(room, options = {}) {
  const now = Number(options.now) || Date.now();
  const events = [];
  for (const player of aliveV1Players(room)) {
    const burn = player.statuses?.burn;
    if (!burn || Number(burn.remainingTicks) <= 0 || Number(burn.nextTickAt) > now) continue;
    const sourceId = String(burn.sourceId || '');
    const source = sourceId ? room.players?.[sourceId] : null;
    const damage = Math.max(1, Math.round(Number(burn.tickDamage) || 1));
    const before = Math.max(0, Number(player.hp) || 0);
    player.hp = Math.max(0, before - damage);
    player.damageTaken += damage;
    if (source) {
      normalizeV1Player(source, { now });
      source.damageDealt += damage;
      source.score += damage;
    }
    burn.remainingTicks = Math.max(0, Number(burn.remainingTicks) - 1);
    burn.nextTickAt = now + Math.max(250, Number(burn.tickMs) || 1000);
    if (burn.remainingTicks <= 0) delete player.statuses.burn;
    const killed = player.hp <= 0;
    if (killed) {
      player.alive = false;
      player.deaths += 1;
      player.killStreak = 0;
      player.respawnAt = now + V1_RULES.respawnDelayMs;
      if (source) {
        source.kills += 1;
        source.killStreak = (Number(source.killStreak) || 0) + 1;
        source.lastKillTime = now;
        source.score += 50;
      }
    }
    events.push(v1Event(room, 'statusTick', {
      attacker: sourceId,
      attackerNick: publicPlayerLabel(source, burn.sourceNick || sourceId),
      target: player.uniqueId,
      targetNick: publicPlayerLabel(player),
      abilityKey: 'fire',
      commandDescription: 'BURN',
      damage,
      killed,
      effect: burn.effect || 'fire',
      special: true,
      remainingHpPct: Math.max(0, Number(player.hp) || 0) / Math.max(1, Number(player.maxHp) || V1_RULES.maxHp),
    }, now));
  }
  return events;
}

export function buildV1Snapshot(room) {
  const state = ensureV1RoomState(room);
  return {
    version: 1,
    mode: state.mode,
    phase: state.phase,
    phaseEndsAt: state.phaseEndsAt || 0,
    roundId: state.roundId || '',
    sequence: Number(state.sequence) || 0,
    arenaPower: state.arenaPower || null,
    recentEvents: state.recentEvents || [],
  };
}
