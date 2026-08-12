import { useEffect, useMemo } from 'react'
import { useGLTF } from '@react-three/drei'
import * as THREE from 'three'
import { BIOME_STRUCTURE_KITS, REGIONAL_PACK_URL, selectRegionalTerritories } from '../data/landmarkCatalog'
import { getBiomeById } from '../data/biomeData'
import { PLANET } from '../config'
import { latLonToVector3, offsetLatLon } from './geo'
import { createStructureMaterial, mergeStructureNodeGeometry } from './structureModelUtils'
import { recordStructureAsset } from './structureDiagnostics'
import type { PerfTier, Territory } from '../types'

const LOCAL_UP = new THREE.Vector3(0, 1, 0)

interface RegionalMonumentsProps {
  territories: readonly Territory[]
  perfTier: PerfTier
  reducedMotion: boolean
}

interface RegionalEntry {
  id: string
  geometry: THREE.BufferGeometry
  material: THREE.MeshStandardMaterial
  position: THREE.Vector3
  quaternion: THREE.Quaternion
  yaw: number
  scale: number
  flagship: boolean
}

export default function RegionalMonuments({
  territories,
  perfTier,
  reducedMotion,
}: RegionalMonumentsProps) {
  const { scene } = useGLTF(REGIONAL_PACK_URL, false, true)
  const entries = useMemo<RegionalEntry[]>(() => {
    const result: RegionalEntry[] = []
    BIOME_STRUCTURE_KITS.forEach((kit) => {
      const anchors = selectRegionalTerritories(territories, kit.biomeId)
      const material = createStructureMaterial(kit.biomeId, 'regional')
      kit.regionalNodes.forEach((nodeName, index) => {
        const source = scene.getObjectByName(nodeName)
        const territory = anchors[index]
        if (!source || !territory) {
          throw new Error(`Regional structure contract is missing ${nodeName}.`)
        }
        const offsetDegrees = THREE.MathUtils.radToDeg(territory.angularRadius) * (index === 1 ? 0.62 : -0.58)
        const { lat, lon } = offsetLatLon(territory.lat, territory.lon, (index - 1) * 0.32, offsetDegrees)
        const position = latLonToVector3(lat, lon, PLANET.radius + 0.014)
        result.push({
          id: `${kit.biomeId}:${index}`,
          geometry: mergeStructureNodeGeometry(source, kit.biomeId),
          material,
          position,
          quaternion: new THREE.Quaternion().setFromUnitVectors(LOCAL_UP, position.clone().normalize()),
          yaw: territory.rotation + index * 0.83,
          scale: (perfTier === 'low' ? 0.046 : 0.058) * (territory.sizeClass === 'large' ? 1.12 : 1),
          flagship: Boolean(getBiomeById(kit.biomeId)?.isFlagship),
        })
      })
    })
    return result
  }, [perfTier, scene, territories])

  useEffect(() => {
    recordStructureAsset('regional-monuments')
    return () => {
      entries.forEach((entry) => entry.geometry.dispose())
      new Set(entries.map((entry) => entry.material)).forEach((material) => material.dispose())
    }
  }, [entries])

  return (
    <group name="regional-monuments" raycast={() => undefined}>
      {entries.filter((entry, index) => perfTier !== 'low' || (entry.flagship && index % 3 === 1)).map((entry, index) => (
        <group key={entry.id} position={entry.position} quaternion={entry.quaternion}>
          <mesh
            geometry={entry.geometry}
            material={entry.material}
            rotation={[0, entry.yaw, 0]}
            scale={entry.scale}
            raycast={() => undefined}
            userData={{ idleEffects: reducedMotion || perfTier === 'low' ? 'paused' : index % 3 === 1 ? 'active' : 'static' }}
          />
        </group>
      ))}
    </group>
  )
}
