import { mulberry32 } from './config.js';

// Each generator returns { outer: [[x,y], ...], holes: [[[x,y], ...], ...] } describing a
// closed polygon footprint in unit local space (roughly radius 1, centered at origin).
// Geometry built from these is shared across many InstancedMesh instances — per-territory
// variety comes from instance-level rotation/scale/color, not per-instance geometry, so the
// jaggedness baked in here is deterministic rather than reseeded per use.

function ring(pointCount, radiusFn) {
  const points = [];
  for (let i = 0; i < pointCount; i += 1) {
    const angle = (i / pointCount) * Math.PI * 2;
    const r = radiusFn(angle, i);
    points.push([Math.cos(angle) * r, Math.sin(angle) * r]);
  }
  return points;
}

function jaggedRadius(rng, base, jag, lobes) {
  const phases = Array.from({ length: lobes }, () => rng() * Math.PI * 2);
  const amps = Array.from({ length: lobes }, () => 0.5 + rng() * 0.5);
  return (angle) => {
    let r = base;
    for (let i = 0; i < lobes; i += 1) {
      r += Math.sin(angle * (i + 2) + phases[i]) * jag * amps[i];
    }
    return Math.max(r, base * 0.35);
  };
}

export function makeBlob(seed = 1) {
  const rng = mulberry32(seed);
  const radiusFn = jaggedRadius(rng, 1, 0.22, 3);
  return { outer: ring(24, (a) => radiusFn(a)), holes: [] };
}

export function makeCrescent(seed = 2) {
  const rng = mulberry32(seed);
  const outerR = jaggedRadius(rng, 1, 0.06, 2);
  const outer = ring(20, (a) => outerR(a));
  // A hole circle offset toward one edge carves the remaining silhouette into a crescent.
  const holeOffset = 0.34;
  const hole = ring(16, () => 0.82)
    .map(([x, y]) => [x + holeOffset, y])
    .reverse();
  return { outer, holes: [hole] };
}

export function makeStar(seed = 3, points = 5) {
  const rng = mulberry32(seed);
  const verts = [];
  for (let i = 0; i < points * 2; i += 1) {
    const angle = (i / (points * 2)) * Math.PI * 2;
    const r = i % 2 === 0 ? 1 : 0.42 + rng() * 0.1;
    verts.push([Math.cos(angle) * r, Math.sin(angle) * r]);
  }
  return { outer: verts, holes: [] };
}

export function makeHex(seed = 4) {
  const rng = mulberry32(seed);
  const r = 0.95 + rng() * 0.08;
  return { outer: ring(6, () => r), holes: [] };
}

export function makeRingIsland(seed = 5) {
  const rng = mulberry32(seed);
  const outerR = jaggedRadius(rng, 1, 0.12, 2);
  const outer = ring(20, (a) => outerR(a));
  const innerR = jaggedRadius(rng, 0.5, 0.08, 2);
  const inner = ring(16, (a) => innerR(a)).reverse();
  return { outer, holes: [inner] };
}

export function makeShard(seed = 6) {
  const rng = mulberry32(seed);
  const points = 7;
  const verts = [];
  for (let i = 0; i < points; i += 1) {
    const angle = (i / points) * Math.PI * 2;
    const r = 0.65 + rng() * 0.55;
    verts.push([Math.cos(angle) * r, Math.sin(angle) * r]);
  }
  return { outer: verts, holes: [] };
}

export function makeSpit(seed = 7) {
  const rng = mulberry32(seed);
  const half = [];
  const segments = 10;
  for (let i = 0; i <= segments; i += 1) {
    const t = i / segments;
    const x = (t - 0.5) * 2.1;
    const width = 0.18 + Math.sin(t * Math.PI) * (0.28 + rng() * 0.08);
    half.push([x, width]);
  }
  const outer = [...half, ...half.slice().reverse().map(([x, y]) => [x, -y])];
  return { outer, holes: [] };
}

export function makeCluster(seed = 8) {
  const rng = mulberry32(seed);
  const lobeCenters = [
    [-0.35, 0.1],
    [0.4, -0.15],
    [0.0, 0.4],
  ];
  const outer = [];
  const lobeR = jaggedRadius(rng, 0.55, 0.12, 3);
  lobeCenters.forEach(([cx, cy], idx) => {
    const points = ring(10, (a) => lobeR(a + idx));
    points.forEach(([x, y]) => outer.push([x + cx, y + cy]));
  });
  return { outer, holes: [] };
}

export const SHAPE_LIBRARY = {
  'blob-1': () => makeBlob(101),
  'blob-2': () => makeBlob(202),
  crescent: () => makeCrescent(303),
  star: () => makeStar(404),
  hex: () => makeHex(505),
  ring: () => makeRingIsland(606),
  shard: () => makeShard(707),
  spit: () => makeSpit(808),
  cluster: () => makeCluster(909),
};

export const SHAPE_IDS = Object.keys(SHAPE_LIBRARY);

export function buildShapeFootprint(shapeId) {
  const factory = SHAPE_LIBRARY[shapeId] || SHAPE_LIBRARY['blob-1'];
  return factory();
}
