import * as THREE from 'three';
import { PLANET } from './config.js';

function hexToRgb(hex) {
  const value = parseInt(hex.slice(1), 16);
  return [((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255];
}

function biomeColorAtLat(biomes, latDegrees) {
  const match = biomes.find((b) => latDegrees >= b.latBand[0] && latDegrees <= b.latBand[1]);
  const biome = match || biomes[biomes.length - 1];
  return hexToRgb(biome.baseColor);
}

// Blends toward a biome's neighbor near band edges so the banding isn't a hard seam.
function blendedColorAtLat(biomes, latDegrees, blendDegrees = 4) {
  const base = biomeColorAtLat(biomes, latDegrees);
  const above = biomeColorAtLat(biomes, latDegrees + blendDegrees);
  const below = biomeColorAtLat(biomes, latDegrees - blendDegrees);
  return [
    (base[0] * 2 + above[0] + below[0]) / 4,
    (base[1] * 2 + above[1] + below[1]) / 4,
    (base[2] * 2 + above[2] + below[2]) / 4,
  ];
}

export function createPlanetMesh(biomes) {
  const geometry = new THREE.IcosahedronGeometry(PLANET.radius, PLANET.icosahedronDetail);
  const positions = geometry.attributes.position;
  const colors = new Float32Array(positions.count * 3);

  for (let i = 0; i < positions.count; i += 1) {
    const y = positions.getY(i);
    const latRad = Math.asin(Math.max(-1, Math.min(1, y / PLANET.radius)));
    const latDegrees = (latRad * 180) / Math.PI;
    const [r, g, b] = blendedColorAtLat(biomes, latDegrees);
    colors[i * 3] = r;
    colors[i * 3 + 1] = g;
    colors[i * 3 + 2] = b;
  }

  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.55,
    metalness: 0.2,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'planet-surface';
  return mesh;
}
