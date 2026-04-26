import { useCallback, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useAuthStore } from '../stores/authStore'
import { API } from '../api'

const DRAIN_MS = 200

export function useArtistPrefetch() {
  const queryClient = useQueryClient()
  const token = useAuthStore((s) => s.token)

  // artistId → set of albumIds accumulated since last drain
  const pendingRef = useRef<Map<string, Set<string>>>(new Map())
  // Drain timer handle
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const drain = useCallback(() => {
    if (!token) return

    const pending = pendingRef.current
    if (pending.size === 0) {
      timerRef.current = null
      return
    }

    // Flush pending to local var, clear ref immediately
    const toProcess = Array.from(pending.entries()).map(([artistId, albumIds]) => ({
      artistId,
      albumIds: Array.from(albumIds),
    }))
    pending.clear()

    console.log(`[prefetch] draining ${toProcess.length} artist(s)`, 'color: #8B2A1A')

    for (const { artistId, albumIds } of toProcess) {
      const uniqueAlbums = [...new Set(albumIds)]

      // Fire artist head + albums immediately (cached reads, ~5ms)
      queryClient.prefetchQuery({
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

      queryClient.prefetchQuery({
        queryKey: ['artist-albums', artistId],
        queryFn: (): Promise<{ albums: any[] }> =>
          fetch(`${API}/artist/${artistId}/albums`, {
            headers: token ? { Authorization: `Bearer ${token}` } : {},
          }).then((r) => r.ok ? r.json() : { albums: [] }),
        staleTime: Infinity,
      })

      // Batch album tracklists — server returns ALL albums, not just these
      // This gives us full discography cached after first hover
      fetch(`${API}/prefetch/artist`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ artist_id: artistId, album_ids: uniqueAlbums }),
      })
        .then((r) => r.ok ? r.json() : null)
        .then((data) => {
          if (!data) return
          const { artist, albums } = data

          if (artist) {
            console.log(`[prefetch] artist ${artistId} cached, ${albums?.length ?? 0} album tracklists`, 'color: #1DB954')
            queryClient.setQueryData(['artist', artistId], artist)
          }

          for (const { id, data: alb } of albums ?? []) {
            if (alb) {
              queryClient.setQueryData(['album', id], alb)
            }
          }
        })
        .catch(() => {})
    }

    timerRef.current = null
  }, [queryClient, token])

  const scheduleDrain = useCallback(() => {
    if (timerRef.current === null) {
      timerRef.current = setTimeout(drain, DRAIN_MS)
    }
  }, [drain])

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

  return { enqueue }
}