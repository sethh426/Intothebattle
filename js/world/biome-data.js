// Biomes are arranged as latitude belts (north pole to south pole) rather than
// Voronoi-carved continents — see plan doc for why this is the phase-1 tradeoff.
// Belt widths are irregular by design, not proportional to landCount.
export const BIOMES = [
  {
    id: 'frozen-crown',
    name: 'Frozen Crown',
    isFlagship: true,
    landCount: 10,
    latBand: [72, 90],
    baseColor: '#cfe8ff',
    accentColor: '#8fd6ff',
    particleProfileId: 'frozen-crown',
    terrainMaterial: { roughness: 0.25, metalness: 0.15 },
  },
  {
    id: 'thunder-highlands',
    name: 'Thunder Highlands',
    isFlagship: false,
    landCount: 5,
    latBand: [60, 72],
    baseColor: '#3a3f52',
    accentColor: '#9db4ff',
    particleProfileId: 'thunder-highlands',
    terrainMaterial: { roughness: 0.7, metalness: 0.2 },
  },
  {
    id: 'whispering-desert',
    name: 'Whispering Desert',
    isFlagship: false,
    landCount: 11,
    latBand: [42, 60],
    baseColor: '#6b4a2a',
    accentColor: '#ffcf7a',
    particleProfileId: 'whispering-desert',
    terrainMaterial: { roughness: 0.85, metalness: 0.05 },
  },
  {
    id: 'ancient-jungle',
    name: 'Ancient Jungle',
    isFlagship: false,
    landCount: 13,
    latBand: [22, 42],
    baseColor: '#234d2f',
    accentColor: '#7be08a',
    particleProfileId: 'ancient-jungle',
    terrainMaterial: { roughness: 0.75, metalness: 0.05 },
  },
  {
    id: 'emerald-grasslands',
    name: 'Emerald Grasslands',
    isFlagship: false,
    landCount: 18,
    latBand: [-2, 22],
    baseColor: '#2e6b3e',
    accentColor: '#a8e6a1',
    particleProfileId: 'emerald-grasslands',
    terrainMaterial: { roughness: 0.7, metalness: 0.05 },
  },
  {
    id: 'liquid-blu-metal-sea',
    name: 'Liquid Blu Metal Sea',
    isFlagship: true,
    landCount: 9,
    latBand: [-16, -2],
    baseColor: '#1c3a52',
    accentColor: '#3fd0ff',
    particleProfileId: 'liquid-metal-sea',
    terrainMaterial: { roughness: 0.25, metalness: 0.85 },
  },
  {
    id: 'molten-wastes',
    name: 'Molten Wastes',
    isFlagship: true,
    landCount: 6,
    latBand: [-28, -16],
    baseColor: '#3a1408',
    accentColor: '#ff6a2b',
    particleProfileId: 'molten-wastes',
    terrainMaterial: { roughness: 0.9, metalness: 0.1 },
  },
  {
    id: 'toxic-expanse',
    name: 'Toxic Expanse',
    isFlagship: false,
    landCount: 7,
    latBand: [-40, -28],
    baseColor: '#2a3d1a',
    accentColor: '#9dff5c',
    particleProfileId: 'toxic-expanse',
    terrainMaterial: { roughness: 0.6, metalness: 0.1 },
  },
  {
    id: 'crystal-lakes',
    name: 'Crystal Lakes',
    isFlagship: false,
    landCount: 8,
    latBand: [-54, -40],
    baseColor: '#1a3a4a',
    accentColor: '#7ee8ff',
    particleProfileId: 'crystal-lakes',
    terrainMaterial: { roughness: 0.2, metalness: 0.3 },
  },
  {
    id: 'void-scar',
    name: 'Void Scar',
    isFlagship: true,
    landCount: 13,
    latBand: [-90, -54],
    baseColor: '#170826',
    accentColor: '#b26bff',
    particleProfileId: 'void-scar',
    terrainMaterial: { roughness: 0.4, metalness: 0.4 },
  },
];

export const FLAGSHIP_BIOME_IDS = BIOMES.filter(b => b.isFlagship).map(b => b.id);

export function getBiomeById(id) {
  return BIOMES.find(b => b.id === id);
}

export function totalTerritoryCount() {
  return BIOMES.reduce((sum, b) => sum + b.landCount, 0);
}
