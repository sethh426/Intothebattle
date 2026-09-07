export const HEROES = Object.freeze([
  { id: 'solar-vanguard', name: 'Solar Vanguard', faction: 'prismatic', role: 'Vanguard', accent: '#8fdcff' },
  { id: 'prism-arcanist', name: 'Prism Arcanist', faction: 'prismatic', role: 'Arcanist', accent: '#d8b7ff' },
  { id: 'tempest-lancer', name: 'Tempest Lancer', faction: 'prismatic', role: 'Lancer', accent: '#68bfff' },
  { id: 'verdant-oracle', name: 'Verdant Oracle', faction: 'solar', role: 'Oracle', accent: '#ffd06f' },
  { id: 'moonveil-huntress', name: 'Moonveil Huntress', faction: 'solar', role: 'Huntress', accent: '#ffad75' },
  { id: 'emberforged-colossus', name: 'Emberforged Colossus', faction: 'solar', role: 'Colossus', accent: '#ff744d' },
]);

export const HERO_IDS = Object.freeze(HEROES.map(hero => hero.id));

export function stableHeroForPlayer(playerId, slot = 0, hostHeroId = HERO_IDS[0]) {
  const pool = HERO_IDS.filter(id => id !== hostHeroId);
  let hash = 2166136261;
  for (const char of String(playerId || slot)) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return pool[Math.abs(hash) % pool.length] || hostHeroId;
}

export function modelUrl(heroId, lod = 1) {
  return `/assets/overlay-cinematic/models/${heroId}-lod${lod}.glb`;
}
