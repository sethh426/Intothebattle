import type {
  BiomeStructureKit,
  KingdomState,
  LandmarkAssetSpec,
  StructureStage,
  Territory,
} from '../types'
import geography from './geographyLayout.json'

const MODEL_URLS = import.meta.glob<string>(
  [
    '../assets/aetheris/models/*.glb',
    '../assets/aetheris/models/heroes/*.glb',
  ],
  { eager: true, query: '?url', import: 'default' },
)

function modelUrl(relativePath: string): string {
  const key = `../assets/aetheris/models/${relativePath}`
  const url = MODEL_URLS[key]
  if (!url) throw new Error(`Aetheris model is missing from the build: ${relativePath}`)
  return url
}

function heroSpec(
  biomeId: string,
  scale: number,
  yaw: number,
  animationProfile: LandmarkAssetSpec['animationProfile'],
  materialProfile: LandmarkAssetSpec['materialProfile'],
): LandmarkAssetSpec {
  const [lat, lon] = geography.biomes[biomeId as keyof typeof geography.biomes].capital
  return {
    biomeId,
    lodUrls: [
      modelUrl(`heroes/${biomeId}-lod0.glb`),
      modelUrl(`heroes/${biomeId}-lod1.glb`),
      modelUrl(`heroes/${biomeId}-lod2.glb`),
    ],
    lat,
    lon,
    scale,
    yaw,
    animationProfile,
    materialProfile,
  }
}

export const LANDMARK_CATALOG: readonly LandmarkAssetSpec[] = [
  heroSpec('frozen-crown', 0.21, 0.24, 'beacon', 'ice'),
  heroSpec('thunder-highlands', 0.21, -0.4, 'storm', 'storm'),
  heroSpec('whispering-desert', 0.22, 0.18, 'sand', 'desert'),
  heroSpec('ancient-jungle', 0.21, -0.3, 'foliage', 'jungle'),
  heroSpec('emerald-wilds', 0.21, 0.42, 'foliage', 'wilds'),
  heroSpec('liquid-blu-metal-sea', 0.22, -0.16, 'magnetic', 'metal'),
  heroSpec('molten-wastes', 0.21, 0.36, 'molten', 'molten'),
  heroSpec('toxic-expanse', 0.21, -0.22, 'toxic', 'toxic'),
  heroSpec('crystal-basin', 0.21, 0.28, 'crystal', 'crystal'),
  heroSpec('void-scar', 0.21, -0.34, 'void', 'void'),
]

function nodeSlug(biomeId: string): string {
  return biomeId.replaceAll('-', '_').toUpperCase()
}

function structureKit(biomeId: string): BiomeStructureKit {
  const slug = nodeSlug(biomeId)
  const variant = (index: number): readonly [string, string, string] => [
    `STRONGHOLD_${slug}_V${index}_BASE`,
    `STRONGHOLD_${slug}_V${index}_LIVE`,
    `STRONGHOLD_${slug}_V${index}_APEX`,
  ]
  return {
    biomeId,
    regionalNodes: [
      `REGION_${slug}_GATE`,
      `REGION_${slug}_SHRINE`,
      `REGION_${slug}_RUIN`,
    ],
    strongholdNodes: [variant(0), variant(1), variant(2)],
    ambientNode: `PROP_${slug}`,
  }
}

export const BIOME_STRUCTURE_KITS: readonly BiomeStructureKit[] = LANDMARK_CATALOG.map(({ biomeId }) =>
  structureKit(biomeId),
)

export const REGIONAL_PACK_URL = modelUrl('regional-monuments.glb')
export const STRONGHOLD_PACK_URL = modelUrl('stronghold-kit.glb')
export const AMBIENT_PACK_URL = modelUrl('ambient-clusters.glb')

export const STRUCTURE_STAGE_RANK: Record<StructureStage, number> = {
  ruin: 0,
  claimed: 1,
  live: 2,
  high: 3,
  packed: 4,
}

export function deriveStructureStage(state: KingdomState | undefined): StructureStage {
  if (!state?.isClaimed && !state?.isLive) return 'ruin'
  if (!state.isLive) return 'claimed'
  if (state.viewerTier === 'packed') return 'packed'
  if (state.viewerTier === 'high') return 'high'
  return 'live'
}

const SIZE_RANK = { large: 0, medium: 1, small: 2 } as const

export function selectRegionalTerritories(
  territories: readonly Territory[],
  biomeId: string,
): readonly Territory[] {
  return territories
    .filter((territory) => territory.biomeId === biomeId)
    .sort((left, right) => {
      const sizeDifference = SIZE_RANK[left.sizeClass] - SIZE_RANK[right.sizeClass]
      return sizeDifference || left.seed - right.seed
    })
    .slice(0, 3)
}

export function strongholdVariant(territory: Territory): 0 | 1 | 2 {
  return Math.abs(territory.seed % 3) as 0 | 1 | 2
}
