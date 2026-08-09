import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { getBiomeById } from '../data/biomeData'
import type { LandmarkAssetSpec } from '../types'

type MaterialRole = 'stone' | 'metal' | 'organic' | 'crystal' | 'emissive'

const PROFILE_TINT: Record<LandmarkAssetSpec['materialProfile'], string> = {
  ice: '#8bdfff',
  storm: '#7d85d8',
  desert: '#9f6029',
  jungle: '#235c35',
  wilds: '#337942',
  metal: '#468ba8',
  molten: '#8c2d18',
  toxic: '#5b6f2c',
  crystal: '#5aa7b5',
  void: '#281743',
}

let structureNormalMap: THREE.DataTexture | null = null

function getStructureNormalMap(): THREE.DataTexture {
  if (structureNormalMap) return structureNormalMap
  const size = 32
  const data = new Uint8Array(size * size * 4)
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const offset = (y * size + x) * 4
      const ridge = Math.sin(x * 1.73 + y * 0.41) * 0.5 + Math.cos(y * 1.31 - x * 0.27) * 0.5
      data[offset] = 128 + Math.round(ridge * 18)
      data[offset + 1] = 128 + Math.round(Math.sin(y * 0.83 + x * 0.19) * 15)
      data[offset + 2] = 244
      data[offset + 3] = 255
    }
  }
  structureNormalMap = new THREE.DataTexture(data, size, size, THREE.RGBAFormat)
  structureNormalMap.colorSpace = THREE.NoColorSpace
  structureNormalMap.wrapS = THREE.RepeatWrapping
  structureNormalMap.wrapT = THREE.RepeatWrapping
  structureNormalMap.repeat.set(3, 3)
  structureNormalMap.needsUpdate = true
  return structureNormalMap
}

function inferMaterialRole(materialName: string, objectName: string): MaterialRole {
  const name = `${materialName} ${objectName}`.toUpperCase()
  if (/EMISSIVE|FX_CORE|LAVA|LIGHTNING|BEACON|LANTERN|TOXIC_POOL/.test(name)) return 'emissive'
  if (/CRYSTAL|GLASS|ICE|SHARD/.test(name)) return 'crystal'
  if (/ORGANIC|ROOT|VINE|FOLIAGE|TREE|CANOPY/.test(name)) return 'organic'
  if (/METAL|TRIM|PIPE|FORGE|CONDUCTOR|GANTRY/.test(name)) return 'metal'
  return 'stone'
}

function roleColor(biomeId: string, role: MaterialRole): THREE.Color {
  const biome = getBiomeById(biomeId)
  const base = new THREE.Color(biome?.baseColor ?? '#66717c').convertSRGBToLinear()
  const accent = new THREE.Color(biome?.accentColor ?? '#d8e2eb').convertSRGBToLinear()
  if (role === 'stone') return base.lerp(new THREE.Color('#51585f').convertSRGBToLinear(), 0.48).multiplyScalar(0.62)
  if (role === 'metal') return base.lerp(accent, 0.28).multiplyScalar(0.7)
  if (role === 'organic') return base.multiplyScalar(0.52)
  if (role === 'crystal') return accent.multiplyScalar(0.92)
  return accent.multiplyScalar(1.35)
}

function styleMaterial(
  source: THREE.Material,
  biomeId: string,
  profile: LandmarkAssetSpec['materialProfile'] | undefined,
  objectName: string,
): THREE.Material {
  const material = source.clone()
  if (!(material instanceof THREE.MeshStandardMaterial)) return material

  const biome = getBiomeById(biomeId)
  const role = inferMaterialRole(material.name, objectName)
  const base = new THREE.Color(biome?.baseColor ?? '#66717c')
  const accent = new THREE.Color(biome?.accentColor ?? '#d8e2eb')
  const profileTint = new THREE.Color(PROFILE_TINT[profile ?? 'storm'])

  material.color.convertSRGBToLinear()
  if (role === 'stone') {
    material.color.lerp(base, 0.34).lerp(profileTint, 0.18).multiplyScalar(0.72)
    material.roughness = 0.82
    material.metalness = 0.08
  } else if (role === 'metal') {
    material.color.lerp(base, 0.28).lerp(accent, 0.16).multiplyScalar(0.75)
    material.roughness = 0.38
    material.metalness = 0.76
  } else if (role === 'organic') {
    material.color.lerp(base, 0.44).multiplyScalar(0.72)
    material.roughness = 0.9
    material.metalness = 0
  } else if (role === 'crystal') {
    material.color.lerp(accent, 0.5)
    material.emissive.copy(accent).multiplyScalar(0.42)
    material.emissiveIntensity = 0.72
    material.roughness = 0.18
    material.metalness = 0.22
  } else {
    material.color.copy(accent).multiplyScalar(0.9)
    material.emissive.copy(accent)
    material.emissiveIntensity = 2.4
    material.roughness = 0.24
    material.metalness = 0.18
    material.toneMapped = false
  }

  if (role !== 'emissive' && role !== 'crystal') {
    material.normalMap = getStructureNormalMap()
    material.normalScale.set(0.24, 0.24)
  }
  material.envMapIntensity = role === 'metal' || role === 'crystal' ? 1.15 : 0.62
  material.needsUpdate = true
  return material
}

export function cloneStructureScene(
  source: THREE.Object3D,
  biomeId: string,
  profile?: LandmarkAssetSpec['materialProfile'],
): THREE.Object3D {
  const clone = source.clone(true)
  clone.traverse((child) => {
    child.raycast = () => undefined
    if (!(child instanceof THREE.Mesh)) return
    child.castShadow = false
    child.receiveShadow = false
    child.material = Array.isArray(child.material)
      ? child.material.map((material) => styleMaterial(material, biomeId, profile, child.name))
      : styleMaterial(child.material, biomeId, profile, child.name)
  })
  return clone
}

function isInsideDynamicNode(object: THREE.Object3D, root: THREE.Object3D): boolean {
  let current: THREE.Object3D | null = object
  while (current && current !== root) {
    if (/^FX_/.test(current.name)) return true
    current = current.parent
  }
  return false
}

export function compactStructureScene(
  source: THREE.Object3D,
  biomeId: string,
  profile: LandmarkAssetSpec['materialProfile'],
): THREE.Object3D {
  const clone = cloneStructureScene(source, biomeId, profile)
  clone.updateWorldMatrix(true, true)
  const inverseRoot = clone.matrixWorld.clone().invert()
  const buckets = new Map<'solid' | 'emissive', THREE.BufferGeometry[]>()

  clone.traverse((child) => {
    if (!(child instanceof THREE.Mesh) || isInsideDynamicNode(child, clone)) return
    child.updateWorldMatrix(true, false)
    const sourceMaterial = Array.isArray(child.material) ? child.material[0] : child.material
    const role = inferMaterialRole(sourceMaterial?.name ?? '', child.name)
    const bucketName = role === 'emissive' ? 'emissive' : 'solid'
    const geometry = child.geometry.clone()
    Object.keys(geometry.attributes).forEach((attribute) => {
      if (attribute !== 'position' && attribute !== 'normal') geometry.deleteAttribute(attribute)
    })
    if (!geometry.getAttribute('normal')) geometry.computeVertexNormals()
    geometry.applyMatrix4(inverseRoot.clone().multiply(child.matrixWorld))
    geometry.clearGroups()
    const sourceColor = sourceMaterial instanceof THREE.MeshStandardMaterial
      ? sourceMaterial.color
      : roleColor(biomeId, role)
    const position = geometry.getAttribute('position')
    const colors = new Float32Array(position.count * 3)
    for (let index = 0; index < position.count; index += 1) {
      colors[index * 3] = sourceColor.r
      colors[index * 3 + 1] = sourceColor.g
      colors[index * 3 + 2] = sourceColor.b
    }
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    const bucket = buckets.get(bucketName)
    if (bucket) bucket.push(geometry)
    else buckets.set(bucketName, [geometry])
    child.visible = false
  })

  buckets.forEach((geometries, bucketName) => {
    const geometry = geometries.length === 1 ? geometries[0] : mergeGeometries(geometries, false)
    if (!geometry) throw new Error(`Hero ${biomeId} could not merge its ${bucketName} material shell.`)
    geometry.clearGroups()
    geometry.computeBoundingBox()
    geometry.computeBoundingSphere()
    const material = bucketName === 'emissive'
      ? new THREE.MeshBasicMaterial({
          color: '#ffffff',
          vertexColors: true,
          toneMapped: false,
        })
      : new THREE.MeshStandardMaterial({
          color: '#ffffff',
          vertexColors: true,
          roughness: 0.64,
          metalness: 0.26,
          normalMap: getStructureNormalMap(),
          normalScale: new THREE.Vector2(0.2, 0.2),
          envMapIntensity: 0.74,
        })
    const mesh = new THREE.Mesh(geometry, material)
    mesh.name = `STATIC_${bucketName.toUpperCase()}`
    mesh.raycast = () => undefined
    clone.add(mesh)
  })
  return clone
}

export function mergeStructureNodeGeometry(source: THREE.Object3D, biomeId?: string): THREE.BufferGeometry {
  source.updateWorldMatrix(true, true)
  const inverseRoot = source.matrixWorld.clone().invert()
  const geometries: THREE.BufferGeometry[] = []

  source.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return
    child.updateWorldMatrix(true, false)
    const geometry = child.geometry.clone()
    Object.keys(geometry.attributes).forEach((attribute) => {
      if (attribute !== 'position' && attribute !== 'normal') geometry.deleteAttribute(attribute)
    })
    if (!geometry.getAttribute('normal')) geometry.computeVertexNormals()
    geometry.applyMatrix4(inverseRoot.clone().multiply(child.matrixWorld))
    if (biomeId) {
      const sourceMaterial = Array.isArray(child.material) ? child.material[0] : child.material
      const color = roleColor(biomeId, inferMaterialRole(sourceMaterial?.name ?? '', child.name))
      const position = geometry.getAttribute('position')
      const colors = new Float32Array(position.count * 3)
      for (let index = 0; index < position.count; index += 1) {
        colors[index * 3] = color.r
        colors[index * 3 + 1] = color.g
        colors[index * 3 + 2] = color.b
      }
      geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    }
    geometries.push(geometry)
  })

  if (geometries.length === 0) {
    throw new Error(`Structure node "${source.name}" contains no mesh geometry.`)
  }
  const merged = geometries.length === 1 ? geometries[0] : mergeGeometries(geometries, false)
  if (!merged) throw new Error(`Structure node "${source.name}" could not be merged for instancing.`)
  merged.clearGroups()
  merged.computeBoundingBox()
  merged.computeBoundingSphere()
  return merged
}

export function createStructureMaterial(
  biomeId: string,
  role: 'base' | 'live' | 'apex' | 'regional' | 'ambient',
): THREE.MeshStandardMaterial {
  const biome = getBiomeById(biomeId)
  const base = new THREE.Color(biome?.baseColor ?? '#66717c')
  const accent = new THREE.Color(biome?.accentColor ?? '#d8e2eb')
  const material = new THREE.MeshStandardMaterial({
    color: '#ffffff',
    vertexColors: role === 'regional' || role === 'ambient',
    roughness: role === 'base' || role === 'regional' ? 0.78 : role === 'ambient' ? 0.72 : 0.38,
    metalness: role === 'base' || role === 'regional' ? 0.12 : role === 'ambient' ? 0.2 : 0.56,
    emissive: role === 'live' || role === 'apex' ? accent : base.clone().multiplyScalar(0.06),
    emissiveIntensity: role === 'live' ? 0.62 : role === 'apex' ? 1.1 : 0.08,
  })
  material.normalMap = getStructureNormalMap()
  material.normalScale.set(role === 'ambient' ? 0.16 : 0.23, role === 'ambient' ? 0.16 : 0.23)
  return material
}
