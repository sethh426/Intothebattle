import { useEffect, useState } from 'react'

export function detectWebglSupport(): boolean {
  try {
    const canvas = document.createElement('canvas')
    return !!(canvas.getContext('webgl2') || canvas.getContext('webgl'))
  } catch {
    return false
  }
}

// Reads the OS-level `prefers-reduced-motion` preference and stays in sync if it changes.
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState<boolean>(() => (
    typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  ))

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const mql = window.matchMedia('(prefers-reduced-motion: reduce)')
    const listener = (event: MediaQueryListEvent) => setReduced(event.matches)
    mql.addEventListener?.('change', listener)
    return () => mql.removeEventListener?.('change', listener)
  }, [])

  return reduced
}
