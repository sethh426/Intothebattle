import { useCallback, useMemo, useRef } from 'react'
import type { RefObject } from 'react'
import { useFrame } from '@react-three/fiber'
import { Instance, Instances } from '@react-three/drei'
import * as THREE from 'three'
import { KINGDOM, PLANET, WORLD_GRAPHICS } from '../config'
import { latLonToVector3 } from './geo'
import { useLatestRef } from '../hooks/useLatestRef'
import type { KingdomState, Territory, ViewerTier } from '../types'

const UP = new THREE.Vector3(0, 0, 1)
const HIDDEN_SCALE = 0.0001

interface InstanceHandle extends THREE.Object3D {
  color: THREE.Color
}

interface HaloEntry {
  ref: InstanceHandle
  baseColor: THREE.Color
  radius: number
}

interface TerritoryHalosProps {
  territories: Territory[]
  kingdomState?: Record<string, KingdomState>
  selectedTerritoryId?: string | null
  sunDirectionRef: RefObject<THREE.Vector3 | null>
}

function tierFactor(tier: ViewerTier | undefined): number {
  if (tier === 'packed') return 1.18
  if (tier === 'high') return 1.05
  if (tier === 'medium') return 0.92
  if (tier === 'low') return 0.82
  return 0.72
}

export default function TerritoryHalos({
  territories,
  kingdomState,
  selectedTerritoryId,
  sunDirectionRef,
}: TerritoryHalosProps) {
  const geometry = useMemo(() => new THREE.RingGeometry(0.9, 1, 56, 1, 0.38, Math.PI * 1.48), [])
  const material = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        transparent: true,
        opacity: 0.2,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
        toneMapped: true,
      }),
    [],
  )
  const entries = useRef(new Map<string, HaloEntry>())
  const tmpColor = useMemo(() => new THREE.Color(), [])
  const selectedColor = useMemo(() => new THREE.Color('#ffe99a'), [])
  const kingdomStateRef = useLatestRef<Record<string, KingdomState>>(kingdomState ?? {})
  const selectedTerritoryIdRef = useLatestRef<string | null | undefined>(selectedTerritoryId)

  const setup = useCallback((instance: InstanceHandle | null, territory: Territory) => {
    if (!instance) {
      entries.current.delete(territory.id)
      return
    }
    const position = latLonToVector3(territory.lat, territory.lon, PLANET.radius + WORLD_GRAPHICS.territoryHaloOffset)
    const normal = position.clone().normalize()
    instance.position.copy(position)
    instance.quaternion.setFromUnitVectors(UP, normal)
    instance.scale.set(HIDDEN_SCALE, HIDDEN_SCALE, HIDDEN_SCALE)
    const baseColor = new THREE.Color(territory.colorHex)
    instance.color.copy(baseColor)
    entries.current.set(territory.id, {
      ref: instance,
      baseColor,
      radius: Math.max(territory.angularRadius * PLANET.radius * 1.28, 0.105),
    })
  }, [])

  useFrame(({ clock }) => {
    const states = kingdomStateRef.current
    const selectedId = selectedTerritoryIdRef.current
    const pulse = 0.92 + Math.sin(clock.elapsedTime * 2.4) * 0.08
    entries.current.forEach(({ ref, baseColor, radius }, territoryId) => {
      const state = states[territoryId]
      const selected = selectedId === territoryId
      const active = selected || state?.isLive
      if (!active) {
        ref.scale.set(HIDDEN_SCALE, HIDDEN_SCALE, HIDDEN_SCALE)
        return
      }

      const daylight = sunDirectionRef.current
        ? Math.max(0, ref.position.clone().normalize().dot(sunDirectionRef.current))
        : 0.4
      const nightBoost = 1.15 - daylight * 0.28
      const scale = radius * (selected ? 1.22 : tierFactor(state?.viewerTier)) * (state?.isLive ? pulse : 0.86) * nightBoost
      ref.scale.set(scale, scale, 1)
      tmpColor.copy(baseColor)
      if (selected) tmpColor.lerp(selectedColor, 0.62)
      tmpColor.multiplyScalar(state?.isLive ? KINGDOM.colorBoost[state.viewerTier] * 0.85 : 1.08)
      ref.color.copy(tmpColor)
    })
  })

  return (
    <Instances geometry={geometry} material={material} limit={territories.length} renderOrder={5} raycast={() => undefined}>
      {territories.map((territory) => (
        <Instance key={territory.id} ref={(instance: InstanceHandle | null) => setup(instance, territory)} />
      ))}
    </Instances>
  )
}
