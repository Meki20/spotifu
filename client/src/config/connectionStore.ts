import { create } from 'zustand'
import { persist } from 'zustand/middleware'

const DEFAULT_API = 'http://localhost:1985'
const STORAGE_KEY = 'spotifu-connection'

export type ConnectionSource = 'mdns' | 'manual' | 'env' | 'default'

function normalizeUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, '')
  if (!/^https?:\/\//i.test(trimmed)) {
    return `http://${trimmed}`
  }
  return trimmed
}

function getEnvApiUrl(): string | null {
  const env = import.meta.env.VITE_API_URL
  if (env && typeof env === 'string' && env.trim()) {
    return normalizeUrl(env)
  }
  return null
}

interface ConnectionState {
  apiBaseUrl: string | null
  source: ConnectionSource
  setManualUrl: (url: string) => void
  applyDiscoveredService: (host: string, port: number) => void
  clearConnection: () => void
  getEffectiveApiUrl: () => string
  seedFromEnv: () => void
}

export const useConnectionStore = create<ConnectionState>()(
  persist(
    (set, get) => ({
      apiBaseUrl: null,
      source: 'default',
      setManualUrl: (url) => {
        set({ apiBaseUrl: normalizeUrl(url), source: 'manual' })
      },
      applyDiscoveredService: (host, port) => {
        set({
          apiBaseUrl: normalizeUrl(`http://${host}:${port}`),
          source: 'mdns',
        })
      },
      clearConnection: () => {
        const env = getEnvApiUrl()
        if (env) {
          set({ apiBaseUrl: env, source: 'env' })
        } else {
          set({ apiBaseUrl: null, source: 'default' })
        }
      },
      getEffectiveApiUrl: () => {
        const { apiBaseUrl } = get()
        if (apiBaseUrl) return apiBaseUrl
        const env = getEnvApiUrl()
        if (env) return env
        return DEFAULT_API
      },
      seedFromEnv: () => {
        const state = get()
        if (state.apiBaseUrl && state.source !== 'default') return
        const env = getEnvApiUrl()
        if (env && !state.apiBaseUrl) {
          set({ apiBaseUrl: env, source: 'env' })
        }
      },
    }),
    { name: STORAGE_KEY },
  ),
)
