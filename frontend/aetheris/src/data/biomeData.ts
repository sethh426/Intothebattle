import type { Biome } from '../types'

// Biomes are arranged as latitude belts (north pole to south pole) rather than
// Voronoi-carved continents — see the Aetheris plan doc for why this is the v0.1/v0.2
// tradeoff. Belt widths are irregular by design, not proportional to landCount.
//
// Note: 'emerald-wilds' and 'crystal-basin' are renamed from the original v0.1 prototype's
// 'emerald-grasslands'/'crystal-lakes' to match the current Aetheris naming.
export const BIOMES: Biome[] = [
  {
    id: 'frozen-crown',
    name: 'Frozen Crown',
    isFlagship: true,
    landCount: 10,
    latBand: [72, 90],
    baseColor: '#b7efff',
    accentColor: '#55d8ff',
    particleProfileId: 'frozen-crown',
    terrainMaterial: { roughness: 0.25, metalness: 0.15 },
  },
  {
    id: 'thunder-highlands',
    name: 'Thunder Highlands',
    isFlagship: false,
    landCount: 5,
    latBand: [60, 72],
    baseColor: '#3430a4',
    accentColor: '#b7c7ff',
    particleProfileId: 'thunder-highlands',
    terrainMaterial: { roughness: 0.7, metalness: 0.2 },
  },
  {
    id: 'whispering-desert',
    name: 'Whispering Desert',
    isFlagship: false,
    landCount: 11,
    latBand: [42, 60],
    baseColor: '#a95d20',
    accentColor: '#ffd15c',
    particleProfileId: 'whispering-desert',
    terrainMaterial: { roughness: 0.85, metalness: 0.05 },
  },
  {
    id: 'ancient-jungle',
    name: 'Ancient Jungle',
    isFlagship: false,
    landCount: 13,
    latBand: [22, 42],
    baseColor: '#0f6c37',
    accentColor: '#66ff8d',
    particleProfileId: 'ancient-jungle',
    terrainMaterial: { roughness: 0.75, metalness: 0.05 },
  },
  {
    id: 'emerald-wilds',
    name: 'Emerald Wilds',
    isFlagship: false,
    landCount: 18,
    latBand: [-2, 22],
    baseColor: '#1f8f46',
    accentColor: '#b7ff82',
    particleProfileId: 'emerald-wilds',
    terrainMaterial: { roughness: 0.7, metalness: 0.05 },
  },
  {
    id: 'liquid-blu-metal-sea',
    name: 'Liquid Blu Metal Sea',
    isFlagship: true,
    landCount: 9,
    latBand: [-16, -2],
    baseColor: '#035d91',
    accentColor: '#39e4ff',
    particleProfileId: 'liquid-metal-sea',
    terrainMaterial: { roughness: 0.25, metalness: 0.85 },
  },
  {
    id: 'molten-wastes',
    name: 'Molten Wastes',
    isFlagship: true,
    landCount: 6,
    latBand: [-28, -16],
    baseColor: '#7e1f0b',
    accentColor: '#ff7a24',
    particleProfileId: 'molten-wastes',
    terrainMaterial: { roughness: 0.9, metalness: 0.1 },
  },
  {
    id: 'toxic-expanse',
    name: 'Toxic Expanse',
    isFlagship: false,
    landCount: 7,
    latBand: [-40, -28],
    baseColor: '#4d7313',
    accentColor: '#b6ff36',
    particleProfileId: 'toxic-expanse',
    terrainMaterial: { roughness: 0.6, metalness: 0.1 },
  },
  {
    id: 'crystal-basin',
    name: 'Crystal Basin',
    isFlagship: false,
    landCount: 8,
    latBand: [-54, -40],
    baseColor: '#006c9d',
    accentColor: '#8af6ff',
    particleProfileId: 'crystal-basin',
    terrainMaterial: { roughness: 0.2, metalness: 0.3 },
  },
  {
    id: 'void-scar',
    name: 'Void Scar',
    isFlagship: true,
    landCount: 13,
    latBand: [-90, -54],
    baseColor: '#210054',
    accentColor: '#c46bff',
    particleProfileId: 'void-scar',
    terrainMaterial: { roughness: 0.4, metalness: 0.4 },
  },
]

export const FLAGSHIP_BIOME_IDS: string[] = BIOMES.filter((b) => b.isFlagship).map((b) => b.id)

export function getBiomeById(id: string): Biome | undefined {
  return BIOMES.find((b) => b.id === id)
}

export function totalTerritoryCount(): number {
  return BIOMES.reduce((sum, b) => sum + b.landCount, 0)
}
