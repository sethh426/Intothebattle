import { useEffect, useRef, useState } from 'react'
import { KINGDOM, mulberry32 } from '../config'
import type { KingdomState, Territory, ViewerTier } from '../types'

function pickTier(rng: () => number): ViewerTier {
  const r = rng()
  if (r < 0.45) return 'low'
  if (r < 0.78) return 'medium'
  if (r < 0.95) return 'high'
  return 'packed'
}

// Mock kingdom-state simulator: locally evolves each territory's live/viewer-tier
// state over time so the world reads as alive before any real socket data exists.
// A later phase swaps this hook's internals for `worldSocketClient` events --
// the returned Record<territoryId, KingdomState> shape stays the same, so
// consumers (Territories.tsx) don't need to change when that swap happens.
export function useKingdomState(territories: Territory[], seed: number): Record<string, KingdomState> {
  const rngRef = useRef(mulberry32(seed))
  const [state, setState] = useState<Record<string, KingdomState>>(() => {
    const rng = rngRef.current
    const initial: Record<string, KingdomState> = {}
    territories.forEach((t) => {
      initial[t.id] = t.isLive ? { isLive: true, viewerTier: pickTier(rng) } : { isLive: false, viewerTier: 'off' }
    })
    return initial
  })

  useEffect(() => {
    const interval = setInterval(() => {
      const rng = rngRef.current
      setState((prev) => {
        let changed = false
        const next: Record<string, KingdomState> = { ...prev }
        territories.forEach((t) => {
          const current = prev[t.id]
          if (!current) return
          if (rng() < KINGDOM.toggleLiveChance) {
            changed = true
            next[t.id] = current.isLive
              ? { isLive: false, viewerTier: 'off' }
              : { isLive: true, viewerTier: pickTier(rng) }
            return
          }
          if (current.isLive && rng() < KINGDOM.tierChangeChance) {
            changed = true
            next[t.id] = { isLive: true, viewerTier: pickTier(rng) }
          }
        })
        return changed ? next : prev
      })
    }, KINGDOM.simTickSeconds * 1000)
    return () => clearInterval(interval)
  }, [territories])

  return state
}
