import { useAuthStore } from './stores/authStore'
import { isTokenExpired } from './authToken'
import { getApiBase } from './config/resolveApi'

/** Resolved at call time from connection store (runtime) or env/default fallback. */
export function getApi(): string {
  return getApiBase()
}

/** Prepend API origin to server-relative URLs (e.g. /covers/artist-local/...). */
export function mediaUrl(url: string | null | undefined): string | undefined {
  if (!url) return undefined
  if (url.startsWith('/')) return `${getApiBase()}${url}`
  return url
}

export type AuthFetchOptions = RequestInit & {
  /** Default 15s. Hybrid search and other MusicBrainz-backed calls need longer. */
  timeoutMs?: number
}

const DEFAULT_FETCH_TIMEOUT_MS = 15_000

function mergeFetchSignal(userSignal: AbortSignal | null | undefined, timeoutMs: number): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  if (userSignal) {
    return AbortSignal.any([timeoutSignal, userSignal])
  }
  return timeoutSignal
}

async function _doFetch(path: string, options: RequestInit, signal: AbortSignal): Promise<Response> {
  const res = await fetch(`${getApiBase()}${path}`, { ...options, signal })
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

  const res = await fetch(`${getApiBase()}${path}`, { ...options, headers, signal: options.signal })
  if (res.status === 401) {
    clearAuth()
    window.location.href = '/login'
    throw new Error('Unauthorized')
  }
  return res
}

export async function authFetch(path: string, options: AuthFetchOptions = {}): Promise<Response> {
  const { timeoutMs = DEFAULT_FETCH_TIMEOUT_MS, ...fetchOptions } = options
  const { token, clearAuth } = useAuthStore.getState()

  if (!token || isTokenExpired(token)) {
    clearAuth()
    window.location.href = '/login'
    throw new Error('Unauthorized')
  }

  const headers: Record<string, string> = {
    ...(fetchOptions.headers as Record<string, string> || {}),
  }
  headers['Authorization'] = `Bearer ${token}`
  if (fetchOptions.body && !headers['Content-Type']) {
    if (!(fetchOptions.body instanceof FormData)) {
      headers['Content-Type'] = 'application/json'
    }
  }

  const isMutation = fetchOptions.method && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(fetchOptions.method.toUpperCase())
  const userSignal = fetchOptions.signal as AbortSignal | undefined
  const combined = mergeFetchSignal(userSignal, timeoutMs)

  try {
    const res = await _doFetch(path, { ...fetchOptions, headers }, combined)
    if (res.status === 401) {
      clearAuth()
      window.location.href = '/login'
      throw new Error('Unauthorized')
    }
    return res
  } catch (err) {
    if (err instanceof DOMException && err.name === 'TimeoutError') {
      throw new Error(`Request timed out after ${Math.round(timeoutMs / 1000)}s: ${path}`)
    }
    if (!isMutation && (err instanceof TypeError || (err instanceof DOMException && err.name === 'AbortError'))) {
      if (userSignal?.aborted) throw err
      const retrySignal = mergeFetchSignal(userSignal, timeoutMs)
      try {
        const res = await _doFetch(path, { ...fetchOptions, headers }, retrySignal)
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

export interface UserPermission {
  can_play: boolean
  can_download: boolean
  can_use_soulseek: boolean
  can_access_apis: boolean
  can_view_recently_downloaded: boolean
}

export interface UserWithPermissions {
  id: number
  username: string
  is_admin: boolean
  permissions: UserPermission | null
}

export interface UserListResponse {
  users: UserWithPermissions[]
  total: number
}

export async function getUsers(): Promise<UserListResponse> {
  const res = await authFetch('/admin/users')
  if (!res.ok) throw new Error('Failed to fetch users')
  return res.json()
}

export async function updateUserPermissions(userId: number, permissions: Partial<UserPermission>): Promise<void> {
  const res = await authFetch(`/admin/users/${userId}/permissions`, {
    method: 'PATCH',
    body: JSON.stringify(permissions),
  })
  if (!res.ok) throw new Error('Failed to update permissions')
}

export async function grantAllPermissions(userId: number): Promise<void> {
  const res = await authFetch(`/admin/users/${userId}/grant-all`, { method: 'POST' })
  if (!res.ok) throw new Error('Failed to grant permissions')
}

export async function revokeAllPermissions(userId: number): Promise<void> {
  const res = await authFetch(`/admin/users/${userId}/revoke`, { method: 'POST' })
  if (!res.ok) throw new Error('Failed to revoke permissions')
}

export async function deleteUser(userId: number): Promise<void> {
  const res = await authFetch(`/admin/users/${userId}`, { method: 'DELETE' })
  if (!res.ok) throw new Error('Failed to delete user')
}
