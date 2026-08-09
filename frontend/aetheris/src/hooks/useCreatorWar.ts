import { useCallback, useEffect, useState } from 'react'
import type { CreatorWarStatus } from '../types'

interface CreatorWarController {
  status: CreatorWarStatus | null
  loading: boolean
  busyAction: string
  error: string
  refresh: () => Promise<void>
  optIn: (enabled: boolean) => Promise<boolean>
  selectHome: (territoryId: string) => Promise<boolean>
  mobilize: (territoryId: string, neutral: boolean) => Promise<boolean>
  startRound: (campaignId: number) => Promise<boolean>
  withdraw: (campaignId: number) => Promise<boolean>
  abandon: (territoryId: string) => Promise<boolean>
}

async function responseJson(response: Response): Promise<Record<string, unknown>> {
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>
  if (!response.ok || payload.success === false) {
    throw new Error(String(payload.error || payload.message || 'Aetheris request failed.'))
  }
  return payload
}

export function useCreatorWar(enabled: boolean): CreatorWarController {
  const [status, setStatus] = useState<CreatorWarStatus | null>(null)
  const [loading, setLoading] = useState(enabled)
  const [busyAction, setBusyAction] = useState('')
  const [error, setError] = useState('')

  const refresh = useCallback(async () => {
    if (!enabled) return
    try {
      const response = await fetch('/api/aetheris/war/status', { credentials: 'same-origin' })
      const payload = await responseJson(response)
      setStatus(payload as unknown as CreatorWarStatus)
      setError('')
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Unable to load Aetheris war status.')
    } finally {
      setLoading(false)
    }
  }, [enabled])

  useEffect(() => {
    if (!enabled) return
    void refresh()
    const timer = window.setInterval(() => void refresh(), 10_000)
    return () => window.clearInterval(timer)
  }, [enabled, refresh])

  const perform = useCallback(async (action: string, pathname: string, body: Record<string, unknown> = {}) => {
    setBusyAction(action)
    setError('')
    try {
      const response = await fetch(pathname, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      await responseJson(response)
      await refresh()
      return true
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Aetheris request failed.')
      return false
    } finally {
      setBusyAction('')
    }
  }, [refresh])

  return {
    status,
    loading,
    busyAction,
    error,
    refresh,
    optIn: (value) => perform(value ? 'opt-in' : 'opt-out', '/api/aetheris/war/opt-in', { enabled: value }),
    selectHome: (territoryId) => perform('home', '/api/aetheris/war/home', { territoryId }),
    mobilize: (territoryId, neutral) => perform('mobilize', neutral ? '/api/aetheris/war/expeditions' : '/api/aetheris/war/campaigns', { territoryId }),
    startRound: (campaignId) => perform('round', '/api/aetheris/war/rounds/start', { campaignId }),
    withdraw: (campaignId) => perform('withdraw', `/api/aetheris/war/campaigns/${campaignId}/withdraw`),
    abandon: (territoryId) => perform('abandon', `/api/aetheris/war/holdings/${encodeURIComponent(territoryId)}/abandon`),
  }
}
