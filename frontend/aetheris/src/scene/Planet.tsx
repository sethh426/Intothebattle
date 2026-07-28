import { useMemo } from 'react'
import * as THREE from 'three'
import { PLANET } from '../config'
import type { Biome } from '../types'

const DEG2RAD = Math.PI / 180
const SHADOW = new THREE.Color('#050817')

function clamp(value: number, min = 0, max = 1): number {
  return Math.min(max, Math.max(min, value))
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const x = clamp((value - edge0) / (edge1 - edge0))
  return x * x * (3 - 2 * x)
}

function biomeAtLat(biomes: Biome[], latDegrees: number): Biome {
  return biomes.find((b) => latDegrees >= b.latBand[0] && latDegrees <= b.latBand[1]) ?? biomes[biomes.length - 1]
}

function terrainNoise(latDegrees: number, lonDegrees: number): number {
  const lat = latDegrees * DEG2RAD
  const lon = lonDegrees * DEG2RAD
  const continent = Math.sin(lon * 2.8 + Math.sin(lat * 3.2) * 1.6)
  const ridges = Math.sin(lon * 7.4 - lat * 4.6 + Math.cos(lon * 1.7) * 1.2)
  const veins = Math.sin((lon + lat) * 12.8 + Math.sin(lon * 3.1) * 0.9)
  return continent * 0.48 + ridges * 0.34 + veins * 0.18
}

function biomeEdgeBlend(biomes: Biome[], biome: Biome, latDegrees: number): THREE.Color {
  const base = new THREE.Color(biome.baseColor)
  const distanceToEdge = Math.min(latDegrees - biome.latBand[0], biome.latBand[1] - latDegrees)
  const edgeBlend = 1 - smoothstep(0, 5.5, distanceToEdge)
  if (edgeBlend <= 0.001) return base

  const neighborLat = latDegrees <= (biome.latBand[0] + biome.latBand[1]) / 2
    ? latDegrees - 6
    : latDegrees + 6
  const neighbor = biomeAtLat(biomes, neighborLat)
  if (neighbor.id === biome.id) return base
  return base.lerp(new THREE.Color(neighbor.baseColor), edgeBlend * 0.34)
}

function enrichBiomeColor(biomes: Biome[], latDegrees: number, lonDegrees: number): THREE.Color {
  const biome = biomeAtLat(biomes, latDegrees)
  const base = biomeEdgeBlend(biomes, biome, latDegrees)
  const accent = new THREE.Color(biome.accentColor)
  const terrain = terrainNoise(latDegrees, lonDegrees)
  const ridge = clamp((terrain + 1) / 2)
  const color = base.lerp(accent, 0.18 + ridge * 0.34)

  const latitudeLight = Math.cos(latDegrees * DEG2RAD) * 0.06
  const valleyShade = clamp(-terrain) * 0.2
  color.lerp(SHADOW, valleyShade)

  const hsl = { h: 0, s: 0, l: 0 }
  color.getHSL(hsl)
  color.setHSL(
    hsl.h,
    clamp(hsl.s * 1.32 + 0.1),
    clamp(hsl.l + latitudeLight + terrain * 0.055, 0.08, 0.72),
  )

  return color
}

interface PlanetProps {
  biomes: Biome[]
}

export default function Planet({ biomes }: PlanetProps) {
  const geometry = useMemo(() => {
    const geom = new THREE.IcosahedronGeometry(PLANET.radius, PLANET.icosahedronDetail)
    const positions = geom.attributes.position
    const colors = new Float32Array(positions.count * 3)
    const vertex = new THREE.Vector3()

    for (let i = 0; i < positions.count; i += 1) {
      vertex.fromBufferAttribute(positions, i).normalize()
      const latRad = Math.asin(clamp(vertex.y, -1, 1))
      const latDegrees = (latRad * 180) / Math.PI
      const lonDegrees = (Math.atan2(vertex.z, vertex.x) * 180) / Math.PI
      const terrain = terrainNoise(latDegrees, lonDegrees)
      const elevation = PLANET.radius * (1 + terrain * 0.012)
      positions.setXYZ(i, vertex.x * elevation, vertex.y * elevation, vertex.z * elevation)

      const color = enrichBiomeColor(biomes, latDegrees, lonDegrees)
      colors[i * 3] = color.r
      colors[i * 3 + 1] = color.g
      colors[i * 3 + 2] = color.b
    }

    geom.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    geom.computeVertexNormals()
    return geom
  }, [biomes])

  return (
    <mesh geometry={geometry} name="planet-surface">
      <meshStandardMaterial
        vertexColors
        roughness={0.68}
        metalness={0.08}
        emissive="#071224"
        emissiveIntensity={0.1}
      />
    </mesh>
  )
}
