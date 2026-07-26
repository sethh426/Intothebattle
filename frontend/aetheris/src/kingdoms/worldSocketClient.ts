import type { KingdomState } from '../types'

// Placeholder client for the future `/aetheris-world` Socket.IO namespace
// (see the Aetheris plan's §4.6 real-data-binding section). Intentionally NOT
// connected to any real server yet -- v0.4 ships with useKingdomState's local
// mock simulator only. This file exists so that swapping in real viewer data
// later is a change to this module's internals, not a new integration surface
// or a change to what Territories.tsx/useKingdomState expect to consume.

export type KingdomStateListener = (territoryId: string, state: KingdomState) => void

export interface WorldSocketClient {
  connect(): void
  disconnect(): void
  onKingdomState(listener: KingdomStateListener): () => void
}

// Stub implementation: no network activity. connect()/disconnect() are no-ops,
// and onKingdomState listeners are stored but never invoked. Replace this
// factory's body with a real socket.io-client connection to `/aetheris-world`
// when real data binding ships (paused pending explicit go-ahead).
export function createWorldSocketClient(): WorldSocketClient {
  const listeners = new Set<KingdomStateListener>()
  return {
    connect() {},
    disconnect() {},
    onKingdomState(listener: KingdomStateListener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
