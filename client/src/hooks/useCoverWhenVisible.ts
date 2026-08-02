import { useInView } from './useInView'
import { useCover, type UseCoverResult } from './useCover'
import type { CoverPriority } from '../lib/coverManager'

interface UseCoverWhenVisibleOptions {
  rootMargin?: string
  threshold?: number
}

export function useCoverWhenVisible(
  elementRef: React.RefObject<HTMLElement | null>,
  mbid: string | null | undefined,
  priority?: CoverPriority,
  options?: UseCoverWhenVisibleOptions,
): UseCoverResult {
  const isVisible = useInView(elementRef, options)
  return useCover(isVisible ? mbid : null, priority)
}