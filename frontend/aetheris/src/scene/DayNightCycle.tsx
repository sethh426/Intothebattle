import { useRef } from 'react'
import type { RefObject } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { DAY_NIGHT } from '../config'

interface DayNightCycleProps {
  wrapperRef: RefObject<THREE.Object3D | null>
  sunDirectionRef: RefObject<THREE.Vector3 | null>
  paused?: boolean
}

// Slowly orbits the sun light and keeps `sunDirectionRef` updated with the sun's
// direction in the rotating wrapper group's LOCAL space, so Territories can cheaply
// dot-product it against each live territory's static local-space normal to decide
// which side of the planet is currently dark (the "kingdom lights up at night" cue).
export default function DayNightCycle({ wrapperRef, sunDirectionRef, paused = false }: DayNightCycleProps) {
  const lightRef = useRef<THREE.DirectionalLight>(null)
  const angleRef = useRef(0)
  const tmpWorldPos = useRef(new THREE.Vector3()).current

  useFrame((_, delta) => {
    if (!paused) {
      angleRef.current += (Math.PI * 2 * delta) / DAY_NIGHT.cycleSeconds
    }
    const angle = angleRef.current

    const light = lightRef.current
    if (!light) return

    light.position.set(
      Math.cos(angle) * DAY_NIGHT.orbitRadius,
      Math.sin(DAY_NIGHT.orbitTiltRadians) * DAY_NIGHT.orbitRadius,
      Math.sin(angle) * DAY_NIGHT.orbitRadius,
    )

    if (!wrapperRef.current || !sunDirectionRef.current) return
    tmpWorldPos.copy(light.position)
    wrapperRef.current.worldToLocal(tmpWorldPos)
    sunDirectionRef.current.copy(tmpWorldPos).normalize()
  })

  return (
    <>
      <ambientLight color={0x9ec8ff} intensity={0.42} />
      <hemisphereLight color={0x8ee7ff} groundColor={0x18072f} intensity={0.44} />
      <directionalLight ref={lightRef} color={0xfff0c2} intensity={2.05} position={[4, 2, 3]} />
      <pointLight color={0x55d8ff} intensity={0.52} distance={12} position={[-5, 1.5, -4]} />
    </>
  )
}
