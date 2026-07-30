export const DEFAULT_AETHERIS_TERRITORY_ID = 'emberfall-forge';

export const AETHERIS_TERRITORIES = Object.freeze([
  Object.freeze({
    id: 'emberfall-forge',
    name: 'Emberfall Forge',
    faction: 'Forgeguard',
    battlefield: 'Molten foundry front',
    oath: 'Hold the forge. Break the siege.',
    structurePlan: Object.freeze({
      frontline: 'Iron gate',
      anchor: 'Smelter tower',
      ultimate: 'Siege gantry',
    }),
    palette: Object.freeze({
      primary: '#ff6a3d',
      secondary: '#f6c95b',
      surface: '#541824',
      deep: '#140807',
      text: '#fff0b9',
    }),
  }),
  Object.freeze({
    id: 'stormglass-coast',
    name: 'Stormglass Coast',
    faction: 'Tidecallers',
    battlefield: 'Shattered glass shoreline',
    oath: 'Bend the storm. Guard the coast.',
    structurePlan: Object.freeze({
      frontline: 'Breaker wall',
      anchor: 'Glass beacon',
      ultimate: 'Tempest spire',
    }),
    palette: Object.freeze({
      primary: '#55e7ff',
      secondary: '#9ff5ff',
      surface: '#12425a',
      deep: '#06121b',
      text: '#e4fbff',
    }),
  }),
  Object.freeze({
    id: 'verdant-crown',
    name: 'Verdant Crown',
    faction: 'Crownwardens',
    battlefield: 'Overgrown throne grove',
    oath: 'Root the line. Reclaim the crown.',
    structurePlan: Object.freeze({
      frontline: 'Briar palisade',
      anchor: 'Living watchtree',
      ultimate: 'Crownheart shrine',
    }),
    palette: Object.freeze({
      primary: '#77f0a1',
      secondary: '#d6f66b',
      surface: '#214b2e',
      deep: '#07150c',
      text: '#ecffe5',
    }),
  }),
  Object.freeze({
    id: 'umbral-bastion',
    name: 'Umbral Bastion',
    faction: 'Night Vow',
    battlefield: 'Moonlit fortress breach',
    oath: 'Hold the dark. Strike from silence.',
    structurePlan: Object.freeze({
      frontline: 'Shadow bulwark',
      anchor: 'Moonwell keep',
      ultimate: 'Eclipse obelisk',
    }),
    palette: Object.freeze({
      primary: '#b89cff',
      secondary: '#ff8bc2',
      surface: '#332255',
      deep: '#0d0a17',
      text: '#f4edff',
    }),
  }),
]);

const TERRITORIES_BY_ID = new Map(AETHERIS_TERRITORIES.map(territory => [territory.id, territory]));

function cloneTerritory(territory) {
  return {
    ...territory,
    palette: { ...territory.palette },
    structurePlan: { ...territory.structurePlan },
  };
}

export function normalizeAetherisTerritoryId(value, fallback = DEFAULT_AETHERIS_TERRITORY_ID) {
  const id = String(value || '').trim().toLowerCase();
  if (TERRITORIES_BY_ID.has(id)) return id;
  const fallbackId = String(fallback || '').trim().toLowerCase();
  return TERRITORIES_BY_ID.has(fallbackId) ? fallbackId : DEFAULT_AETHERIS_TERRITORY_ID;
}

export function getAetherisTerritory(value) {
  return cloneTerritory(TERRITORIES_BY_ID.get(normalizeAetherisTerritoryId(value)));
}

export function listAetherisTerritories() {
  return AETHERIS_TERRITORIES.map(cloneTerritory);
}
