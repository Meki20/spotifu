import { useEffect, useRef, useState } from 'react'
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

  return useCover(isVisible ? mbid : null, priority)
}
