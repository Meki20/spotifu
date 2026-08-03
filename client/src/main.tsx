import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { useConnectionStore } from './config/connectionStore'
import { PRESET_THEMES, DEFAULT_THEME_ID, type Theme } from './lib/themes'
import { applyVisualEffects, readStoredVisualEffects } from './stores/visualEffectsStore'

useConnectionStore.getState().seedFromEnv()

// Apply the persisted theme synchronously to avoid a flash of the default
// theme before the persist middleware rehydrates. Falls back to the
// default (Y2K) when nothing usable is stored.
;(function bootstrapTheme() {
  const root = document.documentElement
  let theme: Theme | undefined
  let bg = { url: '', opacity: 0.15 }
  try {
    const raw = localStorage.getItem('spotifu.theme.v1')
    if (raw) {
      const parsed = JSON.parse(raw) as {
        state?: { activeId?: string; customs?: Theme[]; appliedBg?: { url: string; opacity: number } }
      }
      const activeId = parsed.state?.activeId ?? DEFAULT_THEME_ID
      theme =
        parsed.state?.customs?.find((c) => c.id === activeId) ??
        PRESET_THEMES.find((t) => t.id === activeId)
      bg = parsed.state?.appliedBg ?? bg
    }
  } catch {
    /* fall through to default */
  }
  if (!theme) {
    theme = PRESET_THEMES.find((t) => t.id === DEFAULT_THEME_ID) ?? PRESET_THEMES[0]
  }
  for (const [k, v] of Object.entries(theme.vars)) {
    root.style.setProperty(k, v)
  }
  if (theme.backgroundUrl?.trim()) {
    bg = { url: theme.backgroundUrl, opacity: theme.backgroundOpacity ?? bg.opacity }
  }
  if (bg.url.trim()) {
    root.style.setProperty('--bg-image', `url("${bg.url}")`)
    root.style.setProperty('--bg-image-opacity', String(bg.opacity))
    root.style.setProperty('--bg-image-dim', String(Math.max(0, 1 - bg.opacity)))
  }
  root.dataset.flavor = theme.flavor ?? ''
  applyVisualEffects(readStoredVisualEffects())
})()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
