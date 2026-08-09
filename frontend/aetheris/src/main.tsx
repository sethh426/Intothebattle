import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import type { DataMode, WorldFraming } from './types'

const mountEl = document.getElementById('aetheris-root')!
// Read once at mount -- home.html sets data-mode="live", aetheris-preview.html sets
// data-mode="mock" (or omits it; missing/unrecognized values default to mock, so a
// misconfigured mount never accidentally opens a real socket connection).
const dataMode: DataMode = mountEl.dataset.mode === 'live' ? 'live' : 'mock'
const framing: WorldFraming = mountEl.dataset.framing === 'wide' ? 'wide' : 'hero'
const warRoom = mountEl.dataset.warRoom === 'true'

createRoot(mountEl).render(
  <StrictMode>
    <App dataMode={dataMode} framing={framing} warRoom={warRoom} />
  </StrictMode>,
)
