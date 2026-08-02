import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { useConnectionStore } from './config/connectionStore'
import { PRESET_THEMES, type Theme } from './lib/themes'

useConnectionStore.getState().seedFromEnv()

// Apply persisted theme synchronously to avoid a flash of the default theme
// before the persist middleware rehydrates.
;(function bootstrapTheme() {
  try {
    const raw = localStorage.getItem('spotifu.theme.v1')
    if (!raw) {
      document.documentElement.setAttribute('data-theme', 'polly-dark')
      return
    }
    const parsed = JSON.parse(raw) as {
      state?: { activeId?: string; customs?: Theme[] }
    }
    const activeId = parsed.state?.activeId ?? 'polly-dark'
    const custom = parsed.state?.customs?.find((c) => c.id === activeId)
    const preset = PRESET_THEMES.find((t) => t.id === activeId)
    const theme: Theme | undefined = preset ?? custom
    if (theme) {
      const root = document.documentElement
      for (const [k, v] of Object.entries(theme.vars)) {
        root.style.setProperty(k, v)
      }
      if (theme.backgroundUrl?.trim()) {
        root.style.setProperty('--bg-image', `url("${theme.backgroundUrl}")`)
        root.style.setProperty('--bg-image-opacity', String(theme.backgroundOpacity ?? 0.15))
      }
      root.dataset.flavor = theme.flavor ?? ''
    }
  } catch {
    /* fall back to :root defaults (polly-dark) */
  }
})()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
