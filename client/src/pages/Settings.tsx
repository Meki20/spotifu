import { useState, useEffect, useRef } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useNavigate } from 'react-router-dom'
import { useAuthStore } from '../stores/authStore'
import { subscribeSpotifuWebSocket, WS_RECONNECT } from '../spotifuWebSocket'
import { authFetch } from '../api'
import { PollyLoading } from '../components/PollyLoading'

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
      style={{ background: on ? '#8B2A1A' : '#3D2820', border: 'none' }}
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
    color: '#5C1A10',
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
              background: '#8B2A1A',
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
              color: props.status === 'Saved' ? '#4A9' : '#8B2A1A',
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
              background: settings?.soulseek_connected ? 'oklch(65% 0.14 160)' : '#C43030',
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
              color: settings?.soulseek_connected ? 'oklch(65% 0.14 160)' : '#E86B6B',
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
            {status && <p className="text-xs" style={{ color: '#8B2A1A', fontFamily: "'Barlow Semi Condensed', sans-serif" }}>{status}</p>}
            <button
              type="submit"
              disabled={loading || !username || !password}
              className="px-6 py-2 text-sm font-bold transition-colors"
              style={{
                background: '#8B2A1A',
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
                  style={{ background: settings?.soulseek_connected ? '#8B2A1A' : '#3D2820' }}
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

            {status && <p className="text-xs" style={{ color: '#8B2A1A', fontFamily: "'Barlow Semi Condensed', sans-serif" }}>{status}</p>}
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

      {/* Downloaded Tracks */}
      <section className="mb-6">
        <div style={sectionLabelStyle}>Downloaded Tracks</div>
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
                          background: track.status === 'READY' ? '#8B2A1A' : track.status === 'ERROR' ? '#C43030' : '#3D2820',
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
                      className="p-1 rounded hover:bg-[#C43030]/20 shrink-0 transition-colors"
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
                  {kind === 'searches' ? 'MusicBrainz search results stored locally' :
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
                      color: cacheCleared[kind] === 'Cleared' ? '#8EC9A0' : '#C43030',
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
            color: '#C43030',
            borderColor: '#C43030',
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
      </div>
    </div>
  )
}