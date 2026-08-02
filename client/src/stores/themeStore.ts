// Theme store. Persists active theme + custom themes + background to localStorage.
// Applies the active theme by writing CSS variables onto <html>.

import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import {
  DEFAULT_THEME_ID,
  type Theme,
  getTheme,
  normalizeHex,
} from '../lib/themes'

interface AppliedBg {
  url: string
  opacity: number
}

interface ThemeState {
  activeId: string
  customs: Theme[]
  /** Currently applied background image, persisted so it survives a reload. */
  appliedBg: AppliedBg
  setActive: (id: string) => void
  /** Live preview of a draft theme. Touches the DOM only; does NOT persist. */
  applyCustom: (vars: Record<string, string>, backgroundUrl?: string, backgroundOpacity?: number, flavor?: string) => void
  /** Persist and apply a background image for the active theme. */
  applyBackground: (url: string, opacity: number) => void
  saveCustom: (name: string, vars: Record<string, string>, backgroundUrl?: string, backgroundOpacity?: number, flavor?: string) => string
  deleteCustom: (id: string) => void
}

const STORAGE_KEY = 'spotifu.theme.v1'

function applyVars(vars: Record<string, string>) {
  const root = document.documentElement
  for (const [k, v] of Object.entries(vars)) {
    root.style.setProperty(k, v)
  }
}

function applyBackgroundImage(url: string, opacity: number) {
  const root = document.documentElement
  if (url.trim()) {
    root.style.setProperty('--bg-image', `url("${url}")`)
    root.style.setProperty('--bg-image-opacity', String(opacity))
    root.style.setProperty('--bg-image-dim', String(Math.min(0.95, Math.max(0, 1 - opacity))))
  } else {
    root.style.setProperty('--bg-image', 'none')
    root.style.setProperty('--bg-image-opacity', '0')
    root.style.setProperty('--bg-image-dim', '0')
  }
}

function applyFlavor(flavor?: string) {
  document.documentElement.dataset.flavor = flavor ?? ''
}

/** Background to use for a theme: its own backgroundUrl when set, else the applied one. */
function backgroundFor(
  theme: Theme,
  applied: AppliedBg
): { url: string; opacity: number } {
  if (theme.backgroundUrl?.trim()) {
    return {
      url: theme.backgroundUrl,
      opacity: theme.backgroundOpacity ?? applied.opacity,
    }
  }
  return { url: applied.url, opacity: applied.opacity }
}

function applyTheme(theme: Theme, applied: AppliedBg) {
  document.documentElement.removeAttribute('data-theme')
  applyVars(theme.vars)
  applyFlavor(theme.flavor)
  const bg = backgroundFor(theme, applied)
  applyBackgroundImage(bg.url, bg.opacity)
}

export const useThemeStore = create<ThemeState>()(
  persist(
    (set, get) => ({
      activeId: DEFAULT_THEME_ID,
      customs: [],
      appliedBg: { url: '', opacity: 0.15 },

      setActive: (id: string) => {
        const theme =
          get().customs.find((t) => t.id === id) ?? getTheme(id)
        const bg = backgroundFor(theme, get().appliedBg)
        applyTheme(theme, bg)
        set({ activeId: theme.id, appliedBg: bg })
      },

      applyCustom: (vars, backgroundUrl = '', backgroundOpacity = 0.15, flavor) => {
        document.documentElement.removeAttribute('data-theme')
        applyVars(vars)
        applyFlavor(flavor)
        applyBackgroundImage(backgroundUrl, backgroundOpacity)
      },

      applyBackground: (url, opacity) => {
        const theme =
          get().customs.find((t) => t.id === get().activeId) ??
          getTheme(get().activeId)
        applyTheme(theme, { url, opacity })
        set({ appliedBg: { url, opacity } })
      },

      saveCustom: (name, vars, backgroundUrl = '', backgroundOpacity = 0.15, flavor) => {
        const id = `custom-${Date.now().toString(36)}`
        const theme: Theme = {
          id,
          name: name.trim() || 'Custom theme',
          builtin: false,
          vars,
          ...(backgroundUrl.trim() ? { backgroundUrl: backgroundUrl.trim() } : {}),
          ...(backgroundOpacity !== undefined ? { backgroundOpacity } : {}),
          ...(flavor ? { flavor } : {}),
        }
        set((s) => ({ customs: [...s.customs, theme] }))
        const bg = backgroundFor(theme, get().appliedBg)
        applyTheme(theme, bg)
        set({ activeId: id, appliedBg: bg })
        return id
      },

      deleteCustom: (id: string) => {
        set((s) => ({ customs: s.customs.filter((t) => t.id !== id) }))
        if (get().activeId === id) {
          get().setActive(DEFAULT_THEME_ID)
        }
      },
    }),
    {
      name: STORAGE_KEY,
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({ activeId: s.activeId, customs: s.customs, appliedBg: s.appliedBg }),
      onRehydrateStorage: () => (state) => {
        if (!state) return
        const theme =
          state.customs.find((t) => t.id === state.activeId) ??
          getTheme(state.activeId)
        applyTheme(theme, state.appliedBg)
      },
    }
  )
)

/** Normalize a vars map: ensure all hex values are 6-digit #rrggbb lowercase. */
export function normalizeVars(vars: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(vars)) {
    const trimmed = v.trim()
    if (/^#[0-9A-Fa-f]{6}$/.test(trimmed)) {
      out[k] = normalizeHex(trimmed)
    } else {
      out[k] = trimmed
    }
  }
  return out
}