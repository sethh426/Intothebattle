import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outputPath = path.join(__dirname, '..', 'frontend', 'aetheris', 'src', 'data', 'territoryCatalog.json');
const WORLD_SEED = 918273645;
const MIN_ANGULAR_SEPARATION = 0.09;
const DEG2RAD = Math.PI / 180;
const SHAPE_IDS = ['blob-1', 'blob-2', 'crescent', 'star', 'hex', 'ring', 'shard', 'spit', 'cluster'];
const SIZE_CLASSES = [
  { key: 'small', weight: 0.28, angularRadius: [0.032, 0.044] },
  { key: 'medium', weight: 0.48, angularRadius: [0.05, 0.068] },
  { key: 'large', weight: 0.24, angularRadius: [0.078, 0.108] },
];
const NAME_PREFIXES = ['Vol', 'Thal', 'Ember', 'Storm', 'Grim', 'Sylv', 'Kael', 'Fenn', 'Or', 'Wyr', 'Dus', 'Ael'];
const NAME_SUFFIXES = ['tari', 'ric', 'wyn', 'dor', 'vane', 'thorn', 'gard', 'meer', 'ash', 'holt', 'wick', 'sera'];
const BIOMES = [
  { id: 'frozen-crown', landCount: 10, latBand: [72, 90], baseColor: '#b7efff', accentColor: '#55d8ff' },
  { id: 'thunder-highlands', landCount: 5, latBand: [60, 72], baseColor: '#3430a4', accentColor: '#b7c7ff' },
  { id: 'whispering-desert', landCount: 11, latBand: [42, 60], baseColor: '#a95d20', accentColor: '#ffd15c' },
  { id: 'ancient-jungle', landCount: 13, latBand: [22, 42], baseColor: '#0f6c37', accentColor: '#66ff8d' },
  { id: 'emerald-wilds', landCount: 18, latBand: [-2, 22], baseColor: '#1f8f46', accentColor: '#b7ff82' },
  { id: 'liquid-blu-metal-sea', landCount: 9, latBand: [-16, -2], baseColor: '#035d91', accentColor: '#39e4ff' },
  { id: 'molten-wastes', landCount: 6, latBand: [-28, -16], baseColor: '#7e1f0b', accentColor: '#ff7a24' },
  { id: 'toxic-expanse', landCount: 7, latBand: [-40, -28], baseColor: '#4d7313', accentColor: '#b6ff36' },
  { id: 'crystal-basin', landCount: 8, latBand: [-54, -40], baseColor: '#006c9d', accentColor: '#8af6ff' },
  { id: 'void-scar', landCount: 13, latBand: [-90, -54], baseColor: '#210054', accentColor: '#c46bff' },
];

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function angularDistance(a, b) {
  const lat1 = a.lat * DEG2RAD;
  const lat2 = b.lat * DEG2RAD;
  const dLon = (b.lon - a.lon) * DEG2RAD;
  const cosD = Math.sin(lat1) * Math.sin(lat2) + Math.cos(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return Math.acos(Math.min(1, Math.max(-1, cosD)));
}

function sampleLatInBand(latBand, rng) {
  const sinMin = Math.sin(latBand[0] * DEG2RAD);
  const sinMax = Math.sin(latBand[1] * DEG2RAD);
  return Math.asin(sinMin + rng() * (sinMax - sinMin)) / DEG2RAD;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function wrapLon(lon) {
  if (lon > 180) return wrapLon(lon - 360);
  if (lon < -180) return wrapLon(lon + 360);
  return lon;
}

function clampLatInBand(latBand, lat) {
  const padding = Math.min(1.2, Math.max(0.2, (latBand[1] - latBand[0]) * 0.06));
  return clamp(lat, latBand[0] + padding, latBand[1] - padding);
}

function minimumDistance(candidate, neighbors) {
  if (!neighbors.length) return Infinity;
  return Math.min(...neighbors.map(point => angularDistance(candidate, point)));
}

function randomCandidate(latBand, rng) {
  return { lat: sampleLatInBand(latBand, rng), lon: rng() * 360 - 180 };
}

function formationCandidate(latBand, rng, anchors, index) {
  const anchor = anchors[index % anchors.length];
  const ring = Math.floor(index / anchors.length) + 1;
  const theta = rng() * Math.PI * 2 + ring * 0.74 + index * 0.31;
  const distanceDegrees = 2.8 + ring * 2.3 + rng() * 4.8;
  const chainBias = Math.sin(index * 1.17) * 2.6;
  const lat = clampLatInBand(
    latBand,
    anchor.lat + Math.sin(theta) * distanceDegrees * 0.58 + (rng() - 0.5) * 2.2,
  );
  const lonScale = Math.max(0.25, Math.cos(lat * DEG2RAD));
  const lon = wrapLon(anchor.lon + (Math.cos(theta) * distanceDegrees + chainBias) / lonScale + Math.sin(ring * 0.9) * 2.4);
  return { lat, lon };
}

function placeAnchors(latBand, anchorCount, rng, avoidPoints, minSeparation) {
  const anchors = [];
  for (let index = 0; index < anchorCount; index += 1) {
    let best = null;
    let bestMinDist = -Infinity;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const bandSpan = latBand[1] - latBand[0];
      const laneOffset = anchorCount === 1 ? 0 : (index / (anchorCount - 1) - 0.5) * bandSpan * 0.28;
      const candidate = randomCandidate(latBand, rng);
      candidate.lat = clampLatInBand(latBand, candidate.lat + laneOffset);
      candidate.lon = wrapLon(candidate.lon + (index - (anchorCount - 1) / 2) * (42 + rng() * 18));
      const minDist = minimumDistance(candidate, [...anchors, ...avoidPoints]);
      if (minDist >= minSeparation * 1.35) {
        best = candidate;
        break;
      }
      if (minDist > bestMinDist) {
        bestMinDist = minDist;
        best = candidate;
      }
    }
    anchors.push(best ?? randomCandidate(latBand, rng));
  }
  return anchors;
}

function placeInBand(latBand, count, rng, avoidPoints = []) {
  const anchorCount = Math.min(count, count >= 14 ? 3 : count >= 8 ? 2 : 1);
  const anchors = placeAnchors(latBand, anchorCount, rng, avoidPoints, MIN_ANGULAR_SEPARATION);
  const placed = [];
  for (let index = 0; index < count; index += 1) {
    let best = null;
    let bestMinDist = -Infinity;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const candidate = index < anchors.length
        ? anchors[index]
        : attempt < 52
          ? formationCandidate(latBand, rng, anchors, index + attempt)
          : randomCandidate(latBand, rng);
      const minDist = minimumDistance(candidate, [...placed, ...avoidPoints]);
      const relaxedSeparation = MIN_ANGULAR_SEPARATION * (attempt < 52 ? 0.82 : 1);
      if (minDist >= relaxedSeparation) {
        best = candidate;
        break;
      }
      if (minDist > bestMinDist) {
        bestMinDist = minDist;
        best = candidate;
      }
    }
    placed.push(best);
  }
  return placed;
}

function pickWeighted(rng) {
  let value = rng() * SIZE_CLASSES.reduce((sum, entry) => sum + entry.weight, 0);
  for (const entry of SIZE_CLASSES) {
    value -= entry.weight;
    if (value <= 0) return entry;
  }
  return SIZE_CLASSES[SIZE_CLASSES.length - 1];
}

function mixHexColor(hexA, hexB, amount) {
  const a = Number.parseInt(hexA.slice(1), 16);
  const b = Number.parseInt(hexB.slice(1), 16);
  const channels = [16, 8, 0].map(shift => Math.round(((a >> shift) & 255) + (((b >> shift) & 255) - ((a >> shift) & 255)) * amount));
  return `#${((1 << 24) + (channels[0] << 16) + (channels[1] << 8) + channels[2]).toString(16).slice(1)}`;
}

function generateTerritories() {
  const rng = mulberry32(WORLD_SEED);
  const territories = [];
  const placedByBiome = [];
  for (const biome of BIOMES) {
    const points = placeInBand(biome.latBand, biome.landCount, rng, placedByBiome.flat());
    placedByBiome.push(points);
    points.forEach((point, index) => {
      const sizeClass = pickWeighted(rng);
      const shapeId = SHAPE_IDS[Math.floor(rng() * SHAPE_IDS.length)];
      const isLive = rng() < 0.15;
      const colorHex = mixHexColor(biome.accentColor, biome.baseColor, rng() * 0.3);
      territories.push({
        id: `terr-${biome.id}-${index}`,
        biomeId: biome.id,
        shapeId,
        sizeClass: sizeClass.key,
        lat: point.lat,
        lon: point.lon,
        angularRadius: sizeClass.angularRadius[0] + rng() * (sizeClass.angularRadius[1] - sizeClass.angularRadius[0]),
        rotation: rng() * Math.PI * 2,
        territoryName: `${NAME_PREFIXES[Math.floor(rng() * NAME_PREFIXES.length)]}${NAME_SUFFIXES[Math.floor(rng() * NAME_SUFFIXES.length)]}`,
        isLive,
        colorHex,
        seed: Math.floor(rng() * 0xffffffff),
        neighbors: [],
      });
    });
  }
  return territories;
}

function addAdjacency(territories) {
  const neighbors = territories.map(() => new Set());
  const edgeExists = (a, b) => neighbors[a].has(b);
  const addEdge = (a, b) => {
    if (a === b || edgeExists(a, b) || neighbors[a].size >= 6 || neighbors[b].size >= 6) return false;
    neighbors[a].add(b);
    neighbors[b].add(a);
    return true;
  };

  const unvisited = new Set(territories.map((_, index) => index));
  let current = 0;
  unvisited.delete(current);
  while (unvisited.size) {
    const next = [...unvisited].sort((a, b) => angularDistance(territories[current], territories[a]) - angularDistance(territories[current], territories[b]) || a - b)[0];
    addEdge(current, next);
    unvisited.delete(next);
    current = next;
  }

  let guard = 0;
  while (neighbors.some(set => set.size < 3) && guard < 2000) {
    guard += 1;
    const source = neighbors
      .map((set, index) => ({ index, degree: set.size }))
      .filter(entry => entry.degree < 3)
      .sort((a, b) => a.degree - b.degree || a.index - b.index)[0]?.index;
    if (source == null) break;
    const candidate = territories
      .map((territory, index) => ({
        index,
        degree: neighbors[index].size,
        distance: angularDistance(territories[source], territory),
      }))
      .filter(entry => entry.index !== source && entry.degree < 6 && !edgeExists(source, entry.index))
      .sort((a, b) => (a.distance + a.degree * 0.025) - (b.distance + b.degree * 0.025) || a.index - b.index)[0];
    if (!candidate || !addEdge(source, candidate.index)) throw new Error(`Unable to satisfy adjacency for ${territories[source].id}`);
  }

  territories.forEach((territory, index) => {
    territory.neighbors = [...neighbors[index]].map(neighborIndex => territories[neighborIndex].id).sort();
  });
}

const territories = generateTerritories();
addAdjacency(territories);
const badDegree = territories.filter(territory => territory.neighbors.length < 3 || territory.neighbors.length > 6);
if (territories.length !== 100 || badDegree.length) {
  throw new Error(`Invalid catalog: ${territories.length} territories, ${badDegree.length} invalid adjacency degrees`);
}
fs.writeFileSync(outputPath, `${JSON.stringify({ version: 1, seed: WORLD_SEED, territories }, null, 2)}\n`);
console.log(`Generated ${territories.length} canonical Aetheris territories at ${outputPath}`);
