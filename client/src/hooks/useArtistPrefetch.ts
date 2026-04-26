import { useCallback, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useAuthStore } from '../stores/authStore'
import { API } from '../api'

const DEFAULT_DRAIN_MS = 280
const PREFETCH_ALBUM_BATCH = 4

/** Serialize all prefetch POST work so MB queue is not flooded by parallel bodies. */
let prefetchPostChain: Promise<void> = Promise.resolve()

export type ArtistPrefetchOptions = {
  /** Coalesce rapid hovers (e.g. search). Slightly slower first prefetch, fewer storms. */
  drainMs?: number
}

function scheduleIdle(fn: () => void) {
  const ric = (globalThis as unknown as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number })
    .requestIdleCallback
  if (typeof ric === 'function') {
    ric(fn, { timeout: 1200 })
  } else {
    setTimeout(fn, 400)
  }
}

export function useArtistPrefetch(options?: ArtistPrefetchOptions) {
  const queryClient = useQueryClient()
  const token = useAuthStore((s) => s.token)
  const drainMs = options?.drainMs ?? DEFAULT_DRAIN_MS

  const pendingRef = useRef<Map<string, Set<string>>>(new Map())
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const applyPrefetchResponse = useCallback(
    (artistId: string, data: { artist?: unknown; albums?: { id: string; data: unknown }[] } | null) => {
      if (!data) return
      const { artist, albums } = data
      if (artist) {
        queryClient.setQueryData(['artist', artistId], artist)
      }
      for (const row of albums ?? []) {
        if (row?.id && row.data) {
          queryClient.setQueryData(['album', row.id], row.data)
        }
      }
    },
    [queryClient],
  )

  const queueAlbumPosts = useCallback(
    (artistId: string, albumIds: string[]) => {
      if (!token || albumIds.length === 0) return
      const unique = [...new Set(albumIds)]
      const run = async () => {
        let rest = [...unique]
        while (rest.length > 0) {
          const chunk = rest.slice(0, PREFETCH_ALBUM_BATCH)
          rest = rest.slice(PREFETCH_ALBUM_BATCH)
          try {
            const r = await fetch(`${API}/prefetch/artist`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                ...(token ? { Authorization: `Bearer ${token}` } : {}),
              },
              body: JSON.stringify({ artist_id: artistId, album_ids: chunk }),
            })
            const data = r.ok ? await r.json() : null
            applyPrefetchResponse(artistId, data)
          } catch {
            /* ignore */
          }
        }
      }
      prefetchPostChain = prefetchPostChain.then(run).catch(() => {})
    },
    [applyPrefetchResponse, token],
  )

  const drain = useCallback(() => {
    if (!token) {
      timerRef.current = null
      return
    }

    const pending = pendingRef.current
    if (pending.size === 0) {
      timerRef.current = null
      return
    }

    const toProcess = Array.from(pending.entries()).map(([artistId, albumIds]) => ({
      artistId,
      albumIds: Array.from(albumIds),
    }))
    pending.clear()

    for (const { artistId, albumIds } of toProcess) {
      void queryClient.prefetchQuery({
        queryKey: ['artist', artistId],
        queryFn: () =>
          fetch(`${API}/artist/${artistId}`, {
            headers: token ? { Authorization: `Bearer ${token}` } : {},
          }).then((r) => {
            if (!r.ok) throw new Error('Failed')
            return r.json()
          }),
        staleTime: Infinity,
      })

      void queryClient.prefetchQuery({
        queryKey: ['artist-albums', artistId],
        queryFn: (): Promise<{ albums: unknown[] }> =>
          fetch(`${API}/artist/${artistId}/albums`, {
            headers: token ? { Authorization: `Bearer ${token}` } : {},
          }).then((r) => (r.ok ? r.json() : { albums: [] })),
        staleTime: Infinity,
      })

      if (albumIds.length > 0) {
        queueAlbumPosts(artistId, albumIds)
      }
    }

    timerRef.current = null
  }, [queryClient, queueAlbumPosts, token])

  const scheduleDrain = useCallback(() => {
    if (timerRef.current === null) {
      timerRef.current = setTimeout(drain, drainMs)
    }
  }, [drain, drainMs])

  const enqueue = useCallback(
    (artistId: string, albumIds: string[] = []) => {
      if (!artistId) return

      const existing = pendingRef.current.get(artistId)
      if (existing) {
        for (const id of albumIds) existing.add(id)
      } else {
        pendingRef.current.set(artistId, new Set(albumIds))
      }
      scheduleDrain()
    },
    [scheduleDrain],
  )

  /** Defer album prefetch until the browser is idle (e.g. warm rest of discography after paint). */
  const enqueueAlbumsIdle = useCallback(
    (artistId: string, albumIds: string[]) => {
      if (!artistId || albumIds.length === 0) return
      scheduleIdle(() => enqueue(artistId, albumIds))
    },
    [enqueue],
  )

  return { enqueue, enqueueAlbumsIdle }
}
