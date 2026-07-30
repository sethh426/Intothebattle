import { useCallback, useMemo, useRef } from 'react'
import type { RefObject } from 'react'
import { useFrame } from '@react-three/fiber'
import { Instances, Instance } from '@react-three/drei'
import * as THREE from 'three'
import { PLANET, KINGDOM } from '../config'
import { latLonToVector3 } from './geo'
import { useLatestRef } from '../hooks/useLatestRef'
import type { KingdomState, Territory, ViewerTier } from '../types'

const LOCAL_UP = new THREE.Vector3(0, 1, 0)
const HIDDEN_SCALE = 0.0001

type StrongholdRole = 'stone' | 'trim' | 'light'

interface InstanceHandle extends THREE.Object3D {
  color: THREE.Color
}

interface StrongholdPart {
  ref: InstanceHandle
  role: StrongholdRole
  biomeIds?: string[]
}

interface StrongholdEntry {
  parts: Map<string, StrongholdPart>
  arcLength: number
  baseColor: THREE.Color
  normal: THREE.Vector3
  biomeId: string
  seed: number
}

interface StrongholdGeometryDef {
  key: string
  role: StrongholdRole
  material: THREE.Material
  geometry: THREE.BufferGeometry
  biomeIds?: string[]
}

interface KingdomSilhouettesProps {
  territories: Territory[]
  kingdomState?: Record<string, KingdomState>
  selectedTerritoryId?: string | null
  sunDirectionRef: RefObject<THREE.Vector3 | null>
}

function transformed<T extends THREE.BufferGeometry>(
  geometry: T,
  position: [number, number, number],
  rotation: [number, number, number] = [0, 0, 0],
  scale: [number, number, number] = [1, 1, 1],
): T {
  geometry.scale(...scale)
  geometry.rotateX(rotation[0])
  geometry.rotateY(rotation[1])
  geometry.rotateZ(rotation[2])
  geometry.translate(...position)
  return geometry
}

function isEscalatedTier(tier: ViewerTier | undefined): tier is 'high' | 'packed' {
  return tier === 'high' || tier === 'packed'
}

function accentDef(
  key: string,
  biomeIds: string[],
  role: StrongholdRole,
  material: THREE.Material,
  geometry: THREE.BufferGeometry,
): StrongholdGeometryDef {
  return { key, biomeIds, role, material, geometry }
}

function makeStrongholdGeometryDefs(materials: Record<StrongholdRole, THREE.Material>): StrongholdGeometryDef[] {
  const wallGeometry = (key: string, width: number, depth: number, x: number, z: number): StrongholdGeometryDef => ({
    key,
    role: 'stone',
    material: materials.stone,
    geometry: transformed(new THREE.BoxGeometry(width, 0.16, depth), [x, 0.3, z]),
  })

  const towerGeometry = (key: string, x: number, z: number): StrongholdGeometryDef => ({
    key,
    role: 'stone',
    material: materials.stone,
    geometry: transformed(new THREE.CylinderGeometry(0.1, 0.13, 0.58, 12), [x, 0.42, z]),
  })

  const roofGeometry = (key: string, x: number, z: number): StrongholdGeometryDef => ({
    key,
    role: 'trim',
    material: materials.trim,
    geometry: transformed(new THREE.ConeGeometry(0.15, 0.18, 12), [x, 0.8, z]),
  })

  return [
    {
      key: 'foundation-ring',
      role: 'stone',
      material: materials.stone,
      geometry: transformed(new THREE.CylinderGeometry(0.68, 0.78, 0.12, 18), [0, 0.06, 0]),
    },
    {
      key: 'upper-plinth',
      role: 'stone',
      material: materials.stone,
      geometry: transformed(new THREE.CylinderGeometry(0.46, 0.56, 0.1, 16), [0, 0.17, 0]),
    },
    wallGeometry('wall-north', 0.78, 0.08, 0, 0.34),
    wallGeometry('wall-south', 0.78, 0.08, 0, -0.34),
    wallGeometry('wall-east', 0.08, 0.78, 0.34, 0),
    wallGeometry('wall-west', 0.08, 0.78, -0.34, 0),
    towerGeometry('tower-ne', 0.34, 0.34),
    towerGeometry('tower-nw', -0.34, 0.34),
    towerGeometry('tower-se', 0.34, -0.34),
    towerGeometry('tower-sw', -0.34, -0.34),
    roofGeometry('roof-ne', 0.34, 0.34),
    roofGeometry('roof-nw', -0.34, 0.34),
    roofGeometry('roof-se', 0.34, -0.34),
    roofGeometry('roof-sw', -0.34, -0.34),
    {
      key: 'central-keep',
      role: 'stone',
      material: materials.stone,
      geometry: transformed(new THREE.CylinderGeometry(0.16, 0.24, 0.82, 14), [0, 0.63, 0]),
    },
    {
      key: 'keep-roof',
      role: 'trim',
      material: materials.trim,
      geometry: transformed(new THREE.ConeGeometry(0.26, 0.24, 14), [0, 1.16, 0]),
    },
    {
      key: 'front-window',
      role: 'light',
      material: materials.light,
      geometry: transformed(new THREE.BoxGeometry(0.04, 0.16, 0.018), [0, 0.66, 0.245]),
    },
    {
      key: 'rear-window',
      role: 'light',
      material: materials.light,
      geometry: transformed(new THREE.BoxGeometry(0.04, 0.14, 0.018), [0, 0.64, -0.245]),
    },
    {
      key: 'beacon',
      role: 'light',
      material: materials.light,
      geometry: transformed(new THREE.SphereGeometry(0.13, 12, 8), [0, 1.34, 0]),
    },
    accentDef(
      'ice-crown-shard',
      ['frozen-crown'],
      'light',
      materials.light,
      transformed(new THREE.OctahedronGeometry(0.11, 0), [0, 1.52, -0.04], [0.18, 0.35, 0.12], [0.7, 1.55, 0.7]),
    ),
    accentDef(
      'storm-sol-rod',
      ['thunder-highlands'],
      'light',
      materials.light,
      transformed(new THREE.CylinderGeometry(0.022, 0.036, 0.6, 7), [0, 1.44, 0], [0.18, 0.4, -0.1]),
    ),
    accentDef(
      'storm-capacitor-ring',
      ['thunder-highlands'],
      'light',
      materials.light,
      transformed(new THREE.TorusGeometry(0.28, 0.01, 8, 28), [0, 1.14, 0], [Math.PI / 2.15, 0.2, 0.7]),
    ),
    accentDef(
      'desert-arch-left',
      ['whispering-desert'],
      'trim',
      materials.trim,
      transformed(new THREE.BoxGeometry(0.07, 0.5, 0.07), [-0.26, 0.78, 0]),
    ),
    accentDef(
      'desert-arch-right',
      ['whispering-desert'],
      'trim',
      materials.trim,
      transformed(new THREE.BoxGeometry(0.07, 0.5, 0.07), [0.26, 0.78, 0]),
    ),
    accentDef(
      'desert-arch-crown',
      ['whispering-desert'],
      'trim',
      materials.trim,
      transformed(new THREE.BoxGeometry(0.58, 0.06, 0.08), [0, 1.06, 0]),
    ),
    accentDef(
      'forest-world-trunk',
      ['ancient-jungle', 'emerald-wilds'],
      'stone',
      materials.stone,
      transformed(new THREE.CylinderGeometry(0.055, 0.09, 0.5, 8), [0, 1.17, 0]),
    ),
    accentDef(
      'forest-world-canopy',
      ['ancient-jungle', 'emerald-wilds'],
      'light',
      materials.light,
      transformed(new THREE.SphereGeometry(0.22, 16, 10), [0, 1.52, 0], [0.1, 0.35, 0], [1.25, 0.86, 1.25]),
    ),
    accentDef(
      'metal-orbit-ring',
      ['liquid-blu-metal-sea'],
      'light',
      materials.light,
      transformed(new THREE.TorusGeometry(0.42, 0.012, 8, 36), [0, 1.06, 0], [Math.PI / 2.3, 0.1, 0.55]),
    ),
    accentDef(
      'metal-orbit-core',
      ['liquid-blu-metal-sea'],
      'light',
      materials.light,
      transformed(new THREE.SphereGeometry(0.18, 18, 10), [0, 1.08, 0]),
    ),
    accentDef(
      'molten-vent',
      ['molten-wastes'],
      'light',
      materials.light,
      transformed(new THREE.ConeGeometry(0.22, 0.7, 14, 1, true), [0, 1.32, 0]),
    ),
    accentDef(
      'molten-lava-cut',
      ['molten-wastes'],
      'light',
      materials.light,
      transformed(new THREE.BoxGeometry(0.08, 0.72, 0.028), [0.2, 0.68, 0], [0.28, 0.72, 0.12]),
    ),
    accentDef(
      'toxic-stack-left',
      ['toxic-expanse'],
      'stone',
      materials.stone,
      transformed(new THREE.CylinderGeometry(0.035, 0.05, 0.72, 8), [-0.24, 0.82, 0.08], [0.1, 0, -0.06]),
    ),
    accentDef(
      'toxic-stack-right',
      ['toxic-expanse'],
      'stone',
      materials.stone,
      transformed(new THREE.CylinderGeometry(0.032, 0.046, 0.62, 8), [0.22, 0.74, -0.06], [-0.08, 0, 0.1]),
    ),
    accentDef(
      'toxic-glow-pool',
      ['toxic-expanse'],
      'light',
      materials.light,
      transformed(new THREE.CircleGeometry(0.26, 22), [0, 0.245, 0], [-Math.PI / 2, 0, 0], [1.2, 0.72, 1]),
    ),
    accentDef(
      'crystal-spire-main',
      ['crystal-basin'],
      'light',
      materials.light,
      transformed(new THREE.OctahedronGeometry(0.18, 0), [0, 1.38, 0], [0.2, 0.5, 0.14], [0.72, 1.8, 0.72]),
    ),
    accentDef(
      'crystal-spire-side',
      ['crystal-basin'],
      'light',
      materials.light,
      transformed(new THREE.OctahedronGeometry(0.11, 0), [0.24, 1.08, -0.12], [0.26, 0.9, -0.12], [0.75, 1.35, 0.75]),
    ),
    accentDef(
      'void-black-shard',
      ['void-scar'],
      'trim',
      materials.trim,
      transformed(new THREE.OctahedronGeometry(0.19, 0), [0, 1.42, 0], [0.08, 0.6, -0.18], [0.62, 1.95, 0.62]),
    ),
    accentDef(
      'void-event-horizon',
      ['void-scar'],
      'light',
      materials.light,
      transformed(new THREE.TorusGeometry(0.34, 0.012, 8, 36), [0, 1.22, 0], [Math.PI / 1.7, 0.4, 0.82]),
    ),
  ]
}

export default function KingdomSilhouettes({
  territories,
  kingdomState,
  selectedTerritoryId,
  sunDirectionRef,
}: KingdomSilhouettesProps) {
  const materials = useMemo<Record<StrongholdRole, THREE.Material>>(() => ({
    stone: new THREE.MeshStandardMaterial({
      color: '#6f7880',
      roughness: 0.72,
      metalness: 0.12,
      emissive: '#05080f',
      emissiveIntensity: 0.06,
    }),
    trim: new THREE.MeshStandardMaterial({
      color: '#f0d996',
      roughness: 0.48,
      metalness: 0.28,
      emissive: '#17100a',
      emissiveIntensity: 0.14,
    }),
    light: new THREE.MeshBasicMaterial({
      color: '#ffd98b',
      transparent: true,
      opacity: 0.92,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    }),
  }), [])
  const geometryDefs = useMemo(() => makeStrongholdGeometryDefs(materials), [materials])
  const entries = useRef(new Map<string, StrongholdEntry>())
  const kingdomStateRef = useLatestRef<Record<string, KingdomState>>(kingdomState ?? {})
  const selectedTerritoryIdRef = useLatestRef<string | null | undefined>(selectedTerritoryId)
  const tmpColor = useMemo(() => new THREE.Color(), [])
  const selectedGold = useMemo(() => new THREE.Color('#ffe99a'), [])
  const solWarm = useMemo(() => new THREE.Color('#ffbd75'), [])
  const stoneColor = useMemo(() => new THREE.Color('#7a8289'), [])
  const lightGold = useMemo(() => new THREE.Color('#ffd98b'), [])

  const setup = useCallback((
    instance: InstanceHandle | null,
    territory: Territory,
    partKey: string,
    role: StrongholdRole,
    biomeIds?: string[],
  ) => {
    let entry = entries.current.get(territory.id)
    if (!instance) {
      entry?.parts.delete(partKey)
      if (entry && entry.parts.size === 0) entries.current.delete(territory.id)
      return
    }

    const surfacePoint = latLonToVector3(territory.lat, territory.lon, PLANET.radius + KINGDOM.silhouetteLift)
    const normal = surfacePoint.clone().normalize()
    instance.position.copy(surfacePoint)
    instance.quaternion.setFromUnitVectors(LOCAL_UP, normal)
    instance.rotateY(territory.rotation)
    instance.scale.setScalar(HIDDEN_SCALE)

    if (!entry) {
      entry = {
        parts: new Map<string, StrongholdPart>(),
        arcLength: territory.angularRadius * PLANET.radius,
        baseColor: new THREE.Color(territory.colorHex),
        normal,
        biomeId: territory.biomeId,
        seed: (territory.seed % 1000) / 997,
      }
      entries.current.set(territory.id, entry)
    }
    instance.color.copy(entry.baseColor)
    entry.parts.set(partKey, { ref: instance, role, biomeIds })
  }, [])

  useFrame(({ clock }) => {
    const states = kingdomStateRef.current
    const selectedId = selectedTerritoryIdRef.current
    entries.current.forEach((entry, territoryId) => {
      const state = states[territoryId]
      const selected = selectedId === territoryId
      const visible = selected || Boolean(state?.isClaimed) || (state?.isLive && isEscalatedTier(state.viewerTier))

      if (!visible) {
        entry.parts.forEach(({ ref }) => ref.scale.setScalar(HIDDEN_SCALE))
        return
      }

      const sol = sunDirectionRef.current ? Math.max(0, entry.normal.dot(sunDirectionRef.current)) : 0.55
      const night = 1 - sol
      const twilight = Math.max(0, 1 - Math.abs(sol - 0.22) / 0.24)
      const tier = state?.viewerTier
      const packed = tier === 'packed'
      const highTier = isEscalatedTier(tier)
      const liveBoost = state?.isLive ? KINGDOM.colorBoost[state.viewerTier] : 1
      const baseScale = Math.max(entry.arcLength * 0.72, 0.044)
      const tierScale = state?.isLive ? (packed ? 1.18 : highTier ? 1.0 : 0.72) : 0.58
      const selectedScale = selected ? 1.28 : 1
      const pulse = state?.isLive ? 1 + Math.sin(clock.elapsedTime * 2.4 + entry.seed * 8) * (packed ? 0.08 : 0.045) : 1
      const scale = baseScale * tierScale * selectedScale * pulse
      const heightScale = scale * (packed ? 1.18 : highTier ? 1.08 : 0.88)

      entry.parts.forEach(({ ref, role, biomeIds }) => {
        if (biomeIds && !biomeIds.includes(entry.biomeId)) {
          ref.scale.setScalar(HIDDEN_SCALE)
          return
        }

        const accentScale = biomeIds ? 1.04 : 1
        ref.scale.set(scale * accentScale, heightScale * accentScale, scale * accentScale)
        tmpColor.copy(entry.baseColor)
        if (role === 'stone') {
          tmpColor.lerp(stoneColor, state?.isLive ? 0.5 : 0.7)
          tmpColor.lerp(solWarm, sol * 0.16)
          tmpColor.multiplyScalar((state?.isLive ? 1.05 : 0.86) * (0.76 + sol * 0.42))
        } else if (role === 'trim') {
          if (entry.biomeId === 'void-scar') tmpColor.set('#251044')
          if (selected) tmpColor.lerp(selectedGold, 0.48)
          tmpColor.lerp(solWarm, sol * 0.12).multiplyScalar(Math.min(liveBoost, 1.75) * (0.82 + sol * 0.3))
        } else {
          const solPulse = 0.92 + Math.sin(clock.elapsedTime * 3.2 + entry.seed * 9) * 0.08
          tmpColor.lerp(lightGold, selected ? 0.62 : 0.36)
          tmpColor.multiplyScalar((state?.isLive ? liveBoost * 1.12 : 1.15) * (1.0 + night * 0.55 + twilight * 0.38) * solPulse)
        }
        if (selected && role !== 'trim') tmpColor.lerp(selectedGold, 0.26)
        ref.color.copy(tmpColor)
      })
    })
  })

  return (
    <group raycast={() => undefined}>
      {geometryDefs.map((def) => (
        <Instances
          key={def.key}
          geometry={def.geometry}
          material={def.material}
          limit={territories.length}
          raycast={() => undefined}
        >
          {territories.map((territory) => (
            <Instance
              key={territory.id}
              raycast={() => undefined}
              ref={(instance: InstanceHandle | null) => setup(
                instance,
                territory,
                def.key,
                def.role,
                def.biomeIds,
              )}
            />
          ))}
        </Instances>
      ))}
    </group>
  )
}
