import type { PerfTier, ViewerTier } from './types'

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
  introDistance: 18, // deep-space starting distance for the opening cinematic dolly-in
  introDurationSeconds: 2.8,
  zoomMinDistance: 2.8, // close but stays outside the atmosphere shell
  zoomMaxDistance: 6.2, // a bit beyond restDistance, for a little zoom-out headroom
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
