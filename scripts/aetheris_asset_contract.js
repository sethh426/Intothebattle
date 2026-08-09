import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const modelsRoot = path.join(repoRoot, 'frontend', 'aetheris', 'src', 'assets', 'aetheris', 'models')
const manifestPath = path.join(modelsRoot, 'manifest.json')
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))

function readGlb(relativePath) {
  const absolutePath = path.join(modelsRoot, relativePath)
  const buffer = fs.readFileSync(absolutePath)
  assert.equal(buffer.toString('ascii', 0, 4), 'glTF', `${relativePath} must be a binary glTF`)
  assert.equal(buffer.readUInt32LE(4), 2, `${relativePath} must use glTF 2.0`)
  const jsonLength = buffer.readUInt32LE(12)
  const document = JSON.parse(buffer.subarray(20, 20 + jsonLength).toString('utf8'))
  return { absolutePath, buffer, document }
}

function nodeNames(document) {
  return new Set((document.nodes || []).map(node => node.name).filter(Boolean))
}

function triangleCount(document) {
  let triangles = 0
  for (const mesh of document.meshes || []) {
    for (const primitive of mesh.primitives || []) {
      const accessorIndex = primitive.indices ?? primitive.attributes?.POSITION
      assert.notEqual(accessorIndex, undefined, 'Every primitive must have positions or indices')
      triangles += (document.accessors?.[accessorIndex]?.count || 0) / 3
    }
  }
  return Math.ceil(triangles)
}

assert.equal(manifest.schemaVersion, 1)
assert.equal(manifest.heroes.length, 30, 'Expected 10 heroes with three LODs each')
assert.equal(manifest.regional.length, 30, 'Expected three regional monuments per biome')
assert.equal(manifest.strongholds.length, 90, 'Expected three modules for 30 biome variants')
assert.equal(manifest.ambient.length, 10, 'Expected one ambient archetype per biome')
assert.equal(manifest.ambient.reduce((sum, entry) => sum + entry.instances, 0), 60)

const biomeIds = [...new Set(manifest.heroes.map(entry => entry.biomeId))]
assert.equal(biomeIds.length, 10)

for (const biomeId of biomeIds) {
  const heroEntries = manifest.heroes.filter(entry => entry.biomeId === biomeId)
  assert.deepEqual(heroEntries.map(entry => entry.lod).sort(), [0, 1, 2])
  assert.equal(manifest.regional.filter(entry => entry.biomeId === biomeId).length, 3)

  const strongholds = manifest.strongholds.filter(entry => entry.biomeId === biomeId)
  assert.deepEqual([...new Set(strongholds.map(entry => entry.variant))].sort(), [0, 1, 2])
  for (const variant of [0, 1, 2]) {
    assert.deepEqual(
      strongholds.filter(entry => entry.variant === variant).map(entry => entry.module).sort(),
      ['apex', 'base', 'live'],
    )
  }
}

const lodBudgets = { 0: 35000, 1: 10000, 2: 2000 }
for (const hero of manifest.heroes) {
  const { document } = readGlb(hero.file)
  assert.ok(
    (document.extensionsRequired || []).includes('EXT_meshopt_compression'),
    `${hero.file} must require Meshopt decompression`,
  )
  assert.ok((document.materials || []).length >= 3, `${hero.file} must retain at least three material roles`)
  assert.ok(triangleCount(document) <= lodBudgets[hero.lod], `${hero.file} exceeds its LOD triangle budget`)
  assert.ok(nodeNames(document).has(`HERO_${hero.biomeId.replaceAll('-', '_').toUpperCase()}_LOD${hero.lod}`))
}

for (const [packFile, entries] of [
  ['regional-monuments.glb', manifest.regional],
  ['stronghold-kit.glb', manifest.strongholds],
  ['ambient-clusters.glb', manifest.ambient],
]) {
  const { document } = readGlb(packFile)
  const names = nodeNames(document)
  for (const entry of entries) {
    assert.ok(names.has(entry.node), `${packFile} is missing named root ${entry.node}`)
  }
}

const glbFiles = []
function collectGlbs(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolutePath = path.join(directory, entry.name)
    if (entry.isDirectory()) collectGlbs(absolutePath)
    else if (entry.name.endsWith('.glb')) glbFiles.push(absolutePath)
  }
}
collectGlbs(modelsRoot)
assert.equal(glbFiles.length, 33)
const totalBytes = glbFiles.reduce((sum, file) => sum + fs.statSync(file).size, 0)
assert.ok(totalBytes <= 12 * 1024 * 1024, `Structure payload exceeds 12 MB: ${totalBytes} bytes`)

const landmarkSource = fs.readFileSync(
  path.join(repoRoot, 'frontend', 'aetheris', 'src', 'data', 'landmarkLibrary.ts'),
  'utf8',
)
assert.equal((landmarkSource.match(/biomeId:\s*'/g) || []).length, 10, 'Procedural fallback must cover 10 biomes')

console.log(
  `Aetheris asset contract passed: ${biomeIds.length} heroes, ${manifest.regional.length} monuments, `
  + `30 stronghold variants, 60 ambient clusters, ${glbFiles.length} GLBs, ${totalBytes} bytes.`,
)
