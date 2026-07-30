import * as THREE from 'three'
import { mulberry32 } from '../config'
import { getBiomeById } from './biomeData'

type Vec3 = [number, number, number]

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

function standardMaterial(
  colorHex: string,
  roughness = 0.62,
  metalness = 0.18,
  emissiveHex = '#000000',
  emissiveIntensity = 0,
): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: colorHex,
    roughness,
    metalness,
    emissive: emissiveHex,
    emissiveIntensity,
  })
}

function glowMaterial(colorHex: string, opacity = 0.82): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    color: colorHex,
    transparent: true,
    opacity,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
  })
}

function addMesh(
  group: THREE.Group,
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  position: Vec3,
  rotation: Vec3 = [0, 0, 0],
  scale: Vec3 = [1, 1, 1],
): THREE.Mesh {
  const mesh = new THREE.Mesh(geometry, material)
  mesh.position.set(...position)
  mesh.rotation.set(...rotation)
  mesh.scale.set(...scale)
  group.add(mesh)
  return mesh
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
  const material = standardMaterial(
    opts.colorHex,
    opts.roughness ?? 0.5,
    opts.metalness ?? 0.3,
    opts.emissiveHex ?? '#000000',
    opts.emissiveHex ? 0.5 : 0,
  )
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
  material: THREE.Material
  x?: number
  z?: number
}

function buildTower(opts: TowerOptions): THREE.Mesh {
  const geometry = new THREE.CylinderGeometry(opts.radiusTop, opts.radiusBottom, opts.height, 12)
  const mesh = new THREE.Mesh(geometry, opts.material)
  mesh.position.set(opts.x ?? 0, opts.height / 2, opts.z ?? 0)
  return mesh
}

function addRing(group: THREE.Group, radius: number, tube: number, material: THREE.Material, y: number): THREE.Mesh {
  return addMesh(group, new THREE.TorusGeometry(radius, tube, 10, 42), material, [0, y, 0], [Math.PI / 2, 0, 0])
}

interface CitadelOptions {
  baseColor: string
  towerColor: string
}

function buildCitadel(rng: () => number, opts: CitadelOptions): THREE.Group {
  const group = new THREE.Group()
  const stone = standardMaterial('#7e8792', 0.76, 0.12)
  const darkStone = standardMaterial(opts.baseColor, 0.68, 0.18)
  const roof = standardMaterial(opts.towerColor, 0.42, 0.28, opts.towerColor, 0.18)
  const windowLight = glowMaterial('#ffe7a3', 0.88)

  group.add(buildRockCluster(rng, { count: 9, baseRadius: 0.075, spread: 0.22, colorHex: opts.baseColor, roughness: 0.42, metalness: 0.08 }))
  addMesh(group, new THREE.CylinderGeometry(0.26, 0.32, 0.06, 18), darkStone, [0, 0.03, 0])
  addRing(group, 0.22, 0.018, stone, 0.1)
  addMesh(group, new THREE.CylinderGeometry(0.16, 0.2, 0.42, 14), stone, [0, 0.3, 0])
  addMesh(group, new THREE.ConeGeometry(0.19, 0.16, 14), roof, [0, 0.59, 0])
  addMesh(group, new THREE.BoxGeometry(0.034, 0.12, 0.012), windowLight, [0, 0.35, 0.205])
  addMesh(group, new THREE.BoxGeometry(0.034, 0.1, 0.012), windowLight, [0, 0.32, -0.205])

  for (let i = 0; i < 6; i += 1) {
    const angle = (i / 6) * Math.PI * 2
    const x = Math.cos(angle) * 0.18
    const z = Math.sin(angle) * 0.18
    const towerHeight = 0.2 + rng() * 0.1
    group.add(buildTower({ height: towerHeight, radiusBottom: 0.045, radiusTop: 0.032, material: stone, x, z }))
    addMesh(group, new THREE.ConeGeometry(0.06, 0.08, 12), roof, [x, towerHeight + 0.04, z])
  }
  return group
}

function buildLightningSpire(baseColor: string, accentColor: string): THREE.Group {
  const group = new THREE.Group()
  const stone = standardMaterial(baseColor, 0.72, 0.28)
  const trim = standardMaterial('#8c91b7', 0.42, 0.36, accentColor, 0.1)
  const energy = glowMaterial(accentColor, 0.86)

  addMesh(group, new THREE.CylinderGeometry(0.19, 0.27, 0.08, 12), stone, [0, 0.04, 0])
  addRing(group, 0.2, 0.012, trim, 0.1)
  addMesh(group, new THREE.CylinderGeometry(0.05, 0.1, 0.5, 8), stone, [0, 0.34, 0])
  addMesh(group, new THREE.ConeGeometry(0.08, 0.24, 7), trim, [0, 0.72, 0])
  addMesh(group, new THREE.OctahedronGeometry(0.07, 0), energy, [0, 0.9, 0], [0.2, 0.4, 0], [0.72, 1.35, 0.72])
  addRing(group, 0.13, 0.007, energy, 0.62)

  for (let i = 0; i < 4; i += 1) {
    const angle = (i / 4) * Math.PI * 2 + Math.PI / 4
    const x = Math.cos(angle) * 0.11
    const z = Math.sin(angle) * 0.11
    const rotation: Vec3 = [0.28, angle, 0.18]
    addMesh(group, new THREE.BoxGeometry(0.035, 0.36, 0.035), stone, [x, 0.22, z], rotation)
  }
  return group
}

interface TreeOptions {
  trunkHeight: number
  canopyRadius: number
  trunkColor: string
  canopyColor: string
  canopyEmissiveHex?: string
  templeBase?: boolean
}

function buildTree(rng: () => number, opts: TreeOptions): THREE.Group {
  const group = new THREE.Group()
  const trunkMaterial = standardMaterial(opts.trunkColor, 0.9, 0.04)
  const canopyMaterial = standardMaterial(
    opts.canopyColor,
    0.58,
    0.05,
    opts.canopyEmissiveHex ?? '#000000',
    opts.canopyEmissiveHex ? 0.38 : 0,
  )
  const stone = standardMaterial('#8a8271', 0.78, 0.08)

  if (opts.templeBase) {
    addMesh(group, new THREE.CylinderGeometry(0.24, 0.3, 0.055, 12), stone, [0, 0.028, 0])
    addRing(group, 0.2, 0.014, stone, 0.075)
    for (let i = 0; i < 5; i += 1) {
      const angle = (i / 5) * Math.PI * 2
      addMesh(group, new THREE.CylinderGeometry(0.018, 0.024, 0.12, 7), stone, [Math.cos(angle) * 0.2, 0.13, Math.sin(angle) * 0.2])
    }
  }

  const trunk = new THREE.Mesh(
    new THREE.CylinderGeometry(opts.canopyRadius * 0.12, opts.canopyRadius * 0.26, opts.trunkHeight, 10),
    trunkMaterial,
  )
  trunk.position.y = opts.trunkHeight / 2 + (opts.templeBase ? 0.06 : 0)
  group.add(trunk)

  for (let i = 0; i < 5; i += 1) {
    const angle = (i / 5) * Math.PI * 2
    addMesh(
      group,
      new THREE.CylinderGeometry(opts.canopyRadius * 0.035, opts.canopyRadius * 0.07, opts.canopyRadius * 1.15, 7),
      trunkMaterial,
      [Math.cos(angle) * opts.canopyRadius * 0.34, opts.templeBase ? 0.08 : 0.04, Math.sin(angle) * opts.canopyRadius * 0.34],
      [Math.PI / 2.5, 0, angle],
    )
  }

  for (let i = 0; i < 8; i += 1) {
    const r = opts.canopyRadius * (0.42 + rng() * 0.55)
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(r, 14, 10), canopyMaterial)
    const angle = rng() * Math.PI * 2
    const dist = rng() * opts.canopyRadius * 0.72
    mesh.position.set(
      Math.cos(angle) * dist,
      (opts.templeBase ? 0.06 : 0) + opts.trunkHeight + r * 0.58,
      Math.sin(angle) * dist,
    )
    mesh.scale.y = 1.08 + rng() * 0.24
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
  const ringMaterial = standardMaterial(opts.colorHex, 0.22, 0.85, opts.colorHex, 0.2)
  const stone = standardMaterial('#32475a', 0.54, 0.38)
  const energy = glowMaterial(opts.colorHex, 0.78)

  addMesh(group, new THREE.CylinderGeometry(opts.radius * 0.54, opts.radius * 0.68, 0.055, 14), stone, [0, 0.028, 0])
  for (let i = 0; i < 3; i += 1) {
    const angle = (i / 3) * Math.PI * 2
    addMesh(group, new THREE.CylinderGeometry(opts.tube * 0.7, opts.tube * 1.05, opts.radius * 1.1, 8), stone, [
      Math.cos(angle) * opts.radius * 0.45,
      opts.radius * 0.32,
      Math.sin(angle) * opts.radius * 0.45,
    ])
  }

  const outerRing = addMesh(
    group,
    new THREE.TorusGeometry(opts.radius, opts.tube, 12, 40),
    ringMaterial,
    [0, opts.radius * 0.95, 0],
    [Math.PI / 2.4, 0.2, 0.25],
  )
  outerRing.scale.set(1.14, 1.14, 1.14)
  addMesh(
    group,
    new THREE.TorusGeometry(opts.radius * 0.58, opts.tube * 0.6, 8, 30),
    ringMaterial,
    [0, opts.radius * 0.98, 0],
    [Math.PI / 1.9, 0, 0.85],
  )
  addMesh(group, new THREE.SphereGeometry(opts.radius * 0.18, 12, 8), energy, [0, opts.radius * 0.98, 0])

  const shardMaterial = standardMaterial(opts.colorHex, 0.3, 0.68, opts.colorHex, 0.12)
  for (let i = 0; i < 4; i += 1) {
    const angle = rng() * Math.PI * 2
    const shard = new THREE.Mesh(jaggedRockGeometry(rng, opts.radius * 0.08, 0.4), shardMaterial)
    shard.position.set(
      Math.cos(angle) * opts.radius * 1.15,
      opts.radius * 0.8 + (rng() - 0.5) * opts.radius * 0.42,
      Math.sin(angle) * opts.radius * 1.15,
    )
    shard.scale.y = 1.3 + rng() * 0.6
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
  const rock = standardMaterial(opts.colorHex, 0.88, 0.12)
  const lava = glowMaterial(opts.emissiveHex, 0.9)

  addMesh(group, new THREE.CylinderGeometry(opts.baseRadius * 0.72, opts.baseRadius * 1.15, 0.08, 14), rock, [0, 0.04, 0])
  addMesh(group, new THREE.ConeGeometry(opts.baseRadius, opts.height, 18, 1, true), rock, [0, opts.height / 2 + 0.04, 0])
  addRing(group, opts.baseRadius * 0.35, opts.baseRadius * 0.055, rock, opts.height * 0.96 + 0.04)
  addMesh(group, new THREE.CircleGeometry(opts.baseRadius * 0.32, 22), lava, [0, opts.height * 0.99 + 0.046, 0], [-Math.PI / 2, 0, 0])
  addMesh(group, new THREE.ConeGeometry(opts.baseRadius * 0.22, opts.height * 0.95, 14, 1, true), lava, [0, opts.height * 1.34, 0])

  for (let i = 0; i < 5; i += 1) {
    const angle = (i / 5) * Math.PI * 2
    addMesh(
      group,
      new THREE.BoxGeometry(opts.baseRadius * 0.08, opts.height * 0.68, opts.baseRadius * 0.035),
      lava,
      [Math.cos(angle) * opts.baseRadius * 0.43, opts.height * 0.42, Math.sin(angle) * opts.baseRadius * 0.43],
      [0.38, angle, 0],
    )
  }
  return group
}

function buildIndustrialRuins(rng: () => number, baseColor: string, accentColor: string): THREE.Group {
  const group = new THREE.Group()
  const concrete = standardMaterial(baseColor, 0.82, 0.16)
  const metal = standardMaterial('#66726d', 0.5, 0.52)
  const toxicGlow = glowMaterial(accentColor, 0.78)

  addMesh(group, new THREE.CylinderGeometry(0.22, 0.29, 0.045, 12), concrete, [0, 0.022, 0])
  for (let i = 0; i < 7; i += 1) {
    const w = 0.05 + rng() * 0.07
    const h = 0.08 + rng() * 0.15
    const d = 0.05 + rng() * 0.07
    const angle = rng() * Math.PI * 2
    const dist = 0.04 + rng() * 0.18
    addMesh(
      group,
      new THREE.BoxGeometry(w, h, d),
      i % 3 === 0 ? metal : concrete,
      [Math.cos(angle) * dist, h / 2 + 0.035, Math.sin(angle) * dist],
      [(rng() - 0.5) * 0.24, rng() * Math.PI * 2, (rng() - 0.5) * 0.24],
    )
  }
  for (let i = 0; i < 3; i += 1) {
    const angle = (i / 3) * Math.PI * 2 + 0.2
    const x = Math.cos(angle) * 0.13
    const z = Math.sin(angle) * 0.13
    addMesh(group, new THREE.CylinderGeometry(0.018, 0.026, 0.28 + rng() * 0.1, 8), metal, [x, 0.18, z])
  }
  addMesh(group, new THREE.CircleGeometry(0.085, 18), toxicGlow, [-0.05, 0.052, 0.09], [-Math.PI / 2, 0, 0], [1.45, 1, 1])
  addMesh(group, new THREE.CylinderGeometry(0.012, 0.012, 0.34, 8), metal, [0.04, 0.09, -0.02], [Math.PI / 2, 0, 0.7])
  return group
}

interface BuriedGiantOptions {
  colorHex: string
  scale: number
}

function buildBuriedGiant(rng: () => number, opts: BuriedGiantOptions): THREE.Group {
  const group = new THREE.Group()
  const sandstone = standardMaterial(opts.colorHex, 0.9, 0.04)
  const shadowStone = standardMaterial('#6f4a2e', 0.86, 0.05)

  addMesh(group, new THREE.CylinderGeometry(opts.scale * 0.38, opts.scale * 0.48, opts.scale * 0.055, 14), sandstone, [0, opts.scale * 0.027, 0])
  const torso = new THREE.Mesh(jaggedRockGeometry(rng, opts.scale * 0.26, 0.26), sandstone)
  torso.position.y = opts.scale * 0.18
  torso.scale.set(1.25, 0.66, 0.92)
  group.add(torso)

  const head = new THREE.Mesh(jaggedRockGeometry(rng, opts.scale * 0.18, 0.3), sandstone)
  head.position.y = opts.scale * 0.43
  head.scale.set(0.8, 1.08, 0.78)
  group.add(head)

  for (const side of [-1, 1]) {
    addMesh(
      group,
      new THREE.CylinderGeometry(opts.scale * 0.07, opts.scale * 0.09, opts.scale * 0.42, 8),
      shadowStone,
      [side * opts.scale * 0.36, opts.scale * 0.12, 0],
      [Math.PI / 2.25, 0, side * 0.36],
    )
  }
  for (let i = 0; i < 5; i += 1) {
    const x = (i - 2) * opts.scale * 0.08
    addMesh(group, new THREE.BoxGeometry(opts.scale * 0.035, opts.scale * 0.12, opts.scale * 0.045), shadowStone, [x, opts.scale * 0.1, opts.scale * 0.22])
  }
  return group
}

function buildCrystalMountain(rng: () => number, baseColor: string, accentColor: string): THREE.Group {
  const group = new THREE.Group()
  const stone = standardMaterial(baseColor, 0.42, 0.24)
  const crystal = standardMaterial(accentColor, 0.15, 0.12, accentColor, 0.58)

  addMesh(group, new THREE.CylinderGeometry(0.22, 0.28, 0.055, 13), stone, [0, 0.028, 0])
  for (let i = 0; i < 9; i += 1) {
    const radius = 0.045 + rng() * 0.055
    const height = 1.35 + rng() * 1.1
    const angle = rng() * Math.PI * 2
    const dist = rng() * 0.17
    addMesh(
      group,
      new THREE.OctahedronGeometry(radius, 0),
      crystal,
      [Math.cos(angle) * dist, radius * height * 0.7 + 0.04, Math.sin(angle) * dist],
      [rng() * 0.35, rng() * Math.PI, rng() * 0.35],
      [0.75 + rng() * 0.6, height, 0.75 + rng() * 0.6],
    )
  }
  return group
}

function buildVoidShard(rng: () => number, baseColor: string, accentColor: string): THREE.Group {
  const group = new THREE.Group()
  const obsidian = standardMaterial(baseColor, 0.32, 0.48, accentColor, 0.22)
  const glow = glowMaterial(accentColor, 0.72)

  addMesh(group, new THREE.CylinderGeometry(0.19, 0.25, 0.05, 11), obsidian, [0, 0.025, 0])
  addRing(group, 0.16, 0.01, glow, 0.09)
  addMesh(group, jaggedRockGeometry(rng, 0.14, 0.32), obsidian, [0, 0.3, 0], [0.14, 0.4, -0.08], [0.66, 1.85, 0.66])
  addMesh(group, new THREE.TorusGeometry(0.18, 0.009, 8, 32), glow, [0, 0.42, 0], [Math.PI / 1.8, 0.4, 0.8])
  for (let i = 0; i < 5; i += 1) {
    const angle = rng() * Math.PI * 2
    addMesh(
      group,
      jaggedRockGeometry(rng, 0.035 + rng() * 0.035, 0.45),
      obsidian,
      [Math.cos(angle) * (0.16 + rng() * 0.08), 0.18 + rng() * 0.34, Math.sin(angle) * (0.16 + rng() * 0.08)],
      [rng() * Math.PI, rng() * Math.PI, rng() * Math.PI],
    )
  }
  return group
}

export interface LandmarkDef {
  biomeId: string
  name: string
  build: () => THREE.Object3D
}

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
      build: () => buildLightningSpire(biome('thunder-highlands').baseColor, biome('thunder-highlands').accentColor),
    },
    {
      biomeId: 'whispering-desert',
      name: 'Buried Stone Giant',
      build: () => buildBuriedGiant(mulberry32(seedBase + 3), { colorHex: biome('whispering-desert').baseColor, scale: 0.54 }),
    },
    {
      biomeId: 'ancient-jungle',
      name: 'Temple of the Elder Tree',
      build: () => buildTree(mulberry32(seedBase + 4), {
        trunkHeight: 0.2,
        canopyRadius: 0.12,
        trunkColor: '#4a3524',
        canopyColor: biome('ancient-jungle').accentColor,
        templeBase: true,
      }),
    },
    {
      biomeId: 'emerald-wilds',
      name: 'The Colossal Tree',
      build: () => buildTree(mulberry32(seedBase + 5), {
        trunkHeight: 0.24,
        canopyRadius: 0.16,
        trunkColor: '#3f2a1a',
        canopyColor: biome('emerald-wilds').accentColor,
        canopyEmissiveHex: biome('emerald-wilds').accentColor,
        templeBase: true,
      }),
    },
    {
      biomeId: 'liquid-blu-metal-sea',
      name: 'The Magnetic Ring',
      build: () => buildFloatingRing(mulberry32(seedBase + 6), {
        radius: 0.22,
        tube: 0.025,
        colorHex: biome('liquid-blu-metal-sea').accentColor,
      }),
    },
    {
      biomeId: 'molten-wastes',
      name: 'The Great Volcano',
      build: () => buildVolcano({
        baseRadius: 0.22,
        height: 0.34,
        colorHex: biome('molten-wastes').baseColor,
        emissiveHex: biome('molten-wastes').accentColor,
      }),
    },
    {
      biomeId: 'toxic-expanse',
      name: 'Ruined Industrial Complex',
      build: () => buildIndustrialRuins(
        mulberry32(seedBase + 8),
        biome('toxic-expanse').baseColor,
        biome('toxic-expanse').accentColor,
      ),
    },
    {
      biomeId: 'crystal-basin',
      name: 'Crystal Mountain',
      build: () => buildCrystalMountain(
        mulberry32(seedBase + 9),
        biome('crystal-basin').baseColor,
        biome('crystal-basin').accentColor,
      ),
    },
    {
      biomeId: 'void-scar',
      name: 'The Black Crystal',
      build: () => buildVoidShard(mulberry32(seedBase + 10), biome('void-scar').baseColor, biome('void-scar').accentColor),
    },
  ]
}
