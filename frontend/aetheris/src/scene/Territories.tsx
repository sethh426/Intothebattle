import { useMemo, useRef, useState, useCallback } from 'react'
import type { RefObject } from 'react'
import { useFrame, type ThreeEvent } from '@react-three/fiber'
import { Instances, Instance, Html } from '@react-three/drei'
import * as THREE from 'three'
import { PLANET, DAY_NIGHT } from '../config'
import { buildShapeFootprint, SHAPE_IDS } from '../data/shapeLibrary'
import { getBiomeById } from '../data/biomeData'
import { latLonToVector3 } from './geo'
import type { Territory } from '../types'

const EXTRUDE_DEPTH = 0.05
const SURFACE_OFFSET = 0.01 // lift footprints slightly above the base sphere to avoid z-fighting

interface InstanceHandle extends THREE.Object3D {
  color: THREE.Color
}

interface LiveEntry {
  ref: InstanceHandle
  baseColor: THREE.Color
  normal: THREE.Vector3
}

function buildShapeGeometry(shapeId: string): THREE.ExtrudeGeometry {
  const { outer, holes } = buildShapeFootprint(shapeId)
  const shape = new THREE.Shape(outer.map(([x, y]) => new THREE.Vector2(x, y)))
  holes.forEach((holePoints) => {
    shape.holes.push(new THREE.Path(holePoints.map(([x, y]) => new THREE.Vector2(x, y))))
  })
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: EXTRUDE_DEPTH, bevelEnabled: false, curveSegments: 8 })
  geometry.translate(0, 0, -EXTRUDE_DEPTH / 2)
  return geometry
}

interface TerritoriesProps {
  territories: Territory[]
  wrapperRef: RefObject<THREE.Object3D | null>
  sunDirectionRef: RefObject<THREE.Vector3 | null>
  // 0-1, one-shot intro flash intensity (see useCameraRig) applied to a single
  // designated flagship-biome territory as the opening cinematic's payoff beat.
  flashRef?: RefObject<number>
}

interface TooltipState {
  territory: Territory
  position: THREE.Vector3
}

const UP = new THREE.Vector3(0, 0, 1)

export default function Territories({ territories, wrapperRef, sunDirectionRef, flashRef }: TerritoriesProps) {
  const geometries = useMemo(() => {
    const map = new Map<string, THREE.ExtrudeGeometry>()
    SHAPE_IDS.forEach((shapeId) => map.set(shapeId, buildShapeGeometry(shapeId)))
    return map
  }, [])

  const material = useMemo(() => new THREE.MeshStandardMaterial({ roughness: 0.45, metalness: 0.35 }), [])

  const grouped = useMemo(() => {
    const map = new Map<string, Territory[]>()
    SHAPE_IDS.forEach((shapeId) => {
      map.set(shapeId, territories.filter((t) => t.shapeId === shapeId))
    })
    return map
  }, [territories])

  // territory.id -> live instance handle, for per-frame day/night color updates
  const liveInstanceRefs = useRef(new Map<string, LiveEntry>())
  const flashInstanceRef = useRef<{ ref: InstanceHandle; baseColor: THREE.Color } | null>(null)
  const [tooltip, setTooltip] = useState<TooltipState | null>(null)
  const tmpColor = useMemo(() => new THREE.Color(), [])
  const flashWhite = useMemo(() => new THREE.Color(1, 1, 1), [])

  // One designated flagship-biome territory is the intro cinematic's one-shot flash target.
  const flashTerritoryId = useMemo(() => {
    const flagship = territories.find((t) => getBiomeById(t.biomeId)?.isFlagship)
    return flagship?.id ?? null
  }, [territories])

  const instanceSetup = useCallback((instance: InstanceHandle | null, territory: Territory) => {
    if (!instance) {
      liveInstanceRefs.current.delete(territory.id)
      if (flashInstanceRef.current?.ref && territory.id === flashTerritoryId) flashInstanceRef.current = null
      return
    }
    const surfacePoint = latLonToVector3(territory.lat, territory.lon, PLANET.radius + SURFACE_OFFSET)
    const normal = surfacePoint.clone().normalize()
    const quaternion = new THREE.Quaternion().setFromUnitVectors(UP, normal)
    const spin = new THREE.Quaternion().setFromAxisAngle(normal, territory.rotation)
    quaternion.premultiply(spin)

    const arcLength = territory.angularRadius * PLANET.radius

    instance.position.copy(surfacePoint)
    instance.quaternion.copy(quaternion)
    instance.scale.set(arcLength, arcLength, 1)

    const baseColor = new THREE.Color(territory.colorHex)
    instance.color.copy(baseColor)

    if (territory.isLive) {
      liveInstanceRefs.current.set(territory.id, { ref: instance, baseColor, normal })
    }
    if (territory.id === flashTerritoryId) {
      flashInstanceRef.current = { ref: instance, baseColor }
    }
  }, [flashTerritoryId])

  useFrame(() => {
    const sunDir = sunDirectionRef.current
    if (sunDir) {
      liveInstanceRefs.current.forEach(({ ref, baseColor, normal }) => {
        const isNightSide = normal.dot(sunDir) < 0.05
        tmpColor.copy(baseColor)
        if (isNightSide) tmpColor.multiplyScalar(DAY_NIGHT.nightLiveBoost)
        ref.color.copy(tmpColor)
      })
    }

    const flashIntensity = flashRef?.current ?? 0
    const flashEntry = flashInstanceRef.current
    if (flashEntry && flashIntensity > 0.001) {
      tmpColor.copy(flashEntry.baseColor).lerp(flashWhite, flashIntensity)
      flashEntry.ref.color.copy(tmpColor)
    }
  })

  const handlePointerOver = useCallback((territory: Territory, event: ThreeEvent<PointerEvent>) => {
    event.stopPropagation()
    const localPoint = event.point.clone()
    if (wrapperRef.current) wrapperRef.current.worldToLocal(localPoint)
    setTooltip({ territory, position: localPoint })
  }, [wrapperRef])

  const handlePointerOut = useCallback(() => setTooltip(null), [])

  return (
    <group>
      {SHAPE_IDS.map((shapeId) => {
        const geometry = geometries.get(shapeId)
        const shapeTerritories = grouped.get(shapeId) ?? []
        if (!geometry || shapeTerritories.length === 0) return null
        return (
          <Instances key={shapeId} geometry={geometry} material={material} limit={shapeTerritories.length}>
            {shapeTerritories.map((territory) => (
              <Instance
                key={territory.id}
                ref={(instance: InstanceHandle | null) => instanceSetup(instance, territory)}
                onPointerOver={(event: ThreeEvent<PointerEvent>) => handlePointerOver(territory, event)}
                onPointerOut={handlePointerOut}
              />
            ))}
          </Instances>
        )
      })}
      {tooltip && (
        <Html position={tooltip.position} style={{ pointerEvents: 'none' }}>
          <div
            style={{
              background: 'rgba(4,8,18,0.92)',
              border: '1px solid rgba(0,200,255,0.28)',
              borderRadius: 10,
              padding: '8px 12px',
              fontSize: 11,
              lineHeight: 1.4,
              color: '#dce6f6',
              whiteSpace: 'nowrap',
              transform: 'translate(-50%, -120%)',
            }}
          >
            <strong style={{ display: 'block', color: '#ffe99a', fontSize: 12, fontWeight: 800 }}>
              {tooltip.territory.creatorName}
            </strong>
            <span style={{ display: 'block', color: 'rgba(220,230,246,0.75)' }}>
              {getBiomeById(tooltip.territory.biomeId)?.name}
            </span>
            <span
              style={{
                display: 'inline-block',
                marginTop: 4,
                padding: '2px 7px',
                borderRadius: 999,
                fontSize: 9,
                fontWeight: 700,
                letterSpacing: '0.08em',
                textTransform: 'uppercase',
                background: tooltip.territory.isLive ? 'rgba(0,200,255,0.16)' : 'rgba(255,255,255,0.08)',
                color: tooltip.territory.isLive ? '#3fd0ff' : 'rgba(220,230,246,0.55)',
              }}
            >
              {tooltip.territory.isLive ? 'Live' : 'Offline'}
            </span>
          </div>
        </Html>
      )}
    </group>
  )
}
