import * as THREE from 'three'
import { mulberry32 } from '../config'
import { getBiomeById } from './biomeData'

// A small set of reusable procedural builders — same "parameterized generator, not
// hand-authored geometry" philosophy as shapeLibrary.ts, just for the 10 hero landmarks
// instead of the 100 territory footprints. Each region gets one archetype tuned with its
// own parameters/colors rather than 10 fully bespoke code paths.

function jaggedRockGeometry(rng: () => number, radius: number, jag: number, detail = 1): THREE.BufferGeometry {
  const geometry = new THREE.IcosahedronGeometry(radius, detail)
  const position = geometry.attributes.position
  const vertex = new THREE.Vector3()
  for (let i = 0; i < position.count; i += 1) {
    vertex.fromBufferAttribute(position, i)
    const displacement = 1 + (rng() - 0.5) * jag
    vertex.multiplyScalar(displacement)
    position.setXYZ(i, vertex.x, vertex.y, vertex.z)
  }
  geometry.computeVertexNormals()
  return geometry
}

interface RockClusterOptions {
  count: number
  baseRadius: number
  spread: number
  colorHex: string
  metalness?: number
  roughness?: number
  emissiveHex?: string
}

function buildRockCluster(rng: () => number, opts: RockClusterOptions): THREE.Group {
  const group = new THREE.Group()
  const material = new THREE.MeshStandardMaterial({
    color: opts.colorHex,
    metalness: opts.metalness ?? 0.3,
    roughness: opts.roughness ?? 0.5,
    emissive: opts.emissiveHex ?? '#000000',
    emissiveIntensity: opts.emissiveHex ? 0.5 : 0,
  })
  for (let i = 0; i < opts.count; i += 1) {
    const r = opts.baseRadius * (0.45 + rng() * 0.6)
    const mesh = new THREE.Mesh(jaggedRockGeometry(rng, r, 0.5), material)
    const angle = rng() * Math.PI * 2
    const dist = rng() * opts.spread
    mesh.position.set(Math.cos(angle) * dist, r * 0.6 + rng() * r * 0.3, Math.sin(angle) * dist)
    mesh.rotation.set(rng() * Math.PI, rng() * Math.PI, rng() * Math.PI)
    group.add(mesh)
  }
  return group
}

interface TowerOptions {
  height: number
  radiusBottom: number
  radiusTop: number
  colorHex: string
  x?: number
  z?: number
}

function buildTower(opts: TowerOptions): THREE.Mesh {
  const geometry = new THREE.CylinderGeometry(opts.radiusTop, opts.radiusBottom, opts.height, 8)
  const material = new THREE.MeshStandardMaterial({ color: opts.colorHex, metalness: 0.2, roughness: 0.6 })
  const mesh = new THREE.Mesh(geometry, material)
  mesh.position.set(opts.x ?? 0, opts.height / 2, opts.z ?? 0)
  return mesh
}

interface CitadelOptions {
  baseColor: string
  towerColor: string
}

function buildCitadel(rng: () => number, opts: CitadelOptions): THREE.Group {
  const group = new THREE.Group()
  group.add(buildRockCluster(rng, { count: 5, baseRadius: 0.09, spread: 0.1, colorHex: opts.baseColor, roughness: 0.3, metalness: 0.1 }))
  const towerCount = 4
  for (let i = 0; i < towerCount; i += 1) {
    const angle = (i / towerCount) * Math.PI * 2
    group.add(
      buildTower({
        height: 0.16 + rng() * 0.1,
        radiusBottom: 0.035,
        radiusTop: 0.012,
        colorHex: opts.towerColor,
        x: Math.cos(angle) * 0.08,
        z: Math.sin(angle) * 0.08,
      }),
    )
  }
  return group
}

interface TreeOptions {
  trunkHeight: number
  canopyRadius: number
  trunkColor: string
  canopyColor: string
  canopyEmissiveHex?: string
}

function buildTree(rng: () => number, opts: TreeOptions): THREE.Group {
  const group = new THREE.Group()
  const trunkGeometry = new THREE.CylinderGeometry(opts.canopyRadius * 0.12, opts.canopyRadius * 0.22, opts.trunkHeight, 8)
  const trunkMaterial = new THREE.MeshStandardMaterial({ color: opts.trunkColor, roughness: 0.9 })
  const trunk = new THREE.Mesh(trunkGeometry, trunkMaterial)
  trunk.position.y = opts.trunkHeight / 2
  group.add(trunk)

  const canopyMaterial = new THREE.MeshStandardMaterial({
    color: opts.canopyColor,
    roughness: 0.6,
    emissive: opts.canopyEmissiveHex ?? '#000000',
    emissiveIntensity: opts.canopyEmissiveHex ? 0.45 : 0,
  })
  for (let i = 0; i < 6; i += 1) {
    const r = opts.canopyRadius * (0.5 + rng() * 0.5)
    const mesh = new THREE.Mesh(new THREE.IcosahedronGeometry(r, 1), canopyMaterial)
    const angle = rng() * Math.PI * 2
    const dist = rng() * opts.canopyRadius * 0.6
    mesh.position.set(Math.cos(angle) * dist, opts.trunkHeight + r * 0.5, Math.sin(angle) * dist)
    group.add(mesh)
  }
  return group
}

interface RingOptions {
  radius: number
  tube: number
  colorHex: string
}

function buildFloatingRing(rng: () => number, opts: RingOptions): THREE.Group {
  const group = new THREE.Group()
  const ringMaterial = new THREE.MeshStandardMaterial({
    color: opts.colorHex,
    metalness: 0.85,
    roughness: 0.2,
    emissive: opts.colorHex,
    emissiveIntensity: 0.15,
  })
  const ring = new THREE.Mesh(new THREE.TorusGeometry(opts.radius, opts.tube, 12, 32), ringMaterial)
  ring.rotation.x = Math.PI / 2.4
  ring.position.y = opts.radius * 0.6
  group.add(ring)

  const shardMaterial = new THREE.MeshStandardMaterial({ color: opts.colorHex, metalness: 0.7, roughness: 0.3 })
  for (let i = 0; i < 3; i += 1) {
    const shard = new THREE.Mesh(jaggedRockGeometry(rng, opts.radius * 0.09, 0.4), shardMaterial)
    const angle = rng() * Math.PI * 2
    shard.position.set(
      Math.cos(angle) * opts.radius * 1.15,
      opts.radius * 0.6 + (rng() - 0.5) * opts.radius * 0.3,
      Math.sin(angle) * opts.radius * 1.15,
    )
    group.add(shard)
  }
  return group
}

interface VolcanoOptions {
  baseRadius: number
  height: number
  colorHex: string
  emissiveHex: string
}

function buildVolcano(opts: VolcanoOptions): THREE.Group {
  const group = new THREE.Group()
  const cone = new THREE.Mesh(
    new THREE.ConeGeometry(opts.baseRadius, opts.height, 10, 1, true),
    new THREE.MeshStandardMaterial({ color: opts.colorHex, roughness: 0.85 }),
  )
  cone.position.y = opts.height / 2
  group.add(cone)

  const crater = new THREE.Mesh(
    new THREE.CircleGeometry(opts.baseRadius * 0.35, 12),
    new THREE.MeshStandardMaterial({
      color: opts.emissiveHex,
      emissive: opts.emissiveHex,
      emissiveIntensity: 1.2,
      roughness: 0.4,
    }),
  )
  crater.rotation.x = -Math.PI / 2
  crater.position.y = opts.height * 0.98
  group.add(crater)
  return group
}

interface RuinsOptions {
  colorHex: string
}

function buildRuinsCluster(rng: () => number, opts: RuinsOptions): THREE.Group {
  const group = new THREE.Group()
  const material = new THREE.MeshStandardMaterial({ color: opts.colorHex, roughness: 0.8, metalness: 0.15 })
  for (let i = 0; i < 6; i += 1) {
    const w = 0.04 + rng() * 0.05
    const h = 0.06 + rng() * 0.12
    const d = 0.04 + rng() * 0.05
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material)
    const angle = rng() * Math.PI * 2
    const dist = rng() * 0.14
    mesh.position.set(Math.cos(angle) * dist, (h / 2) * (0.5 + rng() * 0.5), Math.sin(angle) * dist)
    mesh.rotation.set((rng() - 0.5) * 0.6, rng() * Math.PI * 2, (rng() - 0.5) * 0.6)
    group.add(mesh)
  }
  return group
}

interface BuriedGiantOptions {
  colorHex: string
  scale: number
}

function buildBuriedGiant(rng: () => number, opts: BuriedGiantOptions): THREE.Group {
  const group = new THREE.Group()
  const material = new THREE.MeshStandardMaterial({ color: opts.colorHex, roughness: 0.95 })

  const head = new THREE.Mesh(jaggedRockGeometry(rng, opts.scale * 0.22, 0.35), material)
  head.position.y = opts.scale * 0.42
  group.add(head)

  const torso = new THREE.Mesh(jaggedRockGeometry(rng, opts.scale * 0.32, 0.3), material)
  torso.position.y = opts.scale * 0.14
  torso.scale.set(1.3, 0.8, 1)
  group.add(torso)

  for (const side of [-1, 1]) {
    const arm = new THREE.Mesh(jaggedRockGeometry(rng, opts.scale * 0.14, 0.4), material)
    arm.position.set(side * opts.scale * 0.36, opts.scale * 0.08, 0)
    group.add(arm)
  }
  return group
}

export interface LandmarkDef {
  biomeId: string
  name: string
  build: () => THREE.Object3D
}

// One landmark per region, anchored at a fixed point within that region's biome band by
// Landmarks.tsx. Colors are pulled from each biome's own palette so landmarks read as
// belonging to their region rather than looking like generic assets dropped in.
export function buildAllLandmarks(seedBase: number): LandmarkDef[] {
  const biome = (id: string) => getBiomeById(id)!

  return [
    {
      biomeId: 'frozen-crown',
      name: 'Frozen Citadel',
      build: () => buildCitadel(mulberry32(seedBase + 1), {
        baseColor: biome('frozen-crown').baseColor,
        towerColor: biome('frozen-crown').accentColor,
      }),
    },
    {
      biomeId: 'thunder-highlands',
      name: 'Lightning Spire',
      build: () => {
        const group = new THREE.Group()
        group.add(buildTower({ height: 0.3, radiusBottom: 0.09, radiusTop: 0.015, colorHex: biome('thunder-highlands').baseColor }))
        const crystal = new THREE.Mesh(
          new THREE.OctahedronGeometry(0.035, 0),
          new THREE.MeshStandardMaterial({
            color: biome('thunder-highlands').accentColor,
            emissive: biome('thunder-highlands').accentColor,
            emissiveIntensity: 1.4,
            roughness: 0.2,
          }),
        )
        crystal.position.y = 0.32
        group.add(crystal)
        return group
      },
    },
    {
      biomeId: 'whispering-desert',
      name: 'Buried Stone Giant',
      build: () => buildBuriedGiant(mulberry32(seedBase + 3), { colorHex: biome('whispering-desert').baseColor, scale: 0.5 }),
    },
    {
      biomeId: 'ancient-jungle',
      name: 'Temple of the Elder Tree',
      build: () => {
        const group = new THREE.Group()
        group.add(
          buildTree(mulberry32(seedBase + 4), {
            trunkHeight: 0.18,
            canopyRadius: 0.11,
            trunkColor: '#4a3524',
            canopyColor: biome('ancient-jungle').accentColor,
          }),
        )
        group.add(buildRuinsCluster(mulberry32(seedBase + 44), { colorHex: '#8a8271' }))
        return group
      },
    },
    {
      biomeId: 'emerald-wilds',
      name: 'The Colossal Tree',
      build: () => buildTree(mulberry32(seedBase + 5), {
        trunkHeight: 0.2,
        canopyRadius: 0.14,
        trunkColor: '#3f2a1a',
        canopyColor: biome('emerald-wilds').accentColor,
        canopyEmissiveHex: biome('emerald-wilds').accentColor,
      }),
    },
    {
      biomeId: 'liquid-blu-metal-sea',
      name: 'The Magnetic Ring',
      build: () => buildFloatingRing(mulberry32(seedBase + 6), {
        radius: 0.2,
        tube: 0.025,
        colorHex: biome('liquid-blu-metal-sea').accentColor,
      }),
    },
    {
      biomeId: 'molten-wastes',
      name: 'The Great Volcano',
      build: () => buildVolcano({
        baseRadius: 0.2,
        height: 0.3,
        colorHex: biome('molten-wastes').baseColor,
        emissiveHex: biome('molten-wastes').accentColor,
      }),
    },
    {
      biomeId: 'toxic-expanse',
      name: 'Ruined Industrial Complex',
      build: () => buildRuinsCluster(mulberry32(seedBase + 8), { colorHex: biome('toxic-expanse').baseColor }),
    },
    {
      biomeId: 'crystal-basin',
      name: 'Crystal Mountain',
      build: () => buildRockCluster(mulberry32(seedBase + 9), {
        count: 6,
        baseRadius: 0.15,
        spread: 0.09,
        colorHex: biome('crystal-basin').accentColor,
        metalness: 0.1,
        roughness: 0.15,
        emissiveHex: biome('crystal-basin').accentColor,
      }),
    },
    {
      biomeId: 'void-scar',
      name: 'The Black Crystal',
      build: () => buildRockCluster(mulberry32(seedBase + 10), {
        count: 5,
        baseRadius: 0.17,
        spread: 0.12,
        colorHex: biome('void-scar').baseColor,
        metalness: 0.4,
        roughness: 0.35,
        emissiveHex: biome('void-scar').accentColor,
      }),
    },
  ]
}
