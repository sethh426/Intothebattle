import { Suspense, useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { BIOMES } from '../data/biomeData'
import { deriveStructureStage } from '../data/landmarkCatalog'
import { ATMOSPHERE, CAMERA, PLANET } from '../config'
import Planet from './Planet'
import BiomeContours from './BiomeContours'
import Territories from './Territories'
import HeroLandmarks from './HeroLandmarks'
import RegionalMonuments from './RegionalMonuments'
import AmbientStructureClusters from './AmbientStructureClusters'
import KingdomSilhouettes from './KingdomSilhouettes'
import ProceduralKingdomSilhouettes from './ProceduralKingdomSilhouettes'
import StructureAssetBoundary from './StructureAssetBoundary'
import AetherisDiagnostics from './AetherisDiagnostics'
import DayNightCycle from './DayNightCycle'
import Atmosphere from './Atmosphere'
import Clouds from './Clouds'
import Starfield from './Starfield'
import RealmVeins from './RealmVeins'
import TerminatorShadow from './TerminatorShadow'
import TerritoryHalos from './TerritoryHalos'
import SettlementLights from './SettlementLights'
import TerritoryBanners from './TerritoryBanners'
import CinematicPostProcessing from './CinematicPostProcessing'
import Particles from '../particles/Particles'
import { useDragControls } from '../hooks/useDragControls'
import { usePerfTier } from '../hooks/usePerfTier'
import { useCameraRig } from '../hooks/useCameraRig'
import { useWorldAnalytics } from '../hooks/useWorldAnalytics'
import type { KingdomState, StructureStage, Territory, WorldFraming } from '../types'

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
  const structureStages = useMemo<Record<StructureStage, number>>(() => {
    const counts: Record<StructureStage, number> = { ruin: 0, claimed: 0, live: 0, high: 0, packed: 0 }
    territories.forEach((territory) => {
      counts[deriveStructureStage(kingdomState[territory.id])] += 1
    })
    return counts
  }, [kingdomState, territories])
  useWorldAnalytics({ isVisible, introOpacityRef: cameraRig.introOpacityRef })

  useEffect(() => {
    controls.setMotionEnabled(!reducedMotion)
  }, [controls, reducedMotion])

  return (
    <>
      <Starfield tier={tier} />
      <group ref={wrapperRef} name="aetheris-world-root">
        <Planet biomes={BIOMES} perfTier={tier} />
        {tier !== 'low' && <BiomeContours biomes={BIOMES} />}
        {tier !== 'low' && <RealmVeins />}
        <TerminatorShadow sunDirectionRef={sunDirectionRef} perfTier={tier} />
        <TerritoryHalos
          territories={territories}
          sunDirectionRef={sunDirectionRef}
          kingdomState={kingdomState}
          selectedTerritoryId={selectedTerritoryId}
        />
        <HeroLandmarks
          perfTier={tier}
          reducedMotion={reducedMotion}
          cameraDistanceRef={cameraRig.zoomDistanceRef}
        />
        <StructureAssetBoundary assetId="regional-monuments" fallback={null}>
          <Suspense fallback={null}>
            <RegionalMonuments territories={territories} perfTier={tier} reducedMotion={reducedMotion} />
          </Suspense>
        </StructureAssetBoundary>
        <StructureAssetBoundary assetId="ambient-clusters" fallback={null}>
          <Suspense fallback={null}>
            <AmbientStructureClusters territories={territories} perfTier={tier} />
          </Suspense>
        </StructureAssetBoundary>
        <Territories
          territories={territories}
          wrapperRef={wrapperRef}
          sunDirectionRef={sunDirectionRef}
          flashRef={cameraRig.flashRef}
          kingdomState={kingdomState}
          selectedTerritoryId={selectedTerritoryId}
          onTerritorySelect={onTerritorySelect}
        />
        <StructureAssetBoundary
          assetId="stronghold-kit"
          fallback={(
            <ProceduralKingdomSilhouettes
              territories={territories}
              kingdomState={kingdomState}
              selectedTerritoryId={selectedTerritoryId}
              sunDirectionRef={sunDirectionRef}
            />
          )}
        >
          <Suspense fallback={null}>
            <KingdomSilhouettes
              territories={territories}
              kingdomState={kingdomState}
              selectedTerritoryId={selectedTerritoryId}
              sunDirectionRef={sunDirectionRef}
              perfTier={tier}
              reducedMotion={reducedMotion}
              cameraDistanceRef={cameraRig.zoomDistanceRef}
            />
          </Suspense>
        </StructureAssetBoundary>
        <TerritoryBanners
          territories={territories}
          kingdomState={kingdomState}
          selectedTerritoryId={selectedTerritoryId}
        />
        <SettlementLights
          territories={territories}
          sunDirectionRef={sunDirectionRef}
          kingdomState={kingdomState}
          selectedTerritoryId={selectedTerritoryId}
        />
        <Clouds introOpacityRef={cameraRig.introOpacityRef} perfTier={tier} />
        <Atmosphere introOpacityRef={cameraRig.introOpacityRef} perfTier={tier} />
        <Particles tier={tier} paused={reducedMotion} zoomDistanceRef={cameraRig.zoomDistanceRef} />
        <DayNightCycle wrapperRef={wrapperRef} sunDirectionRef={sunDirectionRef} paused={reducedMotion} />
      </group>
      <CinematicPostProcessing tier={tier} reducedMotion={reducedMotion} />
      <AetherisDiagnostics perfTier={tier} structureStages={structureStages} />
    </>
  )
}
