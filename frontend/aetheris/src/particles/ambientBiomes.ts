import * as THREE from 'three'
import { mulberry32, PLANET } from '../config'
import { getBiomeById } from '../data/biomeData'
import { sampleLatInBand } from '../data/territoryPlacement'
import { latLonToVector3 } from '../scene/geo'
import { createParticleSystem, type ParticleState, type ParticleSystemHandle } from './particleSystemBase'
import type { BiomeParticleSystem } from './flagshipBiomes'

function randomInRange(rng: () => number, min: number, max: number): number {
  return min + rng() * (max - min)
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

// One shared "ambient sparkle" behavior — gentle outward bob + tangential drift, recolored
// per biome — used for the biomes that don't get bespoke flagship particle treatment in
// this phase (see the Aetheris plan doc for the flagship-vs-ambient split).
export function createAmbientBiomeParticles(biomeId: string, count: number, seed: number): ParticleSystemHandle {
  const rng = mulberry32(seed)
  const biome = getBiomeById(biomeId)!
  const palette = [biome.accentColor, biome.accentColor, '#ffffff']

  return createParticleSystem({
    count,
    blending: THREE.NormalBlending,
    respawn(i, state) {
      const lat = sampleLatInBand(biome.latBand, rng)
      const lon = rng() * 360 - 180
      const normal = latLonToVector3(lat, lon, 1)
      const height = PLANET.radius + randomInRange(rng, 0.01, 0.06)
      const position = normal.clone().multiplyScalar(height)
      const drift = tangentVector(normal, rng).multiplyScalar(randomInRange(rng, 0.008, 0.02))
      const bob = normal.clone().multiplyScalar(randomInRange(rng, -0.006, 0.012))

      state.positions[i * 3] = position.x
      state.positions[i * 3 + 1] = position.y
      state.positions[i * 3 + 2] = position.z
      state.velocities[i * 3] = drift.x + bob.x
      state.velocities[i * 3 + 1] = drift.y + bob.y
      state.velocities[i * 3 + 2] = drift.z + bob.z
      setColorFromHex(state, i, palette[Math.floor(rng() * palette.length)])
      state.sizes[i] = randomInRange(rng, 1.5, 3)
      state.maxLife[i] = randomInRange(rng, 2.5, 5)
      state.life[i] = state.maxLife[i]
    },
  })
}

interface AmbientBiomeConfig {
  biomeId: string
  count: number
  seed: number
}

const AMBIENT_BIOME_CONFIG: AmbientBiomeConfig[] = [
  { biomeId: 'emerald-wilds', count: 450, seed: 51 },
  { biomeId: 'ancient-jungle', count: 400, seed: 52 },
  { biomeId: 'whispering-desert', count: 350, seed: 53 },
  { biomeId: 'toxic-expanse', count: 300, seed: 54 },
  { biomeId: 'crystal-basin', count: 300, seed: 55 },
  { biomeId: 'thunder-highlands', count: 200, seed: 56 },
]

export function createAmbientParticleSystems(): BiomeParticleSystem[] {
  return AMBIENT_BIOME_CONFIG.map(({ biomeId, count, seed }) => ({
    biomeId,
    system: createAmbientBiomeParticles(biomeId, count, seed),
  }))
}
