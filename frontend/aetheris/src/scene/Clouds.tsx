import { useMemo, useRef } from 'react'
import type { RefObject } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { PLANET, CLOUDS, WORLD_SEED, mulberry32 } from '../config'
import type { PerfTier } from '../types'

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
  const blobCount = 82
  for (let i = 0; i < blobCount; i += 1) {
    const x = rng() * canvas.width
    const band = Math.sin((x / canvas.width) * Math.PI * 2 + rng() * Math.PI) * 0.12
    const y = canvas.height * (0.5 + band + (rng() - 0.5) * 0.66)
    const radius = 14 + rng() * 54
    const alpha = 0.24 + rng() * 0.58
    const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius)
    gradient.addColorStop(0, `rgba(255,255,255,${alpha})`)
    gradient.addColorStop(1, 'rgba(255,255,255,0)')
    ctx.fillStyle = gradient
    ctx.beginPath()
    ctx.arc(x, y, radius, 0, Math.PI * 2)
    ctx.fill()
  }

  ctx.globalCompositeOperation = 'screen'
  for (let i = 0; i < 9; i += 1) {
    const y = canvas.height * (0.12 + rng() * 0.76)
    const alpha = 0.08 + rng() * 0.12
    const gradient = ctx.createLinearGradient(0, y - 18, canvas.width, y + 18)
    gradient.addColorStop(0, 'rgba(255,255,255,0)')
    gradient.addColorStop(0.5, `rgba(255,255,255,${alpha})`)
    gradient.addColorStop(1, 'rgba(255,255,255,0)')
    ctx.fillStyle = gradient
    ctx.fillRect(0, y - 16, canvas.width, 32)
  }

  const texture = new THREE.CanvasTexture(canvas)
  texture.wrapS = THREE.RepeatWrapping
  texture.wrapT = THREE.ClampToEdgeWrapping
  return texture
}

interface CloudsProps {
  // 0-1, imperatively driven by the intro sequence. Defaults to fully visible.
  introOpacityRef?: RefObject<number>
  perfTier: PerfTier
}

// Rendered as a child of the same rotating wrapper group as Planet/Territories (so it
// moves with user drag/auto-rotate like a real cloud layer over the planet), plus a
// small independent extra rotation each frame for a parallax "clouds drift on their
// own" feel on top of that shared rotation.
export default function Clouds({ introOpacityRef, perfTier }: CloudsProps) {
  const meshRef = useRef<THREE.Mesh>(null)
  const segments = perfTier === 'high' ? 48 : perfTier === 'medium' ? 36 : 28
  const geometry = useMemo(
    () => new THREE.SphereGeometry(PLANET.radius * CLOUDS.radiusScale, segments, segments),
    [segments],
  )
  const alphaMap = useMemo(() => createCloudAlphaTexture(WORLD_SEED + 7), [])
  const material = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        color: new THREE.Color(CLOUDS.color),
        alphaMap,
        transparent: true,
        depthWrite: false,
        blending: THREE.NormalBlending,
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

  return <mesh ref={meshRef} geometry={geometry} material={material} raycast={() => undefined} name="clouds" />
}
