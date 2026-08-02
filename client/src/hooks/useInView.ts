import { useEffect, useState } from 'react'

// One shared IntersectionObserver per distinct (rootMargin, threshold) config,
// reused by every card/row instead of creating a fresh observer per element.
// With dozens (or hundreds, once virtualized: viewport-sized) of mounted rows,
// this removes the per-element observer churn that previously spiked while
// fast-scrolling a list to its end.

interface Pool {
  observer: IntersectionObserver | null
  callbacks: Map<Element, (visible: boolean) => void>
}

const pools = new Map<string, Pool>()

function getPool(rootMargin: string, threshold: number): Pool {
  const key = `${rootMargin}|${threshold}`
  let pool = pools.get(key)
  if (!pool) {
    const callbacks = new Map<Element, (visible: boolean) => void>()
    const observer =
      typeof IntersectionObserver === 'undefined'
        ? null
        : new IntersectionObserver(
            (entries) => {
              for (const entry of entries) {
                const cb = callbacks.get(entry.target)
                if (cb) cb(entry.isIntersecting)
              }
            },
            { rootMargin, threshold },
          )
    pool = { observer, callbacks }
    pools.set(key, pool)
  }
  return pool
}

interface UseInViewOptions {
  rootMargin?: string
  threshold?: number
}

export function useInView(
  elementRef: React.RefObject<HTMLElement | null>,
  options: UseInViewOptions = {},
): boolean {
  const { rootMargin = '200px', threshold = 0 } = options
  const [isVisible, setIsVisible] = useState(false)

  useEffect(() => {
    const el = elementRef.current
    if (!el) return
    const pool = getPool(rootMargin, threshold)
    pool.callbacks.set(el, setIsVisible)
    pool.observer?.observe(el)
    return () => {
      pool.callbacks.delete(el)
      pool.observer?.unobserve(el)
    }
  }, [elementRef, rootMargin, threshold])

  return isVisible
}