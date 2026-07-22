import { useCallback, useEffect, useState } from 'react'
import { useConnectionStore, type ConnectionSource } from '../config/connectionStore'
import { discoverServers, probeServerUrl, type DiscoveredServer } from '../config/discoverServer'
import { reconnectWebSocket } from '../spotifuWebSocket'
import { PollyLoading } from './PollyLoading'

const inputStyle: React.CSSProperties = {
  background: '--bg-surface',
  border: '1px solid var(--border)',
  borderRadius: 4,
  color: 'var(--text-primary)',
  fontFamily: "'Barlow Semi Condensed', sans-serif",
}

const sourceLabels: Record<ConnectionSource, string> = {
  mdns: 'discovered on LAN',
  manual: 'manual',
  env: 'build config',
  default: 'default',
}

interface ServerConnectionPanelProps {
  compact?: boolean
  onConnected?: () => void
}

export default function ServerConnectionPanel({ compact, onConnected }: ServerConnectionPanelProps) {
  const apiBaseUrl = useConnectionStore((s) => s.apiBaseUrl)
  const source = useConnectionStore((s) => s.source)
  const setManualUrl = useConnectionStore((s) => s.setManualUrl)
  const applyDiscoveredService = useConnectionStore((s) => s.applyDiscoveredService)
  const clearConnection = useConnectionStore((s) => s.clearConnection)
  const getEffectiveApiUrl = useConnectionStore((s) => s.getEffectiveApiUrl)

  const [manualInput, setManualInput] = useState(() => getEffectiveApiUrl())
  const [connStatus, setConnStatus] = useState<'idle' | 'checking' | 'connected' | 'unreachable'>('idle')
  const [discoverStatus, setDiscoverStatus] = useState<'idle' | 'searching'>('idle')
  const [discovered, setDiscovered] = useState<DiscoveredServer[]>([])
  const [message, setMessage] = useState('')

  const checkConnection = useCallback(async (url?: string) => {
    const target = url ?? getEffectiveApiUrl()
    setConnStatus('checking')
    const ok = await probeServerUrl(target)
    setConnStatus(ok ? 'connected' : 'unreachable')
    if (ok) onConnected?.()
    return ok
  }, [getEffectiveApiUrl, onConnected])

  useEffect(() => {
    useConnectionStore.getState().seedFromEnv()
  }, [])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const target = getEffectiveApiUrl()
      setConnStatus('checking')
      const ok = await probeServerUrl(target)
      if (!cancelled) {
        setConnStatus(ok ? 'connected' : 'unreachable')
        if (ok) onConnected?.()
      }
    })()
    return () => {
      cancelled = true
    }
  }, [getEffectiveApiUrl, onConnected])

  const runDiscovery = useCallback(async () => {
    setDiscoverStatus('searching')
    setMessage('')
    const servers = await discoverServers()
    setDiscovered(servers)
    setDiscoverStatus('idle')
    if (servers.length === 0) {
      setMessage('No servers found. Try manual URL or ensure spotifu.local resolves on your network.')
    }
  }, [])

  async function handleTestManual() {
    setMessage('')
    const trimmed = manualInput.trim()
    if (!trimmed) {
      setMessage('Enter a server URL')
      return
    }
    setManualUrl(trimmed)
    reconnectWebSocket()
    const ok = await checkConnection(trimmed.startsWith('http') ? trimmed : `http://${trimmed}`)
    setMessage(ok ? 'Connected' : 'Could not reach server')
  }

  function handleSelectDiscovered(server: DiscoveredServer) {
    applyDiscoveredService(server.host, server.port)
    setManualInput(`http://${server.host}:${server.port}`)
    reconnectWebSocket()
    void checkConnection(`http://${server.host}:${server.port}`)
  }

  function handleClear() {
    clearConnection()
    const next = useConnectionStore.getState().getEffectiveApiUrl()
    setManualInput(next)
    reconnectWebSocket()
    void checkConnection(next)
  }

  return (
    <div className={compact ? 'space-y-3' : 'space-y-4'}>
      <div
        className="flex items-center gap-2.5 p-3 rounded"
        style={{
          background: connStatus === 'connected' ? 'var(--bg-surface)' : 'var(--bg-surface)',
          border: connStatus === 'connected'
            ? '1px solid rgba(101, 163, 13, 0.35)'
            : '1px solid rgba(196, 48, 48, 0.35)',
          borderRadius: 4,
        }}
      >
        {connStatus === 'checking' ? (
          <PollyLoading size={20} />
        ) : (
          <div
            className="w-2 h-2 rounded-full shrink-0"
            style={{
              background: connStatus === 'connected' ? 'var(--color-success)' : 'var(--accent)',
            }}
          />
        )}
        <span className="text-xs" style={{ fontFamily: "'Barlow Semi Condensed', sans-serif", color: 'var(--text-primary)' }}>
          {connStatus === 'checking' && 'Checking server…'}
          {connStatus === 'connected' && `Connected to ${getEffectiveApiUrl()} (${sourceLabels[source]})`}
          {connStatus === 'unreachable' && `Cannot reach ${getEffectiveApiUrl()}`}
          {connStatus === 'idle' && 'Server connection'}
        </span>
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => void runDiscovery()}
          disabled={discoverStatus === 'searching'}
          className="px-3 py-1.5 text-xs rounded cursor-pointer"
          style={{ background: 'var(--bg-surface)', color: 'var(--text-primary)', border: 'none' }}
        >
          {discoverStatus === 'searching' ? 'Searching…' : 'Search LAN'}
        </button>
        <button
          type="button"
          onClick={() => void checkConnection()}
          className="px-3 py-1.5 text-xs rounded cursor-pointer"
          style={{ background: 'var(--bg-surface)', color: 'var(--text-primary)', border: 'none' }}
        >
          Test connection
        </button>
        {(apiBaseUrl || source !== 'default') && (
          <button
            type="button"
            onClick={handleClear}
            className="px-3 py-1.5 text-xs rounded cursor-pointer"
            style={{ background: 'transparent', color: 'var(--text-primary)', border: '1px solid var(--border)' }}
          >
            Reset URL
          </button>
        )}
      </div>

      {discovered.length > 0 && (
        <ul className="space-y-1">
          {discovered.map((s) => (
            <li key={`${s.host}:${s.port}`}>
              <button
                type="button"
                onClick={() => handleSelectDiscovered(s)}
                className="w-full text-left px-3 py-2 text-sm rounded cursor-pointer"
                style={{ background: '--bg-surface', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
              >
                {s.name} — {s.host}:{s.port}
              </button>
            </li>
          ))}
        </ul>
      )}

      <div>
        <label className="block text-xs mb-1" style={{ fontFamily: "'Barlow Semi Condensed', sans-serif", color: 'var(--text-primary)' }}>
          Server URL
        </label>
        <div className="flex gap-2">
          <input
            type="text"
            value={manualInput}
            onChange={(e) => setManualInput(e.target.value)}
            className="flex-1 px-3 py-2 text-sm"
            style={inputStyle}
            placeholder="http://192.168.1.100:1985 or spotifu.local:1985"
          />
          <button
            type="button"
            onClick={() => void handleTestManual()}
            className="px-4 py-2 text-sm rounded cursor-pointer shrink-0"
            style={{ background: 'var(--bg-surface)', color: '#fff', border: 'none' }}
          >
            Save
          </button>
        </div>
      </div>

      {message && (
        <p className="text-xs" style={{ color: 'var(--text-primary)', fontFamily: "'Barlow Semi Condensed', sans-serif" }}>
          {message}
        </p>
      )}
    </div>
  )
}
