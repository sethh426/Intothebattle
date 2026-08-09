import { useCallback, useMemo, useRef } from 'react'
import type { RefObject } from 'react'
import { useFrame } from '@react-three/fiber'
import { Instance, Instances } from '@react-three/drei'
import * as THREE from 'three'
import { KINGDOM, PLANET, WORLD_GRAPHICS } from '../config'
import { latLonToVector3 } from './geo'
import { useLatestRef } from '../hooks/useLatestRef'
import type { KingdomState, Territory, ViewerTier } from '../types'

const HIDDEN_SCALE = 0.0001

interface InstanceHandle extends THREE.Object3D {
  color: THREE.Color
}

interface LightEntry {
  ref: InstanceHandle
  baseColor: THREE.Color
  seedOffset: number
  baseScale: number
}

interface SettlementLightsProps {
  territories: Territory[]
  kingdomState?: Record<string, KingdomState>
  selectedTerritoryId?: string | null
  sunDirectionRef: RefObject<THREE.Vector3 | null>
}

function tierScale(tier: ViewerTier | undefined): number {
  if (tier === 'packed') return 1.85
  if (tier === 'high') return 1.5
  if (tier === 'medium') return 1.2
  if (tier === 'low') return 0.9
  return 0.68
}

export default function SettlementLights({
  territories,
  kingdomState,
  selectedTerritoryId,
  sunDirectionRef,
}: SettlementLightsProps) {
  const geometry = useMemo(() => new THREE.SphereGeometry(1, 8, 8), [])
  const material = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        transparent: true,
        opacity: 0.68,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
      }),
    [],
  )
  const entries = useRef(new Map<string, LightEntry>())
  const tmpColor = useMemo(() => new THREE.Color(), [])
  const liveWhite = useMemo(() => new THREE.Color('#fff7c4'), [])
  const selectedGold = useMemo(() => new THREE.Color('#ffe99a'), [])
  const kingdomStateRef = useLatestRef<Record<string, KingdomState>>(kingdomState ?? {})
  const selectedTerritoryIdRef = useLatestRef<string | null | undefined>(selectedTerritoryId)

  const setup = useCallback((instance: InstanceHandle | null, territory: Territory) => {
    if (!instance) {
      entries.current.delete(territory.id)
      return
    }
    const position = latLonToVector3(territory.lat, territory.lon, PLANET.radius + WORLD_GRAPHICS.settlementLightOffset)
    instance.position.copy(position)
    instance.scale.set(HIDDEN_SCALE, HIDDEN_SCALE, HIDDEN_SCALE)
    const baseColor = new THREE.Color(territory.colorHex)
    instance.color.copy(baseColor)
    entries.current.set(territory.id, {
      ref: instance,
      baseColor,
      seedOffset: (territory.seed % 1000) / 997,
      baseScale: Math.max(territory.angularRadius * 0.36, 0.012),
    })
  }, [])

  useFrame(({ clock }) => {
    const states = kingdomStateRef.current
    const selectedId = selectedTerritoryIdRef.current
    entries.current.forEach(({ ref, baseColor, seedOffset, baseScale }, territoryId) => {
      const state = states[territoryId]
      const selected = selectedId === territoryId
      const daylight = sunDirectionRef.current
        ? Math.max(0, ref.position.clone().normalize().dot(sunDirectionRef.current))
        : 0.35
      const nightFactor = 1.35 - daylight * 0.78
      const livePulse = 0.88 + Math.sin(clock.elapsedTime * (3.4 + seedOffset) + seedOffset * 9.0) * 0.12
      const activeScale = baseScale * (selected ? 2.2 : tierScale(state?.viewerTier)) * nightFactor * (state?.isLive ? livePulse : 0.72)

      if (!selected && !state?.isLive && !state?.isClaimed) {
        ref.scale.setScalar(HIDDEN_SCALE)
        return
      }

      ref.scale.setScalar(activeScale)
      tmpColor.copy(baseColor).lerp(liveWhite, state?.isLive ? 0.4 : 0.14)
      if (selected) tmpColor.lerp(selectedGold, 0.55)
      tmpColor.multiplyScalar(state?.isLive ? KINGDOM.colorBoost[state.viewerTier] : 1.25)
      ref.color.copy(tmpColor)
    })
  })

  return (
    <Instances geometry={geometry} material={material} limit={territories.length} renderOrder={6} raycast={() => undefined}>
      {territories.map((territory) => (
        <Instance key={territory.id} ref={(instance: InstanceHandle | null) => setup(instance, territory)} />
      ))}
    </Instances>
  )
}
