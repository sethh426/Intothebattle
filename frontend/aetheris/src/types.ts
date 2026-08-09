export interface TerrainMaterial {
  roughness: number
  metalness: number
}

export interface Biome {
  id: string
  name: string
  isFlagship: boolean
  landCount: number
  latBand: [number, number]
  baseColor: string
  accentColor: string
  particleProfileId: string
  terrainMaterial: TerrainMaterial
}

export type SizeClass = 'small' | 'medium' | 'large'

export interface Territory {
  id: string
  biomeId: string
  shapeId: string
  sizeClass: SizeClass
  lat: number
  lon: number
  angularRadius: number
  rotation: number
  territoryName: string
  isLive: boolean
  colorHex: string
  seed: number
}

export interface ShapeFootprint {
  outer: Array<[number, number]>
  holes: Array<Array<[number, number]>>
}

export type PerfTier = 'high' | 'medium' | 'low'

export type StructureStage = 'ruin' | 'claimed' | 'live' | 'high' | 'packed'

export interface LandmarkAssetSpec {
  biomeId: string
  lodUrls: readonly [string, string, string]
  lat: number
  lon: number
  scale: number
  yaw: number
  animationProfile: 'beacon' | 'storm' | 'sand' | 'foliage' | 'magnetic' | 'molten' | 'toxic' | 'crystal' | 'void'
  materialProfile: 'ice' | 'storm' | 'desert' | 'jungle' | 'wilds' | 'metal' | 'molten' | 'toxic' | 'crystal' | 'void'
}

export interface BiomeStructureKit {
  biomeId: string
  regionalNodes: readonly [string, string, string]
  strongholdNodes: readonly [
    readonly [string, string, string],
    readonly [string, string, string],
    readonly [string, string, string],
  ]
  ambientNode: string
}

// off = not live. The other four are viewer-count buckets that drive kingdom
// visual escalation (glow intensity, banner scale) once a territory goes live.
export type ViewerTier = 'off' | 'low' | 'medium' | 'high' | 'packed'

export interface KingdomState {
  isClaimed?: boolean
  isLive: boolean
  viewerTier: ViewerTier
  holderName?: string
  roomId?: string
  activeCount?: number
  kills?: number
  score?: number
}

// 'mock' -- local deterministic simulator (dev/QA, used by /aetheris-preview).
// 'live' -- real /aetheris-world socket namespace (production home.html).
export type DataMode = 'mock' | 'live'

export type WorldFraming = 'hero' | 'wide'

// Weather is atmospheric/regional, not viewer-driven -- calm is the "nothing happening"
// baseline, active/storm build and dissipate through adjacent-step transitions only.
export type WeatherMode = 'calm' | 'active' | 'storm'

export interface WeatherState {
  mode: WeatherMode
  intensity: number // 0-1, smoothed toward WEATHER.modeIntensity[mode] each frame
}

export interface LatLon {
  lat: number
  lon: number
}
