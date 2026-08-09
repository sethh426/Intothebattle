import catalog from './territoryCatalog.json'
import type { Biome, Territory } from '../types'

// The arguments remain for API compatibility with the preview simulator. Territory
// geometry and adjacency now come from one committed catalog shared with the server.
export function generateTerritories(_biomes: Biome[], _seed?: number): Territory[] {
  return catalog.territories.map((territory) => ({ ...territory, neighbors: [...territory.neighbors] })) as Territory[]
}
