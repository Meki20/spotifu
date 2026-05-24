import { authFetch, authFetchStream } from '../api'

export type CoverStreamItem = { id: string; url: string | null }

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

/** Fast DB-only batch lookup for release-group covers. */
export async function fetchCachedReleaseGroupCovers(
  rgMbids: string[],
  signal?: AbortSignal,
): Promise<Record<string, string | null>> {
  const unique = [...new Set(rgMbids.map((s) => (s || '').trim()).filter(Boolean))]
  if (unique.length === 0) return {}
  try {
    const res = await authFetch('/covers/release-groups/cached', {
      method: 'POST',
      body: JSON.stringify({ ids: unique }),
      signal,
    })
    if (!res.ok) return {}
    const data = (await res.json()) as { urls?: Record<string, string | null> }
    return data.urls ?? {}
  } catch {
    return {}
  }
}

export async function streamReleaseGroupCovers(
  rgMbids: string[],
  onItem: (item: CoverStreamItem) => void,
  signal?: AbortSignal,
): Promise<void> {
  const unique = [...new Set(rgMbids.map((s) => (s || '').trim()).filter(Boolean))]
  if (unique.length === 0) return

  let res: Response
  try {
    res = await authFetchStream('/covers/release-groups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: unique }),
      signal,
    })
  } catch (err) {
    if (signal?.aborted) return
    throw err
  }
  if (!res.ok || !res.body) return

  const reader = res.body.getReader()
  const decoder = new TextDecoder('utf-8')
  let buffer = ''
  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let nl = buffer.indexOf('\n')
      while (nl !== -1) {
        const line = buffer.slice(0, nl).trim()
        buffer = buffer.slice(nl + 1)
        if (line) {
          try {
            const parsed = JSON.parse(line) as CoverStreamItem
            if (parsed && typeof parsed.id === 'string') {
              onItem({ id: parsed.id, url: typeof parsed.url === 'string' ? parsed.url : null })
            }
          } catch {
            // Tolerate malformed lines — keep streaming.
          }
        }
        nl = buffer.indexOf('\n')
      }
    }
    const tail = buffer.trim()
    if (tail) {
      try {
        const parsed = JSON.parse(tail) as CoverStreamItem
        if (parsed && typeof parsed.id === 'string') {
          onItem({ id: parsed.id, url: typeof parsed.url === 'string' ? parsed.url : null })
        }
      } catch {
        // ignore
      }
    }
  } catch (err) {
    if (signal?.aborted) return
    throw err
  } finally {
    try {
      reader.releaseLock()
    } catch {
      // ignore
    }
  }
}

/** Fast DB-only batch lookup. Misses are absent from the response (caller resolves via stream). */
export async function fetchCachedRecordingCovers(
  recordingMbids: string[],
  signal?: AbortSignal,
): Promise<Record<string, string | null>> {
  const unique = [...new Set(recordingMbids.map((s) => (s || '').trim()).filter(Boolean))]
  if (unique.length === 0) return {}
  try {
    const res = await authFetch('/covers/recordings/cached', {
      method: 'POST',
      body: JSON.stringify({ ids: unique }),
      signal,
    })
    if (!res.ok) return {}
    const data = (await res.json()) as { urls?: Record<string, string | null> }
    return data.urls ?? {}
  } catch {
    return {}
  }
}

/**
 * Stream NDJSON cover resolution from ``POST /covers/recordings``.
 * Calls ``onItem`` for each ``{id, url}`` line as it arrives. Honors ``signal``
 * for abort. Resolves when the stream ends (or aborts cleanly).
 */
export async function streamRecordingCovers(
  recordingMbids: string[],
  onItem: (item: CoverStreamItem) => void,
  signal?: AbortSignal,
): Promise<void> {
  const unique = [...new Set(recordingMbids.map((s) => (s || '').trim()).filter(Boolean))]
  if (unique.length === 0) return

  let res: Response
  try {
    res = await authFetchStream('/covers/recordings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: unique }),
      signal,
    })
  } catch (err) {
    if (signal?.aborted) return
    throw err
  }
  if (!res.ok || !res.body) return

  const reader = res.body.getReader()
  const decoder = new TextDecoder('utf-8')
  let buffer = ''
  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let nl = buffer.indexOf('\n')
      while (nl !== -1) {
        const line = buffer.slice(0, nl).trim()
        buffer = buffer.slice(nl + 1)
        if (line) {
          try {
            const parsed = JSON.parse(line) as CoverStreamItem
            if (parsed && typeof parsed.id === 'string') {
              onItem({ id: parsed.id, url: typeof parsed.url === 'string' ? parsed.url : null })
            }
          } catch {
            // Tolerate malformed lines — keep streaming.
          }
        }
        nl = buffer.indexOf('\n')
      }
    }
    const tail = buffer.trim()
    if (tail) {
      try {
        const parsed = JSON.parse(tail) as CoverStreamItem
        if (parsed && typeof parsed.id === 'string') {
          onItem({ id: parsed.id, url: typeof parsed.url === 'string' ? parsed.url : null })
        }
      } catch {
        // ignore
      }
    }
  } catch (err) {
    if (signal?.aborted) return
    throw err
  } finally {
    try {
      reader.releaseLock()
    } catch {
      // ignore
    }
  }
}

/**
 * @deprecated Use the cover manager (``client/src/lib/coverManager``) instead.
 * Kept for any caller that still needs a one-shot eager dict — chunks of 12
 * via the legacy ``/covers/recordings/eager`` endpoint.
 */
export async function fetchRecordingCoversBatch(
  recordingMbids: string[],
): Promise<Record<string, string | null>> {
  const unique = [...new Set(recordingMbids.map((s) => (s || '').trim()).filter(Boolean))]
  if (unique.length === 0) return {}
  const CHUNK = 12
  const out: Record<string, string | null> = {}
  for (let i = 0; i < unique.length; i += CHUNK) {
    const chunk = unique.slice(i, i + CHUNK)
    try {
      const res = await authFetch('/covers/recordings/eager', {
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
