import { useCallback, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { Instances, Instance } from '@react-three/drei'
import * as THREE from 'three'
import { PLANET, KINGDOM } from '../config'
import { latLonToVector3 } from './geo'
import { useLatestRef } from '../hooks/useLatestRef'
import type { KingdomState, Territory, ViewerTier } from '../types'

// A small spire accent authored Y-up (like Landmarks.tsx), unlike Territories.tsx's
// Z-up footprint shapes -- kept in its own file rather than folded into Territories.tsx
// so the two alignment conventions don't mix in one already-dense component.
const LOCAL_UP = new THREE.Vector3(0, 1, 0)

interface InstanceHandle extends THREE.Object3D {
  color: THREE.Color
}

interface SilhouetteEntry {
  ref: InstanceHandle
  arcLength: number
  baseColor: THREE.Color
}

interface KingdomSilhouettesProps {
  territories: Territory[]
  kingdomState?: Record<string, KingdomState>
}

function buildSpireGeometry(): THREE.ConeGeometry {
  const geometry = new THREE.ConeGeometry(1, 1, 6)
  geometry.translate(0, 0.5, 0) // base sits at local origin, apex points along +Y
  return geometry
}

function isEscalatedTier(tier: ViewerTier | undefined): tier is 'high' | 'packed' {
  return tier === 'high' || tier === 'packed'
}

// THREE.Matrix4.decompose() normalizes each basis vector by dividing by its own scale
// length -- an exact 0 scale component produces 1/0 = Infinity, and drei's <Instances>
// decomposes+recomposes every instance's matrixWorld every frame, so that Infinity/NaN
// then corrupts the whole instanceMatrix buffer and renders as huge garbage geometry.
// A tiny nonzero epsilon is visually indistinguishable from zero but avoids the NaN.
const HIDDEN_SCALE = 0.0001

// One shared spire geometry, one <Instances> block for all 100 territories -- every
// territory gets a persistent instance (never conditionally mounted/unmounted), scaled
// to zero unless its kingdom is currently high/packed tier. This mirrors the same
// InstancedMesh trick Territories.tsx already uses for its own escalation.
export default function KingdomSilhouettes({ territories, kingdomState }: KingdomSilhouettesProps) {
  const geometry = useMemo(() => buildSpireGeometry(), [])
  const material = useMemo(() => new THREE.MeshStandardMaterial({ roughness: 0.4, metalness: 0.3 }), [])
  const tmpColor = useMemo(() => new THREE.Color(), [])

  const entries = useRef(new Map<string, SilhouetteEntry>())
  const kingdomStateRef = useLatestRef<Record<string, KingdomState>>(kingdomState ?? {})

  const instanceSetup = useCallback((instance: InstanceHandle | null, territory: Territory) => {
    if (!instance) {
      entries.current.delete(territory.id)
      return
    }
    const surfacePoint = latLonToVector3(territory.lat, territory.lon, PLANET.radius + KINGDOM.silhouetteLift)
    const normal = surfacePoint.clone().normalize()
    // Rotationally symmetric cone -- territory.rotation (roll around the normal) is
    // intentionally not reapplied here, unlike Territories.tsx's asymmetric footprints.
    instance.position.copy(surfacePoint)
    instance.quaternion.setFromUnitVectors(LOCAL_UP, normal)
    instance.scale.set(HIDDEN_SCALE, HIDDEN_SCALE, HIDDEN_SCALE)

    const baseColor = new THREE.Color(territory.colorHex)
    instance.color.copy(baseColor)

    const arcLength = territory.angularRadius * PLANET.radius
    entries.current.set(territory.id, { ref: instance, arcLength, baseColor })
  }, [])

  useFrame(() => {
    const kingdomStates = kingdomStateRef.current
    entries.current.forEach(({ ref, arcLength, baseColor }, territoryId) => {
      const kingdom = kingdomStates[territoryId]
      if (!kingdom?.isLive || !isEscalatedTier(kingdom.viewerTier)) {
        ref.scale.set(HIDDEN_SCALE, HIDDEN_SCALE, HIDDEN_SCALE)
        return
      }
      const tier = kingdom.viewerTier
      const heightBoost = KINGDOM.silhouetteHeightBoost[tier]
      const radius = arcLength * KINGDOM.silhouetteRadiusFactor
      const height = arcLength * KINGDOM.silhouetteHeightFactor * heightBoost
      ref.scale.set(radius, height, radius)

      tmpColor.copy(baseColor).multiplyScalar(KINGDOM.colorBoost[tier])
      ref.color.copy(tmpColor)
    })
  })

  return (
    <Instances geometry={geometry} material={material} limit={territories.length}>
      {territories.map((territory) => (
        <Instance
          key={territory.id}
          ref={(instance: InstanceHandle | null) => instanceSetup(instance, territory)}
        />
      ))}
    </Instances>
  )
}
