import { useInView } from './useInView'
import { useRgCover, type UseRgCoverResult } from './useRgCover'
import type { CoverPriority } from '../lib/coverManager'

interface UseRgCoverWhenVisibleOptions {
  rootMargin?: string
  threshold?: number
}

export function useRgCoverWhenVisible(
  elementRef: React.RefObject<HTMLElement | null>,
  rgMbid: string | null | undefined,
  priority?: CoverPriority,
  options?: UseRgCoverWhenVisibleOptions,
): UseRgCoverResult {
  const isVisible = useInView(elementRef, options)
  return useRgCover(isVisible ? rgMbid : null, priority)
}