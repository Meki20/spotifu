import { useCallback, useMemo, useRef, useSyncExternalStore } from 'react'
import { rgCoverManager } from '../lib/rgCoverManager'
import type { CoverPriority } from '../lib/coverManager'

export interface UseRgCoverResult {
  url: string | null
  isResolved: boolean
}

export function useRgCover(
  rgMbid: string | null | undefined,
  priority: CoverPriority = 'viewport',
): UseRgCoverResult {
  const id = (rgMbid || '').trim()
  const snapshotRef = useRef<UseRgCoverResult | null>(null)

  const subscribe = useCallback(
    (notify: () => void) => {
      if (!id) return () => {}
      return rgCoverManager.subscribe(id, priority, () => {
        snapshotRef.current = null
        notify()
      })
    },
    [id, priority],
  )

  const getSnapshot = useCallback(() => {
    if (!id) return EMPTY_RESOLVED
    if (snapshotRef.current) return snapshotRef.current
    const peek = rgCoverManager.peek(id)
    snapshotRef.current = peek
    return peek
  }, [id])

  useMemo(() => {
    snapshotRef.current = null
  }, [id])

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

const EMPTY_RESOLVED: UseRgCoverResult = { url: null, isResolved: true }
