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
  creatorName: string
  isLive: boolean
  colorHex: string
  seed: number
}

export interface ShapeFootprint {
  outer: Array<[number, number]>
  holes: Array<Array<[number, number]>>
}

export type PerfTier = 'high' | 'medium' | 'low'

// off = not live. The other four are viewer-count buckets that drive kingdom
// visual escalation (glow intensity, banner scale) once a territory goes live.
export type ViewerTier = 'off' | 'low' | 'medium' | 'high' | 'packed'

export interface KingdomState {
  isLive: boolean
  viewerTier: ViewerTier
}

export interface LatLon {
  lat: number
  lon: number
}
