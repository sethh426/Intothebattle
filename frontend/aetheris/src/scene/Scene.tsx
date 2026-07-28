import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { BIOMES } from '../data/biomeData'
import { ATMOSPHERE, CAMERA, PLANET } from '../config'
import Planet from './Planet'
import Territories from './Territories'
import Landmarks from './Landmarks'
import KingdomSilhouettes from './KingdomSilhouettes'
import DayNightCycle from './DayNightCycle'
import Atmosphere from './Atmosphere'
import Clouds from './Clouds'
import Starfield from './Starfield'
import Particles from '../particles/Particles'
import { useDragControls } from '../hooks/useDragControls'
import { usePerfTier } from '../hooks/usePerfTier'
import { useCameraRig } from '../hooks/useCameraRig'
import { useWorldAnalytics } from '../hooks/useWorldAnalytics'
import type { KingdomState, Territory, WorldFraming } from '../types'

interface SceneProps {
  reducedMotion: boolean
  framing: WorldFraming
  isVisible: boolean
  territories: Territory[]
  kingdomState: Record<string, KingdomState>
  selectedTerritoryId: string | null
  onTerritorySelect: (territoryId: string) => void
}

export default function Scene({
  reducedMotion,
  framing,
  isVisible,
  territories,
  kingdomState,
  selectedTerritoryId,
  onTerritorySelect,
}: SceneProps) {
  const wrapperRef = useRef<THREE.Group>(null)
  const sunDirectionRef = useRef(new THREE.Vector3(0, 0, 1))
  const tier = usePerfTier()
  const controls = useDragControls(wrapperRef)
  const cameraRig = useCameraRig(reducedMotion, framing === 'wide'
    ? {
        restDistance: CAMERA.wideRestDistance,
        zoomMinDistance: CAMERA.wideZoomMinDistance,
        zoomMaxDistance: CAMERA.wideZoomMaxDistance,
        fitRadius: PLANET.radius * ATMOSPHERE.radiusScale * 1.04,
      }
    : undefined)
  useWorldAnalytics({ isVisible, introOpacityRef: cameraRig.introOpacityRef })

  useEffect(() => {
    controls.setMotionEnabled(!reducedMotion)
  }, [controls, reducedMotion])

  return (
    <>
      <Starfield tier={tier} />
      <group ref={wrapperRef}>
        <Planet biomes={BIOMES} />
        <Landmarks />
        <Territories
          territories={territories}
          wrapperRef={wrapperRef}
          sunDirectionRef={sunDirectionRef}
          flashRef={cameraRig.flashRef}
          kingdomState={kingdomState}
          selectedTerritoryId={selectedTerritoryId}
          onTerritorySelect={onTerritorySelect}
        />
        <KingdomSilhouettes territories={territories} kingdomState={kingdomState} />
        <Clouds introOpacityRef={cameraRig.introOpacityRef} />
        <Atmosphere introOpacityRef={cameraRig.introOpacityRef} />
        <Particles tier={tier} paused={reducedMotion} zoomDistanceRef={cameraRig.zoomDistanceRef} />
        <DayNightCycle wrapperRef={wrapperRef} sunDirectionRef={sunDirectionRef} paused={reducedMotion} />
      </group>
    </>
  )
}
