import { useEffect, useRef, useState } from 'react'
import { KINGDOM, mulberry32 } from '../config'
import { createWorldSocketClient } from './worldSocketClient'
import type { DataMode, KingdomState, Territory, ViewerTier } from '../types'

function pickTier(rng: () => number): ViewerTier {
  const r = rng()
  if (r < 0.45) return 'low'
  if (r < 0.78) return 'medium'
  if (r < 0.95) return 'high'
  return 'packed'
}

function buildInitialMockState(territories: Territory[], rng: () => number): Record<string, KingdomState> {
  const initial: Record<string, KingdomState> = {}
  territories.forEach((t) => {
    initial[t.id] = t.isLive ? { isLive: true, viewerTier: pickTier(rng) } : { isLive: false, viewerTier: 'off' }
  })
  return initial
}

// dataMode='mock': locally evolves each territory's live/viewer-tier state over time so
// the world reads as alive without a live DB -- used by /aetheris-preview for dev/QA.
// dataMode='live': subscribes to the real /aetheris-world socket namespace instead (see
// tiktokbr/services/worldSocket.js on the server side). Both effects below are
// unconditionally declared (stable hook order) and simply no-op for the inactive mode,
// so this stays one hook with one return shape regardless of which mode is active --
// dataMode never changes during a mounted instance's lifetime (set once from a DOM
// attribute in main.tsx), so this isn't a conditional-hook-call violation.
export function useKingdomState(
  territories: Territory[],
  seed: number,
  dataMode: DataMode,
): Record<string, KingdomState> {
  const rngRef = useRef(mulberry32(seed))
  const [state, setState] = useState<Record<string, KingdomState>>(() =>
    dataMode === 'mock' ? buildInitialMockState(territories, rngRef.current) : {},
  )

  useEffect(() => {
    if (dataMode !== 'mock') return
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
  }, [territories, dataMode])

  useEffect(() => {
    if (dataMode !== 'live') return
    const client = createWorldSocketClient()
    const unsubscribe = client.onKingdomState((territoryId, kingdomState) => {
      setState((prev) => {
        const current = prev[territoryId]
        if (current && current.isLive === kingdomState.isLive && current.viewerTier === kingdomState.viewerTier) {
          return prev
        }
        return { ...prev, [territoryId]: kingdomState }
      })
    })
    client.connect()
    return () => {
      unsubscribe()
      client.disconnect()
    }
  }, [dataMode])

  return state
}
