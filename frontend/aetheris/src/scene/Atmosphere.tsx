import { useMemo } from 'react'
import type { RefObject } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { PLANET, ATMOSPHERE } from '../config'

const VERTEX_SHADER = `
  varying vec3 vNormal;
  varying vec3 vViewDir;
  void main() {
    vNormal = normalize(normalMatrix * normal);
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    vViewDir = normalize(-mvPosition.xyz);
    gl_Position = projectionMatrix * mvPosition;
  }
`

const FRAGMENT_SHADER = `
  uniform vec3 glowColor;
  uniform float glowPower;
  uniform float introOpacity;
  varying vec3 vNormal;
  varying vec3 vViewDir;
  void main() {
    float viewDot = abs(dot(normalize(vNormal), normalize(vViewDir)));
    float rim = pow(1.0 - viewDot, glowPower);
    gl_FragColor = vec4(glowColor, rim * 0.52 * introOpacity);
  }
`

interface AtmosphereProps {
  // 0-1, imperatively driven by the intro sequence (ref, not state, so the fade doesn't
  // trigger React re-renders every frame). Defaults to fully visible for reduced-motion.
  introOpacityRef?: RefObject<number>
}

export default function Atmosphere({ introOpacityRef }: AtmosphereProps) {
  const geometry = useMemo(() => new THREE.SphereGeometry(PLANET.radius * ATMOSPHERE.radiusScale, 48, 48), [])
  const innerGeometry = useMemo(() => new THREE.SphereGeometry(PLANET.radius * ATMOSPHERE.innerRadiusScale, 48, 48), [])
  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        uniforms: {
          glowColor: { value: new THREE.Color(ATMOSPHERE.color) },
          glowPower: { value: ATMOSPHERE.glowPower },
          introOpacity: { value: 1 },
        },
        vertexShader: VERTEX_SHADER,
        fragmentShader: FRAGMENT_SHADER,
        transparent: true,
        depthWrite: false,
        side: THREE.BackSide,
        blending: THREE.AdditiveBlending,
      }),
    [],
  )
  const innerMaterial = useMemo(
    () =>
      new THREE.ShaderMaterial({
        uniforms: {
          glowColor: { value: new THREE.Color(ATMOSPHERE.innerColor) },
          glowPower: { value: 2.2 },
          introOpacity: { value: 1 },
        },
        vertexShader: VERTEX_SHADER,
        fragmentShader: FRAGMENT_SHADER,
        transparent: true,
        depthWrite: false,
        side: THREE.FrontSide,
        blending: THREE.AdditiveBlending,
      }),
    [],
  )

  useFrame(() => {
    if (introOpacityRef?.current == null) return
    material.uniforms.introOpacity.value = introOpacityRef.current
    innerMaterial.uniforms.introOpacity.value = introOpacityRef.current * 0.5
  })

  return (
    <>
      <mesh
        geometry={innerGeometry}
        material={innerMaterial}
        renderOrder={7}
        raycast={() => undefined}
        name="inner-airglow"
      />
      <mesh
        geometry={geometry}
        material={material}
        renderOrder={8}
        raycast={() => undefined}
        name="atmosphere"
      />
    </>
  )
}
