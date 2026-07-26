import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { BIOMES } from '../data/biomeData'
import { generateTerritories } from '../data/territoryData'
import { WORLD_SEED } from '../config'
import Planet from './Planet'
import Territories from './Territories'
import DayNightCycle from './DayNightCycle'
import Atmosphere from './Atmosphere'
import Clouds from './Clouds'
import Starfield from './Starfield'
import Particles from '../particles/Particles'
import { useDragControls } from '../hooks/useDragControls'
import { usePerfTier } from '../hooks/usePerfTier'
import { useCameraRig } from '../hooks/useCameraRig'

interface SceneProps {
  reducedMotion: boolean
}

export default function Scene({ reducedMotion }: SceneProps) {
  const wrapperRef = useRef<THREE.Group>(null)
  const sunDirectionRef = useRef(new THREE.Vector3(0, 0, 1))
  const territories = useMemo(() => generateTerritories(BIOMES, WORLD_SEED), [])
  const tier = usePerfTier()
  const controls = useDragControls(wrapperRef)
  const cameraRig = useCameraRig(reducedMotion)

  useEffect(() => {
    controls.setMotionEnabled(!reducedMotion)
  }, [controls, reducedMotion])

  return (
    <>
      <Starfield tier={tier} />
      <group ref={wrapperRef}>
        <Planet biomes={BIOMES} />
        <Territories
          territories={territories}
          wrapperRef={wrapperRef}
          sunDirectionRef={sunDirectionRef}
          flashRef={cameraRig.flashRef}
        />
        <Clouds introOpacityRef={cameraRig.introOpacityRef} />
        <Atmosphere introOpacityRef={cameraRig.introOpacityRef} />
        <Particles tier={tier} paused={reducedMotion} zoomDistanceRef={cameraRig.zoomDistanceRef} />
        <DayNightCycle wrapperRef={wrapperRef} sunDirectionRef={sunDirectionRef} paused={reducedMotion} />
      </group>
    </>
  )
}
