// Visual-effect toggles for Appearance A/B testing (esp. scroll perf).
// Defaults all on to preserve the current look. Applied as data-fx-* on <html>.

import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'

export const VISUAL_EFFECT_KEYS = [
  'backgroundImage',
  'glassBlur',
  'translucentPanels',
  'cornerBrackets',
  'cardCoverBackdrop',
  'y2kChrome',
  'circuitPattern',
] as const

export type VisualEffectKey = (typeof VISUAL_EFFECT_KEYS)[number]

export type VisualEffects = Record<VisualEffectKey, boolean>

export const DEFAULT_VISUAL_EFFECTS: VisualEffects = {
  backgroundImage: true,
  glassBlur: true,
  translucentPanels: true,
  cornerBrackets: true,
  cardCoverBackdrop: true,
  y2kChrome: true,
  circuitPattern: true,
}

/** Maps store keys → documentElement data-fx-* attribute names. */
const ATTR: Record<VisualEffectKey, string> = {
  backgroundImage: 'fxBg',
  glassBlur: 'fxGlass',
  translucentPanels: 'fxTranslucent',
  cornerBrackets: 'fxBrackets',
  cardCoverBackdrop: 'fxCardBackdrop',
  y2kChrome: 'fxY2kChrome',
  circuitPattern: 'fxCircuit',
}

const STORAGE_KEY = 'spotifu.visual-effects.v1'

export function applyVisualEffects(effects: VisualEffects) {
  const root = document.documentElement
  for (const key of VISUAL_EFFECT_KEYS) {
    root.dataset[ATTR[key]] = effects[key] ? '1' : '0'
  }
}

/** Sync read from localStorage for pre-React bootstrap (avoids flash). */
export function readStoredVisualEffects(): VisualEffects {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...DEFAULT_VISUAL_EFFECTS }
    const parsed = JSON.parse(raw) as { state?: { effects?: Partial<VisualEffects> } }
    return { ...DEFAULT_VISUAL_EFFECTS, ...parsed.state?.effects }
  } catch {
    return { ...DEFAULT_VISUAL_EFFECTS }
  }
}

interface VisualEffectsState {
  effects: VisualEffects
  setEffect: (key: VisualEffectKey, enabled: boolean) => void
  setAll: (enabled: boolean) => void
}

export const useVisualEffectsStore = create<VisualEffectsState>()(
  persist(
    (set, get) => ({
      effects: { ...DEFAULT_VISUAL_EFFECTS },

      setEffect: (key, enabled) => {
        const effects = { ...get().effects, [key]: enabled }
        applyVisualEffects(effects)
        set({ effects })
      },

      setAll: (enabled) => {
        const effects = { ...DEFAULT_VISUAL_EFFECTS }
        for (const key of VISUAL_EFFECT_KEYS) effects[key] = enabled
        applyVisualEffects(effects)
        set({ effects })
      },
    }),
    {
      name: STORAGE_KEY,
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({ effects: s.effects }),
      onRehydrateStorage: () => (state) => {
        if (state) applyVisualEffects(state.effects)
      },
    },
  ),
)
