import * as THREE from 'three'
import { mulberry32, PLANET, AURORA } from '../config'
import { sampleLatInBand } from '../data/territoryPlacement'
import { latLonToVector3 } from '../scene/geo'
import { createParticleSystem, type ParticleState, type ParticleSystemHandle } from './particleSystemBase'

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

// A slow-drifting shimmer curtain above Frozen Crown's polar band, sitting outside the
// atmosphere shell rather than on the planet surface -- an always-present sky phenomenon
// (not a weather mode). Reuses the same shared particle-emitter/shader as every other
// biome system; no new rendering infrastructure needed.
export function createAuroraParticles(seed = 61): ParticleSystemHandle {
  const rng = mulberry32(seed)

  return createParticleSystem({
    count: AURORA.count,
    respawn(i, state) {
      const lat = sampleLatInBand(AURORA.latBand, rng)
      const lon = rng() * 360 - 180
      const radiusScale = randomInRange(rng, AURORA.radiusMinScale, AURORA.radiusMaxScale)
      const position = latLonToVector3(lat, lon, PLANET.radius * radiusScale)
      const normal = position.clone().normalize()
      const drift = tangentVector(normal, rng).multiplyScalar(randomInRange(rng, 0.01, 0.03))

      state.positions[i * 3] = position.x
      state.positions[i * 3 + 1] = position.y
      state.positions[i * 3 + 2] = position.z
      state.velocities[i * 3] = drift.x
      state.velocities[i * 3 + 1] = drift.y
      state.velocities[i * 3 + 2] = drift.z
      setColorFromHex(state, i, AURORA.colors[Math.floor(rng() * AURORA.colors.length)])
      state.sizes[i] = randomInRange(rng, 3, 7)
      state.maxLife[i] = randomInRange(rng, 4, 8)
      state.life[i] = state.maxLife[i]
    },
    blending: THREE.AdditiveBlending,
  })
}
