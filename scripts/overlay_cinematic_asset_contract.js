import fs from 'fs';
import path from 'path';
import assert from 'assert/strict';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const modelDir = path.join(root, 'public', 'assets', 'overlay-cinematic', 'models');
const artDir = path.join(root, 'public', 'assets', 'overlay-cinematic', 'portraits');
const heroes = ['solar-vanguard','prism-arcanist','tempest-lancer','verdant-oracle','moonveil-huntress','emberforged-colossus'];
const requiredArt = [...heroes, 'prismatic-horde-portal', 'prismatic-takeover-map', 'celestial-rift-regent'];
let bytes = 0;
for (const hero of heroes) {
  for (let lod=0; lod<3; lod++) {
    const file=path.join(modelDir,`${hero}-lod${lod}.glb`);
    assert.ok(fs.existsSync(file),`missing ${path.basename(file)}`); bytes+=fs.statSync(file).size;
  }
}
for (const name of ['prismatic-portal','rift-creature-1','rift-creature-2','rift-creature-3','celestial-regent']) {
  for (let lod=0; lod<3; lod++) {
    const file=path.join(modelDir,`${name}-lod${lod}.glb`);
    assert.ok(fs.existsSync(file),`missing ${path.basename(file)}`); bytes+=fs.statSync(file).size;
  }
}
for (const name of requiredArt) {
  const file=path.join(artDir,`${name}.webp`);
  assert.ok(fs.existsSync(file),`missing ${path.basename(file)}`); bytes+=fs.statSync(file).size;
}
assert.ok(bytes < 24*1024*1024,`asset payload ${bytes} exceeds 24MB`);
assert.equal(new Set(heroes).size,6,'hero IDs must be unique');
console.log(`Overlay cinematic assets: 6 heroes, 3 LODs, ${bytes} bytes.`);
