import type { PerfTier, StructureStage } from '../types'

export interface AetherisDiagnostics {
  perfTier: PerfTier
  fps: number
  drawCalls: number
  triangles: number
  textures: number
  loadedAssets: string[]
  failedAssets: Record<string, string>
  activeLods: Record<string, number>
  structureStages: Record<StructureStage, number>
  visibleRenderables: number
  estimatedSceneCalls: number
  sceneGroups: Record<string, number>
}

declare global {
  interface Window {
    __aetherisDiagnostics?: AetherisDiagnostics
  }
}

const loadedAssets = new Set<string>()
const failedAssets: Record<string, string> = {}
const activeLods: Record<string, number> = {}

export function recordStructureAsset(assetId: string): void {
  loadedAssets.add(assetId)
}

export function recordStructureFailure(assetId: string, message: string): void {
  failedAssets[assetId] = message
}

export function recordLandmarkLod(biomeId: string, lod: number): void {
  activeLods[biomeId] = lod
}

export function structureDiagnosticSnapshot(
  perfTier: PerfTier,
  fps: number,
  drawCalls: number,
  triangles: number,
  textures: number,
  structureStages: Record<StructureStage, number>,
  visibleRenderables: number,
  estimatedSceneCalls: number,
  sceneGroups: Record<string, number>,
): AetherisDiagnostics {
  return {
    perfTier,
    fps,
    drawCalls,
    triangles,
    textures,
    loadedAssets: [...loadedAssets].sort(),
    failedAssets: { ...failedAssets },
    activeLods: { ...activeLods },
    structureStages,
    visibleRenderables,
    estimatedSceneCalls,
    sceneGroups,
  }
}
