import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { BIOMES } from '../data/biomeData'
import { generateTerritories } from '../data/territoryData'
import { WORLD_SEED } from '../config'
import Planet from './Planet'
import Territories from './Territories'
import DayNightCycle from './DayNightCycle'
import Particles from '../particles/Particles'
import { useDragControls } from '../hooks/useDragControls'
import { usePerfTier } from '../hooks/usePerfTier'

interface SceneProps {
  reducedMotion: boolean
}

export default function Scene({ reducedMotion }: SceneProps) {
  const wrapperRef = useRef<THREE.Group>(null)
  const sunDirectionRef = useRef(new THREE.Vector3(0, 0, 1))
  const territories = useMemo(() => generateTerritories(BIOMES, WORLD_SEED), [])
  const tier = usePerfTier()
  const controls = useDragControls(wrapperRef)

  useEffect(() => {
    controls.setMotionEnabled(!reducedMotion)
  }, [controls, reducedMotion])

  return (
    <group ref={wrapperRef}>
      <Planet biomes={BIOMES} />
      <Territories territories={territories} wrapperRef={wrapperRef} sunDirectionRef={sunDirectionRef} />
      <Particles tier={tier} paused={reducedMotion} />
      <DayNightCycle wrapperRef={wrapperRef} sunDirectionRef={sunDirectionRef} paused={reducedMotion} />
    </group>
  )
}
