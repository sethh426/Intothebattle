import { mulberry32, TERRITORY, WORLD_SEED } from '../config'
import { SHAPE_IDS } from './shapeLibrary'
import { placeInBand } from './territoryPlacement'
import type { Biome, SizeClass, Territory } from '../types'

interface SizeClassOption {
  key: SizeClass
  weight: number
  angularRadius: [number, number]
}

const SIZE_CLASSES: SizeClassOption[] = [
  { key: 'small', weight: 0.4, angularRadius: [0.024, 0.034] },
  { key: 'medium', weight: 0.45, angularRadius: [0.038, 0.052] },
  { key: 'large', weight: 0.15, angularRadius: [0.058, 0.085] },
]

const NAME_PREFIXES = ['Vol', 'Thal', 'Ember', 'Storm', 'Grim', 'Sylv', 'Kael', 'Fenn', 'Or', 'Wyr', 'Dus', 'Ael']
const NAME_SUFFIXES = ['tari', 'ric', 'wyn', 'dor', 'vane', 'thorn', 'gard', 'meer', 'ash', 'holt', 'wick', 'sera']

function pickWeighted(rng: () => number, entries: SizeClassOption[]): SizeClassOption {
  const total = entries.reduce((sum, e) => sum + e.weight, 0)
  let r = rng() * total
  for (const entry of entries) {
    r -= entry.weight
    if (r <= 0) return entry
  }
  return entries[entries.length - 1]
}

function randomInRange(rng: () => number, [min, max]: [number, number]): number {
  return min + rng() * (max - min)
}

function generateTerritoryName(rng: () => number): string {
  const prefix = NAME_PREFIXES[Math.floor(rng() * NAME_PREFIXES.length)]
  const suffix = NAME_SUFFIXES[Math.floor(rng() * NAME_SUFFIXES.length)]
  return `${prefix}${suffix}`
}

function mixHexColor(hexA: string, hexB: string, t: number): string {
  const a = parseInt(hexA.slice(1), 16)
  const b = parseInt(hexB.slice(1), 16)
  const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255
  const br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255
  const r = Math.round(ar + (br - ar) * t)
  const g = Math.round(ag + (bg - ag) * t)
  const bl = Math.round(ab + (bb - ab) * t)
  return `#${((1 << 24) + (r << 16) + (g << 8) + bl).toString(16).slice(1)}`
}

// Builds all 100 mock Territory objects. Deterministic for a given seed so the layout
// (and any captured screenshots/QA) is stable across reloads.
export function generateTerritories(biomes: Biome[], seed: number = WORLD_SEED): Territory[] {
  const rng = mulberry32(seed)
  const territories: Territory[] = []
  const placedByBiome: Array<Array<{ lat: number; lon: number }>> = []

  biomes.forEach((biome) => {
    const avoidPoints = placedByBiome.flat()
    const points = placeInBand(biome.latBand, biome.landCount, rng, avoidPoints)
    placedByBiome.push(points)

    points.forEach((point, i) => {
      const sizeClass = pickWeighted(rng, SIZE_CLASSES)
      const shapeId = SHAPE_IDS[Math.floor(rng() * SHAPE_IDS.length)]
      const isLive = rng() < TERRITORY.liveFraction
      const colorHex = mixHexColor(biome.accentColor, biome.baseColor, rng() * 0.3)

      territories.push({
        id: `terr-${biome.id}-${i}`,
        biomeId: biome.id,
        shapeId,
        sizeClass: sizeClass.key,
        lat: point.lat,
        lon: point.lon,
        angularRadius: randomInRange(rng, sizeClass.angularRadius),
        rotation: rng() * Math.PI * 2,
        territoryName: generateTerritoryName(rng),
        isLive,
        colorHex,
        seed: Math.floor(rng() * 0xffffffff),
      })
    })
  })

  return territories
}
