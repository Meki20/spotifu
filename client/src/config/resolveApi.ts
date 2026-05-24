import { useConnectionStore } from './connectionStore'

export function getApiBase(): string {
  return useConnectionStore.getState().getEffectiveApiUrl()
}

export function getWsUrl(): string {
  const override = import.meta.env.VITE_WS_URL
  if (override && typeof override === 'string' && override.trim()) {
    return override.trim()
  }
  const api = getApiBase()
  return api.replace(/^http/i, 'ws') + '/ws'
}
