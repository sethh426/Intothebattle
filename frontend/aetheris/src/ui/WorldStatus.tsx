import type { AetherisWorldState, Territory, WorldConnectionStatus } from '../types'

interface WorldStatusProps {
  status: WorldConnectionStatus
  worldState: AetherisWorldState
  territories: Territory[]
  selectedTerritoryId: string | null
  onSelectTerritory: (territoryId: string) => void
}

function connectionLabel(status: WorldConnectionStatus): string {
  if (status === 'preview') return 'World preview'
  if (status === 'connected') return 'World linked'
  if (status === 'connecting') return 'Linking world'
  if (status === 'reconnecting') return 'Restoring link'
  return 'World offline'
}

export default function WorldStatus({ status, worldState, territories, selectedTerritoryId, onSelectTerritory }: WorldStatusProps) {
  const territoryById = new Map(territories.map(territory => [territory.id, territory]))
  const activeCampaigns = worldState.campaigns.filter(campaign => campaign.phase === 'mobilizing' || campaign.phase === 'scoring' || campaign.phase === 'deadline')

  return (
    <aside className="aetheris-world-status" aria-label="Aetheris world activity">
      <div className="aetheris-world-status__signal">
        <span className={`aetheris-world-status__dot is-${status}`} aria-hidden="true" />
        <strong>{connectionLabel(status)}</strong>
        <small>{activeCampaigns.length ? `${activeCampaigns.length} active ${activeCampaigns.length === 1 ? 'war' : 'wars'}` : 'No active wars'}</small>
      </div>
      {activeCampaigns.length > 0 && (
        <div className="aetheris-world-status__wars" aria-label="Active wars">
          {activeCampaigns.slice(0, 4).map(campaign => {
            const territory = territoryById.get(campaign.territoryId)
            if (!territory) return null
            const selected = selectedTerritoryId === territory.id
            return (
              <button key={campaign.id} type="button" className={selected ? 'is-selected' : ''} onClick={() => onSelectTerritory(territory.id)}>
                <span>{campaign.phase === 'mobilizing' ? 'Mobilizing' : 'Under siege'}</span>
                <strong>{territory.territoryName}</strong>
                <small>{campaign.attackerWins}-{campaign.defenderWins}</small>
              </button>
            )
          })}
        </div>
      )}
    </aside>
  )
}
