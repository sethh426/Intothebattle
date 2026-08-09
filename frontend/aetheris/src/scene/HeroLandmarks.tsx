import { Suspense, useMemo, useRef } from 'react'
import type { RefObject } from 'react'
import { useFrame } from '@react-three/fiber'
import { useGLTF } from '@react-three/drei'
import * as THREE from 'three'
import { LANDMARK_CATALOG } from '../data/landmarkCatalog'
import { buildAllLandmarks } from '../data/landmarkLibrary'
import { PLANET, WORLD_SEED } from '../config'
import { latLonToVector3 } from './geo'
import StructureAssetBoundary from './StructureAssetBoundary'
import { compactStructureScene } from './structureModelUtils'
import { recordLandmarkLod, recordStructureAsset } from './structureDiagnostics'
import type { LandmarkAssetSpec, PerfTier } from '../types'

const LOCAL_UP = new THREE.Vector3(0, 1, 0)

interface HeroLandmarksProps {
  perfTier: PerfTier
  reducedMotion: boolean
  cameraDistanceRef: RefObject<number>
}

interface AnimatedNode {
  object: THREE.Object3D
  basePosition: THREE.Vector3
  baseRotation: THREE.Euler
  baseScale: THREE.Vector3
}

function collectAnimatedNodes(scene: THREE.Object3D): AnimatedNode[] {
  const nodes: AnimatedNode[] = []
  scene.traverse((object) => {
    if (!/^FX_|EMISSIVE_/.test(object.name)) return
    nodes.push({
      object,
      basePosition: object.position.clone(),
      baseRotation: object.rotation.clone(),
      baseScale: object.scale.clone(),
    })
  })
  return nodes
}

function animateNodes(nodes: readonly AnimatedNode[], elapsed: number, phase: number): void {
  nodes.forEach(({ object, basePosition, baseRotation, baseScale }, index) => {
    const offset = phase + index * 0.61
    if (/RING|ORBIT/.test(object.name)) {
      object.rotation.set(baseRotation.x, baseRotation.y + elapsed * (0.22 + index * 0.012), baseRotation.z)
    } else if (/FLOAT|SHARD|DEBRIS/.test(object.name)) {
      object.position.copy(basePosition)
      object.position.y += Math.sin(elapsed * 0.72 + offset) * 0.045
      object.rotation.y = baseRotation.y + elapsed * 0.16
    } else if (/FOLIAGE|VINE/.test(object.name)) {
      object.rotation.set(
        baseRotation.x + Math.sin(elapsed * 0.46 + offset) * 0.04,
        baseRotation.y,
        baseRotation.z + Math.cos(elapsed * 0.41 + offset) * 0.04,
      )
    } else if (/SMOKE/.test(object.name)) {
      const drift = 1 + Math.sin(elapsed * 0.58 + offset) * 0.08
      object.scale.copy(baseScale).multiplyScalar(drift)
      object.position.copy(basePosition)
      object.position.y += Math.sin(elapsed * 0.33 + offset) * 0.035
    } else if (/CORE|BEACON|LIGHTNING|LANTERN|EYE/.test(object.name)) {
      object.scale.copy(baseScale).multiplyScalar(1 + Math.sin(elapsed * 1.7 + offset) * 0.08)
    }
  })
}

function HeroAsset({
  spec,
  perfTier,
  reducedMotion,
  cameraDistanceRef,
}: {
  spec: LandmarkAssetSpec
  perfTier: PerfTier
  reducedMotion: boolean
  cameraDistanceRef: RefObject<number>
}) {
  const lod0 = useGLTF(spec.lodUrls[0], false, true)
  const lod1 = useGLTF(spec.lodUrls[1], false, true)
  const lod2 = useGLTF(spec.lodUrls[2], false, true)
  const scenes = useMemo(
    () => [
      compactStructureScene(lod0.scene, spec.biomeId, spec.materialProfile),
      compactStructureScene(lod1.scene, spec.biomeId, spec.materialProfile),
      compactStructureScene(lod2.scene, spec.biomeId, spec.materialProfile),
    ],
    [lod0.scene, lod1.scene, lod2.scene, spec],
  )
  const animatedNodes = useMemo(() => scenes.map(collectAnimatedNodes), [scenes])
  const lodRefs = useRef<Array<THREE.Group | null>>([])
  const rootRef = useRef<THREE.Group>(null)
  const activeLodRef = useRef(perfTier === 'low' ? 2 : 1)
  const worldPosition = useMemo(() => new THREE.Vector3(), [])
  const cameraDirection = useMemo(() => new THREE.Vector3(), [])

  useMemo(() => {
    spec.lodUrls.forEach((_, index) => recordStructureAsset(`${spec.biomeId}:lod${index}`))
  }, [spec])

  useFrame(({ camera, clock }) => {
    const root = rootRef.current
    if (!root) return
    root.getWorldPosition(worldPosition)
    const objectDistance = worldPosition.distanceTo(camera.position)
    let lod = objectDistance < 1.6 ? 0 : objectDistance < 4.2 ? 1 : 2
    if (perfTier === 'medium') lod = Math.max(1, lod)
    if (perfTier === 'low') lod = 2

    if (lod !== activeLodRef.current) activeLodRef.current = lod
    lodRefs.current.forEach((group, index) => {
      if (group) group.visible = index === lod
    })
    recordLandmarkLod(spec.biomeId, lod)
    animatedNodes[lod].forEach(({ object }) => {
      object.visible = perfTier !== 'low'
    })

    if (reducedMotion) return
    cameraDirection.copy(camera.position).normalize()
    const nearHemisphere = worldPosition.normalize().dot(cameraDirection) > -0.08
    if (nearHemisphere) animateNodes(animatedNodes[lod], clock.elapsedTime, spec.lon * 0.03)

    if (cameraDistanceRef.current > 8) {
      lodRefs.current.forEach((group, index) => {
        if (group) group.visible = index === 2
      })
    }
  })

  return (
    <group ref={rootRef}>
      {scenes.map((scene, index) => (
        <group
          key={index}
          ref={(group) => {
            lodRefs.current[index] = group
          }}
          visible={index === activeLodRef.current}
        >
          <primitive object={scene} />
        </group>
      ))}
    </group>
  )
}

function ProceduralLandmarkFallback({ biomeId }: { biomeId: string }) {
  const object = useMemo(() => {
    const landmark = buildAllLandmarks(WORLD_SEED + 500).find((entry) => entry.biomeId === biomeId)
    const fallback = landmark?.build() ?? new THREE.Group()
    fallback.traverse((child) => {
      child.raycast = () => undefined
    })
    return fallback
  }, [biomeId])
  return <primitive object={object} scale={7.1} />
}

export default function HeroLandmarks({ perfTier, reducedMotion, cameraDistanceRef }: HeroLandmarksProps) {
  return (
    <group name="hero-landmarks" raycast={() => undefined}>
      {LANDMARK_CATALOG.map((spec) => {
        const position = latLonToVector3(spec.lat, spec.lon, PLANET.radius + 0.012)
        const quaternion = new THREE.Quaternion().setFromUnitVectors(LOCAL_UP, position.clone().normalize())
        return (
          <group key={spec.biomeId} position={position} quaternion={quaternion}>
            <group rotation={[0, spec.yaw, 0]} scale={spec.scale}>
              <StructureAssetBoundary
                assetId={`hero:${spec.biomeId}`}
                fallback={<ProceduralLandmarkFallback biomeId={spec.biomeId} />}
              >
                <Suspense fallback={null}>
                  <HeroAsset
                    spec={spec}
                    perfTier={perfTier}
                    reducedMotion={reducedMotion}
                    cameraDistanceRef={cameraDistanceRef}
                  />
                </Suspense>
              </StructureAssetBoundary>
            </group>
          </group>
        )
      })}
    </group>
  )
}
