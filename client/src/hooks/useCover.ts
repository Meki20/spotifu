import { useCallback, useMemo, useRef, useSyncExternalStore } from 'react'
import { coverManager, type CoverPriority } from '../lib/coverManager'

export interface UseCoverResult {
  url: string | null
  isResolved: boolean
}

/**
 * Subscribe to a recording's resolved cover URL via the cover manager.
 * The manager owns batching, concurrency, priority, and pause/abort behavior;
 * this hook is a thin React adapter built on ``useSyncExternalStore``.
 */
export function useCover(mbid: string | null | undefined, priority: CoverPriority = 'playlist'): UseCoverResult {
  const id = (mbid || '').trim()
  const snapshotRef = useRef<UseCoverResult | null>(null)

  const subscribe = useCallback(
    (notify: () => void) => {
      if (!id) return () => {}
      return coverManager.subscribe(id, priority, () => {
        // Force the next getSnapshot to re-read from the manager.
        snapshotRef.current = null
        notify()
      })
    },
    [id, priority],
  )

  const getSnapshot = useCallback(() => {
    if (!id) return EMPTY_RESOLVED
    if (snapshotRef.current) return snapshotRef.current
    const peek = coverManager.peek(id)
    snapshotRef.current = peek
    return peek
  }, [id])

  // Reset memoized snapshot when id changes.
  useMemo(() => {
    snapshotRef.current = null
  }, [id])

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

const EMPTY_RESOLVED: UseCoverResult = { url: null, isResolved: true }
