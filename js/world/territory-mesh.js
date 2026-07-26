import * as THREE from 'three';
import { PLANET } from './config.js';
import { buildShapeFootprint, SHAPE_IDS } from './shape-library.js';
import { getBiomeById } from './biome-data.js';

const DEG2RAD = Math.PI / 180;
const EXTRUDE_DEPTH = 0.05;
const SURFACE_OFFSET = 0.01; // lift footprints slightly above the base sphere to avoid z-fighting

export function latLonToVector3(lat, lon, radius) {
  const phi = (90 - lat) * DEG2RAD;
  const theta = (lon + 180) * DEG2RAD;
  return new THREE.Vector3(
    -radius * Math.sin(phi) * Math.cos(theta),
    radius * Math.cos(phi),
    radius * Math.sin(phi) * Math.sin(theta),
  );
}

function buildShapeGeometry(shapeId) {
  const { outer, holes } = buildShapeFootprint(shapeId);
  const shape = new THREE.Shape(outer.map(([x, y]) => new THREE.Vector2(x, y)));
  holes.forEach((holePoints) => {
    shape.holes.push(new THREE.Path(holePoints.map(([x, y]) => new THREE.Vector2(x, y))));
  });

  const geometry = new THREE.ExtrudeGeometry(shape, { depth: EXTRUDE_DEPTH, bevelEnabled: false, curveSegments: 8 });
  geometry.translate(0, 0, -EXTRUDE_DEPTH / 2);
  return geometry;
}

function hexToThreeColor(hex) {
  return new THREE.Color(hex);
}

// Groups all 100 territories by shapeId (not by biome) so we get one InstancedMesh per
// shape archetype (~8-9 draw calls total) rather than one per territory. Biome identity
// comes through per-instance color; shape geometry is shared and reused across biomes.
export function buildTerritoryMeshes(territories, biomes) {
  const group = new THREE.Group();
  group.name = 'territories';
  const territoryIndex = new Map(); // `${shapeId}::${instanceId}` -> Territory
  const meshByShapeId = new Map(); // shapeId -> InstancedMesh
  const instanceLookup = new Map(); // territory.id -> { shapeId, instanceIndex, baseColor }

  SHAPE_IDS.forEach((shapeId) => {
    const shapeTerritories = territories.filter((t) => t.shapeId === shapeId);
    if (shapeTerritories.length === 0) return;

    const geometry = buildShapeGeometry(shapeId);
    const material = new THREE.MeshStandardMaterial({
      roughness: 0.45,
      metalness: 0.35,
    });

    const mesh = new THREE.InstancedMesh(geometry, material, shapeTerritories.length);
    mesh.name = `territory-shape-${shapeId}`;

    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    const up = new THREE.Vector3(0, 0, 1);

    shapeTerritories.forEach((territory, i) => {
      const surfacePoint = latLonToVector3(territory.lat, territory.lon, PLANET.radius + SURFACE_OFFSET);
      const normal = surfacePoint.clone().normalize();

      quaternion.setFromUnitVectors(up, normal);
      const spin = new THREE.Quaternion().setFromAxisAngle(normal, territory.rotation);
      quaternion.premultiply(spin);

      const arcLength = territory.angularRadius * PLANET.radius;
      scale.set(arcLength, arcLength, 1);

      matrix.compose(surfacePoint, quaternion, scale);
      mesh.setMatrixAt(i, matrix);
      const baseColor = hexToThreeColor(territory.colorHex);
      mesh.setColorAt(i, baseColor);

      territoryIndex.set(`${shapeId}::${i}`, territory);
      instanceLookup.set(territory.id, { shapeId, instanceIndex: i, baseColor });
    });

    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.userData.shapeId = shapeId;
    meshByShapeId.set(shapeId, mesh);
    group.add(mesh);
  });

  return { group, territoryIndex, meshByShapeId, instanceLookup };
}

export { getBiomeById };
