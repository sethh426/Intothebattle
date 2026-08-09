import { useEffect, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import type { PerfTier, StructureStage } from '../types'
import { structureDiagnosticSnapshot } from './structureDiagnostics'

interface AetherisDiagnosticsProps {
  perfTier: PerfTier
  structureStages: Record<StructureStage, number>
}

export default function AetherisDiagnostics({ perfTier, structureStages }: AetherisDiagnosticsProps) {
  const { gl, scene } = useThree()
  const sample = useRef({ frames: 0, elapsed: 0, fps: 0 })
  const enabled = import.meta.env.DEV || new URLSearchParams(window.location.search).get('diagnostics') === '1'

  useFrame((_, delta) => {
    if (!enabled) return
    const current = sample.current
    current.frames += 1
    current.elapsed += delta
    if (current.elapsed >= 0.5) {
      current.fps = current.frames / current.elapsed
      current.frames = 0
      current.elapsed = 0
    }
    let visibleRenderables = 0
    let estimatedSceneCalls = 0
    const sceneGroups: Record<string, number> = {}
    scene.traverse((object) => {
      const renderable = object instanceof THREE.Mesh
        || object instanceof THREE.Points
        || object instanceof THREE.Line
        || object instanceof THREE.LineSegments
      if (!renderable) return
      let ancestor: THREE.Object3D | null = object
      let effectivelyVisible = true
      while (ancestor) {
        if (!ancestor.visible) effectivelyVisible = false
        ancestor = ancestor.parent
      }
      if (!effectivelyVisible) return
      visibleRenderables += 1
      const geometry = object instanceof THREE.Mesh || object instanceof THREE.Points || object instanceof THREE.Line
        ? object.geometry
        : null
      const calls = Math.max(1, geometry?.groups.length || 0)
      estimatedSceneCalls += calls
      let groupName = 'scene'
      ancestor = object
      while (ancestor?.parent && ancestor.parent !== scene) {
        if (ancestor.name) groupName = ancestor.name
        ancestor = ancestor.parent
      }
      sceneGroups[groupName] = (sceneGroups[groupName] || 0) + calls
    })
    window.__aetherisDiagnostics = structureDiagnosticSnapshot(
      perfTier,
      Math.round(current.fps),
      gl.info.render.calls,
      gl.info.render.triangles,
      gl.info.memory.textures,
      structureStages,
      visibleRenderables,
      estimatedSceneCalls,
      sceneGroups,
    )
  })

  useEffect(() => () => {
    if (enabled) delete window.__aetherisDiagnostics
  }, [enabled])

  return null
}
