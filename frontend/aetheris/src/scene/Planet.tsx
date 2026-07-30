import { useEffect, useMemo } from 'react'
import { useFrame, useLoader } from '@react-three/fiber'
import * as THREE from 'three'
import { PLANET } from '../config'
import type { Biome } from '../types'
import worldAlbedoUrl from '../assets/aetheris/world-albedo.png'
import worldEmissiveUrl from '../assets/aetheris/world-emissive.png'

const DEG2RAD = Math.PI / 180
const SHADOW = new THREE.Color('#050817')
const HIGHLIGHT = new THREE.Color('#f8fff4')
const OCEAN_DEEP = new THREE.Color('#021b3d')
const OCEAN_SHALLOW = new THREE.Color('#28c8ff')
const ICE_WHITE = new THREE.Color('#f3ffff')
const MAGMA = new THREE.Color('#ff6435')
const VOID_RIFT = new THREE.Color('#c46bff')
const TOXIC_GLOW = new THREE.Color('#b6ff36')
const WHITE = new THREE.Color('#ffffff')

interface RealmPaintPatch {
  lat: number
  lon: number
  radiusDegrees: number
  color: THREE.Color
  strength: number
  mode?: 'lighten' | 'darken' | 'glow'
}

const REALM_PAINT_PATCHES: RealmPaintPatch[] = [
  { lat: 52, lon: -78, radiusDegrees: 17, color: new THREE.Color('#ffd15c'), strength: 0.42, mode: 'lighten' },
  { lat: 33, lon: -38, radiusDegrees: 18, color: new THREE.Color('#6961ff'), strength: 0.38, mode: 'glow' },
  { lat: 18, lon: -78, radiusDegrees: 22, color: new THREE.Color('#064b31'), strength: 0.46, mode: 'darken' },
  { lat: 4, lon: -116, radiusDegrees: 20, color: new THREE.Color('#0b9472'), strength: 0.34, mode: 'darken' },
  { lat: -9, lon: -72, radiusDegrees: 24, color: new THREE.Color('#0387b8'), strength: 0.42 },
  { lat: -25, lon: -54, radiusDegrees: 22, color: new THREE.Color('#ff4e2f'), strength: 0.54, mode: 'glow' },
  { lat: -42, lon: -90, radiusDegrees: 17, color: new THREE.Color('#8af6ff'), strength: 0.42, mode: 'lighten' },
  { lat: -65, lon: -34, radiusDegrees: 22, color: new THREE.Color('#7d38ff'), strength: 0.46, mode: 'glow' },
  { lat: 66, lon: -18, radiusDegrees: 13, color: new THREE.Color('#f3ffff'), strength: 0.36, mode: 'lighten' },
  { lat: -14, lon: 22, radiusDegrees: 19, color: new THREE.Color('#39e4ff'), strength: 0.32, mode: 'lighten' },
]

const OCEAN_VERTEX_SHADER = `
  uniform float time;
  varying vec3 vNormal;
  varying vec3 vWorldPosition;
  varying vec3 vViewDir;
  void main() {
    vNormal = normalize(normalMatrix * normal);
    vec4 worldPosition = modelMatrix * vec4(position, 1.0);
    vWorldPosition = worldPosition.xyz;
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    vViewDir = normalize(-mvPosition.xyz);
    gl_Position = projectionMatrix * mvPosition;
  }
`

const OCEAN_FRAGMENT_SHADER = `
  uniform float time;
  varying vec3 vNormal;
  varying vec3 vWorldPosition;
  varying vec3 vViewDir;

  void main() {
    vec3 dir = normalize(vWorldPosition);
    float lon = atan(dir.z, dir.x);
    float lat = asin(clamp(dir.y, -1.0, 1.0));
    float continents =
      sin(lon * 3.4 + sin(lat * 4.0) * 1.9 + time * 0.05) * 0.50 +
      sin(lon * 7.3 - lat * 4.2) * 0.28 +
      sin((lon + lat) * 12.0) * 0.16;
    float water = smoothstep(0.48, 0.92, continents * 0.5 + 0.5);
    float fresnel = pow(1.0 - abs(dot(normalize(vNormal), normalize(vViewDir))), 2.15);
    float shimmer = smoothstep(0.48, 1.0, sin(lon * 18.0 + lat * 8.0 + time * 0.58) * 0.5 + 0.5);
    vec3 color = mix(vec3(0.018, 0.32, 0.56), vec3(0.16, 0.86, 1.0), fresnel + shimmer * 0.25);
    float alpha = water * (0.012 + fresnel * 0.105 + shimmer * 0.014);
    gl_FragColor = vec4(color, alpha);
  }
`

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

function formationWarp(latDegrees: number, lonDegrees: number): number {
  const lat = latDegrees * DEG2RAD
  const lon = lonDegrees * DEG2RAD
  return (
    Math.sin(lon * 1.25 + Math.sin(lat * 2.4) * 1.8) * 8.2
    + Math.sin(lon * 3.6 - lat * 1.7) * 4.6
    + terrainNoise(latDegrees, lonDegrees) * 3.4
  )
}

function angularDistanceDegrees(latA: number, lonA: number, latB: number, lonB: number): number {
  const aLat = latA * DEG2RAD
  const bLat = latB * DEG2RAD
  const dLon = (lonB - lonA) * DEG2RAD
  const cosD = Math.sin(aLat) * Math.sin(bLat) + Math.cos(aLat) * Math.cos(bLat) * Math.cos(dLon)
  return (Math.acos(clamp(cosD, -1, 1)) * 180) / Math.PI
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

function oceanMask(biome: Biome, terrain: number, detail: number, latDegrees: number): number {
  const lowland = smoothstep(-0.62, -0.18, -(terrain + detail * 0.16))
  const seaBias = biome.id === 'liquid-blu-metal-sea' ? 0.62 : biome.id === 'crystal-basin' ? 0.22 : 0
  const polarFreeze = Math.abs(latDegrees) > 68 ? 0.45 : 0
  return clamp(lowland * (0.2 + seaBias * 0.38) + seaBias * 0.62 - polarFreeze, 0, 0.86)
}

function riftMask(biome: Biome, latDegrees: number, lonDegrees: number, detail: number): number {
  const lat = latDegrees * DEG2RAD
  const lon = lonDegrees * DEG2RAD
  const fissure = Math.abs(Math.sin(lon * 8.2 + lat * 4.1 + Math.sin(lon * 2.3) * 1.3))
  const volcanicBias = biome.id === 'molten-wastes' ? 1 : biome.id === 'void-scar' ? 0.75 : biome.id === 'toxic-expanse' ? 0.42 : 0
  return smoothstep(0.965, 0.998, fissure + detail * 0.016) * volcanicBias
}

function enrichBiomeColor(biomes: Biome[], latDegrees: number, lonDegrees: number): THREE.Color {
  const warpedLat = clamp(latDegrees + formationWarp(latDegrees, lonDegrees), -89.5, 89.5)
  const biome = biomeAtLat(biomes, warpedLat)
  const base = biomeEdgeBlend(biomes, biome, warpedLat)
  const accent = new THREE.Color(biome.accentColor)
  const terrain = terrainNoise(latDegrees, lonDegrees)
  const detail = terrainNoise(latDegrees * 1.6 + 13, lonDegrees * 1.4 - 29)
  const micro = terrainNoise(latDegrees * 3.8 - 41, lonDegrees * 3.2 + 19)
  const pocket = smoothstep(0.58, 0.94, Math.abs(detail))
  const ridge = clamp((terrain + 1) / 2)
  const water = oceanMask(biome, terrain, detail, latDegrees)
  const color = base.lerp(accent, 0.1 + ridge * 0.24 + pocket * 0.14)

  const pocketBiome = biomeAtLat(biomes, clamp(latDegrees + detail * 18, -89.5, 89.5))
  if (pocketBiome.id !== biome.id) {
    color.lerp(new THREE.Color(pocketBiome.baseColor), pocket * 0.24)
    color.lerp(new THREE.Color(pocketBiome.accentColor), pocket * 0.1)
  }

  const waterColor = OCEAN_DEEP.clone().lerp(OCEAN_SHALLOW, clamp((terrain + 0.8) * 0.38 + pocket * 0.14))
  if (biome.id === 'liquid-blu-metal-sea') waterColor.lerp(accent, 0.34).multiplyScalar(1.08)
  color.lerp(waterColor, water)

  REALM_PAINT_PATCHES.forEach((patch) => {
    const distance = angularDistanceDegrees(latDegrees, lonDegrees, patch.lat, patch.lon)
    const mask = 1 - smoothstep(patch.radiusDegrees * 0.42, patch.radiusDegrees, distance)
    if (mask <= 0.001) return
    const edge = Math.sin((latDegrees + lonDegrees) * DEG2RAD * 9.0 + terrain * 5.2)
    const noisyMask = clamp(mask * (0.84 + edge * 0.16))
    const blend = noisyMask * patch.strength
    color.lerp(patch.color, blend)
    if (patch.mode === 'darken') color.lerp(SHADOW, blend * 0.32)
    if (patch.mode === 'lighten') color.lerp(HIGHLIGHT, blend * 0.18)
    if (patch.mode === 'glow') color.multiplyScalar(1 + blend * 0.16)
  })

  const latitudeLight = Math.cos(latDegrees * DEG2RAD) * 0.06
  const valleyShade = clamp(-terrain) * 0.24 + pocket * 0.04 + clamp(-micro) * 0.065
  color.lerp(SHADOW, valleyShade * (1 - water * 0.45))
  if (terrain > 0.5) color.lerp(HIGHLIGHT, (terrain - 0.5) * 0.2)
  if (micro > 0.42) color.lerp(accent, (micro - 0.42) * 0.12)
  if (Math.abs(latDegrees) > 72) color.lerp(ICE_WHITE, smoothstep(72, 88, Math.abs(latDegrees)) * 0.46)

  const rift = riftMask(biome, latDegrees, lonDegrees, detail)
  if (rift > 0) {
    const riftColor = biome.id === 'void-scar' ? VOID_RIFT : biome.id === 'toxic-expanse' ? TOXIC_GLOW : MAGMA
    color.lerp(riftColor, rift * 0.72).multiplyScalar(1 + rift * 0.25)
  }

  const hsl = { h: 0, s: 0, l: 0 }
  color.getHSL(hsl)
  color.setHSL(
    hsl.h,
    clamp(hsl.s * 1.36 + 0.12),
    clamp(hsl.l + latitudeLight + terrain * 0.055 + pocket * 0.022, 0.055, 0.78),
  )

  return color
}

function elevationAt(biomes: Biome[], latDegrees: number, lonDegrees: number): number {
  const warpedLat = clamp(latDegrees + formationWarp(latDegrees, lonDegrees), -89.5, 89.5)
  const biome = biomeAtLat(biomes, warpedLat)
  const terrain = terrainNoise(latDegrees, lonDegrees)
  const detail = terrainNoise(latDegrees * 1.6 + 13, lonDegrees * 1.4 - 29)
  const water = oceanMask(biome, terrain, detail, latDegrees)
  const mountain = Math.pow(clamp(Math.abs(terrain)), 1.8) * 0.014
  return PLANET.radius * (1 + terrain * 0.021 + mountain - water * 0.01)
}

interface PlanetProps {
  biomes: Biome[]
}

export default function Planet({ biomes }: PlanetProps) {
  const albedoMap = useLoader(THREE.TextureLoader, worldAlbedoUrl)
  const emissiveMap = useLoader(THREE.TextureLoader, worldEmissiveUrl)
  useEffect(() => {
    albedoMap.colorSpace = THREE.SRGBColorSpace
    albedoMap.wrapS = THREE.RepeatWrapping
    albedoMap.wrapT = THREE.ClampToEdgeWrapping
    albedoMap.anisotropy = 8
    albedoMap.needsUpdate = true

    emissiveMap.colorSpace = THREE.SRGBColorSpace
    emissiveMap.wrapS = THREE.RepeatWrapping
    emissiveMap.wrapT = THREE.ClampToEdgeWrapping
    emissiveMap.anisotropy = 8
    emissiveMap.needsUpdate = true
  }, [albedoMap, emissiveMap])

  const geometry = useMemo(() => {
    const geom = new THREE.SphereGeometry(PLANET.radius, 160, 96)
    const positions = geom.attributes.position
    const colors = new Float32Array(positions.count * 3)
    const vertex = new THREE.Vector3()

    for (let i = 0; i < positions.count; i += 1) {
      vertex.fromBufferAttribute(positions, i).normalize()
      const latRad = Math.asin(clamp(vertex.y, -1, 1))
      const latDegrees = (latRad * 180) / Math.PI
      const lonDegrees = (Math.atan2(vertex.z, vertex.x) * 180) / Math.PI
      const elevation = elevationAt(biomes, latDegrees, lonDegrees)
      positions.setXYZ(i, vertex.x * elevation, vertex.y * elevation, vertex.z * elevation)

      const color = WHITE.clone().lerp(enrichBiomeColor(biomes, latDegrees, lonDegrees), 0.28)
      colors[i * 3] = color.r
      colors[i * 3 + 1] = color.g
      colors[i * 3 + 2] = color.b
    }

    geom.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    geom.computeVertexNormals()
    return geom
  }, [biomes])

  const oceanGeometry = useMemo(
    () => new THREE.SphereGeometry(PLANET.radius + PLANET.oceanRadiusOffset, 96, 96),
    [],
  )
  const oceanMaterial = useMemo(
    () =>
      new THREE.ShaderMaterial({
        uniforms: {
          time: { value: 0 },
        },
        vertexShader: OCEAN_VERTEX_SHADER,
        fragmentShader: OCEAN_FRAGMENT_SHADER,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    [],
  )

  useFrame(({ clock }) => {
    oceanMaterial.uniforms.time.value = clock.elapsedTime
  })

  return (
    <>
      <mesh geometry={geometry} raycast={() => undefined} name="planet-surface">
        <meshStandardMaterial
          map={albedoMap}
          vertexColors
          roughness={0.8}
          metalness={0.07}
          emissive="#071224"
          emissiveIntensity={0.11}
        />
      </mesh>
      <mesh
        geometry={oceanGeometry}
        renderOrder={3}
        raycast={() => undefined}
        name="planet-emissive-map"
      >
        <meshBasicMaterial
          map={emissiveMap}
          transparent
          opacity={0.82}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
          toneMapped={false}
        />
      </mesh>
      <mesh
        geometry={oceanGeometry}
        material={oceanMaterial}
        renderOrder={2}
        raycast={() => undefined}
        name="planet-ocean-sheen"
      />
    </>
  )
}
