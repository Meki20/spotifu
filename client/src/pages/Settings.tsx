import { useState, useEffect, useRef } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useNavigate } from 'react-router-dom'
import { useAuthStore } from '../stores/authStore'
import { usePrefetchSettingsStore } from '../stores/prefetchSettingsStore'
import { subscribeSpotifuWebSocket, WS_RECONNECT } from '../spotifuWebSocket'
import { authFetch, getUsers, updateUserPermissions, grantAllPermissions, revokeAllPermissions, deleteUser, type UserWithPermissions, type UserPermission } from '../api'
import { PollyLoading } from '../components/PollyLoading'
import ReconciliationModal from '../components/ReconciliationModal'

interface Settings {
  soulseek_username: string | null
  soulseek_connected: boolean
  soulseek_has_credentials: boolean
  fanarttv_key_configured: boolean
  lastfm_key_configured: boolean
}

interface TrackConfig {
  id: number
  title: string
  artist: string
  artist_credit?: string | null
  album: string
  status: string
  local_file_path: string | null
  mb_id: string | null
}

function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={() => onChange(!on)}
      className="relative w-9 h-5 rounded-full transition-colors cursor-pointer"
      style={{ background: on ? '#b4003e' : '#3D2820', border: 'none' }}
    >
      <div
        className="absolute top-0.5 w-3.5 h-3.5 rounded-full transition-all"
        style={{
          background: '#E8DDD0',
          left: on ? 20 : 3,
        }}
      />
    </button>
  )
}

export default function Settings() {
  const token = useAuthStore((s) => s.token)
  const clearAuth = useAuthStore((s) => s.clearAuth)
  const isAdmin = useAuthStore((s) => s.isAdmin)
  const navigate = useNavigate()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [status, setStatus] = useState('')
  const [fanartKey, setFanartKey] = useState('')
  const [fanartStatus, setFanartStatus] = useState('')
  const [fanartLoading, setFanartLoading] = useState(false)
  const [lastfmKey, setLastfmKey] = useState('')
  const [lastfmStatus, setLastfmStatus] = useState('')
  const [lastfmLoading, setLastfmLoading] = useState(false)
  const [cacheCleared, setCacheCleared] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(false)
  const [settings, setSettings] = useState<Settings | null>(null)
  const [tracks, setTracks] = useState<TrackConfig[]>([])
  const [tracksLoading, setTracksLoading] = useState(false)
  const [prefetchStatus, setPrefetchStatus] = useState('')
  const [reconciliationOpen, setReconciliationOpen] = useState(false)
  const [adminUsers, setAdminUsers] = useState<UserWithPermissions[]>([])
  const [adminUsersLoading, setAdminUsersLoading] = useState(false)
  const prefetch = usePrefetchSettingsStore((s) => s.prefetch)
  const applyServerPrefetch = usePrefetchSettingsStore((s) => s.applyServerPrefetch)
  const trackListRef = useRef<HTMLDivElement>(null)
  const trackVirtualizer = useVirtualizer({
    count: tracks.length,
    getScrollElement: () => trackListRef.current,
    estimateSize: () => 64,
    overscan: 10,
  })

  function handleLogout() {
    clearAuth()
    navigate('/login')
  }

  const tokenRef = useRef(token)
  tokenRef.current = token

  useEffect(() => {
    if (!token) return

    authFetch('/settings')
      .then((r) => r.json())
      .then(setSettings)
      .catch(console.error)

    authFetch('/settings/preferences')
      .then((r) => r.json())
      .then((data: { prefetch?: Record<string, unknown> }) => applyServerPrefetch(data.prefetch))
      .catch(console.error)

    setTracksLoading(true)
    authFetch('/settings/tracks')
      .then((r) => r.json())
      .then((data) => setTracks(data.tracks || []))
      .catch(console.error)
      .finally(() => setTracksLoading(false))

    return subscribeSpotifuWebSocket((data) => {
      if (data.type !== 'soulseek_connected' && data.type !== 'soulseek_error' && data.type !== WS_RECONNECT)
        return
      const t = tokenRef.current
      if (!t) return
      authFetch('/settings')
        .then((r) => r.json())
        .then(setSettings)
        .catch(console.error)
    })
  }, [token])

  useEffect(() => {
    if (!isAdmin) return
    setAdminUsersLoading(true)
    getUsers()
      .then((data) => setAdminUsers(data.users))
      .catch(console.error)
      .finally(() => setAdminUsersLoading(false))
  }, [isAdmin])

  async function handlePermissionChange(userId: number, permission: keyof UserPermission, value: boolean) {
    try {
      await updateUserPermissions(userId, { [permission]: value })
      setAdminUsers((prev) =>
        prev.map((u) =>
          u.id === userId
            ? { ...u, permissions: u.permissions ? { ...u.permissions, [permission]: value } : null }
            : u
        )
      )
    } catch (err) {
      console.error('Failed to update permission:', err)
    }
  }

  async function handleGrantAll(userId: number) {
    try {
      await grantAllPermissions(userId)
      setAdminUsers((prev) =>
        prev.map((u) =>
          u.id === userId
            ? {
                ...u,
                permissions: {
                  can_play: true,
                  can_download: true,
                  can_use_soulseek: true,
                  can_access_apis: true,
                  can_view_recently_downloaded: true,
                },
              }
            : u
        )
      )
    } catch (err) {
      console.error('Failed to grant permissions:', err)
    }
  }

  async function handleRevokeAll(userId: number) {
    try {
      await revokeAllPermissions(userId)
      setAdminUsers((prev) =>
        prev.map((u) =>
          u.id === userId
            ? {
                ...u,
                permissions: {
                  can_play: false,
                  can_download: false,
                  can_use_soulseek: false,
                  can_access_apis: false,
                  can_view_recently_downloaded: false,
                },
              }
            : u
        )
      )
    } catch (err) {
      console.error('Failed to revoke permissions:', err)
    }
  }

  async function handleDeleteUser(userId: number) {
    if (!confirm('Are you sure you want to delete this user? This action cannot be undone.')) return
    try {
      await deleteUser(userId)
      setAdminUsers((prev) => prev.filter((u) => u.id !== userId))
    } catch (err) {
      console.error('Failed to delete user:', err)
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setStatus('')
    try {
      const res = await authFetch('/settings/soulseek', {
        method: 'POST',
        body: JSON.stringify({ username, password }),
      })
      if (!res.ok) throw new Error('Failed to save')
      const settingsRes = await authFetch('/settings')
      const data = await settingsRes.json()
      setSettings(data)
      setUsername('')
      setPassword('')
      setStatus('')
    } catch (err) {
      setStatus('Error: ' + String(err))
    } finally {
      setLoading(false)
    }
  }

  async function handleSoulseekToggle() {
    if (!settings) return
    setLoading(true)
    setStatus('')
    try {
      if (settings.soulseek_connected) {
        await authFetch('/settings/soulseek/disconnect', { method: 'POST' })
        const settingsRes = await authFetch('/settings')
        const data = await settingsRes.json()
        setSettings(data)
      } else {
        const res = await authFetch('/settings/soulseek/connect', { method: 'POST' })
        if (!res.ok) {
          const errData = await res.json().catch(() => ({}))
          throw new Error(errData.detail || 'Failed to connect')
        }
        setStatus('Connecting...')
        await new Promise<void>((resolve) => {
          const unsub = subscribeSpotifuWebSocket((data) => {
            if (data.type === 'soulseek_connected' || data.type === 'soulseek_error') {
              unsub()
              resolve()
            }
          })
          setTimeout(() => {
            unsub()
            resolve()
          }, 10000)
        })
        const settingsRes = await authFetch('/settings')
        const data = await settingsRes.json()
        setSettings(data)
        setStatus('')
      }
    } catch (err) {
      setStatus('Error: ' + String(err))
    } finally {
      setLoading(false)
    }
  }

  async function handleFanartSubmit(e: React.FormEvent) {
    e.preventDefault()
    setFanartLoading(true)
    setFanartStatus('')
    try {
      const res = await authFetch('/settings/fanart', {
        method: 'POST',
        body: JSON.stringify({ api_key: fanartKey }),
      })
      if (!res.ok) throw new Error('Failed to save')
      setFanartKey('')
      setFanartStatus('Saved')
      const settingsRes = await authFetch('/settings')
      setSettings(await settingsRes.json())
    } catch (err) {
      setFanartStatus('Error: ' + String(err))
    } finally {
      setFanartLoading(false)
    }
  }

  async function handleLastfmSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLastfmLoading(true)
    setLastfmStatus('')
    try {
      const res = await authFetch('/settings/lastfm', {
        method: 'POST',
        body: JSON.stringify({ api_key: lastfmKey }),
      })
      if (!res.ok) throw new Error('Failed to save')
      setLastfmKey('')
      setLastfmStatus('Saved')
      const settingsRes = await authFetch('/settings')
      setSettings(await settingsRes.json())
    } catch (err) {
      setLastfmStatus('Error: ' + String(err))
    } finally {
      setLastfmLoading(false)
    }
  }

  async function handleChangeAccount() {
    setLoading(true)
    setStatus('')
    try {
      await authFetch('/settings/soulseek/clear', { method: 'POST' })
      const settingsRes = await authFetch('/settings')
      const data = await settingsRes.json()
      setSettings(data)
      setStatus('')
    } catch (err) {
      setStatus('Error: ' + String(err))
    } finally {
      setLoading(false)
    }
  }

  async function handleDeleteTrack(trackId: number) {
    try {
      const res = await authFetch(`/settings/tracks/${trackId}`, { method: 'DELETE' })
      if (!res.ok) throw new Error('Failed to delete')
      setTracks(prev => prev.filter(t => t.id !== trackId))
    } catch (err) {
      console.error(err)
    }
  }

  async function patchPrefetchPrefs(body: Record<string, boolean>) {
    setPrefetchStatus('')
    try {
      const res = await authFetch('/settings/preferences', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) throw new Error('Failed to save preferences')
      const data = (await res.json()) as { prefetch?: Record<string, unknown> }
      applyServerPrefetch(data.prefetch)
      setPrefetchStatus('Saved')
      setTimeout(() => setPrefetchStatus(''), 2000)
    } catch (err) {
      setPrefetchStatus('Error: ' + String(err))
    }
  }

  async function handleClearCache(kind: 'searches' | 'discography' | 'thumbnails') {
    setCacheCleared((c) => ({ ...c, [kind]: '' }))
    try {
      const res = await authFetch(`/settings/cache/${kind}`, { method: 'POST' })
      if (!res.ok) throw new Error('Failed to clear cache')
      setCacheCleared((c) => ({ ...c, [kind]: 'Cleared' }))
      setTimeout(() => {
        setCacheCleared((c) => {
          const next = { ...c }
          if (next[kind] === 'Cleared') delete next[kind]
          return next
        })
      }, 2500)
    } catch (err) {
      console.error(err)
      setCacheCleared((c) => ({ ...c, [kind]: 'Failed' }))
    }
  }

  const sectionLabelStyle = {
    fontFamily: "'Barlow Condensed', sans-serif",
    fontSize: 17,
    fontWeight: 700,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.15em',
    color: '#b4003e',
    marginBottom: 8,
    paddingBottom: 6,
    borderBottom: '1px solid #261A14',
  }

  const inputStyle = {
    background: '#1A1210',
    border: '1px solid #3D2820',
    borderRadius: 4,
    fontFamily: "'Barlow Semi Condensed', monospace",
    fontSize: 17,
    color: '#E8DDD0',
    padding: '5px 10px',
    outline: 'none' as const,
    width: '100%' as const,
    maxWidth: '100%',
    boxSizing: 'border-box' as const,
  }

  function ApiKeyRow(props: {
    label: string
    configured: boolean
    value: string
    onChange: (v: string) => void
    onSubmit: (e: React.FormEvent) => void
    loading: boolean
    status: string
    placeholder: string
  }) {
    const configured = props.configured
    return (
      <div className="space-y-2">
        <form
          onSubmit={props.onSubmit}
          className="flex items-center gap-2.5 px-3 py-2 rounded"
          style={{
            background: configured ? 'rgba(22, 60, 40, 0.35)' : 'rgba(26, 18, 16, 0.65)',
            border: `1px solid ${configured ? 'rgba(80, 180, 120, 0.35)' : '#3D2820'}`,
            borderRadius: 4,
          }}
        >
          <div
            className="w-7 h-7 rounded-full flex items-center justify-center shrink-0"
            title={configured ? 'Configured' : 'Not configured'}
            style={{
              background: configured ? 'rgba(62, 180, 137, 0.18)' : 'rgba(107, 83, 72, 0.18)',
              border: `1px solid ${configured ? 'rgba(62, 180, 137, 0.55)' : 'rgba(107, 83, 72, 0.55)'}`,
              color: configured ? '#8FD4B0' : '#9A8E84',
              fontFamily: "'Barlow Semi Condensed', sans-serif",
              fontSize: 14,
              lineHeight: 1,
            }}
          >
            {configured ? '✓' : '–'}
          </div>

          <div className="min-w-0">
            <div
              className="text-xs uppercase tracking-wider"
              style={{
                fontFamily: "'Barlow Condensed', sans-serif",
                fontWeight: 700,
                letterSpacing: '0.12em',
                color: '#E8DDD0',
              }}
            >
              {props.label}
            </div>
            <div className="text-[11px]" style={{ fontFamily: "'Barlow Semi Condensed', sans-serif", color: '#9A8E84' }}>
              {configured ? 'set' : 'not set'}
            </div>
          </div>

          <input
            type="text"
            value={props.value}
            onChange={(e) => props.onChange(e.target.value)}
            className="flex-1 min-w-0 px-3 py-2 text-sm"
            style={{ ...inputStyle, width: 'auto' }}
            placeholder={props.placeholder}
          />

          <button
            type="submit"
            disabled={props.loading || !props.value}
            className="px-3 py-2 text-sm font-bold transition-colors shrink-0"
            style={{
              background: '#b4003e',
              color: '#E8DDD0',
              border: 'none',
              cursor: props.loading || !props.value ? 'not-allowed' : 'pointer',
              fontFamily: "'Barlow Condensed', sans-serif",
              fontWeight: 700,
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
              opacity: props.loading || !props.value ? 0.5 : 1,
              borderRadius: 4,
              lineHeight: 1,
            }}
            title="Save"
          >
            {props.loading ? '…' : 'Save'}
          </button>
        </form>

        {props.status && (
          <p
            className="text-xs"
            style={{
              color: props.status === 'Saved' ? '#4A9' : '#b4003e',
              fontFamily: "'Barlow Semi Condensed', sans-serif",
            }}
          >
            {props.status}
          </p>
        )}
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-y-auto w-full">
      <div className="mx-auto w-full max-w-5xl px-6 sm:px-10 md:px-14 lg:px-24 py-6">
      <h1
        className="text-3xl font-bold uppercase mb-5"
        style={{
          fontFamily: "'Barlow Condensed', sans-serif",
          fontWeight: 800,
          textTransform: 'uppercase',
          letterSpacing: '0.04em',
          color: '#E8DDD0',
        }}
      >
        Settings
      </h1>

      {isAdmin && (
        <section className="mb-6 p-4 rounded" style={{ background: '#1A1210', border: '1px solid #3D2820' }}>
          <div style={sectionLabelStyle}>User Management</div>
          {adminUsersLoading ? (
            <p style={{ color: '#9A8E84' }}>Loading users...</p>
          ) : (
            <div className="space-y-3 mt-4">
              {adminUsers.map((user) => (
                <div key={user.id} className="p-4 rounded" style={{ background: '#261A14', border: '1px solid #3D2820' }}>
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-3">
                      <div
                        className="w-10 h-10 rounded-full flex items-center justify-center"
                        style={{ background: '#b4003e' }}
                      >
                        <span className="text-white font-bold text-lg">{user.username[0].toUpperCase()}</span>
                      </div>
                      <div>
                        <span className="text-white font-medium text-lg">{user.username}</span>
                        {user.is_admin && (
                          <span
                            className="ml-2 text-xs px-2 py-0.5 rounded"
                            style={{ background: '#b4003e', color: '#E8DDD0' }}
                          >
                            Admin
                          </span>
                        )}
                      </div>
                    </div>
                    {!user.is_admin && (
                      <button
                        onClick={() => handleDeleteUser(user.id)}
                        className="p-2 rounded transition-colors"
                        style={{ background: 'rgba(196, 48, 43, 0.15)', color: '#b4003e' }}
                        title="Delete user"
                      >
                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M3 6h18"></path>
                          <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"></path>
                          <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"></path>
                        </svg>
                      </button>
                    )}
                  </div>

                  {user.is_admin ? (
                    <div className="flex gap-4 text-sm" style={{ color: '#9A8E84' }}>
                      <span>Has full access to all features</span>
                    </div>
                  ) : (
                    <div className="grid grid-cols-2 gap-3">
                      <div className="flex items-center justify-between p-2 rounded" style={{ background: '#1A1210' }}>
                        <span className="text-sm" style={{ color: '#E8DDD0' }}>Play tracks</span>
                        <Toggle
                          on={user.permissions?.can_play ?? false}
                          onChange={(v) => handlePermissionChange(user.id, 'can_play', v)}
                        />
                      </div>
                      <div className="flex items-center justify-between p-2 rounded" style={{ background: '#1A1210' }}>
                        <span className="text-sm" style={{ color: '#E8DDD0' }}>Download tracks</span>
                        <Toggle
                          on={user.permissions?.can_download ?? false}
                          onChange={(v) => handlePermissionChange(user.id, 'can_download', v)}
                        />
                      </div>
                      <div className="flex items-center justify-between p-2 rounded" style={{ background: '#1A1210' }}>
                        <span className="text-sm" style={{ color: '#E8DDD0' }}>Use Soulseek</span>
                        <Toggle
                          on={user.permissions?.can_use_soulseek ?? false}
                          onChange={(v) => handlePermissionChange(user.id, 'can_use_soulseek', v)}
                        />
                      </div>
                      <div className="flex items-center justify-between p-2 rounded" style={{ background: '#1A1210' }}>
                        <span className="text-sm" style={{ color: '#E8DDD0' }}>Access APIs</span>
                        <Toggle
                          on={user.permissions?.can_access_apis ?? false}
                          onChange={(v) => handlePermissionChange(user.id, 'can_access_apis', v)}
                        />
                      </div>
                      <div className="flex items-center justify-between p-2 rounded" style={{ background: '#1A1210' }}>
                        <span className="text-sm" style={{ color: '#E8DDD0' }}>View Recently Downloaded</span>
                        <Toggle
                          on={user.permissions?.can_view_recently_downloaded ?? false}
                          onChange={(v) => handlePermissionChange(user.id, 'can_view_recently_downloaded', v)}
                        />
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {/* Soulseek section */}
      <section className="mb-6">
        <div style={sectionLabelStyle}>Soulseek / Downloads</div>

        <div
          className="flex items-center gap-2.5 p-3 rounded mb-4"
          style={{
            background: settings?.soulseek_connected ? '#1A2820' : '#281818',
            border: settings?.soulseek_connected
              ? '1px solid rgba(101, 163, 13, 0.35)'
              : '1px solid rgba(196, 48, 48, 0.35)',
            borderRadius: 4,
          }}
        >
          <div
            className="w-2 h-2 rounded-full"
            style={{
              background: settings?.soulseek_connected ? 'oklch(65% 0.14 160)' : '#b4003e',
              boxShadow: settings?.soulseek_connected
                ? '0 0 8px rgba(101, 163, 13, 0.6)'
                : '0 0 8px rgba(196, 48, 48, 0.5)',
              animation: settings?.soulseek_connected ? 'pulse 1.5s ease-in-out infinite' : undefined,
            }}
          />
          <span
            className="text-xs"
            style={{
              fontFamily: "'Barlow Semi Condensed', sans-serif",
              color: settings?.soulseek_connected ? 'oklch(65% 0.14 160)' : '#b4003e',
            }}
          >
            {settings?.soulseek_connected ? 'connected to soulseek' : 'disconnected from soulseek'}
          </span>
        </div>

        {!settings?.soulseek_has_credentials ? (
          <form onSubmit={handleSubmit} className="space-y-3">
            <div>
              <label className="block text-xs mb-1" style={{ fontFamily: "'Barlow Semi Condensed', sans-serif", color: '#9A8E84' }}>Username</label>
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="w-full px-4 py-2 text-sm"
                style={{ ...inputStyle }}
                placeholder="your soulseek username"
              />
            </div>
            <div>
              <label className="block text-xs mb-1" style={{ fontFamily: "'Barlow Semi Condensed', sans-serif", color: '#9A8E84' }}>Password</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full px-4 py-2 text-sm"
                style={{ ...inputStyle }}
                placeholder="your soulseek password"
              />
            </div>
            {status && <p className="text-xs" style={{ color: '#b4003e', fontFamily: "'Barlow Semi Condensed', sans-serif" }}>{status}</p>}
            <button
              type="submit"
              disabled={loading || !username || !password}
              className="px-6 py-2 text-sm font-bold transition-colors"
              style={{
                background: '#b4003e',
                color: '#E8DDD0',
                border: 'none',
                cursor: 'pointer',
                fontFamily: "'Barlow Condensed', sans-serif",
                fontWeight: 700,
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
                opacity: loading || !username || !password ? 0.5 : 1,
              }}
            >
              {loading ? 'Saving...' : 'Save Credentials'}
            </button>
          </form>
        ) : (
          <div className="space-y-3">
            {/* Connection toggle */}
            <div
              className="flex items-center justify-between p-3 rounded"
              style={{ background: '#1A1210', border: '1px solid #3D2820', borderRadius: 4 }}
            >
              <div className="flex items-center gap-3">
                <div
                  className="w-8 h-8 rounded-full flex items-center justify-center"
                  style={{ background: settings?.soulseek_connected ? '#b4003e' : '#3D2820' }}
                >
                  <span style={{ fontSize: 17 }}>⬡</span>
                </div>
                <div>
                  <p className="text-sm" style={{ fontFamily: "'Barlow Semi Condensed', sans-serif", fontWeight: 600, color: '#E8DDD0' }}>Soulseek</p>
                  <p className="text-xs" style={{ fontFamily: "'Barlow Semi Condensed', sans-serif", color: '#9A8E84' }}>
                    {settings?.soulseek_connected ? 'connected' : 'tap toggle to connect'}
                  </p>
                </div>
              </div>
              <Toggle
                on={settings?.soulseek_connected ?? false}
                onChange={() => handleSoulseekToggle()}
              />
            </div>

            {status && <p className="text-xs" style={{ color: '#b4003e', fontFamily: "'Barlow Semi Condensed', sans-serif" }}>{status}</p>}
            <div className="flex items-center justify-between">
              <span className="text-xs" style={{ fontFamily: "'Barlow Semi Condensed', sans-serif", color: '#9A8E84' }}>
                Logged in as: <span style={{ color: '#E8DDD0' }}>{settings?.soulseek_username}</span>
              </span>
              <button
                onClick={handleChangeAccount}
                disabled={loading || settings?.soulseek_connected}
                className="text-xs underline transition-colors"
                style={{
                  fontFamily: "'Barlow Semi Condensed', sans-serif",
                  color: '#9A8E84',
                  opacity: loading || settings?.soulseek_connected ? 0.5 : 1,
                  cursor: loading || settings?.soulseek_connected ? 'not-allowed' : 'pointer',
                }}
              >
                change account
              </button>
            </div>
          </div>
        )}
      </section>

      {/* Provider API Keys */}
      <section className="mb-6">
        <div style={sectionLabelStyle}>Provider API Keys</div>
        <p className="text-xs mb-4" style={{ fontFamily: "'Barlow Semi Condensed', sans-serif", color: '#9A8E84' }}>
          Fanart.tv enables higher-quality artist images. Last.fm can power similarity + tags. Keys are stored locally in your `.secrets`.
        </p>

        <div className="space-y-4">
          <ApiKeyRow
            label="Fanart.tv"
            configured={Boolean(settings?.fanarttv_key_configured)}
            value={fanartKey}
            onChange={setFanartKey}
            onSubmit={handleFanartSubmit}
            loading={fanartLoading}
            status={fanartStatus}
            placeholder="Fanart.tv API key"
          />

          <ApiKeyRow
            label="Last.fm"
            configured={Boolean(settings?.lastfm_key_configured)}
            value={lastfmKey}
            onChange={setLastfmKey}
            onSubmit={handleLastfmSubmit}
            loading={lastfmLoading}
            status={lastfmStatus}
            placeholder="Last.fm API key"
          />
        </div>
      </section>

      {/* Prefetching */}
      <section className="mb-6">
        <div style={sectionLabelStyle}>Prefetching</div>
        <p className="text-xs mb-4" style={{ fontFamily: "'Barlow Semi Condensed', sans-serif", color: '#9A8E84' }}>
          Control background metadata requests. When the master switch is off, all categories are inactive until you turn it on again.
        </p>
        {(() => {
          const rows: { key: keyof typeof prefetch; label: string; hint: string }[] = [
            {
              key: 'enabled',
              label: 'Background prefetch',
              hint: 'Master switch for every category below.',
            },
            {
              key: 'hover_metadata',
              label: 'Artist & album list on hover',
              hint: 'Warms artist head and discography list when you hover tiles (home, search, playlists).',
            },
            {
              key: 'album_tracklists',
              label: 'Album tracklists in the background',
              hint: 'Fetches release tracks after hover or idle hints (MusicBrainz, low priority).',
            },
            {
              key: 'artist_idle',
              label: 'Artist page idle warm-up',
              hint: 'After opening an artist, loads a few more albums when the browser is idle.',
            },
            {
              key: 'hybrid_stale_refresh',
              label: 'Hybrid search stale refresh',
              hint: 'Refreshes cached hybrid “best match” results in the background when they age out.',
            },
          ]
          return (
            <div className="space-y-2">
              {rows.map((row) => {
                const isMaster = row.key === 'enabled'
                const dimmed = !isMaster && !prefetch.enabled
                const on = prefetch[row.key]
                return (
                  <div
                    key={row.key}
                    className="flex items-center justify-between gap-3 p-3 rounded"
                    style={{
                      background: '#1A1210',
                      border: '1px solid #261A14',
                      borderRadius: 4,
                      opacity: dimmed ? 0.72 : 1,
                    }}
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="text-xs" style={{ fontFamily: "'Barlow Semi Condensed', sans-serif", color: '#E8DDD0' }}>
                          {row.label}
                        </p>
                        {!isMaster && prefetch.enabled && !on && (
                          <span
                            className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded"
                            style={{
                              fontFamily: "'Barlow Condensed', sans-serif",
                              fontWeight: 700,
                              letterSpacing: '0.08em',
                              color: '#9A8E84',
                              border: '1px solid #3D2820',
                            }}
                          >
                            off
                          </span>
                        )}
                      </div>
                      <p className="text-[11px] mt-1" style={{ fontFamily: "'Barlow Semi Condensed', sans-serif", color: '#4A413C' }}>
                        {row.hint}
                      </p>
                    </div>
                    <Toggle
                      on={on}
                      onChange={() => void patchPrefetchPrefs({ [row.key]: !on })}
                    />
                  </div>
                )
              })}
              {prefetchStatus && (
                <p
                  className="text-xs px-1"
                  style={{
                    color: prefetchStatus.startsWith('Error') ? '#b4003e' : '#8EC9A0',
                    fontFamily: "'Barlow Semi Condensed', sans-serif",
                  }}
                >
                  {prefetchStatus}
                </p>
              )}
            </div>
          )
        })()}
      </section>

      {/* Downloaded Tracks */}
      <section className="mb-6">
        <div style={sectionLabelStyle}>Downloaded Tracks</div>
        <button
          type="button"
          onClick={() => setReconciliationOpen(true)}
          className="mb-3 px-3 py-1.5 text-xs font-semibold border transition-colors"
          style={{
            fontFamily: "'Barlow Condensed', sans-serif",
            fontWeight: 600,
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
            background: 'transparent',
            color: '#b4003e',
            borderColor: '#b4003e',
            borderRadius: 4,
            cursor: 'pointer',
          }}
        >
          Reconcile Tracks
        </button>
        {tracksLoading ? (
          <div className="flex items-center gap-2 py-2">
            <PollyLoading size={28} />
            <p className="text-xs" style={{ fontFamily: "'Barlow Semi Condensed', sans-serif", color: '#4A413C' }}>loading…</p>
          </div>
        ) : tracks.length === 0 ? (
          <p className="text-xs" style={{ fontFamily: "'Barlow Semi Condensed', sans-serif", color: '#4A413C' }}>No downloaded tracks yet.</p>
        ) : (
          <div ref={trackListRef} className="max-h-80 overflow-y-auto" style={{ position: 'relative' }}>
            <div
              className="relative w-full"
              style={{ height: trackVirtualizer.getTotalSize() }}
            >
              {trackVirtualizer.getVirtualItems().map((virtualRow) => {
                const track = tracks[virtualRow.index]
                return (
                  <div
                    key={track.id}
                    className="absolute left-0 w-full flex items-center justify-between p-3 rounded"
                    style={{
                      top: 0,
                      height: virtualRow.size,
                      transform: `translateY(${virtualRow.start}px)`,
                      background: '#1A1210',
                      border: '1px solid #3D2820',
                      borderRadius: 4,
                    }}
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <div
                        className="w-6 h-6 rounded-full flex items-center justify-center shrink-0"
                        style={{
                          background: track.status === 'READY' ? '#b4003e' : track.status === 'ERROR' ? '#b4003e' : '#3D2820',
                        }}
                      >
                        <span style={{ fontSize: 16, color: track.status === 'READY' || track.status === 'ERROR' ? '#E8DDD0' : '#9A8E84' }}>✓</span>
                      </div>
                      <div className="min-w-0">
                        <p className="text-xs truncate" style={{ fontFamily: "'Barlow Semi Condensed', sans-serif", color: '#E8DDD0' }}>{track.title}</p>
                        <p className="text-xs truncate" style={{ fontFamily: "'Barlow Semi Condensed', sans-serif", color: '#9A8E84' }}>{(track.artist_credit || track.artist)} — {track.album}</p>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => handleDeleteTrack(track.id)}
                      className="p-1 rounded hover:bg-[#b4003e]/20 shrink-0 transition-colors"
                      style={{ color: '#4A413C' }}
                      title="Remove download"
                    >
                      ✕
                    </button>
                  </div>
                )
              })}
            </div>
          </div>
        )}
      </section>

      {/* Cache */}
      <section className="mb-6">
        <div style={sectionLabelStyle}>Cache</div>
        <p className="text-xs mb-4" style={{ fontFamily: "'Barlow Semi Condensed', sans-serif", color: '#9A8E84' }}>
          Clear cached metadata. Thumbnails include cover art from Cover Art Archive and artist images from fanart.tv.
        </p>
        <div className="space-y-2">
          {(['searches', 'discography', 'thumbnails'] as const).map((kind) => (
            <div key={kind} className="flex items-center justify-between p-3 rounded" style={{ background: '#1A1210', border: '1px solid #261A14', borderRadius: 4 }}>
              <div>
                <p className="text-xs" style={{ fontFamily: "'Barlow Semi Condensed', sans-serif", color: '#E8DDD0' }}>
                  Cached {kind.charAt(0).toUpperCase() + kind.slice(1)}
                </p>
                <p className="text-xs" style={{ fontFamily: "'Barlow Semi Condensed', sans-serif", color: '#4A413C', fontSize: 18 }}>
                  {kind === 'searches' ? 'Hybrid best-match + similar-tracks (per recording) cache' :
                   kind === 'discography' ? 'Artist data, album lists, and ordering' :
                   'Cover art from Cover Art Archive and fanart.tv artist images'}
                </p>
              </div>
              <div className="flex items-center gap-2">
                {cacheCleared[kind] && (
                  <span
                    className="text-xs tabular-nums"
                    style={{
                      fontFamily: "'Barlow Semi Condensed', sans-serif",
                      color: cacheCleared[kind] === 'Cleared' ? '#8EC9A0' : '#b4003e',
                    }}
                  >
                    {cacheCleared[kind]}
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => handleClearCache(kind)}
                  className="px-3 py-1 text-xs border transition-colors"
                  style={{
                    fontFamily: "'Barlow Condensed', sans-serif",
                    fontWeight: 600,
                    textTransform: 'uppercase',
                    letterSpacing: '0.1em',
                    background: 'transparent',
                    color: '#9A8E84',
                    borderColor: '#3D2820',
                    cursor: 'pointer',
                  }}
                >
                  Clear
                </button>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* About */}
      <section
        className="p-4 rounded"
        style={{ background: '#1A1210', border: '1px solid #3D2820', borderRadius: 4 }}
      >
        <h2
          className="text-lg uppercase mb-1"
          style={{ fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: '#E8DDD0' }}
        >
          About SpotiFU
        </h2>
        <p className="text-xs mb-4" style={{ fontFamily: "'Barlow Semi Condensed', sans-serif", color: '#9A8E84' }}>
          Music streaming app powered by MusicBrainz metadata and Soulseek full-track downloads.
          Backend runs on port 1985, frontend on port 1984.
        </p>
        <button
          onClick={handleLogout}
          className="px-4 py-2 text-sm font-semibold border transition-colors"
          style={{
            background: 'transparent',
            color: '#b4003e',
            borderColor: '#b4003e',
            cursor: 'pointer',
            fontFamily: "'Barlow Condensed', sans-serif",
            fontWeight: 600,
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
          }}
        >
          Logout
        </button>
      </section>

      <ReconciliationModal open={reconciliationOpen} onClose={() => setReconciliationOpen(false)} />
      </div>
    </div>
  )
}