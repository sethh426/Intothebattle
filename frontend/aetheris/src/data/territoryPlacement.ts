import { TERRITORY } from '../config'
import type { LatLon } from '../types'

const DEG2RAD = Math.PI / 180
const MAX_ATTEMPTS_PER_POINT = 80
const FORMATION_ATTEMPTS = 52

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

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function wrapLon(lon: number): number {
  if (lon > 180) return wrapLon(lon - 360)
  if (lon < -180) return wrapLon(lon + 360)
  return lon
}

function clampLatInBand(latBand: [number, number], lat: number): number {
  const padding = Math.min(1.2, Math.max(0.2, (latBand[1] - latBand[0]) * 0.06))
  return clamp(lat, latBand[0] + padding, latBand[1] - padding)
}

function lonDistanceScale(lat: number): number {
  return Math.max(0.25, Math.cos(lat * DEG2RAD))
}

function minimumDistance(candidate: LatLon, neighbors: LatLon[]): number {
  if (neighbors.length === 0) return Infinity
  return Math.min(...neighbors.map((p) => angularDistance(candidate, p)))
}

function randomCandidate(latBand: [number, number], rng: () => number): LatLon {
  return {
    lat: sampleLatInBand(latBand, rng),
    lon: rng() * 360 - 180,
  }
}

function formationCandidate(latBand: [number, number], rng: () => number, anchors: LatLon[], index: number): LatLon {
  const anchor = anchors[index % anchors.length]
  const ring = Math.min(3, Math.floor(index / anchors.length) + 1)
  const theta = rng() * Math.PI * 2 + ring * 0.74 + index * 0.31
  const distanceDegrees = 2.8 + ring * 2.3 + rng() * 4.8
  const chainBias = Math.sin(index * 1.17) * 2.6
  const lat = clampLatInBand(
    latBand,
    anchor.lat + Math.sin(theta) * distanceDegrees * 0.58 + (rng() - 0.5) * 2.2,
  )
  const lon = wrapLon(
    anchor.lon
      + (Math.cos(theta) * distanceDegrees + chainBias) / lonDistanceScale(lat)
      + Math.sin(ring * 0.9) * 2.4,
  )
  return { lat, lon }
}

function placeAnchors(
  latBand: [number, number],
  anchorCount: number,
  rng: () => number,
  avoidPoints: LatLon[],
  minSeparation: number,
): LatLon[] {
  const anchors: LatLon[] = []

  for (let i = 0; i < anchorCount; i += 1) {
    let best: LatLon | null = null
    let bestMinDist = -Infinity

    for (let attempt = 0; attempt < MAX_ATTEMPTS_PER_POINT; attempt += 1) {
      const bandSpan = latBand[1] - latBand[0]
      const laneOffset = anchorCount === 1 ? 0 : (i / (anchorCount - 1) - 0.5) * bandSpan * 0.28
      const candidate = randomCandidate(latBand, rng)
      candidate.lat = clampLatInBand(latBand, candidate.lat + laneOffset)
      candidate.lon = wrapLon(candidate.lon + (i - (anchorCount - 1) / 2) * (42 + rng() * 18))
      const minDist = minimumDistance(candidate, [...anchors, ...avoidPoints])

      if (minDist >= minSeparation * 1.35) {
        best = candidate
        break
      }
      if (minDist > bestMinDist) {
        bestMinDist = minDist
        best = candidate
      }
    }

    anchors.push(best ?? randomCandidate(latBand, rng))
  }

  return anchors
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
  const anchorCount = Math.min(count, count >= 14 ? 3 : count >= 8 ? 2 : 1)
  const anchors = placeAnchors(latBand, anchorCount, rng, avoidPoints, minSeparation)
  const placed: LatLon[] = []

  for (let i = 0; i < count; i += 1) {
    let best: LatLon | null = null
    let bestMinDist = -Infinity

    for (let attempt = 0; attempt < MAX_ATTEMPTS_PER_POINT; attempt += 1) {
      const candidate = i < anchors.length
        ? anchors[i]
        : attempt < FORMATION_ATTEMPTS
          ? formationCandidate(latBand, rng, anchors, i + attempt)
          : randomCandidate(latBand, rng)
      const neighbors = [...placed, ...avoidPoints]
      const minDist = minimumDistance(candidate, neighbors)
      const relaxedSeparation = minSeparation * (attempt < FORMATION_ATTEMPTS ? 0.82 : 1)

      if (minDist >= relaxedSeparation) {
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
