import { useEffect, useMemo, useRef } from 'react'
import type { RefObject } from 'react'
import { useFrame } from '@react-three/fiber'
import { createFlagshipParticleSystems } from './flagshipBiomes'
import { createAmbientParticleSystems } from './ambientBiomes'
import { PARTICLE_TIER_FACTOR } from '../hooks/usePerfTier'
import { CAMERA } from '../config'
import type { PerfTier } from '../types'

interface ParticlesProps {
  tier: PerfTier
  paused: boolean
  // Current camera distance (see useCameraRig) — closer zoom bumps the density
  // multiplier since fewer territories are in view and the scene should feel denser
  // up close; zoomed out returns to the plain perf-tier baseline.
  zoomDistanceRef?: RefObject<number>
}

const MIN_LOD_FACTOR = 0.7
const MAX_LOD_FACTOR = 1.4
const REAPPLY_THRESHOLD = 0.05 // only call setActiveCount when the effective factor moves >5%

function zoomLodFactor(distance: number): number {
  const span = CAMERA.zoomMaxDistance - CAMERA.zoomMinDistance
  const t = span > 0 ? 1 - (distance - CAMERA.zoomMinDistance) / span : 0
  const clamped = Math.max(0, Math.min(1, t))
  return MAX_LOD_FACTOR - clamped * (MAX_LOD_FACTOR - MIN_LOD_FACTOR)
}

export default function Particles({ tier, paused, zoomDistanceRef }: ParticlesProps) {
  const systems = useMemo(() => [...createFlagshipParticleSystems(), ...createAmbientParticleSystems()], [])
  const pausedRef = useRef(paused)
  pausedRef.current = paused
  const lastAppliedFactorRef = useRef(1)

  function applyFactor(factor: number): void {
    systems.forEach(({ system }) => system.setActiveCount(Math.floor(system.count * factor)))
  }

  useEffect(() => {
    const tierFactor = PARTICLE_TIER_FACTOR[tier]
    const zoomFactor = zoomDistanceRef?.current != null ? zoomLodFactor(zoomDistanceRef.current) : 1
    const factor = tierFactor * zoomFactor
    lastAppliedFactorRef.current = factor
    applyFactor(factor)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [systems, tier])

  useFrame((_, delta) => {
    if (pausedRef.current) return
    systems.forEach(({ system }) => system.update(delta))

    if (zoomDistanceRef?.current == null) return
    const tierFactor = PARTICLE_TIER_FACTOR[tier]
    const factor = tierFactor * zoomLodFactor(zoomDistanceRef.current)
    const last = lastAppliedFactorRef.current
    if (last === 0 || Math.abs(factor - last) / last > REAPPLY_THRESHOLD) {
      lastAppliedFactorRef.current = factor
      applyFactor(factor)
    }
  })

  return (
    <>
      {systems.map(({ biomeId, system }) => (
        <primitive key={biomeId} object={system.points} />
      ))}
    </>
  )
}
