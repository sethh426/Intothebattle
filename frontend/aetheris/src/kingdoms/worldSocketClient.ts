import { io, type Socket } from 'socket.io-client'
import type { AetherisWorldState, KingdomState, WorldConnectionStatus } from '../types'

// Real client for the `/aetheris-world` Socket.IO namespace. The server sends one
// full `kingdomStateSnapshot` on connect, then periodic
// `kingdomStateUpdate` deltas -- this client normalizes both into the same
// per-territory `onKingdomState(territoryId, state)` callback shape.

export type KingdomStateListener = (territoryId: string, state: KingdomState) => void
export type WorldStateListener = (state: AetherisWorldState) => void
export type ConnectionStatusListener = (status: WorldConnectionStatus) => void

export interface WorldSocketClient {
  connect(): void
  disconnect(): void
  onKingdomState(listener: KingdomStateListener): () => void
  onWorldState(listener: WorldStateListener): () => void
  onConnectionStatus(listener: ConnectionStatusListener): () => void
}

export function createWorldSocketClient(): WorldSocketClient {
  const listeners = new Set<KingdomStateListener>()
  const worldListeners = new Set<WorldStateListener>()
  const statusListeners = new Set<ConnectionStatusListener>()
  let socket: Socket | null = null

  function emitAll(payload: Record<string, KingdomState>): void {
    Object.entries(payload).forEach(([territoryId, state]) => {
      listeners.forEach((listener) => listener(territoryId, state))
    })
  }

  function emitWorld(payload: AetherisWorldState): void {
    if (!payload || typeof payload !== 'object') return
    worldListeners.forEach((listener) => listener(payload))
    const kingdomStates: Record<string, KingdomState> = {}
    Object.entries(payload.claims || {}).forEach(([territoryId, claim]) => {
      kingdomStates[territoryId] = {
        isClaimed: true,
        isLive: Boolean(claim.isLive),
        viewerTier: claim.viewerTier || 'off',
        holderName: claim.holderName,
        activeCount: claim.activeCount,
        kills: claim.kills,
        score: claim.score,
        claimType: claim.claimType,
        shieldUntil: claim.shieldUntil,
      }
    })
    emitAll(kingdomStates)
  }

  function emitStatus(status: WorldConnectionStatus): void {
    statusListeners.forEach((listener) => listener(status))
  }

  return {
    connect() {
      if (socket) return
      socket = io('/aetheris-world', { transports: ['websocket', 'polling'] })
      emitStatus('connecting')
      socket.on('connect', () => emitStatus('connected'))
      socket.on('disconnect', (reason) => emitStatus(reason === 'io client disconnect' ? 'offline' : 'reconnecting'))
      socket.io.on('reconnect_attempt', () => emitStatus('reconnecting'))
      socket.io.on('reconnect_failed', () => emitStatus('offline'))
      socket.on('connect_error', () => emitStatus('reconnecting'))
      socket.on('worldStateSnapshot', emitWorld)
      socket.on('worldStateUpdate', emitWorld)
      socket.on('kingdomStateSnapshot', emitAll)
      socket.on('kingdomStateUpdate', emitAll)
    },
    disconnect() {
      socket?.disconnect()
      socket = null
      emitStatus('offline')
    },
    onKingdomState(listener: KingdomStateListener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    onWorldState(listener: WorldStateListener) {
      worldListeners.add(listener)
      return () => worldListeners.delete(listener)
    },
    onConnectionStatus(listener: ConnectionStatusListener) {
      statusListeners.add(listener)
      return () => statusListeners.delete(listener)
    },
  }
}
