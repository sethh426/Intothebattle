import assert from 'node:assert/strict';
import fs from 'node:fs';

const catalog = JSON.parse(fs.readFileSync(new URL('../frontend/aetheris/src/data/territoryCatalog.json', import.meta.url)));
const geography = JSON.parse(fs.readFileSync(new URL('../frontend/aetheris/src/data/geographyLayout.json', import.meta.url)));
const rad = Math.PI / 180;

function angularDistance(a, b) {
  const lat1 = a.lat * rad;
  const lat2 = b.lat * rad;
  const dLon = (b.lon - a.lon) * rad;
  return Math.acos(Math.min(1, Math.max(-1, Math.sin(lat1) * Math.sin(lat2) + Math.cos(lat1) * Math.cos(lat2) * Math.cos(dLon))));
}

const byId = new Map(catalog.territories.map(territory => [territory.id, territory]));
for (const territory of catalog.territories) {
  const layout = geography.biomes[territory.biomeId];
  assert(layout, `Missing geography for ${territory.biomeId}`);
  const anchors = layout.settlements.map(([lat, lon]) => ({ lat, lon }));
  const nearestSettlement = Math.min(...anchors.map(anchor => angularDistance(territory, anchor)));
  assert(nearestSettlement <= 0.34, `${territory.id} is isolated from its biome settlements`);
  for (const neighborId of territory.neighbors) {
    const neighbor = byId.get(neighborId);
    assert(neighbor, `${territory.id} references missing neighbor ${neighborId}`);
    assert(angularDistance(territory, neighbor) <= 1.15, `${territory.id} has an implausibly long route to ${neighborId}`);
  }
}

for (const [biomeId, layout] of Object.entries(geography.biomes)) {
  const biomeTerritories = catalog.territories.filter(territory => territory.biomeId === biomeId);
  const capital = { lat: layout.capital[0], lon: layout.capital[1] };
  assert(biomeTerritories.some(territory => angularDistance(territory, capital) <= 0.18), `${biomeId} landmark has no nearby territory`);
}

console.log(`Aetheris geography contract passed for ${catalog.territories.length} territories.`);
