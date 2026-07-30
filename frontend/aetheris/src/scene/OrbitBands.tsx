import { useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { PLANET, WORLD_GRAPHICS } from '../config'

interface BandDef {
  id: string
  radius: number
  color: string
  opacity: number
  rotation: [number, number, number]
  speed: number
}

const BANDS: BandDef[] = [
  { id: 'equatorial-claim-grid', radius: 1.0, color: '#55d8ff', opacity: 0.25, rotation: [1.46, 0.18, 0.08], speed: 0.014 },
  { id: 'war-path-amber', radius: 1.06, color: '#ffe99a', opacity: 0.18, rotation: [1.14, -0.52, 0.28], speed: -0.01 },
  { id: 'void-orbit', radius: 0.92, color: '#c46bff', opacity: 0.2, rotation: [1.8, 0.84, -0.22], speed: 0.018 },
]

export default function OrbitBands({ paused = false }: { paused?: boolean }) {
  const groupRef = useRef<THREE.Group>(null)
  const geometry = useMemo(
    () =>
      new THREE.TorusGeometry(
        PLANET.radius * WORLD_GRAPHICS.orbitBandRadiusScale,
        WORLD_GRAPHICS.orbitBandTube,
        8,
        192,
      ),
    [],
  )
  const materials = useMemo(
    () =>
      BANDS.map((band) =>
        new THREE.MeshBasicMaterial({
          color: band.color,
          transparent: true,
          opacity: band.opacity,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          toneMapped: false,
        }),
      ),
    [],
  )

  useFrame((_, delta) => {
    if (paused || !groupRef.current) return
    groupRef.current.children.forEach((child, index) => {
      child.rotation.z += BANDS[index].speed * delta
    })
  })

  return (
    <group ref={groupRef} name="territory-orbit-bands">
      {BANDS.map((band, index) => (
        <mesh
          key={band.id}
          geometry={geometry}
          material={materials[index]}
          scale={[band.radius, band.radius, band.radius]}
          rotation={band.rotation}
          renderOrder={4}
          raycast={() => undefined}
        />
      ))}
    </group>
  )
}
