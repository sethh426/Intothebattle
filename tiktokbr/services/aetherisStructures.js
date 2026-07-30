import {
  DEFAULT_AETHERIS_TERRITORY_ID,
  getAetherisTerritory,
  normalizeAetherisTerritoryId,
} from './aetherisTerritories.js';

export const AETHERIS_STRUCTURE_TYPES = Object.freeze(['frontline', 'anchor', 'ultimate']);

export const AETHERIS_STRUCTURE_RULES = Object.freeze({
  frontline: Object.freeze({
    label: 'Frontline',
    fallbackName: 'Frontline gate',
    role: 'First breach objective',
    maxHp: 420,
    order: 1,
  }),
  anchor: Object.freeze({
    label: 'Anchor',
    fallbackName: 'Anchor tower',
    role: 'Territory control objective',
    maxHp: 620,
    order: 2,
  }),
  ultimate: Object.freeze({
    label: 'Ultimate',
    fallbackName: 'Ultimate core',
    role: 'Final territory objective',
    maxHp: 840,
    order: 3,
  }),
});

function safeStructureHp(value, fallback, maxHp) {
  const numeric = Number(value);
  const safeFallback = Number.isFinite(Number(fallback)) ? Number(fallback) : maxHp;
  const next = Number.isFinite(numeric) ? numeric : safeFallback;
  return Math.max(0, Math.min(maxHp, Math.round(next)));
}

function structureStatus(hp, maxHp) {
  if (hp <= 0) return 'destroyed';
  const pct = hp / Math.max(1, maxHp);
  if (pct <= 0.33) return 'critical';
  if (pct <= 0.66) return 'damaged';
  return 'standing';
}

function cloneLastHitBy(value) {
  if (!value || typeof value !== 'object') return null;
  return {
    uniqueId: String(value.uniqueId || value.attackerId || '').slice(0, 80),
    nickname: String(value.nickname || value.attackerNick || value.uniqueId || '').slice(0, 80),
    damage: Math.max(0, Math.round(Number(value.damage) || 0)),
    at: Math.max(0, Math.round(Number(value.at) || 0)),
  };
}

function publicStructure(structure) {
  const maxHp = Math.max(1, Math.round(Number(structure.maxHp) || 1));
  const hp = safeStructureHp(structure.hp, maxHp, maxHp);
  return {
    id: structure.id,
    type: structure.type,
    name: structure.name,
    label: structure.label,
    role: structure.role,
    order: structure.order,
    territoryId: structure.territoryId,
    hp,
    maxHp,
    hpPct: Math.max(0, Math.min(1, hp / maxHp)),
    status: structureStatus(hp, maxHp),
    alive: hp > 0,
    lastDamagedAt: Math.max(0, Math.round(Number(structure.lastDamagedAt) || 0)),
    lastHitBy: cloneLastHitBy(structure.lastHitBy),
  };
}

function structureId(territoryId, type) {
  return `aetheris:${territoryId}:${type}`;
}

function buildStructureForType(territory, type, incoming = null) {
  const rules = AETHERIS_STRUCTURE_RULES[type] || AETHERIS_STRUCTURE_RULES.frontline;
  const territoryId = normalizeAetherisTerritoryId(territory?.id, DEFAULT_AETHERIS_TERRITORY_ID);
  const maxHp = Math.max(1, Math.round(Number(rules.maxHp) || 1));
  const hp = safeStructureHp(incoming?.hp, maxHp, maxHp);
  return {
    id: structureId(territoryId, type),
    type,
    name: territory?.structurePlan?.[type] || rules.fallbackName,
    label: rules.label,
    role: rules.role,
    order: rules.order,
    territoryId,
    hp,
    maxHp,
    status: structureStatus(hp, maxHp),
    alive: hp > 0,
    lastDamagedAt: Math.max(0, Math.round(Number(incoming?.lastDamagedAt) || 0)),
    lastHitBy: cloneLastHitBy(incoming?.lastHitBy),
  };
}

function aggregateForStructures(structures = []) {
  const publicStructures = structures.map(publicStructure).sort((a, b) => a.order - b.order);
  const hp = publicStructures.reduce((sum, structure) => sum + structure.hp, 0);
  const maxHp = publicStructures.reduce((sum, structure) => sum + structure.maxHp, 0);
  const standing = publicStructures.filter(structure => structure.alive).length;
  const destroyed = publicStructures.length - standing;
  const critical = publicStructures.filter(structure => structure.status === 'critical').length;
  const hpPct = maxHp > 0 ? Math.max(0, Math.min(1, hp / maxHp)) : 0;
  return {
    hp,
    maxHp,
    hpPct,
    standing,
    destroyed,
    critical,
    total: publicStructures.length,
    status: standing <= 0 ? 'destroyed' : critical > 0 ? 'critical' : hpPct <= 0.66 ? 'damaged' : 'standing',
  };
}

export function buildAetherisStructures(territoryId = DEFAULT_AETHERIS_TERRITORY_ID) {
  const territory = getAetherisTerritory(territoryId);
  const normalizedTerritoryId = normalizeAetherisTerritoryId(territory.id);
  const structures = AETHERIS_STRUCTURE_TYPES.map(type => buildStructureForType(territory, type));
  const now = Date.now();
  return {
    territoryId: normalizedTerritoryId,
    version: 1,
    resetAt: now,
    updatedAt: now,
    structures,
    aggregate: aggregateForStructures(structures),
  };
}

export function normalizeAetherisStructures(state = null, territoryId = DEFAULT_AETHERIS_TERRITORY_ID) {
  const normalizedTerritoryId = normalizeAetherisTerritoryId(territoryId);
  if (!state || typeof state !== 'object' || normalizeAetherisTerritoryId(state.territoryId, '') !== normalizedTerritoryId) {
    return buildAetherisStructures(normalizedTerritoryId);
  }

  const territory = getAetherisTerritory(normalizedTerritoryId);
  const incomingStructures = Array.isArray(state.structures) ? state.structures : [];
  const byType = new Map(incomingStructures.map(structure => [String(structure?.type || ''), structure]));
  const structures = AETHERIS_STRUCTURE_TYPES.map(type => buildStructureForType(territory, type, byType.get(type)));
  return {
    territoryId: normalizedTerritoryId,
    version: Math.max(1, Math.round(Number(state.version) || 1)),
    resetAt: Math.max(0, Math.round(Number(state.resetAt) || Date.now())),
    updatedAt: Math.max(0, Math.round(Number(state.updatedAt) || Date.now())),
    structures,
    aggregate: aggregateForStructures(structures),
  };
}

export function currentAetherisStructureStatus(state = null, territoryId = DEFAULT_AETHERIS_TERRITORY_ID) {
  const normalized = normalizeAetherisStructures(state, territoryId);
  const structures = normalized.structures.map(publicStructure).sort((a, b) => a.order - b.order);
  return {
    territoryId: normalized.territoryId,
    version: normalized.version,
    resetAt: normalized.resetAt,
    updatedAt: normalized.updatedAt,
    structures,
    aggregate: aggregateForStructures(structures),
  };
}

export function damageAetherisStructure(state, options = {}) {
  const normalized = normalizeAetherisStructures(state, state?.territoryId || options.territoryId);
  const damage = Math.max(1, Math.round(Number(options.damage) || 1));
  const requestedTarget = String(options.targetId || options.structureId || '').trim();
  const requestedType = String(options.type || options.structureType || '').trim();
  const alive = normalized.structures
    .filter(structure => Number(structure.hp) > 0)
    .sort((a, b) => a.order - b.order);
  const target = alive.find(structure => structure.id === requestedTarget)
    || alive.find(structure => structure.type === requestedType)
    || alive[0]
    || null;

  if (!target) {
    normalized.aggregate = aggregateForStructures(normalized.structures);
    return {
      damaged: false,
      reason: 'all_structures_destroyed',
      state: normalized,
      aggregate: normalized.aggregate,
    };
  }

  const beforeHp = Math.max(0, Math.round(Number(target.hp) || 0));
  target.hp = Math.max(0, beforeHp - damage);
  target.status = structureStatus(target.hp, target.maxHp);
  target.alive = target.hp > 0;
  target.lastDamagedAt = Date.now();
  target.lastHitBy = {
    uniqueId: String(options.attackerId || '').slice(0, 80),
    nickname: String(options.attackerNick || options.attackerId || '').slice(0, 80),
    damage: Math.min(beforeHp, damage),
    at: target.lastDamagedAt,
  };
  normalized.updatedAt = target.lastDamagedAt;
  normalized.aggregate = aggregateForStructures(normalized.structures);

  return {
    damaged: true,
    state: normalized,
    target: publicStructure(target),
    beforeHp,
    damageApplied: Math.min(beforeHp, damage),
    requestedDamage: damage,
    overkill: Math.max(0, damage - beforeHp),
    destroyed: target.hp <= 0,
    aggregate: normalized.aggregate,
  };
}
