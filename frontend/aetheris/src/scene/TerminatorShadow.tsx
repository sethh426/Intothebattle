import { useMemo } from 'react'
import type { RefObject } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { PLANET, WORLD_GRAPHICS } from '../config'
import type { PerfTier } from '../types'

const VERTEX_SHADER = `
  varying vec3 vNormal;
  varying vec3 vViewDir;
  void main() {
    vNormal = normalize(normal);
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    vViewDir = normalize(-mvPosition.xyz);
    gl_Position = projectionMatrix * mvPosition;
  }
`

const FRAGMENT_SHADER = `
  uniform vec3 sunDirection;
  varying vec3 vNormal;
  varying vec3 vViewDir;

  void main() {
    float sunlight = dot(normalize(vNormal), normalize(sunDirection));
    float night = smoothstep(0.18, -0.38, sunlight);
    float viewFade = smoothstep(0.04, 0.46, abs(dot(normalize(vNormal), normalize(vViewDir))));
    float terminator = 1.0 - smoothstep(0.02, 0.22, abs(sunlight));
    vec3 shadow = mix(vec3(0.010, 0.018, 0.045), vec3(0.018, 0.007, 0.052), night);
    float alpha = (night * 0.62 + terminator * 0.12) * viewFade;
    gl_FragColor = vec4(shadow, alpha);
  }
`

interface TerminatorShadowProps {
  sunDirectionRef: RefObject<THREE.Vector3 | null>
  perfTier: PerfTier
}

export default function TerminatorShadow({ sunDirectionRef, perfTier }: TerminatorShadowProps) {
  const geometry = useMemo(
    () => {
      const segments = perfTier === 'high' ? 64 : perfTier === 'medium' ? 48 : 32
      return new THREE.SphereGeometry(PLANET.radius + WORLD_GRAPHICS.terminatorRadiusOffset, segments, segments)
    },
    [perfTier],
  )
  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        uniforms: {
          sunDirection: { value: new THREE.Vector3(0, 0, 1) },
        },
        vertexShader: VERTEX_SHADER,
        fragmentShader: FRAGMENT_SHADER,
        transparent: true,
        depthWrite: false,
      }),
    [],
  )

  useFrame(() => {
    if (sunDirectionRef.current) material.uniforms.sunDirection.value.copy(sunDirectionRef.current)
  })

  return (
    <mesh
      geometry={geometry}
      material={material}
      renderOrder={3}
      raycast={() => undefined}
      name="terminator-shadow"
    />
  )
}
