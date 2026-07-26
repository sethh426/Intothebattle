import { useEffect, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { createFlagshipParticleSystems } from './flagshipBiomes'
import { createAmbientParticleSystems } from './ambientBiomes'
import { PARTICLE_TIER_FACTOR } from '../hooks/usePerfTier'
import type { PerfTier } from '../types'

interface ParticlesProps {
  tier: PerfTier
  paused: boolean
}

export default function Particles({ tier, paused }: ParticlesProps) {
  const systems = useMemo(() => [...createFlagshipParticleSystems(), ...createAmbientParticleSystems()], [])
  const pausedRef = useRef(paused)
  pausedRef.current = paused

  useEffect(() => {
    const factor = PARTICLE_TIER_FACTOR[tier]
    systems.forEach(({ system }) => system.setActiveCount(Math.floor(system.count * factor)))
  }, [systems, tier])

  useFrame((_, delta) => {
    if (pausedRef.current) return
    systems.forEach(({ system }) => system.update(delta))
  })

  return (
    <>
      {systems.map(({ biomeId, system }) => (
        <primitive key={biomeId} object={system.points} />
      ))}
    </>
  )
}
