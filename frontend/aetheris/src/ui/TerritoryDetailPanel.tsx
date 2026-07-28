import type { KingdomState, Territory, WorldFraming } from '../types'

interface TerritoryDetailPanelProps {
  territory: Territory
  kingdomState?: KingdomState
  biomeName: string
  framing: WorldFraming
  onClose: () => void
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
    </section>
  )
}
