import { useEffect, useMemo, useRef } from 'react'
import type { RefObject } from 'react'
import { useFrame } from '@react-three/fiber'
import { createFlagshipParticleSystems } from './flagshipBiomes'
import { createAmbientParticleSystems } from './ambientBiomes'
import { useWeatherState } from './weather/useWeatherState'
import { PARTICLE_TIER_FACTOR } from '../hooks/usePerfTier'
import { CAMERA, WEATHER, WORLD_SEED } from '../config'
import { BIOMES } from '../data/biomeData'
import type { PerfTier, WeatherState } from '../types'

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

const DEFAULT_WEATHER: WeatherState = { mode: 'calm', intensity: 0 }

export default function Particles({ tier, paused, zoomDistanceRef }: ParticlesProps) {
  const systems = useMemo(() => [...createFlagshipParticleSystems(), ...createAmbientParticleSystems()], [])
  const pausedRef = useRef(paused)
  pausedRef.current = paused
  // territory-state-mirroring pattern used elsewhere (Territories.tsx): one entry per
  // biome id, only touched when that biome's effective density actually moves >5%.
  const lastAppliedDensityRef = useRef(new Map<string, number>())
  const weatherStateRef = useWeatherState(
    useMemo(() => BIOMES.map((b) => b.id), []),
    WORLD_SEED + 2,
    paused,
  )

  useEffect(() => {
    const tierFactor = PARTICLE_TIER_FACTOR[tier]
    const zoomFactor = zoomDistanceRef?.current != null ? zoomLodFactor(zoomDistanceRef.current) : 1
    const globalFactor = tierFactor * zoomFactor
    systems.forEach(({ biomeId, system }) => {
      lastAppliedDensityRef.current.set(biomeId, globalFactor)
      system.setActiveCount(Math.floor(system.count * globalFactor))
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [systems, tier])

  useFrame((_, delta) => {
    if (pausedRef.current) return
    systems.forEach(({ system }) => system.update(delta))

    const tierFactor = PARTICLE_TIER_FACTOR[tier]
    const zoomFactor = zoomDistanceRef?.current != null ? zoomLodFactor(zoomDistanceRef.current) : 1
    const globalFactor = tierFactor * zoomFactor

    systems.forEach(({ biomeId, system }) => {
      const weather = weatherStateRef.current[biomeId] ?? DEFAULT_WEATHER
      system.setSizeScale(1 + weather.intensity * WEATHER.sizeBoostMax)
      system.setColorBoost(1 + weather.intensity * WEATHER.colorBoostMax)

      const density = globalFactor * (1 + weather.intensity * WEATHER.densityBoostMax)
      const last = lastAppliedDensityRef.current.get(biomeId) ?? 0
      if (last === 0 || Math.abs(density - last) / last > REAPPLY_THRESHOLD) {
        lastAppliedDensityRef.current.set(biomeId, density)
        system.setActiveCount(Math.floor(system.count * density))
      }
    })
  })

  return (
    <>
      {systems.map(({ biomeId, system }) => (
        <primitive key={biomeId} object={system.points} />
      ))}
    </>
  )
}
