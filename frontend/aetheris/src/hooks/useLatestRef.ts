import { useEffect, useRef } from 'react'
import type { RefObject } from 'react'

// Mirrors a changing prop into a ref so a useFrame loop can read the latest value every
// frame without depending on the prop directly (which would tear down/rebuild the loop
// on every change). Shared by Territories.tsx and KingdomSilhouettes.tsx.
export function useLatestRef<T>(value: T): RefObject<T> {
  const ref = useRef(value)
  useEffect(() => {
    ref.current = value
  }, [value])
  return ref
}
