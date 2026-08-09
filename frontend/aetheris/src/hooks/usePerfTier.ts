import { useRef, useState } from 'react'
import { useFrame } from '@react-three/fiber'
import type { PerfTier } from '../types'

export const PARTICLE_TIER_FACTOR: Record<PerfTier, number> = { high: 1, medium: 0.6, low: 0.3 }

const TIER_RANK: Record<PerfTier, number> = { low: 0, medium: 1, high: 2 }

// Chrome-only, nonstandard API — not in the DOM lib types.
interface NavigatorWithDeviceMemory extends Navigator {
  deviceMemory?: number
}

// Instant heuristic from device signals, used before any frame has rendered so particle
// budgets can be set on the very first frame rather than waiting on an FPS sample.
function quickPerfTier(): PerfTier {
  const cores = navigator.hardwareConcurrency || 4
  const memory = (navigator as NavigatorWithDeviceMemory).deviceMemory || 4
  const width = window.innerWidth || 1024

  let score = 0
  if (cores >= 8) score += 2
  else if (cores >= 4) score += 1
  if (memory >= 8) score += 2
  else if (memory >= 4) score += 1
  if (width >= 1200) score += 1

  if (score >= 4) return 'high'
  if (score >= 2) return 'medium'
  return 'low'
}

function tierFromFps(fps: number): PerfTier {
  if (fps >= 50) return 'high'
  if (fps >= 30) return 'medium'
  return 'low'
}

function forcedPerfTier(): PerfTier | null {
  const value = new URLSearchParams(window.location.search).get('perf')
  return value === 'high' || value === 'medium' || value === 'low' ? value : null
}

// Samples real frame rate over the first ~1s of rendering and downgrades the quick
// heuristic's tier if it was too optimistic (never upgrades, to avoid oscillation).
export function usePerfTier(): PerfTier {
  const forcedTier = useRef(forcedPerfTier())
  const [tier, setTier] = useState<PerfTier>(() => forcedTier.current ?? quickPerfTier())
  const sample = useRef({ frames: 0, elapsed: 0, settled: Boolean(forcedTier.current) })

  useFrame((_, delta) => {
    const s = sample.current
    if (s.settled) return
    s.frames += 1
    s.elapsed += delta
    if (s.elapsed >= 1) {
      s.settled = true
      const measured = tierFromFps(s.frames / s.elapsed)
      setTier((current) => (TIER_RANK[measured] < TIER_RANK[current] ? measured : current))
    }
  })

  return tier
}
