import { useEffect, useRef, useState } from 'react'
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
  const { rootMargin = '200px', threshold = 0 } = options ?? {}
  const [isVisible, setIsVisible] = useState(false)
  const observerRef = useRef<IntersectionObserver | null>(null)

  useEffect(() => {
    const el = elementRef.current
    if (!el) return

    observerRef.current = new IntersectionObserver(
      ([entry]) => {
        setIsVisible(entry.isIntersecting)
      },
      { rootMargin, threshold },
    )
    observerRef.current.observe(el)

    return () => {
      observerRef.current?.disconnect()
      observerRef.current = null
    }
  }, [elementRef, rootMargin, threshold])

  return useRgCover(isVisible ? rgMbid : null, priority)
}
