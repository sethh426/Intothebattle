import type { PerfTier } from './types'

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
  distance: 5.4,
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
