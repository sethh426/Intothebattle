import { TERRITORY } from '../config'
import type { LatLon } from '../types'

const DEG2RAD = Math.PI / 180

export function angularDistance(a: LatLon, b: LatLon): number {
  const lat1 = a.lat * DEG2RAD
  const lat2 = b.lat * DEG2RAD
  const dLon = (b.lon - a.lon) * DEG2RAD
  const cosD = Math.sin(lat1) * Math.sin(lat2) + Math.cos(lat1) * Math.cos(lat2) * Math.cos(dLon)
  return Math.acos(Math.min(1, Math.max(-1, cosD)))
}

// Area-uniform latitude sample within a band: uniform in sin(lat), not lat itself,
// so narrow polar bands don't get an artificial density spike toward the pole edge.
export function sampleLatInBand(latBand: [number, number], rng: () => number): number {
  const [latMin, latMax] = latBand
  const sinMin = Math.sin(latMin * DEG2RAD)
  const sinMax = Math.sin(latMax * DEG2RAD)
  const s = sinMin + rng() * (sinMax - sinMin)
  return Math.asin(s) / DEG2RAD
}

// Places `count` points inside `latBand` (degrees), rejecting candidates that fall
// within `minSeparation` radians of an already-placed point (this biome's own points
// plus any already placed in other biomes, passed in via `avoidPoints`).
export function placeInBand(
  latBand: [number, number],
  count: number,
  rng: () => number,
  avoidPoints: LatLon[] = [],
  minSeparation: number = TERRITORY.minAngularSeparation,
): LatLon[] {
  const placed: LatLon[] = []
  const maxAttemptsPerPoint = 60

  for (let i = 0; i < count; i += 1) {
    let best: LatLon | null = null
    let bestMinDist = -Infinity

    for (let attempt = 0; attempt < maxAttemptsPerPoint; attempt += 1) {
      const candidate: LatLon = {
        lat: sampleLatInBand(latBand, rng),
        lon: rng() * 360 - 180,
      }
      const neighbors = [...placed, ...avoidPoints]
      const minDist = neighbors.length === 0
        ? Infinity
        : Math.min(...neighbors.map((p) => angularDistance(candidate, p)))

      if (minDist >= minSeparation) {
        best = candidate
        break
      }
      if (minDist > bestMinDist) {
        bestMinDist = minDist
        best = candidate
      }
    }

    placed.push(best as LatLon)
  }

  return placed
}
