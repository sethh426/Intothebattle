import { useMemo, useRef } from 'react'
import { Line } from '@react-three/drei'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { PLANET } from '../config'
import { latLonToVector3 } from './geo'
import type { Territory, WarCampaign } from '../types'

const UP = new THREE.Vector3(0, 0, 1)
const ROUTE_RADIUS = PLANET.radius + 0.17

interface MobilizationRoutesProps {
  campaigns: WarCampaign[]
  territories: Territory[]
  reducedMotion: boolean
}

interface RouteProps {
  campaign: WarCampaign
  origin: Territory
  target: Territory
  reducedMotion: boolean
}

function routePoints(origin: Territory, target: Territory): THREE.Vector3[] {
  const start = latLonToVector3(origin.lat, origin.lon, ROUTE_RADIUS).normalize()
  const end = latLonToVector3(target.lat, target.lon, ROUTE_RADIUS).normalize()
  const dot = THREE.MathUtils.clamp(start.dot(end), -0.9999, 0.9999)
  const angle = Math.acos(dot)
  const axis = new THREE.Vector3().crossVectors(start, end).normalize()
  if (axis.lengthSq() < 0.001) axis.set(0, 1, 0)
  return Array.from({ length: 33 }, (_, index) => {
    const progress = index / 32
    const vector = start.clone().applyAxisAngle(axis, angle * progress)
    const lift = Math.sin(progress * Math.PI) * Math.min(0.42, 0.18 + angle * 0.16)
    return vector.multiplyScalar(ROUTE_RADIUS + lift)
  })
}

function MobilizationRoute({ campaign, origin, target, reducedMotion }: RouteProps) {
  const markerRef = useRef<THREE.Group>(null)
  const targetRingRef = useRef<THREE.Mesh>(null)
  const points = useMemo(() => routePoints(origin, target), [origin, target])
  const color = campaign.phase === 'mobilizing' ? '#ffc857' : '#ff544d'
  const targetPosition = useMemo(() => latLonToVector3(target.lat, target.lon, PLANET.radius + 0.12), [target])
  const targetQuaternion = useMemo(() => new THREE.Quaternion().setFromUnitVectors(UP, targetPosition.clone().normalize()), [targetPosition])

  useFrame(({ clock }) => {
    const marker = markerRef.current
    if (!marker) return
    const rawProgress = reducedMotion ? 0.58 : (clock.elapsedTime * 0.09 + campaign.id * 0.137) % 1
    const scaled = rawProgress * (points.length - 1)
    const index = Math.min(points.length - 2, Math.floor(scaled))
    marker.position.lerpVectors(points[index], points[index + 1], scaled - index)
    marker.position.normalize().multiplyScalar(PLANET.radius + 0.2)
    marker.quaternion.setFromUnitVectors(UP, marker.position.clone().normalize())
    if (!reducedMotion) marker.rotateZ(Math.sin(clock.elapsedTime * 2.6 + campaign.id) * 0.08)
    if (targetRingRef.current && !reducedMotion) {
      const pulse = 1 + Math.sin(clock.elapsedTime * 3.4 + campaign.id) * 0.16
      targetRingRef.current.scale.setScalar(pulse)
    }
  })

  return (
    <group name={`mobilization-${campaign.id}`}>
      <Line
        points={points}
        color={color}
        lineWidth={campaign.phase === 'mobilizing' ? 2 : 2.8}
        transparent
        opacity={0.78}
        dashed
        dashSize={0.09}
        gapSize={0.055}
        depthWrite={false}
        raycast={() => undefined}
      />
      <group ref={markerRef} scale={0.11} raycast={() => undefined}>
        <mesh position={[0, 0, 0.12]} raycast={() => undefined}>
          <octahedronGeometry args={[0.62, 0]} />
          <meshStandardMaterial color={color} emissive={color} emissiveIntensity={1.4} roughness={0.3} />
        </mesh>
        <mesh position={[0.34, 0, 0.18]} rotation={[0, 0.45, 0]} raycast={() => undefined}>
          <boxGeometry args={[0.7, 0.08, 0.52]} />
          <meshStandardMaterial color={campaign.phase === 'mobilizing' ? '#f7d995' : '#ffb0a8'} emissive={color} emissiveIntensity={0.45} />
        </mesh>
      </group>
      <mesh ref={targetRingRef} position={targetPosition} quaternion={targetQuaternion} raycast={() => undefined}>
        <torusGeometry args={[Math.max(0.105, target.angularRadius * PLANET.radius * 1.35), 0.018, 8, 40]} />
        <meshBasicMaterial color={color} transparent opacity={0.86} blending={THREE.AdditiveBlending} depthWrite={false} />
      </mesh>
      <pointLight position={targetPosition} color={color} intensity={campaign.phase === 'mobilizing' ? 0.6 : 1.1} distance={0.65} decay={2} />
    </group>
  )
}

export default function MobilizationRoutes({ campaigns, territories, reducedMotion }: MobilizationRoutesProps) {
  const territoryById = useMemo(() => new Map(territories.map(territory => [territory.id, territory])), [territories])
  return (
    <group name="aetheris-live-mobilizations">
      {campaigns.slice(0, 20).map(campaign => {
        const origin = territoryById.get(campaign.originTerritoryId)
        const target = territoryById.get(campaign.territoryId)
        if (!origin || !target) return null
        return <MobilizationRoute key={campaign.id} campaign={campaign} origin={origin} target={target} reducedMotion={reducedMotion} />
      })}
    </group>
  )
}
