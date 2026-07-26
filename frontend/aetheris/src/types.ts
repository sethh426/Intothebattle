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

export interface LatLon {
  lat: number
  lon: number
}
