import { authFetch } from '../api'

export async function fetchRecordingCover(recordingMbid: string): Promise<string | null> {
  const enc = encodeURIComponent(recordingMbid)
  const res = await authFetch(`/covers/recordings/${enc}`)
  if (!res.ok) return null
  const data = (await res.json()) as { url?: string | null }
  return typeof data.url === 'string' && data.url ? data.url : null
}

export async function fetchReleaseGroupCover(rgMbid: string): Promise<string | null> {
  const enc = encodeURIComponent(rgMbid)
  const res = await authFetch(`/covers/release-groups/${enc}`)
  if (!res.ok) return null
  const data = (await res.json()) as { url?: string | null }
  return typeof data.url === 'string' && data.url ? data.url : null
}

/** Batch recording covers via ``POST /covers/recordings`` (server cache + centralized fetch). */
export async function fetchRecordingCoversBatch(
  recordingMbids: string[],
): Promise<Record<string, string | null>> {
  const unique = [...new Set(recordingMbids.map((s) => (s || '').trim()).filter(Boolean))]
  if (unique.length === 0) return {}
  // Important: `authFetch` has a hard 15s timeout. The server batch endpoint can be slow on cache-miss
  // (it may need to hit MB/CAA), so chunk requests to avoid timeouts and still hydrate most covers.
  const CHUNK = 12
  const out: Record<string, string | null> = {}
  for (let i = 0; i < unique.length; i += CHUNK) {
    const chunk = unique.slice(i, i + CHUNK)
    try {
      const res = await authFetch('/covers/recordings', {
        method: 'POST',
        body: JSON.stringify({ ids: chunk }),
      })
      if (!res.ok) {
        for (const id of chunk) out[id] = null
        continue
      }
      const data = (await res.json()) as { urls?: Record<string, string | null> }
      for (const id of chunk) out[id] = (data.urls ?? {})[id] ?? null
    } catch {
      for (const id of chunk) out[id] = null
    }
  }
  return out
}

