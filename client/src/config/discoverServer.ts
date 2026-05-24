import { useConnectionStore } from './connectionStore'

export interface DiscoveredServer {
  name: string
  host: string
  port: number
}

export async function probeServerUrl(url: string, timeoutMs = 4000): Promise<boolean> {
  const base = url.trim().replace(/\/+$/, '')
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const res = await fetch(`${base}/health`, { signal: controller.signal })
    clearTimeout(timer)
    return res.ok
  } catch {
    return false
  }
}

function urlToDiscovered(url: string): DiscoveredServer | null {
  try {
    const u = new URL(url.startsWith('http') ? url : `http://${url}`)
    return {
      name: u.hostname,
      host: u.hostname,
      port: u.port ? parseInt(u.port, 10) : 1985,
    }
  } catch {
    return null
  }
}

const MDNS_PROBE_URLS = [
  'http://spotifu.local:1985',
]

export async function discoverServersWeb(): Promise<DiscoveredServer[]> {
  const candidates = [...MDNS_PROBE_URLS]
  const saved = useConnectionStore.getState().getEffectiveApiUrl()
  if (saved && !candidates.includes(saved)) {
    candidates.unshift(saved)
  }

  const found: DiscoveredServer[] = []
  const seen = new Set<string>()

  await Promise.all(
    candidates.map(async (url) => {
      const ok = await probeServerUrl(url)
      if (!ok) return
      const entry = urlToDiscovered(url)
      if (!entry) return
      const key = `${entry.host}:${entry.port}`
      if (seen.has(key)) return
      seen.add(key)
      found.push(entry)
    }),
  )

  return found
}

export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

export async function discoverServers(): Promise<DiscoveredServer[]> {
  if (isTauri()) {
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const servers = await invoke<DiscoveredServer[]>('discover_spotifu_servers')
      if (servers.length > 0) return servers
    } catch (err) {
      console.warn('[discover] Tauri mDNS browse failed:', err)
    }
  }
  return discoverServersWeb()
}
