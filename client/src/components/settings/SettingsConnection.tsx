// Settings → Connection tab: server connection + Soulseek credentials.

import { useEffect, useRef, useState } from 'react'
import ServerConnectionPanel from '../ServerConnectionPanel'
import { Toggle } from './Toggle'
import { SectionLabel } from './Section'
import { authFetch } from '../../api'
import {
  subscribeSpotifuWebSocket,
  WS_RECONNECT,
} from '../../spotifuWebSocket'

interface ServerSettings {
  soulseek_username: string | null
  soulseek_connected: boolean
  soulseek_has_credentials: boolean
  fanarttv_key_configured: boolean
  lastfm_key_configured: boolean
}

export default function SettingsConnection() {
  const [settings, setSettings] = useState<ServerSettings | null>(null)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [status, setStatus] = useState('')
  const tokenRef = useRef<string | null>(null)
  tokenRef.current = localStorage.getItem('spotifu.token')

  useEffect(() => {
    let cancelled = false
    authFetch('/settings')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!cancelled && data) setSettings(data)
      })
      .catch(console.error)
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    return subscribeSpotifuWebSocket((data) => {
      if (
        data.type !== 'soulseek_connected' &&
        data.type !== 'soulseek_error' &&
        data.type !== WS_RECONNECT
      ) {
        return
      }
      if (!tokenRef.current) return
      authFetch('/settings')
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => data && setSettings(data))
        .catch(console.error)
    })
  }, [])

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
      setSettings(await settingsRes.json())
      setUsername('')
      setPassword('')
    } catch (err) {
      setStatus('Error: ' + String(err))
    } finally {
      setLoading(false)
    }
  }

  async function handleToggle() {
    if (!settings) return
    setLoading(true)
    setStatus('')
    try {
      if (settings.soulseek_connected) {
        await authFetch('/settings/soulseek/disconnect', { method: 'POST' })
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
      }
      const r = await authFetch('/settings')
      setSettings(await r.json())
      setStatus('')
    } catch (err) {
      setStatus('Error: ' + String(err))
    } finally {
      setLoading(false)
    }
  }

  async function handleChangeAccount() {
    setLoading(true)
    setStatus('')
    try {
      await authFetch('/settings/soulseek/clear', { method: 'POST' })
      const r = await authFetch('/settings')
      setSettings(await r.json())
    } catch (err) {
      setStatus('Error: ' + String(err))
    } finally {
      setLoading(false)
    }
  }

  const inputStyle: React.CSSProperties = {
    background: 'var(--bg-base)',
    border: '1px solid var(--border)',
    borderRadius: 4,
    fontFamily: 'var(--font-mono)',
    fontSize: 14,
    color: 'var(--text-primary)',
    padding: '5px 10px',
    outline: 'none',
    width: '100%',
    maxWidth: '100%',
    boxSizing: 'border-box',
  }

  return (
    <div className="space-y-6">
      <section>
        <SectionLabel>Server connection</SectionLabel>
        <ServerConnectionPanel compact />
      </section>

      <section>
        <SectionLabel>Soulseek / Downloads</SectionLabel>
        <div
          className="flex items-center gap-2.5 p-3 rounded mb-4"
          style={{
            background: settings?.soulseek_connected ? 'var(--color-success-bg)' : 'var(--color-danger-bg)',
            border: settings?.soulseek_connected ? '1px solid var(--color-success-border)' : '1px solid var(--color-danger-border)',
            borderRadius: 4,
          }}
        >
          <div
            className="w-2 h-2 rounded-full"
            style={{
              background: settings?.soulseek_connected ? 'var(--color-success)' : 'var(--color-danger)',
              boxShadow: settings?.soulseek_connected
                ? '0 0 8px rgba(101, 163, 13, 0.6)'
                : '0 0 8px rgba(196, 48, 48, 0.5)',
              animation: settings?.soulseek_connected ? 'pulse 1.5s ease-in-out infinite' : undefined,
            }}
          />
          <span
            className="text-xs"
            style={{
              fontFamily: 'var(--font-body)',
              color: settings?.soulseek_connected ? 'var(--color-success)' : 'var(--color-danger)',
            }}
          >
            {settings?.soulseek_connected ? 'connected to soulseek' : 'disconnected from soulseek'}
          </span>
        </div>

        {!settings?.soulseek_has_credentials ? (
          <form onSubmit={handleSubmit} className="space-y-3">
            <div>
              <label className="block text-xs mb-1" style={{ fontFamily: 'var(--font-body)', color: 'var(--text-secondary)' }}>
                Username
              </label>
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="w-full px-4 py-2 text-sm"
                style={inputStyle}
                placeholder="your soulseek username"
              />
            </div>
            <div>
              <label className="block text-xs mb-1" style={{ fontFamily: 'var(--font-body)', color: 'var(--text-secondary)' }}>
                Password
              </label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full px-4 py-2 text-sm"
                style={inputStyle}
                placeholder="your soulseek password"
              />
            </div>
            {status && (
              <p className="text-xs" style={{ color: 'var(--color-danger)', fontFamily: 'var(--font-body)' }}>
                {status}
              </p>
            )}
            <button
              type="submit"
              disabled={loading || !username || !password}
              className="px-6 py-2 text-sm font-bold transition-colors"
              style={{
                background: 'var(--accent)',
                color: 'var(--text-primary)',
                border: 'none',
                cursor: 'pointer',
                fontFamily: 'var(--font-display)',
                fontWeight: 700,
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
                opacity: loading || !username || !password ? 0.5 : 1,
                borderRadius: 4,
              }}
            >
              {loading ? 'Saving...' : 'Save Credentials'}
            </button>
          </form>
        ) : (
          <div className="space-y-3">
            <div
              className="flex items-center justify-between p-3 rounded"
              style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 4 }}
            >
              <div className="flex items-center gap-3">
                <div
                  className="w-8 h-8 rounded-full flex items-center justify-center"
                  style={{ background: settings?.soulseek_connected ? 'var(--accent)' : 'var(--border)' }}
                >
                  <span style={{ fontSize: 17 }}>⬡</span>
                </div>
                <div>
                  <p className="text-sm" style={{ fontFamily: 'var(--font-body)', fontWeight: 600, color: 'var(--text-primary)' }}>
                    Soulseek
                  </p>
                  <p className="text-xs" style={{ fontFamily: 'var(--font-body)', color: 'var(--text-secondary)' }}>
                    {settings?.soulseek_connected ? 'connected' : 'tap toggle to connect'}
                  </p>
                </div>
              </div>
              <Toggle on={settings?.soulseek_connected ?? false} onChange={() => void handleToggle()} />
            </div>

            {status && (
              <p className="text-xs" style={{ color: 'var(--color-danger)', fontFamily: 'var(--font-body)' }}>
                {status}
              </p>
            )}
            <div className="flex items-center justify-between">
              <span className="text-xs" style={{ fontFamily: 'var(--font-body)', color: 'var(--text-secondary)' }}>
                Logged in as: <span style={{ color: 'var(--text-primary)' }}>{settings?.soulseek_username}</span>
              </span>
              <button
                onClick={handleChangeAccount}
                disabled={loading || settings?.soulseek_connected}
                className="text-xs underline transition-colors"
                style={{
                  fontFamily: 'var(--font-body)',
                  color: 'var(--text-secondary)',
                  opacity: loading || settings?.soulseek_connected ? 0.5 : 1,
                  cursor: loading || settings?.soulseek_connected ? 'not-allowed' : 'pointer',
                  background: 'transparent',
                  border: 'none',
                }}
              >
                change account
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  )
}
