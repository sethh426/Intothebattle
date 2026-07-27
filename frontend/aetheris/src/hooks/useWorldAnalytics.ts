import { useEffect, useRef } from 'react'
import type { RefObject } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { trackWorldEvent } from '../analytics'

interface UseWorldAnalyticsOptions {
  isVisible: boolean
  introOpacityRef: RefObject<number>
}

// Fire-once engagement signals gathered to evaluate the v0.6 asset-pipeline investment
// decision (see the Aetheris plan doc's roadmap/§7) -- three coarse funnel events, not
// per-frame or per-drag-tick noise: seen, intro finished, first interaction.
export function useWorldAnalytics({ isVisible, introOpacityRef }: UseWorldAnalyticsOptions): void {
  const { gl } = useThree()
  const firedViewed = useRef(false)
  const firedIntro = useRef(false)
  const firedInteracted = useRef(false)

  useEffect(() => {
    if (isVisible && !firedViewed.current) {
      firedViewed.current = true
      trackWorldEvent('world_globe_viewed')
    }
  }, [isVisible])

  useEffect(() => {
    const canvas = gl.domElement
    function onFirstInteraction(): void {
      if (firedInteracted.current) return
      firedInteracted.current = true
      trackWorldEvent('world_globe_interacted')
    }
    canvas.addEventListener('pointerdown', onFirstInteraction, { once: true })
    canvas.addEventListener('wheel', onFirstInteraction, { once: true, passive: true })
    return () => {
      canvas.removeEventListener('pointerdown', onFirstInteraction)
      canvas.removeEventListener('wheel', onFirstInteraction)
    }
  }, [gl])

  useFrame(() => {
    if (!firedIntro.current && (introOpacityRef.current ?? 0) >= 0.999) {
      firedIntro.current = true
      trackWorldEvent('world_globe_intro_completed')
    }
  })
}
