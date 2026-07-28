import type { PerfTier, ViewerTier, WeatherMode } from './types'

function readCssVar(name: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return value || fallback
}

export const PALETTE = {
  gold: readCssVar('--gold', '#ffdf8a'),
  blue: readCssVar('--blue', '#3fd0ff'),
  panel: readCssVar('--panel', '#141824'),
  ink: readCssVar('--ink', '#dce6f6'),
}

export const CAMERA = {
  fov: 42,
  near: 0.1,
  far: 100,
  restDistance: 5.4, // where the camera settles after the intro dolly, and the default zoom level
  wideRestDistance: 6.9, // full-page /world framing: keep the atmosphere inside the viewport
  introDistance: 18, // deep-space starting distance for the opening cinematic dolly-in
  introDurationSeconds: 2.8,
  zoomMinDistance: 2.8, // close but stays outside the atmosphere shell
  zoomMaxDistance: 6.2, // a bit beyond restDistance, for a little zoom-out headroom
  wideZoomMinDistance: 3.2,
  wideZoomMaxDistance: 7.6,
}

export const ROTATION = {
  autoRotateRadiansPerSecond: (Math.PI * 2) / 90, // one full turn per ~90s
  dragSensitivity: 0.0045,
  pitchClampRadians: Math.PI / 3, // +/-60deg
  inertiaDamping: 0.92,
  inertiaStopThreshold: 0.00005,
  idleResumeDelaySeconds: 2.5,
}

export const PLANET = {
  radius: 2,
  icosahedronDetail: 5,
}

// Total live particle budget across all systems, scaled down per perf tier.
export const PARTICLE_BUDGET: Record<PerfTier, number> = {
  high: 6000,
  medium: 3600,
  low: 1800,
}

export const TERRITORY = {
  totalCount: 100,
  liveFraction: 0.15,
  minAngularSeparation: 0.09, // radians, rejection-sampling spacing between territory centers
}

export const DAY_NIGHT = {
  cycleSeconds: 70, // slow enough to read as majestic, fast enough a visitor sees it move
  orbitRadius: 6,
  orbitTiltRadians: 0.35,
  nightLiveBoost: 1.9, // color multiplier applied to a live territory's dark-side instance color
}

export const ATMOSPHERE = {
  radiusScale: 1.18, // relative to PLANET.radius -- must comfortably clear the tallest landmark
  color: '#5fb8ff',
  glowPower: 2.5, // Fresnel falloff exponent
}

export const CLOUDS = {
  radiusScale: 1.02,
  color: '#f4f8ff',
  baseOpacity: 0.55,
  driftRadiansPerSecond: 0.008, // independent extra rotation on top of the shared wrapper's drag/auto-rotate
}

export const STARFIELD: Record<PerfTier, number> = {
  high: 6000,
  medium: 3500,
  low: 1800,
}

// Mock kingdom-state simulator tuning (see kingdoms/useKingdomState.ts). Real
// viewer data replaces this simulator in a later phase without changing these
// escalation buckets -- they describe the visual language, not the data source.
export const KINGDOM = {
  simTickSeconds: 4,
  toggleLiveChance: 0.04, // per-tick chance a given territory flips live/offline
  tierChangeChance: 0.35, // per-tick chance a live territory's viewer tier shifts
  colorBoost: {
    off: 1,
    low: 1,
    medium: 1.25,
    high: 1.6,
    packed: 2.1,
  } as Record<ViewerTier, number>,
  scaleBoost: {
    off: 1,
    low: 1,
    medium: 1.15,
    high: 1.35,
    packed: 1.6,
  } as Record<ViewerTier, number>,
  // Kingdom silhouettes (v0.5): a small spire accent that only appears at high/packed
  // tiers, lifted above the tallest possible escalated footprint (EXTRUDE_DEPTH=0.05 *
  // scaleBoost.packed=1.6 / 2 ~= 0.04) so it never clips into the stretched footprint.
  silhouetteLift: 0.06,
  silhouetteRadiusFactor: 0.18,
  silhouetteHeightFactor: 0.9,
  silhouetteHeightBoost: {
    high: 1,
    packed: 1.4,
  } as Record<'high' | 'packed', number>,
}

// Per-region weather state machine (v0.5) -- independent of KINGDOM's tick, since
// weather is atmospheric/regional, not tied to whether a creator is live.
export const WEATHER = {
  tickSeconds: 20,
  modeShiftChance: 0.12, // per-tick, per-biome chance to step to an adjacent mode
  intensityLerpPerSecond: 0.15, // ~7s full transition -- builds/dissipates, never snaps
  modeIntensity: {
    calm: 0,
    active: 0.55,
    storm: 1,
  } as Record<WeatherMode, number>,
  densityBoostMax: 0.6,
  sizeBoostMax: 0.5,
  colorBoostMax: 0.25,
  // Some biomes read better as a storm darkens them (murk/ash) rather than the default
  // brighten -- flips colorFactor's sign for these biome ids only.
  darkensBiomeIds: ['toxic-expanse', 'void-scar'] as string[],
}

// Frozen Crown's aurora: an ambient sky phenomenon, not a weather mode -- always
// present at low density, unrelated to storm/calm state (it isn't keyed to a real
// biome id, so the weather system's per-biome lookup naturally skips it).
export const AURORA = {
  count: 260,
  radiusMinScale: 1.22, // relative to PLANET.radius -- clears the atmosphere shell (1.18)
  radiusMaxScale: 1.42,
  latBand: [72, 90] as [number, number], // matches Frozen Crown's own band
  colors: ['#7bffb0', '#9a6bff', '#5fd6ff'],
  driftRadiansPerSecond: 0.02,
}

export const WORLD_SEED = 918273645

// Deterministic PRNG (mulberry32) so the generated world is stable across reloads.
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return function next(): number {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
