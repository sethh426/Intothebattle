import {
  DEFAULT_AETHERIS_TERRITORY_ID,
  getAetherisTerritory,
  listAetherisTerritories,
  normalizeAetherisTerritoryId,
} from './aetherisTerritories.js';

const WORLD_EVENT_LIMIT = 12;

function clamp(value, min, max, fallback = min) {
  const numeric = Number(value);
  return Math.max(min, Math.min(max, Number.isFinite(numeric) ? numeric : fallback));
}

function territorySnapshot(territory, incoming = null) {
  const control = Math.round(clamp(incoming?.control, 0, 100, territory.id === DEFAULT_AETHERIS_TERRITORY_ID ? 100 : 50));
  const pressure = Math.round(clamp(incoming?.pressure, 0, 100, 100 - control));
  return {
    id: territory.id,
    name: territory.name,
    faction: territory.faction,
    control,
    pressure,
    status: control <= 20 ? 'falling' : control <= 45 ? 'contested' : control >= 85 ? 'fortified' : 'held',
    updatedAt: Math.max(0, Math.round(Number(incoming?.updatedAt) || 0)),
  };
}

export function buildAetherisWorldState(activeTerritoryId = DEFAULT_AETHERIS_TERRITORY_ID) {
  const activeId = normalizeAetherisTerritoryId(activeTerritoryId);
  const now = Date.now();
  return {
    version: 1,
    activeTerritoryId: activeId,
    territories: listAetherisTerritories().map(territory => territorySnapshot(
      territory,
      { control: territory.id === activeId ? 100 : 50 }
    )),
    events: [],
    updatedAt: now,
  };
}

export function normalizeAetherisWorldState(state = null, activeTerritoryId = DEFAULT_AETHERIS_TERRITORY_ID) {
  const activeId = normalizeAetherisTerritoryId(activeTerritoryId);
  const incoming = state && typeof state === 'object' ? state : {};
  const byId = new Map((Array.isArray(incoming.territories) ? incoming.territories : []).map(row => [row?.id, row]));
  return {
    version: Math.max(1, Math.round(Number(incoming.version) || 1)),
    activeTerritoryId: activeId,
    territories: listAetherisTerritories().map(territory => territorySnapshot(
      territory,
      byId.get(territory.id) || { control: territory.id === activeId ? 100 : 50 }
    )),
    events: (Array.isArray(incoming.events) ? incoming.events : []).slice(0, WORLD_EVENT_LIMIT),
    updatedAt: Math.max(0, Math.round(Number(incoming.updatedAt) || Date.now())),
  };
}

export function syncAetherisWorldFromStructures(state, structureState, options = {}) {
  const territoryId = normalizeAetherisTerritoryId(structureState?.territoryId || options.territoryId);
  const world = normalizeAetherisWorldState(state, territoryId);
  const territory = world.territories.find(row => row.id === territoryId);
  const hpPct = clamp(structureState?.aggregate?.hpPct, 0, 1, 1);
  const now = Math.max(0, Math.round(Number(options.at) || Date.now()));
  const previousControl = territory.control;
  territory.control = Math.round(hpPct * 100);
  territory.pressure = 100 - territory.control;
  territory.status = territory.control <= 20 ? 'falling' : territory.control <= 45 ? 'contested' : territory.control >= 85 ? 'fortified' : 'held';
  territory.updatedAt = now;
  world.updatedAt = now;

  const delta = territory.control - previousControl;
  const eventType = String(options.type || '').trim();
  if (eventType && (delta !== 0 || ['reset', 'destroyed'].includes(eventType))) {
    const catalog = getAetherisTerritory(territoryId);
    const event = {
      id: `${now}:${territoryId}:${world.version + 1}`,
      type: eventType,
      territoryId,
      territoryName: catalog.name,
      faction: catalog.faction,
      control: territory.control,
      delta,
      message: String(options.message || '').slice(0, 180),
      at: now,
    };
    world.events = [event, ...world.events].slice(0, WORLD_EVENT_LIMIT);
    world.version += 1;
  }

  return world;
}

export function currentAetherisWorldStatus(state, activeTerritoryId = DEFAULT_AETHERIS_TERRITORY_ID) {
  const world = normalizeAetherisWorldState(state, activeTerritoryId);
  const active = world.territories.find(row => row.id === world.activeTerritoryId);
  return {
    ...world,
    activeTerritory: active,
    worldSummary: {
      fortified: world.territories.filter(row => row.status === 'fortified').length,
      held: world.territories.filter(row => row.status === 'held').length,
      contested: world.territories.filter(row => row.status === 'contested').length,
      falling: world.territories.filter(row => row.status === 'falling').length,
    },
  };
}
