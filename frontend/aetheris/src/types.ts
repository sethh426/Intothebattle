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
  neighbors: string[]
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
  claimType?: 'home' | 'conquest'
  shieldUntil?: string | null
}

export interface WarClaim {
  territoryId: string
  claimType: 'home' | 'conquest'
  holderName: string
  isLive: boolean
  viewerTier: ViewerTier
  activeCount: number
  kills: number
  score: number
  shieldUntil: string | null
  claimedAt: string
}

export type WarCampaignPhase = 'mobilizing' | 'scoring' | 'deadline' | 'resolved' | 'withdrawn' | 'cancelled'

export interface WarCampaign {
  id: number
  territoryId: string
  originTerritoryId: string
  mode: 'pvp' | 'expedition'
  phase: WarCampaignPhase
  status: string
  attackerHandle: string
  defenderHandle: string
  declaredAt: string
  scoringStartsAt: string
  endsAt: string
  attackerWins: number
  defenderWins: number
}

export interface AetherisSeason {
  id: number
  key: string
  startsAt: string
  endsAt: string
  status: string
}

export interface AetherisWorldState {
  success: boolean
  serverTime: string
  season: AetherisSeason | null
  claims: Record<string, WarClaim>
  campaigns: WarCampaign[]
}

export interface CreatorHolding {
  territoryId: string
  claimType: 'home' | 'conquest'
  shieldUntil: string | null
  claimedAt: string
}

export interface CreatorWarRound {
  id: number
  roundNumber: number
  side: 'attacker' | 'defender'
  status: string
  score: number
  participantCount: number
  startedAt: string
  endsAt: string
}

export interface CreatorWarStatus {
  success: boolean
  season: AetherisSeason | null
  profile: {
    optedIn: boolean
    homeTerritoryId: string | null
    reentryAllowedAt: string | null
  }
  holdings: CreatorHolding[]
  activeCampaign: WarCampaign | null
  rounds: CreatorWarRound[]
  activeRound: {
    campaignId: number
    roundNumber: number
    side: 'attacker' | 'defender'
    endsAt: string
  } | null
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
