import type { AetherisWorldState, CreatorWarStatus, Territory } from '../types'

export type TerritoryWarAction = 'opt-in' | 'home' | 'expedition' | 'attack' | 'abandon' | 'none'

export interface TerritoryWarDecision {
  action: TerritoryWarAction
  label: string
  reason: string
  enabled: boolean
}

export function territoryWarDecision(
  territory: Territory,
  worldState: AetherisWorldState,
  status: CreatorWarStatus | null,
): TerritoryWarDecision {
  if (!status) return { action: 'none', label: 'War status unavailable', reason: '', enabled: false }
  if (!status.profile.optedIn) return { action: 'opt-in', label: 'Join land wars', reason: '', enabled: true }
  const claim = worldState.claims[territory.id]
  const holding = status.holdings.find((entry) => entry.territoryId === territory.id)
  if (!status.profile.homeTerritoryId) {
    return claim
      ? { action: 'none', label: 'Territory unavailable', reason: `${claim.holderName} controls this land.`, enabled: false }
      : { action: 'home', label: 'Establish protected home', reason: '', enabled: true }
  }
  if (holding) {
    return holding.claimType === 'home'
      ? { action: 'none', label: 'Protected home', reason: 'Your seasonal home cannot be captured or abandoned.', enabled: false }
      : { action: 'abandon', label: 'Abandon holding', reason: '', enabled: !status.activeCampaign }
  }
  if (status.activeCampaign) return { action: 'none', label: 'Campaign already active', reason: 'Resolve your current mobilization first.', enabled: false }
  if (!status.holdings.some(entry => territory.neighbors.includes(entry.territoryId))) {
    return { action: 'none', label: 'No supply route', reason: 'Target land must border one of your holdings.', enabled: false }
  }
  if (status.holdings.filter(entry => entry.claimType === 'conquest').length >= 3) {
    return { action: 'none', label: 'Holding limit reached', reason: 'Release a conquest before expanding again.', enabled: false }
  }
  if (claim?.claimType === 'home') return { action: 'none', label: 'Protected home', reason: 'Home territories never transfer.', enabled: false }
  if (claim?.shieldUntil && new Date(claim.shieldUntil).getTime() > Date.now()) {
    return { action: 'none', label: 'Campaign shield active', reason: `Protected until ${new Date(claim.shieldUntil).toLocaleString()}.`, enabled: false }
  }
  return claim
    ? { action: 'attack', label: `Mobilize against ${claim.holderName}`, reason: '', enabled: true }
    : { action: 'expedition', label: 'Launch live expedition', reason: '', enabled: true }
}
