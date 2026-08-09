import { useCallback, useEffect, useMemo, useRef } from 'react'
import type { RefObject } from 'react'
import { useGLTF } from '@react-three/drei'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import {
  BIOME_STRUCTURE_KITS,
  deriveStructureStage,
  STRONGHOLD_PACK_URL,
  strongholdVariant,
  STRUCTURE_STAGE_RANK,
} from '../data/landmarkCatalog'
import { KINGDOM, PLANET } from '../config'
import { useLatestRef } from '../hooks/useLatestRef'
import { latLonToVector3 } from './geo'
import { createStructureMaterial, mergeStructureNodeGeometry } from './structureModelUtils'
import { recordStructureAsset } from './structureDiagnostics'
import type { KingdomState, PerfTier, StructureStage, Territory } from '../types'

const LOCAL_UP = new THREE.Vector3(0, 1, 0)
const HIDDEN_SCALE = 0.0001

type StrongholdModule = 'base' | 'live' | 'apex'
type ModuleHandle = {
  ref: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>
  material: THREE.MeshStandardMaterial
}

interface StrongholdEntry {
  modules: Partial<Record<StrongholdModule, ModuleHandle>>
  alphas: Record<StrongholdModule, number>
  baseColor: THREE.Color
  normal: THREE.Vector3
  baseScale: number
}

interface ModuleDefinition {
  id: string
  biomeId: string
  variant: 0 | 1 | 2
  module: StrongholdModule
  geometry: THREE.BufferGeometry
  material: THREE.MeshStandardMaterial
}

interface KingdomSilhouettesProps {
  territories: Territory[]
  kingdomState?: Record<string, KingdomState>
  selectedTerritoryId?: string | null
  sunDirectionRef: RefObject<THREE.Vector3 | null>
  perfTier: PerfTier
  reducedMotion: boolean
  cameraDistanceRef: RefObject<number>
}

interface TerritoryStrongholdProps {
  territory: Territory
  definitions: Record<StrongholdModule, ModuleDefinition>
  register: (
    territory: Territory,
    module: StrongholdModule,
    mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial> | null,
    material: THREE.MeshStandardMaterial,
  ) => void
}

function desiredModuleAlpha(module: StrongholdModule, stage: StructureStage, showRuin: boolean): number {
  const rank = STRUCTURE_STAGE_RANK[stage]
  if (module === 'base') return stage === 'ruin' ? (showRuin ? 0.48 : 0) : 1
  if (module === 'live') return rank >= STRUCTURE_STAGE_RANK.live ? 1 : 0
  if (stage === 'packed') return 1
  return stage === 'high' ? 0.72 : 0
}

function TerritoryStronghold({ territory, definitions, register }: TerritoryStrongholdProps) {
  const placement = useMemo(() => {
    const position = latLonToVector3(territory.lat, territory.lon, PLANET.radius + KINGDOM.silhouetteLift)
    const quaternion = new THREE.Quaternion().setFromUnitVectors(LOCAL_UP, position.clone().normalize())
    quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(LOCAL_UP, territory.rotation))
    return { position, quaternion }
  }, [territory])
  const materials = useMemo<Record<StrongholdModule, THREE.MeshStandardMaterial>>(() => ({
    base: definitions.base.material.clone(),
    live: definitions.live.material.clone(),
    apex: definitions.apex.material.clone(),
  }), [definitions])

  useEffect(() => () => {
    Object.values(materials).forEach((material) => material.dispose())
  }, [materials])

  return (
    <group position={placement.position} quaternion={placement.quaternion} raycast={() => undefined}>
      {(['base', 'live', 'apex'] as const).map((module) => (
        <mesh
          key={module}
          ref={(mesh) => register(
            territory,
            module,
            mesh as THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial> | null,
            materials[module],
          )}
          geometry={definitions[module].geometry}
          material={materials[module]}
          scale={HIDDEN_SCALE}
          visible={false}
          raycast={() => undefined}
        />
      ))}
    </group>
  )
}

export default function KingdomSilhouettes({
  territories,
  kingdomState,
  selectedTerritoryId,
  sunDirectionRef,
  perfTier,
  reducedMotion,
  cameraDistanceRef,
}: KingdomSilhouettesProps) {
  const { scene } = useGLTF(STRONGHOLD_PACK_URL, false, true)
  const definitions = useMemo<ModuleDefinition[]>(() => {
    const result: ModuleDefinition[] = []
    BIOME_STRUCTURE_KITS.forEach((kit) => {
      const materials: Record<StrongholdModule, THREE.MeshStandardMaterial> = {
        base: createStructureMaterial(kit.biomeId, 'base'),
        live: createStructureMaterial(kit.biomeId, 'live'),
        apex: createStructureMaterial(kit.biomeId, 'apex'),
      }
      kit.strongholdNodes.forEach((variantNodes, variantIndex) => {
        const variant = variantIndex as 0 | 1 | 2
        variantNodes.forEach((nodeName, moduleIndex) => {
          const module = (['base', 'live', 'apex'] as const)[moduleIndex]
          const source = scene.getObjectByName(nodeName)
          if (!source) throw new Error(`Stronghold structure contract is missing ${nodeName}.`)
          result.push({
            id: nodeName,
            biomeId: kit.biomeId,
            variant,
            module,
            geometry: mergeStructureNodeGeometry(source),
            material: materials[module],
          })
        })
      })
    })
    return result
  }, [scene])
  const definitionMap = useMemo(() => new Map(
    definitions.map((definition) => [
      `${definition.biomeId}:${definition.variant}:${definition.module}`,
      definition,
    ]),
  ), [definitions])
  const territoryDefinitions = useMemo(() => new Map(territories.map((territory) => {
    const variant = strongholdVariant(territory)
    const find = (module: StrongholdModule) => {
      const definition = definitionMap.get(`${territory.biomeId}:${variant}:${module}`)
      if (!definition) throw new Error(`Stronghold definition is missing for ${territory.id}:${module}.`)
      return definition
    }
    return [territory.id, { base: find('base'), live: find('live'), apex: find('apex') }]
  })), [definitionMap, territories])

  const entries = useRef(new Map<string, StrongholdEntry>())
  const kingdomStateRef = useLatestRef<Record<string, KingdomState>>(kingdomState ?? {})
  const selectedTerritoryIdRef = useLatestRef<string | null | undefined>(selectedTerritoryId)
  const tempColor = useMemo(() => new THREE.Color(), [])
  const stoneColor = useMemo(() => new THREE.Color('#777d82'), [])
  const warmColor = useMemo(() => new THREE.Color('#ffbc70'), [])
  const selectedColor = useMemo(() => new THREE.Color('#ffe99a'), [])

  useEffect(() => {
    recordStructureAsset('stronghold-kit')
    return () => {
      definitions.forEach(({ geometry }) => geometry.dispose())
      new Set(definitions.map(({ material }) => material)).forEach((material) => material.dispose())
    }
  }, [definitions])

  const register = useCallback((
    territory: Territory,
    module: StrongholdModule,
    mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial> | null,
    material: THREE.MeshStandardMaterial,
  ) => {
    let entry = entries.current.get(territory.id)
    if (!mesh) {
      if (entry) {
        delete entry.modules[module]
        if (Object.keys(entry.modules).length === 0) entries.current.delete(territory.id)
      }
      return
    }
    if (!entry) {
      const position = latLonToVector3(territory.lat, territory.lon, PLANET.radius + KINGDOM.silhouetteLift)
      entry = {
        modules: {},
        alphas: { base: 0, live: 0, apex: 0 },
        baseColor: new THREE.Color(territory.colorHex),
        normal: position.normalize(),
        baseScale: Math.max(territory.angularRadius * PLANET.radius * 1.06, 0.072),
      }
      entries.current.set(territory.id, entry)
    }
    entry.modules[module] = { ref: mesh, material }
  }, [])

  useFrame((_, delta) => {
    const states = kingdomStateRef.current
    const selectedId = selectedTerritoryIdRef.current
    entries.current.forEach((entry, territoryId) => {
      const state = states[territoryId]
      const stage = deriveStructureStage(state)
      const selected = territoryId === selectedId
      const showRuin = selected || (perfTier !== 'low' && cameraDistanceRef.current < 4.2)
      const sol = sunDirectionRef.current ? Math.max(0, entry.normal.dot(sunDirectionRef.current)) : 0.55
      const night = 1 - sol
      const rank = STRUCTURE_STAGE_RANK[stage]
      const stageScale = stage === 'ruin' ? 0.72 : 0.82 + rank * 0.07

      ;(['base', 'live', 'apex'] as const).forEach((module) => {
        const handle = entry.modules[module]
        if (!handle) return
        const desired = perfTier === 'low' && module !== 'base'
          ? 0
          : desiredModuleAlpha(module, stage, showRuin)
        entry.alphas[module] = reducedMotion
          ? desired
          : THREE.MathUtils.damp(entry.alphas[module], desired, 8.2, delta)
        const alpha = entry.alphas[module]
        handle.ref.visible = alpha >= 0.002
        if (!handle.ref.visible) return

        const scale = entry.baseScale
          * stageScale
          * (module === 'base' ? 1 : module === 'live' ? 0.98 : 1.02)
          * (selected ? 1.12 : 1)
          * alpha
        handle.ref.scale.setScalar(scale)
        tempColor.copy(entry.baseColor)
        if (module === 'base') {
          tempColor.lerp(stoneColor, stage === 'ruin' ? 0.76 : 0.5)
          tempColor.lerp(warmColor, sol * 0.12).multiplyScalar(0.72 + sol * 0.38)
        } else {
          tempColor.lerp(module === 'apex' ? selectedColor : warmColor, module === 'apex' ? 0.42 : 0.28)
          tempColor.multiplyScalar(1.05 + night * (module === 'apex' ? 0.72 : 0.4))
        }
        if (selected) tempColor.lerp(selectedColor, 0.38)
        handle.material.color.copy(tempColor)
      })
    })
  })

  return (
    <group name="territory-strongholds" raycast={() => undefined}>
      {territories.map((territory) => {
        const territoryDefinition = territoryDefinitions.get(territory.id)
        if (!territoryDefinition) return null
        return (
          <TerritoryStronghold
            key={territory.id}
            territory={territory}
            definitions={territoryDefinition}
            register={register}
          />
        )
      })}
    </group>
  )
}
