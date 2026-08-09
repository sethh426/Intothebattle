import { useMemo } from 'react'
import * as THREE from 'three'
import { PLANET } from '../config'
import { latLonToVector3 } from './geo'

interface LatLonPoint {
  lat: number
  lon: number
}

interface VeinDef {
  id: string
  color: string
  opacity: number
  radius: number
  points: LatLonPoint[]
}

const VEINS: VeinDef[] = [
  {
    id: 'emerald-river-spine',
    color: '#74ffb3',
    opacity: 0.18,
    radius: 0.0032,
    points: [
      { lat: 43, lon: -112 },
      { lat: 26, lon: -91 },
      { lat: 11, lon: -72 },
      { lat: -5, lon: -60 },
      { lat: -22, lon: -49 },
    ],
  },
  {
    id: 'molten-fault',
    color: '#ff6a35',
    opacity: 0.24,
    radius: 0.0042,
    points: [
      { lat: -18, lon: -132 },
      { lat: -22, lon: -102 },
      { lat: -27, lon: -75 },
      { lat: -33, lon: -48 },
      { lat: -40, lon: -19 },
    ],
  },
  {
    id: 'stormglass-front',
    color: '#8af6ff',
    opacity: 0.17,
    radius: 0.003,
    points: [
      { lat: 61, lon: -154 },
      { lat: 48, lon: -124 },
      { lat: 36, lon: -86 },
      { lat: 31, lon: -45 },
      { lat: 38, lon: -6 },
    ],
  },
  {
    id: 'void-meridian',
    color: '#c46bff',
    opacity: 0.2,
    radius: 0.0036,
    points: [
      { lat: -8, lon: -28 },
      { lat: -31, lon: -30 },
      { lat: -55, lon: -36 },
      { lat: -75, lon: -47 },
    ],
  },
  {
    id: 'crystal-current',
    color: '#39e4ff',
    opacity: 0.16,
    radius: 0.003,
    points: [
      { lat: -45, lon: -138 },
      { lat: -50, lon: -100 },
      { lat: -47, lon: -68 },
      { lat: -39, lon: -34 },
      { lat: -30, lon: 2 },
    ],
  },
]

function buildVeinGeometry(vein: VeinDef): THREE.TubeGeometry {
  const points = vein.points.map((point) => latLonToVector3(point.lat, point.lon, PLANET.radius + 0.028))
  const curve = new THREE.CatmullRomCurve3(points)
  return new THREE.TubeGeometry(curve, Math.max(36, points.length * 18), vein.radius, 8, false)
}

export default function RealmVeins() {
  const meshes = useMemo(
    () =>
      VEINS.map((vein) => ({
        id: vein.id,
        geometry: buildVeinGeometry(vein),
        material: new THREE.MeshBasicMaterial({
          color: vein.color,
          transparent: true,
          opacity: vein.opacity,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          toneMapped: true,
        }),
      })),
    [],
  )

  return (
    <group name="realm-veins">
      {meshes.map(({ id, geometry, material }) => (
        <mesh
          key={id}
          geometry={geometry}
          material={material}
          raycast={() => undefined}
          renderOrder={2}
        />
      ))}
    </group>
  )
}
