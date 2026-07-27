import { useEffect, useRef, useState } from 'react'
import { Canvas } from '@react-three/fiber'
import { CAMERA } from './config'
import { detectWebglSupport, useReducedMotion } from './hooks/useWebglFallback'
import Scene from './scene/Scene'
import type { DataMode } from './types'

interface AppProps {
  dataMode: DataMode
}

export default function App({ dataMode }: AppProps) {
  const [webglSupported] = useState(() => detectWebglSupport())
  const reducedMotion = useReducedMotion()
  const containerRef = useRef<HTMLDivElement>(null)
  const [isVisible, setIsVisible] = useState(true)
  const [tabVisible, setTabVisible] = useState(() => document.visibilityState === 'visible')

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

  // A homepage globe has no reason to keep rendering at 60fps while scrolled off-screen
  // or while the tab is backgrounded — r3f's `frameloop` prop is the supported way to
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
        <span>A living fantasy world &mdash; one territory per creator.</span>
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
      >
        <Scene reducedMotion={reducedMotion} dataMode={dataMode} />
      </Canvas>
    </div>
  )
}
