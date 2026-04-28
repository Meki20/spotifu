import { useAuthStore } from './stores/authStore'
import { isTokenExpired } from './authToken'

export const API = import.meta.env.VITE_API_URL ?? 'http://localhost:1985'

function mergeFetchSignal(userSignal: AbortSignal | null | undefined): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(15_000)
  if (userSignal) {
    return AbortSignal.any([timeoutSignal, userSignal])
  }
  return timeoutSignal
}

async function _doFetch(path: string, options: RequestInit, signal: AbortSignal): Promise<Response> {
  const res = await fetch(`${API}${path}`, { ...options, signal })
  return res
}

export async function authFetchStream(path: string, options: RequestInit = {}): Promise<Response> {
  const { token, clearAuth } = useAuthStore.getState()

  if (!token || isTokenExpired(token)) {
    clearAuth()
    window.location.href = '/login'
    throw new Error('Unauthorized')
  }

  const headers: Record<string, string> = {
    ...(options.headers as Record<string, string> || {}),
  }
  headers['Authorization'] = `Bearer ${token}`

  // Important: no 15s timeout for streaming responses.
  const res = await fetch(`${API}${path}`, { ...options, headers, signal: options.signal })
  if (res.status === 401) {
    clearAuth()
    window.location.href = '/login'
    throw new Error('Unauthorized')
  }
  return res
}

export async function authFetch(path: string, options: RequestInit = {}): Promise<Response> {
  const { token, clearAuth } = useAuthStore.getState()

  if (!token || isTokenExpired(token)) {
    clearAuth()
    window.location.href = '/login'
    throw new Error('Unauthorized')
  }

  const headers: Record<string, string> = {
    ...(options.headers as Record<string, string> || {}),
  }
  headers['Authorization'] = `Bearer ${token}`
  if (options.body && !headers['Content-Type']) {
    if (!(options.body instanceof FormData)) {
      headers['Content-Type'] = 'application/json'
    }
  }

  const isMutation = options.method && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(options.method.toUpperCase())
  const combined = mergeFetchSignal(options.signal as AbortSignal | undefined)

  try {
    const res = await _doFetch(path, { ...options, headers }, combined)
    if (res.status === 401) {
      clearAuth()
      window.location.href = '/login'
      throw new Error('Unauthorized')
    }
    return res
  } catch (err) {
    if (err instanceof DOMException && err.name === 'TimeoutError') {
      throw new Error(`Request timed out after 15s: ${path}`)
    }
    // Retry GETs once on network error, but not intentional aborts
    if (!isMutation && (err instanceof TypeError || (err instanceof DOMException && err.name === 'AbortError'))) {
      const userSignal = options.signal as AbortSignal | undefined
      if (userSignal?.aborted) throw err
      const retrySignal = mergeFetchSignal(userSignal)
      try {
        const res = await _doFetch(path, { ...options, headers }, retrySignal)
        if (res.status === 401) {
          clearAuth()
          window.location.href = '/login'
          throw new Error('Unauthorized')
        }
        return res
      } catch {
        throw err
      }
    }
    throw err
  }
}
