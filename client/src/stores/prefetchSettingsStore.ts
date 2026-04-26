import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'

export type PrefetchSettings = {
  enabled: boolean
  hover_metadata: boolean
  album_tracklists: boolean
  artist_idle: boolean
  hybrid_stale_refresh: boolean
}

export const PREFETCH_DEFAULTS: PrefetchSettings = {
  enabled: true,
  hover_metadata: true,
  album_tracklists: true,
  artist_idle: true,
  hybrid_stale_refresh: true,
}

/** Runtime behavior: master off disables all categories. */
export function effectivePrefetch(s: PrefetchSettings): PrefetchSettings {
  if (!s.enabled) {
    return {
      ...s,
      hover_metadata: false,
      album_tracklists: false,
      artist_idle: false,
      hybrid_stale_refresh: false,
    }
  }
  return s
}

function normalizePrefetch(raw: Record<string, unknown> | undefined): PrefetchSettings {
  const out = { ...PREFETCH_DEFAULTS }
  if (!raw || typeof raw !== 'object') return out
  for (const k of Object.keys(PREFETCH_DEFAULTS) as (keyof PrefetchSettings)[]) {
    if (k in raw) out[k] = Boolean(raw[k])
  }
  return out
}

type PrefetchStore = {
  prefetch: PrefetchSettings
  setPrefetch: (partial: Partial<PrefetchSettings>) => void
  applyServerPrefetch: (prefetch: Record<string, unknown> | undefined) => void
  resetToDefaults: () => void
}

export const usePrefetchSettingsStore = create<PrefetchStore>()(
  persist(
    (set) => ({
      prefetch: { ...PREFETCH_DEFAULTS },
      setPrefetch: (partial) =>
        set((state) => ({ prefetch: { ...state.prefetch, ...partial } })),
      applyServerPrefetch: (raw) => set({ prefetch: normalizePrefetch(raw) }),
      resetToDefaults: () => set({ prefetch: { ...PREFETCH_DEFAULTS } }),
    }),
    {
      name: 'spotifu-prefetch',
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({ prefetch: s.prefetch }),
    },
  ),
)
