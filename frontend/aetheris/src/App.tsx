import { useEffect, useMemo, useRef, useState } from 'react'
import { Canvas } from '@react-three/fiber'
import { CAMERA, WORLD_SEED } from './config'
import { BIOMES, getBiomeById } from './data/biomeData'
import { generateTerritories } from './data/territoryData'
import { detectWebglSupport, useReducedMotion } from './hooks/useWebglFallback'
import { useKingdomState } from './kingdoms/useKingdomState'
import Scene from './scene/Scene'
import TerritoryDetailPanel from './ui/TerritoryDetailPanel'
import type { DataMode, WorldFraming } from './types'

interface AppProps {
  dataMode: DataMode
  framing: WorldFraming
}

export default function App({ dataMode, framing }: AppProps) {
  const [webglSupported] = useState(() => detectWebglSupport())
  const reducedMotion = useReducedMotion()
  const containerRef = useRef<HTMLDivElement>(null)
  const [isVisible, setIsVisible] = useState(true)
  const [tabVisible, setTabVisible] = useState(() => document.visibilityState === 'visible')
  const territories = useMemo(() => generateTerritories(BIOMES, WORLD_SEED), [])
  const kingdomState = useKingdomState(territories, WORLD_SEED + 1, dataMode)
  const [selectedTerritoryId, setSelectedTerritoryId] = useState<string | null>(null)

  const selectedTerritory = useMemo(
    () => territories.find((territory) => territory.id === selectedTerritoryId) ?? null,
    [selectedTerritoryId, territories],
  )

  useEffect(() => {
    const container = containerRef.current
    if (!container || typeof IntersectionObserver !== 'function') return
    const observer = new IntersectionObserver(
      (entries) => setIsVisible(entries.some((entry) => entry.isIntersecting)),
      { threshold: 0.01 },
    )
    observer.observe(container)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    function onVisibilityChange(): void {
      setTabVisible(document.visibilityState === 'visible')
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => document.removeEventListener('visibilitychange', onVisibilityChange)
  }, [])

  useEffect(() => {
    if (!selectedTerritoryId) return
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') setSelectedTerritoryId(null)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [selectedTerritoryId])

  // A homepage globe has no reason to keep rendering at 60fps while scrolled off-screen
  // or while the tab is backgrounded. r3f's `frameloop` prop is the supported way to
  // pause its internal render loop entirely (not just visually hidden).
  const running = isVisible && tabVisible

  if (!webglSupported) {
    return (
      <div
        ref={containerRef}
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          textAlign: 'center',
          padding: 24,
          background: 'radial-gradient(circle at 50% 42%, rgba(0,200,255,0.16), rgba(2,4,10,0.9) 70%)',
          color: 'rgba(220,230,246,0.75)',
          fontSize: 14,
          fontWeight: 600,
        }}
      >
        <span>Aetheris is one shared world where top streamers fight for territory.</span>
      </div>
    )
  }

  return (
    <div ref={containerRef} style={{ width: '100%', height: '100%' }}>
      <Canvas
        frameloop={running ? 'always' : 'never'}
        camera={{ fov: CAMERA.fov, near: CAMERA.near, far: CAMERA.far }}
        dpr={[1, 2]}
        gl={{ antialias: true, alpha: true }}
        style={{ touchAction: 'none', cursor: 'grab' }}
        onPointerMissed={() => setSelectedTerritoryId(null)}
      >
        <Scene
          reducedMotion={reducedMotion}
          framing={framing}
          isVisible={isVisible}
          territories={territories}
          kingdomState={kingdomState}
          selectedTerritoryId={selectedTerritoryId}
          onTerritorySelect={setSelectedTerritoryId}
        />
      </Canvas>
      {selectedTerritory && (
        <TerritoryDetailPanel
          territory={selectedTerritory}
          kingdomState={kingdomState[selectedTerritory.id]}
          biomeName={getBiomeById(selectedTerritory.biomeId)?.name ?? 'Unknown realm'}
          framing={framing}
          onClose={() => setSelectedTerritoryId(null)}
        />
      )}
    </div>
  )
}
