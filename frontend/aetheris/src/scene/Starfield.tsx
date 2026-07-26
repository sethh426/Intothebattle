import { Stars } from '@react-three/drei'
import { STARFIELD } from '../config'
import type { PerfTier } from '../types'

interface StarfieldProps {
  tier: PerfTier
}

// A fixed backdrop, not planet-relative — rendered as a Scene-root sibling of the
// rotating wrapper group, not a child of it. Aurora/meteors/comets from the original
// "Sky System" wishlist are deferred past v0.3 (candidates for v0.5); this delivers
// the star backdrop only.
export default function Starfield({ tier }: StarfieldProps) {
  return <Stars radius={100} depth={50} count={STARFIELD[tier]} factor={4} saturation={0} fade speed={0.5} />
}
