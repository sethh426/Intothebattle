import { useCallback, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { Instance, Instances } from '@react-three/drei'
import * as THREE from 'three'
import { KINGDOM, PLANET } from '../config'
import { latLonToVector3 } from './geo'
import { useLatestRef } from '../hooks/useLatestRef'
import type { KingdomState, Territory } from '../types'

const LOCAL_UP = new THREE.Vector3(0, 1, 0)
const HIDDEN_SCALE = 0.0001

interface InstanceHandle extends THREE.Object3D {
  color: THREE.Color
}

interface BannerEntry {
  ref: InstanceHandle
  baseColor: THREE.Color
  size: number
  seed: number
}

interface TerritoryBannersProps {
  territories: Territory[]
  kingdomState?: Record<string, KingdomState>
  selectedTerritoryId?: string | null
}

function buildBannerGeometry(): THREE.BufferGeometry {
  const shape = new THREE.Shape([
    new THREE.Vector2(-0.16, 0),
    new THREE.Vector2(0.12, 0),
    new THREE.Vector2(0.2, 0.16),
    new THREE.Vector2(0.04, 0.32),
    new THREE.Vector2(-0.16, 0.28),
  ])
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: 0.02, bevelEnabled: false })
  geometry.translate(0.05, 0.18, -0.01)
  return geometry
}

export default function TerritoryBanners({ territories, kingdomState, selectedTerritoryId }: TerritoryBannersProps) {
  const geometry = useMemo(() => buildBannerGeometry(), [])
  const material = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        roughness: 0.42,
        metalness: 0.28,
        emissive: '#101828',
        emissiveIntensity: 0.28,
      }),
    [],
  )
  const entries = useRef(new Map<string, BannerEntry>())
  const tmpColor = useMemo(() => new THREE.Color(), [])
  const selectedGold = useMemo(() => new THREE.Color('#ffe99a'), [])
  const kingdomStateRef = useLatestRef<Record<string, KingdomState>>(kingdomState ?? {})
  const selectedTerritoryIdRef = useLatestRef<string | null | undefined>(selectedTerritoryId)

  const setup = useCallback((instance: InstanceHandle | null, territory: Territory) => {
    if (!instance) {
      entries.current.delete(territory.id)
      return
    }
    const position = latLonToVector3(territory.lat, territory.lon, PLANET.radius + 0.2)
    const normal = position.clone().normalize()
    instance.position.copy(position)
    instance.quaternion.setFromUnitVectors(LOCAL_UP, normal)
    instance.rotateY(territory.rotation)
    instance.scale.setScalar(HIDDEN_SCALE)
    const baseColor = new THREE.Color(territory.colorHex)
    instance.color.copy(baseColor)
    entries.current.set(territory.id, {
      ref: instance,
      baseColor,
      size: Math.max(territory.angularRadius * PLANET.radius * 1.2, 0.1),
      seed: (territory.seed % 1000) / 997,
    })
  }, [])

  useFrame(({ clock }) => {
    const states = kingdomStateRef.current
    const selectedId = selectedTerritoryIdRef.current
    entries.current.forEach(({ ref, baseColor, size, seed }, territoryId) => {
      const state = states[territoryId]
      const selected = selectedId === territoryId
      if (!selected && !state?.isClaimed && !state?.isLive) {
        ref.scale.setScalar(HIDDEN_SCALE)
        return
      }
      const pulse = state?.isLive ? 1 + Math.sin(clock.elapsedTime * 3.0 + seed * 8.0) * 0.08 : 1
      const liveBoost = state?.isLive ? KINGDOM.colorBoost[state.viewerTier] : 1
      const scale = size * (selected ? 1.65 : state?.isLive ? 1.35 : 0.92) * pulse
      ref.scale.set(scale, scale * 1.12, scale)
      tmpColor.copy(baseColor)
      if (selected) tmpColor.lerp(selectedGold, 0.62)
      tmpColor.multiplyScalar(liveBoost)
      ref.color.copy(tmpColor)
    })
  })

  return (
    <Instances geometry={geometry} material={material} limit={territories.length} raycast={() => undefined}>
      {territories.map((territory) => (
        <Instance key={territory.id} ref={(instance: InstanceHandle | null) => setup(instance, territory)} />
      ))}
    </Instances>
  )
}
