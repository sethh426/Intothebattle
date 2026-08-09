import { territoryWarDecision } from './warEligibility'
import type { AetherisWorldState, CreatorWarStatus, KingdomState, Territory, WorldFraming } from '../types'

interface TerritoryDetailPanelProps {
  territory: Territory
  kingdomState?: KingdomState
  biomeName: string
  framing: WorldFraming
  onClose: () => void
  worldState: AetherisWorldState
  creatorStatus?: CreatorWarStatus | null
  warEnabled?: boolean
  busyAction?: string
  warError?: string
  onOptIn?: () => void
  onSelectHome?: (territoryId: string) => void
  onMobilize?: (territoryId: string, neutral: boolean) => void
  onAbandon?: (territoryId: string) => void
}

function formatNumber(value: unknown): string {
  const number = Number(value)
  return Number.isFinite(number) ? String(Math.max(0, Math.round(number))) : '0'
}

function safeTikTokHandle(value: unknown): string {
  const text = String(value || '').trim()
  return /^@[A-Za-z0-9._]{2,64}$/.test(text) ? text : ''
}

function activityLabel(tier: string | undefined): string {
  if (tier === 'packed') return 'packed activity'
  if (tier === 'high') return 'high activity'
  if (tier === 'medium') return 'medium activity'
  if (tier === 'low') return 'low activity'
  return 'quiet'
}

export default function TerritoryDetailPanel({
  territory,
  kingdomState,
  biomeName,
  framing,
  onClose,
  worldState,
  creatorStatus = null,
  warEnabled = false,
  busyAction = '',
  warError = '',
  onOptIn,
  onSelectHome,
  onMobilize,
  onAbandon,
}: TerritoryDetailPanelProps) {
  const tiktokHolder = safeTikTokHandle(kingdomState?.holderName)
  const isLive = Boolean(kingdomState?.isLive)
  const isClaimed = Boolean(kingdomState?.isClaimed || tiktokHolder)
  const status = isLive
    ? `Live: ${activityLabel(kingdomState?.viewerTier)}`
    : tiktokHolder
      ? `Claimed by ${tiktokHolder}`
      : isClaimed
        ? 'Claimed territory'
        : 'Unclaimed territory'
  const campaign = worldState.campaigns.find(entry => entry.territoryId === territory.id)
  const decision = warEnabled ? territoryWarDecision(territory, worldState, creatorStatus) : null

  function runWarAction(): void {
    if (!decision?.enabled) return
    if (decision.action === 'opt-in') onOptIn?.()
    else if (decision.action === 'home') onSelectHome?.(territory.id)
    else if (decision.action === 'expedition') onMobilize?.(territory.id, true)
    else if (decision.action === 'attack') onMobilize?.(territory.id, false)
    else if (decision.action === 'abandon') onAbandon?.(territory.id)
  }

  return (
    <section
      className={`aetheris-detail-panel ${framing === 'wide' ? 'is-wide' : 'is-hero'}`}
      data-testid="aetheris-territory-detail"
      role="dialog"
      aria-label={`${territory.territoryName} territory details`}
    >
      <button
        className="aetheris-detail-close"
        data-testid="aetheris-territory-detail-close"
        type="button"
        aria-label="Close territory details"
        onClick={onClose}
      >
        X
      </button>
      <div className={`aetheris-detail-status ${isLive ? 'is-live' : isClaimed ? 'is-claimed' : 'is-unclaimed'}`}>
        {status}
      </div>
      <h2>{territory.territoryName}</h2>
      <p className="aetheris-detail-biome">{biomeName}</p>
      {tiktokHolder && (
        <div className="aetheris-detail-holder">
          <span>Holder</span>
          <strong>{tiktokHolder}</strong>
        </div>
      )}
      {kingdomState?.claimType === 'home' && <p className="aetheris-detail-protection">Protected seasonal home</p>}
      {kingdomState?.shieldUntil && new Date(kingdomState.shieldUntil).getTime() > Date.now() && (
        <p className="aetheris-detail-protection">Shielded until {new Date(kingdomState.shieldUntil).toLocaleString()}</p>
      )}
      {campaign && (
        <div className="aetheris-detail-campaign">
          <span>{campaign.phase === 'mobilizing' ? 'Mobilizing' : 'Live siege'}</span>
          <strong>{campaign.attackerHandle || 'Expedition'} {campaign.mode === 'pvp' ? `vs ${campaign.defenderHandle}` : ''}</strong>
          <small>{campaign.attackerWins}-{campaign.defenderWins}</small>
        </div>
      )}
      <dl className="aetheris-detail-stats">
        <div>
          <dt>Active</dt>
          <dd>{formatNumber(kingdomState?.activeCount)}</dd>
        </div>
        <div>
          <dt>Kills</dt>
          <dd>{formatNumber(kingdomState?.kills)}</dd>
        </div>
        <div>
          <dt>Score</dt>
          <dd>{formatNumber(kingdomState?.score)}</dd>
        </div>
      </dl>
      {decision && (
        <div className="aetheris-detail-war-action">
          <button type="button" disabled={!decision.enabled || Boolean(busyAction)} onClick={runWarAction}>
            {busyAction ? 'Updating...' : decision.label}
          </button>
          {decision.reason && <p>{decision.reason}</p>}
          {warError && <p className="is-error">{warError}</p>}
        </div>
      )}
    </section>
  )
}
