import { useMemo } from 'react'
import * as THREE from 'three'
import { BIOMES } from '../data/biomeData'
import { buildAllLandmarks } from '../data/landmarkLibrary'
import { latLonToVector3 } from './geo'
import { PLANET, WORLD_SEED } from '../config'

// Landmark builders author their geometry Y-up (heights along the local Y axis, like a
// normal THREE.js scene) — unlike territory footprints, which are authored in the XY
// plane extruded along Z. So landmarks align local +Y (not +Z) to the sphere's outward
// normal at their anchor point.
const LOCAL_UP = new THREE.Vector3(0, 1, 0)

interface PlacedLandmark {
  biomeId: string
  object: THREE.Object3D
  position: THREE.Vector3
  quaternion: THREE.Quaternion
}

// One per-region hero landmark (10 total), anchored at the midpoint latitude of its
// region's belt and spread across longitude — non-instanced (only 10 of them, no need
// for the InstancedMesh strategy the 100 territories use).
export default function Landmarks() {
  const placed = useMemo<PlacedLandmark[]>(() => {
    const landmarks = buildAllLandmarks(WORLD_SEED + 500)
    return landmarks.map((landmark, index) => {
      const biome = BIOMES.find((b) => b.id === landmark.biomeId)
      const lat = biome ? (biome.latBand[0] + biome.latBand[1]) / 2 : 0
      const lon = (index / landmarks.length) * 360 - 180 + 15 // spread out, avoid an exact seam at +/-180
      const position = latLonToVector3(lat, lon, PLANET.radius)
      const normal = position.clone().normalize()
      const quaternion = new THREE.Quaternion().setFromUnitVectors(LOCAL_UP, normal)
      return { biomeId: landmark.biomeId, object: landmark.build(), position, quaternion }
    })
  }, [])

  return (
    <group>
      {placed.map(({ biomeId, object, position, quaternion }) => (
        <group key={biomeId} position={position} quaternion={quaternion}>
          <primitive object={object} />
        </group>
      ))}
    </group>
  )
}
