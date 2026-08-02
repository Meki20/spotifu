// Theme store. Persists active theme + custom themes to localStorage.
// Applies the active theme by writing CSS variables onto <html>.

import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import {
  DEFAULT_THEME_ID,
  type Theme,
  getTheme,
  normalizeHex,
} from '../lib/themes'

interface ThemeState {
  activeId: string
  customs: Theme[]
  setActive: (id: string) => void
  applyCustom: (vars: Record<string, string>, backgroundUrl?: string, backgroundOpacity?: number, flavor?: string) => void
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

function applyBackground(url?: string, opacity?: number) {
  const root = document.documentElement
  if (url && url.trim()) {
    root.style.setProperty('--bg-image', `url("${url}")`)
    root.style.setProperty('--bg-image-opacity', String(opacity ?? 0.15))
  } else {
    root.style.setProperty('--bg-image', 'none')
    root.style.setProperty('--bg-image-opacity', '0')
  }
}

function applyFlavor(flavor?: string) {
  document.documentElement.dataset.flavor = flavor ?? ''
}

function applyTheme(theme: Theme) {
  document.documentElement.removeAttribute('data-theme')
  applyVars(theme.vars)
  applyBackground(theme.backgroundUrl, theme.backgroundOpacity)
  applyFlavor(theme.flavor)
}

export const useThemeStore = create<ThemeState>()(
  persist(
    (set, get) => ({
      activeId: DEFAULT_THEME_ID,
      customs: [],

      setActive: (id: string) => {
        const theme =
          get().customs.find((t) => t.id === id) ?? getTheme(id)
        applyTheme(theme)
        set({ activeId: theme.id })
      },

      applyCustom: (vars: Record<string, string>, backgroundUrl?: string, backgroundOpacity?: number, flavor?: string) => {
        document.documentElement.removeAttribute('data-theme')
        applyVars(vars)
        applyBackground(backgroundUrl, backgroundOpacity)
        applyFlavor(flavor)
        set({ activeId: '__custom__preview__' })
      },

      saveCustom: (name: string, vars: Record<string, string>, backgroundUrl?: string, backgroundOpacity?: number, flavor?: string) => {
        const id = `custom-${Date.now().toString(36)}`
        const theme: Theme = {
          id,
          name: name.trim() || 'Custom theme',
          builtin: false,
          vars,
          ...(backgroundUrl?.trim() ? { backgroundUrl: backgroundUrl.trim() } : {}),
          ...(backgroundOpacity !== undefined ? { backgroundOpacity } : {}),
          ...(flavor ? { flavor } : {}),
        }
        set((s) => ({ customs: [...s.customs, theme] }))
        applyTheme(theme)
        set({ activeId: id })
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
      partialize: (s) => ({ activeId: s.activeId, customs: s.customs }),
      onRehydrateStorage: () => (state) => {
        if (!state) return
        const theme =
          state.customs.find((t) => t.id === state.activeId) ??
          getTheme(state.activeId)
        applyTheme(theme)
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
