import { useMemo, useRef } from 'react'
import type { RefObject } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { PLANET, CLOUDS, WORLD_SEED, mulberry32 } from '../config'

// Procedurally-generated soft-blotch alpha map (Canvas 2D, no image asset) — same
// philosophy as the particle sprite texture in particleSystemBase.ts. Three.js reads
// alphaMap from the texture's green channel, so blotches are drawn in white/gray.
function createCloudAlphaTexture(seed: number): THREE.CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = 512
  canvas.height = 256
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#000000'
  ctx.fillRect(0, 0, canvas.width, canvas.height)

  const rng = mulberry32(seed)
  const blobCount = 46
  for (let i = 0; i < blobCount; i += 1) {
    const x = rng() * canvas.width
    const y = rng() * canvas.height
    const radius = 20 + rng() * 60
    const alpha = 0.35 + rng() * 0.5
    const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius)
    gradient.addColorStop(0, `rgba(255,255,255,${alpha})`)
    gradient.addColorStop(1, 'rgba(255,255,255,0)')
    ctx.fillStyle = gradient
    ctx.beginPath()
    ctx.arc(x, y, radius, 0, Math.PI * 2)
    ctx.fill()
  }

  const texture = new THREE.CanvasTexture(canvas)
  texture.wrapS = THREE.RepeatWrapping
  texture.wrapT = THREE.ClampToEdgeWrapping
  return texture
}

interface CloudsProps {
  // 0-1, imperatively driven by the intro sequence. Defaults to fully visible.
  introOpacityRef?: RefObject<number>
}

// Rendered as a child of the same rotating wrapper group as Planet/Territories (so it
// moves with user drag/auto-rotate like a real cloud layer over the planet), plus a
// small independent extra rotation each frame for a parallax "clouds drift on their
// own" feel on top of that shared rotation.
export default function Clouds({ introOpacityRef }: CloudsProps) {
  const meshRef = useRef<THREE.Mesh>(null)
  const geometry = useMemo(() => new THREE.SphereGeometry(PLANET.radius * CLOUDS.radiusScale, 48, 48), [])
  const alphaMap = useMemo(() => createCloudAlphaTexture(WORLD_SEED + 7), [])
  const material = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        color: new THREE.Color(CLOUDS.color),
        alphaMap,
        transparent: true,
        depthWrite: false,
        opacity: 0,
      }),
    [alphaMap],
  )

  useFrame((_, delta) => {
    if (meshRef.current) {
      meshRef.current.rotation.y += CLOUDS.driftRadiansPerSecond * delta
    }
    const introOpacity = introOpacityRef?.current ?? 1
    material.opacity = CLOUDS.baseOpacity * introOpacity
  })

  return <mesh ref={meshRef} geometry={geometry} material={material} name="clouds" />
}
