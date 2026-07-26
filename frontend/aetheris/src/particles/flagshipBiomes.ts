import * as THREE from 'three'
import { mulberry32, PLANET } from '../config'
import { getBiomeById } from '../data/biomeData'
import { sampleLatInBand } from '../data/territoryPlacement'
import { latLonToVector3 } from '../scene/geo'
import { createParticleSystem, type ParticleState, type ParticleSystemHandle } from './particleSystemBase'

function randomInRange(rng: () => number, min: number, max: number): number {
  return min + rng() * (max - min)
}

function surfaceSpawn(latBand: [number, number], rng: () => number, heightRange: [number, number]) {
  const lat = sampleLatInBand(latBand, rng)
  const lon = rng() * 360 - 180
  const normal = latLonToVector3(lat, lon, 1)
  const height = PLANET.radius + randomInRange(rng, heightRange[0], heightRange[1])
  const position = normal.clone().multiplyScalar(height)
  return { position, normal }
}

function tangentVector(normal: THREE.Vector3, rng: () => number): THREE.Vector3 {
  const arbitrary = Math.abs(normal.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0)
  const tangent = new THREE.Vector3().crossVectors(normal, arbitrary).normalize()
  const bitangent = new THREE.Vector3().crossVectors(normal, tangent).normalize()
  const angle = rng() * Math.PI * 2
  return tangent.multiplyScalar(Math.cos(angle)).add(bitangent.multiplyScalar(Math.sin(angle)))
}

function setColorFromHex(state: ParticleState, i: number, hex: string): void {
  const c = new THREE.Color(hex)
  state.colors[i * 3] = c.r
  state.colors[i * 3 + 1] = c.g
  state.colors[i * 3 + 2] = c.b
}

export function createLiquidMetalSeaParticles(seed = 41): ParticleSystemHandle {
  const rng = mulberry32(seed)
  const biome = getBiomeById('liquid-blu-metal-sea')!
  const palette = [biome.accentColor, '#bfeeff', '#ffffff']

  return createParticleSystem({
    count: 550,
    respawn(i, state) {
      const { position, normal } = surfaceSpawn(biome.latBand, rng, [0.01, 0.05])
      const drift = tangentVector(normal, rng).multiplyScalar(randomInRange(rng, 0.02, 0.06))
      state.positions[i * 3] = position.x
      state.positions[i * 3 + 1] = position.y
      state.positions[i * 3 + 2] = position.z
      state.velocities[i * 3] = drift.x
      state.velocities[i * 3 + 1] = drift.y + 0.01
      state.velocities[i * 3 + 2] = drift.z
      setColorFromHex(state, i, palette[Math.floor(rng() * palette.length)])
      state.sizes[i] = randomInRange(rng, 2, 5)
      state.maxLife[i] = randomInRange(rng, 1.4, 3.2)
      state.life[i] = state.maxLife[i]
    },
  })
}

export function createMoltenWastesParticles(seed = 42): ParticleSystemHandle {
  const rng = mulberry32(seed)
  const biome = getBiomeById('molten-wastes')!
  const palette = [biome.accentColor, '#ffb347', '#6b6b6b']

  return createParticleSystem({
    count: 500,
    respawn(i, state) {
      const { position, normal } = surfaceSpawn(biome.latBand, rng, [0.0, 0.02])
      const rise = normal.clone().multiplyScalar(randomInRange(rng, 0.04, 0.09))
      const drift = tangentVector(normal, rng).multiplyScalar(randomInRange(rng, 0.005, 0.02))
      state.positions[i * 3] = position.x
      state.positions[i * 3 + 1] = position.y
      state.positions[i * 3 + 2] = position.z
      state.velocities[i * 3] = rise.x + drift.x
      state.velocities[i * 3 + 1] = rise.y + drift.y
      state.velocities[i * 3 + 2] = rise.z + drift.z
      setColorFromHex(state, i, palette[Math.floor(rng() * palette.length)])
      state.sizes[i] = randomInRange(rng, 2, 6)
      state.maxLife[i] = randomInRange(rng, 1.8, 3.6)
      state.life[i] = state.maxLife[i]
    },
  })
}

export function createFrozenCrownParticles(seed = 43): ParticleSystemHandle {
  const rng = mulberry32(seed)
  const biome = getBiomeById('frozen-crown')!
  const palette = [biome.accentColor, '#ffffff', '#e6f6ff']

  return createParticleSystem({
    count: 450,
    respawn(i, state) {
      const { position, normal } = surfaceSpawn(biome.latBand, rng, [0.05, 0.14])
      const fall = normal.clone().multiplyScalar(-randomInRange(rng, 0.015, 0.035))
      const drift = tangentVector(normal, rng).multiplyScalar(randomInRange(rng, 0.005, 0.015))
      state.positions[i * 3] = position.x
      state.positions[i * 3 + 1] = position.y
      state.positions[i * 3 + 2] = position.z
      state.velocities[i * 3] = fall.x + drift.x
      state.velocities[i * 3 + 1] = fall.y + drift.y
      state.velocities[i * 3 + 2] = fall.z + drift.z
      setColorFromHex(state, i, palette[Math.floor(rng() * palette.length)])
      state.sizes[i] = randomInRange(rng, 1.5, 3.5)
      state.maxLife[i] = randomInRange(rng, 2.5, 4.5)
      state.life[i] = state.maxLife[i]
    },
  })
}

export function createVoidScarParticles(seed = 44): ParticleSystemHandle {
  const rng = mulberry32(seed)
  const biome = getBiomeById('void-scar')!
  const palette = [biome.accentColor, '#8a4bff', '#ffffff']

  return createParticleSystem({
    count: 500,
    respawn(i, state) {
      const { position, normal } = surfaceSpawn(biome.latBand, rng, [0.02, 0.09])
      const inward = normal.clone().multiplyScalar(-randomInRange(rng, 0.01, 0.03))
      const spiral = tangentVector(normal, rng).multiplyScalar(randomInRange(rng, 0.02, 0.05))
      state.positions[i * 3] = position.x
      state.positions[i * 3 + 1] = position.y
      state.positions[i * 3 + 2] = position.z
      state.velocities[i * 3] = inward.x + spiral.x
      state.velocities[i * 3 + 1] = inward.y + spiral.y
      state.velocities[i * 3 + 2] = inward.z + spiral.z
      setColorFromHex(state, i, palette[Math.floor(rng() * palette.length)])
      state.sizes[i] = randomInRange(rng, 1.5, 4)
      state.maxLife[i] = randomInRange(rng, 2, 4)
      state.life[i] = state.maxLife[i]
    },
  })
}

export interface BiomeParticleSystem {
  biomeId: string
  system: ParticleSystemHandle
}

export function createFlagshipParticleSystems(): BiomeParticleSystem[] {
  return [
    { biomeId: 'liquid-blu-metal-sea', system: createLiquidMetalSeaParticles() },
    { biomeId: 'molten-wastes', system: createMoltenWastesParticles() },
    { biomeId: 'frozen-crown', system: createFrozenCrownParticles() },
    { biomeId: 'void-scar', system: createVoidScarParticles() },
  ]
}
