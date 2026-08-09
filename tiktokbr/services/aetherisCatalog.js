import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const catalogPath = path.join(__dirname, '..', '..', 'frontend', 'aetheris', 'src', 'data', 'territoryCatalog.json');
const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));

export const AETHERIS_TERRITORIES = Object.freeze(catalog.territories.map(territory => Object.freeze({
  ...territory,
  neighbors: Object.freeze([...territory.neighbors]),
})));

export const AETHERIS_TERRITORY_BY_ID = new Map(AETHERIS_TERRITORIES.map(territory => [territory.id, territory]));

export function getWorldTerritory(territoryId) {
  return AETHERIS_TERRITORY_BY_ID.get(String(territoryId || '').trim()) || null;
}

export function areTerritoriesAdjacent(firstId, secondId) {
  const first = getWorldTerritory(firstId);
  return Boolean(first && first.neighbors.includes(String(secondId || '').trim()));
}

export function validateAetherisCatalog() {
  const errors = [];
  if (AETHERIS_TERRITORIES.length !== 100) errors.push(`expected 100 territories, found ${AETHERIS_TERRITORIES.length}`);
  for (const territory of AETHERIS_TERRITORIES) {
    if (territory.neighbors.length < 3 || territory.neighbors.length > 6) {
      errors.push(`${territory.id} has ${territory.neighbors.length} neighbors`);
    }
    for (const neighborId of territory.neighbors) {
      const neighbor = getWorldTerritory(neighborId);
      if (!neighbor) errors.push(`${territory.id} references missing neighbor ${neighborId}`);
      else if (!neighbor.neighbors.includes(territory.id)) errors.push(`${territory.id} -> ${neighborId} is not symmetric`);
    }
  }
  return { ok: errors.length === 0, errors };
}
