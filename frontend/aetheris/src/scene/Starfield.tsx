import { useMemo } from 'react'
import { Stars } from '@react-three/drei'
import * as THREE from 'three'
import { STARFIELD, WORLD_GRAPHICS } from '../config'
import type { PerfTier } from '../types'

interface StarfieldProps {
  tier: PerfTier
}

const VERTEX_SHADER = `
  varying vec3 vDirection;
  void main() {
    vec4 worldPosition = modelMatrix * vec4(position, 1.0);
    vDirection = normalize(worldPosition.xyz);
    gl_Position = projectionMatrix * viewMatrix * worldPosition;
  }
`

const FRAGMENT_SHADER = `
  varying vec3 vDirection;

  void main() {
    vec3 dir = normalize(vDirection);
    float horizon = smoothstep(-0.35, 0.75, dir.y);
    float spiral = sin(dir.x * 8.4 + dir.z * 6.2 + sin(dir.y * 7.0) * 1.6);
    float nebula = smoothstep(0.28, 1.0, spiral * 0.5 + 0.5) * smoothstep(-0.85, 0.2, dir.y);
    float polar = smoothstep(0.62, 1.0, abs(dir.y));
    vec3 deep = vec3(0.006, 0.012, 0.030);
    vec3 blue = vec3(0.015, 0.075, 0.135);
    vec3 violet = vec3(0.085, 0.035, 0.145);
    vec3 cyan = vec3(0.018, 0.20, 0.28);
    vec3 color = mix(deep, blue, horizon * 0.55);
    color += violet * nebula * 0.38;
    color += cyan * polar * 0.18;
    gl_FragColor = vec4(color, 1.0);
  }
`

function NebulaBackdrop() {
  const geometry = useMemo(() => new THREE.SphereGeometry(WORLD_GRAPHICS.backdropRadius, 32, 32), [])
  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: VERTEX_SHADER,
        fragmentShader: FRAGMENT_SHADER,
        side: THREE.BackSide,
        depthWrite: false,
        depthTest: false,
      }),
    [],
  )

  return <mesh geometry={geometry} material={material} frustumCulled={false} name="aetheris-nebula-backdrop" />
}

// Fixed deep-space scene backdrop; it stays outside the planet wrapper so it never
// reads like a flat texture painted onto the globe.
export default function Starfield({ tier }: StarfieldProps) {
  return (
    <>
      <NebulaBackdrop />
      <Stars radius={100} depth={50} count={STARFIELD[tier]} factor={4.8} saturation={0.32} fade speed={0.42} />
    </>
  )
}
