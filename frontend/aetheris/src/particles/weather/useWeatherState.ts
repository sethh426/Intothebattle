import { useEffect, useRef } from 'react'
import type { RefObject } from 'react'
import { useFrame } from '@react-three/fiber'
import { mulberry32, WEATHER } from '../../config'
import type { WeatherMode, WeatherState } from '../../types'

const ADJACENT: Record<WeatherMode, WeatherMode[]> = {
  calm: ['active'],
  active: ['calm', 'storm'],
  storm: ['active'],
}

function pickAdjacent(mode: WeatherMode, rng: () => number): WeatherMode {
  const options = ADJACENT[mode]
  return options[Math.floor(rng() * options.length)]
}

// Mock weather simulator: locally evolves each biome's mode/intensity over time so
// the world reads as alive with atmosphere before any real weather data exists.
// Returns a ref (not React state) -- the only consumer is Particles.tsx's per-frame
// loop, and there's no weather HUD/tooltip in scope needing a reactive re-render
// (contrast with useKingdomState, which correctly uses setState for Territories.tsx's
// hover tooltip).
export function useWeatherState(
  biomeIds: string[],
  seed: number,
  paused: boolean,
): RefObject<Record<string, WeatherState>> {
  const pausedRef = useRef(paused)
  pausedRef.current = paused

  const stateRef = useRef<Record<string, WeatherState>>(
    (() => {
      const initial: Record<string, WeatherState> = {}
      biomeIds.forEach((id) => {
        initial[id] = { mode: 'calm', intensity: 0 }
      })
      return initial
    })(),
  )

  const rngRef = useRef(mulberry32(seed))

  useEffect(() => {
    const interval = setInterval(() => {
      if (pausedRef.current) return
      const rng = rngRef.current
      biomeIds.forEach((id) => {
        if (rng() < WEATHER.modeShiftChance) {
          const current = stateRef.current[id]
          stateRef.current[id] = { ...current, mode: pickAdjacent(current.mode, rng) }
        }
      })
    }, WEATHER.tickSeconds * 1000)
    return () => clearInterval(interval)
  }, [biomeIds])

  useFrame((_, delta) => {
    if (pausedRef.current) return
    const maxStep = WEATHER.intensityLerpPerSecond * delta
    biomeIds.forEach((id) => {
      const entry = stateRef.current[id]
      const target = WEATHER.modeIntensity[entry.mode]
      if (entry.intensity < target) {
        entry.intensity = Math.min(target, entry.intensity + maxStep)
      } else if (entry.intensity > target) {
        entry.intensity = Math.max(target, entry.intensity - maxStep)
      }
    })
  })

  return stateRef
}
