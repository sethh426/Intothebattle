import { io, type Socket } from 'socket.io-client'
import type { KingdomState } from '../types'

// Real client for the `/aetheris-world` Socket.IO namespace. The server sends one
// full `kingdomStateSnapshot` on connect, then periodic
// `kingdomStateUpdate` deltas -- this client normalizes both into the same
// per-territory `onKingdomState(territoryId, state)` callback shape.

export type KingdomStateListener = (territoryId: string, state: KingdomState) => void

export interface WorldSocketClient {
  connect(): void
  disconnect(): void
  onKingdomState(listener: KingdomStateListener): () => void
}

export function createWorldSocketClient(): WorldSocketClient {
  const listeners = new Set<KingdomStateListener>()
  let socket: Socket | null = null

  function emitAll(payload: Record<string, KingdomState>): void {
    Object.entries(payload).forEach(([territoryId, state]) => {
      listeners.forEach((listener) => listener(territoryId, state))
    })
  }

  return {
    connect() {
      if (socket) return
      socket = io('/aetheris-world', { transports: ['websocket', 'polling'] })
      socket.on('kingdomStateSnapshot', emitAll)
      socket.on('kingdomStateUpdate', emitAll)
    },
    disconnect() {
      socket?.disconnect()
      socket = null
    },
    onKingdomState(listener: KingdomStateListener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
