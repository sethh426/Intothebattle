import { useMemo } from 'react'
import * as THREE from 'three'
import { PLANET, WORLD_SEED, mulberry32 } from '../config'
import { latLonToVector3 } from './geo'
import type { Biome } from '../types'

const SURFACE_RADIUS = PLANET.radius + 0.028

interface ContourLayer {
  id: string
  geometry: THREE.BufferGeometry
  colorHex: string
  opacity: number
}

interface BiomeContoursProps {
  biomes: Biome[]
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function randomInRange(rng: () => number, min: number, max: number): number {
  return min + rng() * (max - min)
}

function wrapLon(lon: number): number {
  if (lon > 180) return wrapLon(lon - 360)
  if (lon < -180) return wrapLon(lon + 360)
  return lon
}

function buildBiomeContourLayer(biome: Biome, rng: () => number): ContourLayer {
  const vertices: number[] = []
  const contourCount = Math.max(7, Math.round(biome.landCount * 0.75))
  const latPadding = Math.max(0.8, (biome.latBand[1] - biome.latBand[0]) * 0.08)
  const latMin = biome.latBand[0] + latPadding
  const latMax = biome.latBand[1] - latPadding

  for (let pathIndex = 0; pathIndex < contourCount; pathIndex += 1) {
    const startLat = randomInRange(rng, latMin, latMax)
    const startLon = randomInRange(rng, -180, 180)
    const phase = rng() * Math.PI * 2
    const heading = randomInRange(rng, -0.85, 0.85)
    const length = randomInRange(rng, 12, 34)
    const steps = 8 + Math.floor(rng() * 7)
    let previous: THREE.Vector3 | null = null

    for (let step = 0; step < steps; step += 1) {
      const t = step / (steps - 1)
      const centered = t - 0.5
      const drift = Math.sin(phase + t * Math.PI * 2.2) * randomInRange(rng, 0.8, 2.5)
      const lat = clamp(startLat + centered * length * heading + drift, latMin, latMax)
      const lon = wrapLon(startLon + centered * length + Math.sin(phase * 0.7 + t * 5.2) * 3.8)
      const point = latLonToVector3(lat, lon, SURFACE_RADIUS + pathIndex * 0.0008)

      if (previous) {
        vertices.push(previous.x, previous.y, previous.z, point.x, point.y, point.z)
      }
      previous = point
    }
  }

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3))
  geometry.computeBoundingSphere()

  return {
    id: biome.id,
    geometry,
    colorHex: biome.accentColor,
    opacity: biome.isFlagship ? 0.3 : 0.22,
  }
}

export default function BiomeContours({ biomes }: BiomeContoursProps) {
  const layers = useMemo(() => {
    const rng = mulberry32(WORLD_SEED + 77)
    return biomes.map((biome) => buildBiomeContourLayer(biome, rng))
  }, [biomes])

  return (
    <group name="biome-contours">
      {layers.map((layer) => (
        <lineSegments key={layer.id} geometry={layer.geometry} frustumCulled={false}>
          <lineBasicMaterial
            color={layer.colorHex}
            transparent
            opacity={layer.opacity}
            depthWrite={false}
            depthTest
            toneMapped={false}
          />
        </lineSegments>
      ))}
    </group>
  )
}
