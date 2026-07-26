import * as THREE from 'three';
import { mulberry32, PLANET } from '../config.js';
import { getBiomeById } from '../biome-data.js';
import { sampleLatInBand } from '../territory-placement.js';
import { latLonToVector3 } from '../territory-mesh.js';
import { createParticleSystem } from './particle-system-base.js';

function randomInRange(rng, min, max) {
  return min + rng() * (max - min);
}

function tangentVector(normal, rng) {
  const arbitrary = Math.abs(normal.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
  const tangent = new THREE.Vector3().crossVectors(normal, arbitrary).normalize();
  const bitangent = new THREE.Vector3().crossVectors(normal, tangent).normalize();
  const angle = rng() * Math.PI * 2;
  return tangent.multiplyScalar(Math.cos(angle)).add(bitangent.multiplyScalar(Math.sin(angle)));
}

function setColorFromHex(state, i, hex) {
  const c = new THREE.Color(hex);
  state.colors[i * 3] = c.r;
  state.colors[i * 3 + 1] = c.g;
  state.colors[i * 3 + 2] = c.b;
}

// One shared "ambient sparkle" behavior — gentle outward bob + tangential drift, recolored
// per biome — used for the 6 biomes that don't get bespoke flagship particle treatment
// in this phase (see plan doc for the flagship-vs-ambient split).
export function createAmbientBiomeParticles(biomeId, count, seed) {
  const rng = mulberry32(seed);
  const biome = getBiomeById(biomeId);
  const palette = [biome.accentColor, biome.accentColor, '#ffffff'];

  return createParticleSystem({
    count,
    blending: THREE.NormalBlending,
    respawn(i, state) {
      const lat = sampleLatInBand(biome.latBand, rng);
      const lon = rng() * 360 - 180;
      const normal = latLonToVector3(lat, lon, 1);
      const height = PLANET.radius + randomInRange(rng, 0.01, 0.06);
      const position = normal.clone().multiplyScalar(height);
      const drift = tangentVector(normal, rng).multiplyScalar(randomInRange(rng, 0.008, 0.02));
      const bob = normal.clone().multiplyScalar(randomInRange(rng, -0.006, 0.012));

      state.positions[i * 3] = position.x;
      state.positions[i * 3 + 1] = position.y;
      state.positions[i * 3 + 2] = position.z;
      state.velocities[i * 3] = drift.x + bob.x;
      state.velocities[i * 3 + 1] = drift.y + bob.y;
      state.velocities[i * 3 + 2] = drift.z + bob.z;
      setColorFromHex(state, i, palette[Math.floor(rng() * palette.length)]);
      state.sizes[i] = randomInRange(rng, 1.5, 3);
      state.maxLife[i] = randomInRange(rng, 2.5, 5);
      state.life[i] = state.maxLife[i];
    },
  });
}

const AMBIENT_BIOME_CONFIG = [
  { biomeId: 'emerald-grasslands', count: 450, seed: 51 },
  { biomeId: 'ancient-jungle', count: 400, seed: 52 },
  { biomeId: 'whispering-desert', count: 350, seed: 53 },
  { biomeId: 'toxic-expanse', count: 300, seed: 54 },
  { biomeId: 'crystal-lakes', count: 300, seed: 55 },
  { biomeId: 'thunder-highlands', count: 200, seed: 56 },
];

export function createAmbientParticleSystems() {
  return AMBIENT_BIOME_CONFIG.map(({ biomeId, count, seed }) => ({
    biomeId,
    system: createAmbientBiomeParticles(biomeId, count, seed),
  }));
}
