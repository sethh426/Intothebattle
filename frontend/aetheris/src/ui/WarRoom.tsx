import { useEffect, useMemo, useState } from 'react'
import type { AetherisWorldState, CreatorWarStatus, Territory } from '../types'

interface WarRoomProps {
  territories: Territory[]
  worldState: AetherisWorldState
  status: CreatorWarStatus | null
  loading: boolean
  busyAction: string
  error: string
  onSelectTerritory: (territoryId: string) => void
  onOptIn: (enabled: boolean) => void
  onStartRound: (campaignId: number) => void
  onWithdraw: (campaignId: number) => void
}

function remainingLabel(value: string): string {
  const milliseconds = new Date(value).getTime() - Date.now()
  if (milliseconds <= 0) return 'now'
  const minutes = Math.ceil(milliseconds / 60_000)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes % 60}m`
}

export default function WarRoom({
  territories,
  worldState,
  status,
  loading,
  busyAction,
  error,
  onSelectTerritory,
  onOptIn,
  onStartRound,
  onWithdraw,
}: WarRoomProps) {
  const [query, setQuery] = useState('')
  const [collapsed, setCollapsed] = useState(false)
  const territoryById = useMemo(() => new Map(territories.map(territory => [territory.id, territory])), [territories])
  const targetResults = useMemo(() => {
    const normalized = query.trim().replace(/^@/, '').toLowerCase()
    if (!normalized) return []
    return Object.values(worldState.claims)
      .filter(claim => claim.holderName.toLowerCase().includes(normalized))
      .slice(0, 6)
  }, [query, worldState.claims])
  const campaign = status?.activeCampaign
  const currentSide = campaign && status
    ? status.rounds.find(round => round.side === 'attacker') || status.rounds.find(round => round.side === 'defender')
    : null
  const scoringOpen = campaign?.phase === 'scoring'

  useEffect(() => {
    if (status?.profile.homeTerritoryId && !status.activeCampaign) setCollapsed(true)
    if (status?.activeCampaign) setCollapsed(false)
  }, [status?.activeCampaign, status?.profile.homeTerritoryId])

  return (
    <aside className={`aetheris-war-room ${collapsed ? 'is-collapsed' : ''}`} data-testid="aetheris-war-room" aria-label="Aetheris War Room">
      <div className="aetheris-war-room__head">
        <div>
          <span>Creator command</span>
          <h2>War Room</h2>
        </div>
        <div className="aetheris-war-room__head-actions">
          <span className={`aetheris-war-room__signal ${status?.profile.optedIn ? 'is-ready' : ''}`}>
            {status?.profile.optedIn ? 'Enlisted' : 'Standby'}
          </span>
          <button
            className="aetheris-war-room__toggle"
            type="button"
            aria-label={collapsed ? 'Open War Room' : 'Collapse War Room'}
            title={collapsed ? 'Open War Room' : 'Collapse War Room'}
            onClick={() => setCollapsed(value => !value)}
          >
            {collapsed ? '+' : '-'}
          </button>
        </div>
      </div>

      {loading && <p className="aetheris-war-room__muted">Loading campaign state...</p>}
      {error && <p className="aetheris-war-room__error" role="alert">{error}</p>}

      {!loading && status && !status.profile.optedIn && (
        <button className="aetheris-war-room__primary" type="button" disabled={Boolean(busyAction)} onClick={() => onOptIn(true)}>
          {busyAction === 'opt-in' ? 'Joining...' : 'Join land wars'}
        </button>
      )}

      {status?.profile.optedIn && (
        <>
          <div className="aetheris-war-room__section">
            <label htmlFor="aetheris-target-search">Target creator</label>
            <input
              id="aetheris-target-search"
              type="search"
              value={query}
              placeholder="@streamer"
              autoComplete="off"
              onChange={(event) => setQuery(event.target.value)}
            />
            {targetResults.length > 0 && (
              <div className="aetheris-war-room__targets">
                {targetResults.map(claim => (
                  <button key={claim.territoryId} type="button" onClick={() => onSelectTerritory(claim.territoryId)}>
                    <span>{claim.holderName}</span>
                    <strong>{territoryById.get(claim.territoryId)?.territoryName || claim.territoryId}</strong>
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="aetheris-war-room__section">
            <div className="aetheris-war-room__section-title">
              <span>Holdings</span>
              <strong>{status.holdings.length}/4</strong>
            </div>
            {status.holdings.length ? status.holdings.map(holding => (
              <button className="aetheris-war-room__holding" key={holding.territoryId} type="button" onClick={() => onSelectTerritory(holding.territoryId)}>
                <span>{holding.claimType === 'home' ? 'Home' : 'Conquest'}</span>
                <strong>{territoryById.get(holding.territoryId)?.territoryName || holding.territoryId}</strong>
              </button>
            )) : <p className="aetheris-war-room__muted">Select unclaimed land for your home.</p>}
          </div>

          {campaign && (
            <div className="aetheris-war-room__campaign">
              <div className="aetheris-war-room__section-title">
                <span>{campaign.mode === 'pvp' ? 'Land siege' : 'Expedition'}</span>
                <strong>{campaign.phase}</strong>
              </div>
              <button className="aetheris-war-room__campaign-target" type="button" onClick={() => onSelectTerritory(campaign.territoryId)}>
                {territoryById.get(campaign.territoryId)?.territoryName || campaign.territoryId}
              </button>
              <div className="aetheris-war-room__score">
                <span>{campaign.attackerHandle || 'Attacker'} <b>{campaign.attackerWins}</b></span>
                <i>vs</i>
                <span><b>{campaign.defenderWins}</b> {campaign.defenderHandle || 'Frontier'}</span>
              </div>
              <p className="aetheris-war-room__muted">
                {campaign.phase === 'mobilizing' ? `Scoring opens in ${remainingLabel(campaign.scoringStartsAt)}` : `Campaign closes in ${remainingLabel(campaign.endsAt)}`}
              </p>
              {scoringOpen && !status.activeRound && (
                <button className="aetheris-war-room__primary" type="button" disabled={Boolean(busyAction)} onClick={() => onStartRound(campaign.id)}>
                  {busyAction === 'round' ? 'Opening round...' : `Start ${currentSide ? 'next' : 'first'} 10-minute round`}
                </button>
              )}
              {status.activeRound && <p className="aetheris-war-room__live">Round {status.activeRound.roundNumber} live - {remainingLabel(status.activeRound.endsAt)}</p>}
              {campaign.phase === 'mobilizing' && (
                <button className="aetheris-war-room__quiet" type="button" disabled={Boolean(busyAction)} onClick={() => onWithdraw(campaign.id)}>Withdraw mobilization</button>
              )}
            </div>
          )}

          <button className="aetheris-war-room__quiet" type="button" disabled={Boolean(busyAction) || Boolean(campaign)} onClick={() => onOptIn(false)}>
            Leave land wars
          </button>
        </>
      )}
    </aside>
  )
}
