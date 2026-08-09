import { useEffect, useMemo } from 'react'
import { Instance, Instances, useGLTF } from '@react-three/drei'
import * as THREE from 'three'
import { AMBIENT_PACK_URL, BIOME_STRUCTURE_KITS } from '../data/landmarkCatalog'
import { PLANET } from '../config'
import { latLonToVector3 } from './geo'
import { createStructureMaterial, mergeStructureNodeGeometry } from './structureModelUtils'
import { recordStructureAsset } from './structureDiagnostics'
import type { PerfTier, Territory } from '../types'

const LOCAL_UP = new THREE.Vector3(0, 1, 0)

interface AmbientStructureClustersProps {
  territories: readonly Territory[]
  perfTier: PerfTier
}

interface AmbientPlacement {
  id: string
  position: THREE.Vector3
  quaternion: THREE.Quaternion
  scale: number
}

interface AmbientDefinition {
  biomeId: string
  geometry: THREE.BufferGeometry
  material: THREE.MeshStandardMaterial
  placements: AmbientPlacement[]
}

export default function AmbientStructureClusters({
  territories,
  perfTier,
}: AmbientStructureClustersProps) {
  const { scene } = useGLTF(AMBIENT_PACK_URL, false, true)
  const definitions = useMemo<AmbientDefinition[]>(() =>
    BIOME_STRUCTURE_KITS.map((kit, biomeIndex) => {
      const source = scene.getObjectByName(kit.ambientNode)
      if (!source) throw new Error(`Ambient structure contract is missing ${kit.ambientNode}.`)
      const biomeTerritories = territories
        .filter((territory) => territory.biomeId === kit.biomeId)
        .sort((left, right) => left.seed - right.seed)
      const placements = Array.from({ length: 6 }, (_, index) => {
        const territory = biomeTerritories[index % biomeTerritories.length]
        if (!territory) throw new Error(`No ambient placement territory exists for ${kit.biomeId}.`)
        const direction = index % 2 === 0 ? 1 : -1
        const offset = THREE.MathUtils.radToDeg(territory.angularRadius) * (1.8 + (index % 3) * 0.4)
        const lat = territory.lat + direction * (0.45 + (index % 3) * 0.32)
        const lon = territory.lon + direction * offset
        const position = latLonToVector3(lat, lon, PLANET.radius + 0.012)
        const quaternion = new THREE.Quaternion().setFromUnitVectors(LOCAL_UP, position.clone().normalize())
        quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(LOCAL_UP, territory.rotation + biomeIndex * 0.37 + index * 0.91))
        return {
          id: `${kit.biomeId}:ambient:${index}`,
          position,
          quaternion,
          scale: 0.03 + (index % 3) * 0.004,
        }
      })
      return {
        biomeId: kit.biomeId,
        geometry: mergeStructureNodeGeometry(source, kit.biomeId),
        material: createStructureMaterial(kit.biomeId, 'ambient'),
        placements,
      }
    }), [scene, territories])

  useEffect(() => {
    recordStructureAsset('ambient-clusters')
    return () => {
      definitions.forEach(({ geometry, material }) => {
        geometry.dispose()
        material.dispose()
      })
    }
  }, [definitions])

  if (perfTier === 'low') return null

  return (
    <group name="ambient-structure-clusters" raycast={() => undefined}>
      {definitions.map((definition) => (
        <Instances
          key={definition.biomeId}
          geometry={definition.geometry}
          material={definition.material}
          limit={6}
          range={6}
          raycast={() => undefined}
        >
          {definition.placements.map((placement) => (
            <Instance
              key={placement.id}
              position={placement.position}
              quaternion={placement.quaternion}
              scale={placement.scale}
              raycast={() => undefined}
            />
          ))}
        </Instances>
      ))}
    </group>
  )
}
