import { Bloom, EffectComposer, ToneMapping, Vignette } from '@react-three/postprocessing'
import { ToneMappingMode } from 'postprocessing'
import type { PerfTier } from '../types'

interface CinematicPostProcessingProps {
  tier: PerfTier
  reducedMotion: boolean
}

export default function CinematicPostProcessing({ tier, reducedMotion }: CinematicPostProcessingProps) {
  if (reducedMotion || tier === 'low') return null

  const highTier = tier === 'high'
  return (
    <EffectComposer multisampling={highTier ? 4 : 0} enableNormalPass={false}>
      <Bloom
        intensity={highTier ? 0.92 : 0.56}
        luminanceThreshold={0.42}
        luminanceSmoothing={0.24}
        mipmapBlur
      />
      <Vignette eskil={false} offset={0.22} darkness={0.72} />
      <ToneMapping mode={ToneMappingMode.ACES_FILMIC} resolution={128} whitePoint={3.3} middleGrey={0.58} />
    </EffectComposer>
  )
}
