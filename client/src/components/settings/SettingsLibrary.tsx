// Settings → Library tab: prefetch, auto playlists, downloaded tracks, cache.

import { useEffect, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { usePrefetchSettingsStore } from '../../stores/prefetchSettingsStore'
import { authFetch } from '../../api'
import { Toggle } from './Toggle'
import { SectionLabel, SectionHint } from './Section'
import { PollyLoading } from '../PollyLoading'
import ReconciliationModal from '../ReconciliationModal'
import DetectNewFilesModal from '../DetectNewFilesModal'

interface Track {
  id: number
  title: string
  artist: string
  artist_credit?: string | null
  album: string
  status: string
  local_file_path: string | null
  mb_id: string | null
}

interface AutoPlaylist {
  id: number
  name: string
  playlist_type: string
  is_enabled: boolean
  last_generated_at: string | null
  created_at: string
  track_count: number
  cover_url: string
}

export default function SettingsLibrary() {
  const prefetch = usePrefetchSettingsStore((s) => s.prefetch)
  const applyServerPrefetch = usePrefetchSettingsStore((s) => s.applyServerPrefetch)
  const [prefetchStatus, setPrefetchStatus] = useState('')
  const [tracks, setTracks] = useState<Track[]>([])
  const [tracksLoading, setTracksLoading] = useState(false)
  const [autoPlaylists, setAutoPlaylists] = useState<AutoPlaylist[]>([])
  const [autoPlaylistsLoading, setAutoPlaylistsLoading] = useState(false)
  const [autoPlaylistStatus, setAutoPlaylistStatus] = useState<Record<string, string>>({})
  const [cacheCleared, setCacheCleared] = useState<Record<string, string>>({})
  const [reconciliationOpen, setReconciliationOpen] = useState(false)
  const [detectNewFilesOpen, setDetectNewFilesOpen] = useState(false)
  const trackListRef = useRef<HTMLDivElement>(null)
  const trackVirtualizer = useVirtualizer({
    count: tracks.length,
    getScrollElement: () => trackListRef.current,
    estimateSize: () => 64,
    overscan: 10,
  })

  useEffect(() => {
    authFetch('/settings/preferences')
      .then(async (r) => {
        if (!r.ok) return
        const data: { prefetch?: Record<string, unknown> } = await r.json()
        applyServerPrefetch(data.prefetch)
      })
      .catch(console.error)

    setTracksLoading(true)
    authFetch('/settings/tracks')
      .then(async (r) => {
        if (!r.ok) return
        const data = await r.json()
        setTracks(Array.isArray(data?.tracks) ? data.tracks : [])
      })
      .catch(console.error)
      .finally(() => setTracksLoading(false))

    setAutoPlaylistsLoading(true)
    authFetch('/auto-playlists')
      .then(async (r) => {
        if (!r.ok) return
        const data = await r.json()
        setAutoPlaylists(Array.isArray(data) ? data : [])
      })
      .catch(console.error)
      .finally(() => setAutoPlaylistsLoading(false))
  }, [applyServerPrefetch])

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

  async function handleAutoPlaylistToggle(playlistType: string, enabled: boolean) {
    try {
      setAutoPlaylistStatus((s) => ({ ...s, [playlistType]: 'Saving...' }))
      const res = await authFetch(`/auto-playlists/${playlistType}/toggle`, {
        method: 'PATCH',
        body: JSON.stringify({ is_enabled: enabled }),
      })
      if (!res.ok) throw new Error('Failed to toggle')
      const updated = await res.json()
      setAutoPlaylists((prev) => prev.map((p) => (p.playlist_type === playlistType ? updated : p)))
      setAutoPlaylistStatus((s) => ({ ...s, [playlistType]: '' }))
    } catch (err) {
      setAutoPlaylistStatus((s) => ({ ...s, [playlistType]: 'Error: ' + String(err) }))
    }
  }

  async function handleAutoPlaylistRegenerate(playlistType: string) {
    try {
      setAutoPlaylistStatus((s) => ({ ...s, [playlistType]: 'Regenerating...' }))
      const res = await authFetch(`/auto-playlists/${playlistType}/generate`, { method: 'POST' })
      if (!res.ok) throw new Error('Failed to regenerate')
      const updated = await res.json()
      setAutoPlaylists((prev) => prev.map((p) => (p.playlist_type === playlistType ? updated : p)))
      setAutoPlaylistStatus((s) => ({ ...s, [playlistType]: '' }))
    } catch (err) {
      setAutoPlaylistStatus((s) => ({ ...s, [playlistType]: 'Error: ' + String(err) }))
    }
  }

  async function handleDeleteTrack(trackId: number) {
    try {
      const res = await authFetch(`/settings/tracks/${trackId}`, { method: 'DELETE' })
      if (!res.ok) throw new Error('Failed to delete')
      setTracks((prev) => prev.filter((t) => t.id !== trackId))
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

  const prefetchRows: { key: keyof typeof prefetch; label: string; hint: string }[] = [
    { key: 'enabled', label: 'Background prefetch', hint: 'Master switch for every category below.' },
    { key: 'hover_metadata', label: 'Artist & album list on hover', hint: 'Warms artist head and discography list when you hover tiles.' },
    { key: 'album_tracklists', label: 'Album tracklists in the background', hint: 'Fetches release tracks after hover or idle hints (MusicBrainz).' },
    { key: 'artist_idle', label: 'Artist page idle warm-up', hint: 'After opening an artist, loads a few more albums when the browser is idle.' },
    { key: 'hybrid_stale_refresh', label: 'Hybrid search stale refresh', hint: 'Refreshes cached hybrid "best match" results in the background.' },
  ]

  return (
    <div className="space-y-6">
      <section>
        <SectionLabel>Prefetching</SectionLabel>
        <SectionHint>
          Control background metadata requests. When the master switch is off, all categories are inactive.
        </SectionHint>
        <div className="space-y-2">
          {prefetchRows.map((row) => {
            const isMaster = row.key === 'enabled'
            const dimmed = !isMaster && !prefetch.enabled
            const on = prefetch[row.key]
            return (
              <div
                key={row.key}
                className="flex items-center justify-between gap-3 p-3 rounded"
                style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)', borderRadius: 4, opacity: dimmed ? 0.72 : 1 }}
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="text-xs" style={{ fontFamily: 'var(--font-body)', color: 'var(--text-primary)' }}>
                      {row.label}
                    </p>
                    {!isMaster && prefetch.enabled && !on && (
                      <span
                        className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded"
                        style={{ fontFamily: 'var(--font-display)', fontWeight: 700, letterSpacing: '0.08em', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}
                      >
                        off
                      </span>
                    )}
                  </div>
                  <p className="text-[11px] mt-1" style={{ fontFamily: 'var(--font-body)', color: 'var(--text-faint)' }}>
                    {row.hint}
                  </p>
                </div>
                <Toggle on={on} onChange={() => void patchPrefetchPrefs({ [row.key]: !on })} />
              </div>
            )
          })}
          {prefetchStatus && (
            <p className="text-xs px-1" style={{ color: prefetchStatus.startsWith('Error') ? 'var(--color-danger)' : 'var(--color-success-strong)', fontFamily: 'var(--font-body)' }}>
              {prefetchStatus}
            </p>
          )}
        </div>
      </section>

      <section>
        <SectionLabel>Personalised Playlists</SectionLabel>
        <SectionHint>
          Auto-generated playlists based on listening history. Generated weekly on Mondays at 00:01.
        </SectionHint>
        {autoPlaylistsLoading ? (
          <div className="flex items-center gap-2 py-2">
            <PollyLoading size={28} />
            <p className="text-xs" style={{ fontFamily: 'var(--font-body)', color: 'var(--text-faint)' }}>loading…</p>
          </div>
        ) : autoPlaylists.length === 0 ? (
          <p className="text-xs" style={{ fontFamily: 'var(--font-body)', color: 'var(--text-faint)' }}>No auto playlists available.</p>
        ) : (
          <div className="space-y-3">
            {autoPlaylists.map((playlist) => (
              <div
                key={playlist.id}
                className="flex items-center gap-4 p-3 rounded"
                style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)' }}
              >
                <img src={playlist.cover_url} alt={playlist.name} className="w-14 h-14 rounded" style={{ objectFit: 'cover' }} />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium" style={{ fontFamily: 'var(--font-body)', color: 'var(--text-primary)' }}>
                    {playlist.name}
                  </p>
                  <p className="text-xs" style={{ fontFamily: 'var(--font-body)', color: 'var(--text-faint)' }}>
                    {playlist.track_count} tracks
                    {playlist.last_generated_at && (
                      <> · Last generated: {new Date(playlist.last_generated_at).toLocaleDateString()}</>
                    )}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Toggle on={playlist.is_enabled} onChange={(enabled) => void handleAutoPlaylistToggle(playlist.playlist_type, enabled)} />
                  <button
                    onClick={() => void handleAutoPlaylistRegenerate(playlist.playlist_type)}
                    disabled={autoPlaylistStatus[playlist.playlist_type]?.includes('Generating')}
                    className="px-2 py-1 text-xs font-semibold border transition-colors"
                    style={{
                      fontFamily: 'var(--font-display)',
                      fontWeight: 600,
                      textTransform: 'uppercase',
                      letterSpacing: '0.05em',
                      background: 'transparent',
                      color: 'var(--accent)',
                      borderColor: 'var(--accent)',
                      borderRadius: 4,
                      cursor: autoPlaylistStatus[playlist.playlist_type]?.includes('Generating') ? 'not-allowed' : 'pointer',
                      opacity: autoPlaylistStatus[playlist.playlist_type]?.includes('Generating') ? 0.5 : 1,
                    }}
                  >
                    {autoPlaylistStatus[playlist.playlist_type]?.includes('Regenerate') ? 'Regenerating...' : 'Recreate'}
                  </button>
                </div>
              </div>
            ))}
            {Object.values(autoPlaylistStatus).some((s) => s && !s.startsWith('Error')) && (
              <p className="text-xs px-1" style={{ color: 'var(--color-success-strong)', fontFamily: 'var(--font-body)' }}>
                {Object.values(autoPlaylistStatus).find((s) => s && !s.startsWith('Error'))}
              </p>
            )}
          </div>
        )}
      </section>

      <section>
        <SectionLabel>Downloaded Tracks</SectionLabel>
        <div className="flex gap-2 mb-3">
          <button
            type="button"
            onClick={() => setReconciliationOpen(true)}
            className="px-3 py-1.5 text-xs font-semibold border transition-colors"
            style={{ fontFamily: 'var(--font-display)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', background: 'transparent', color: 'var(--accent)', borderColor: 'var(--accent)', borderRadius: 4, cursor: 'pointer' }}
          >
            Reconcile Tracks
          </button>
          <button
            type="button"
            onClick={() => setDetectNewFilesOpen(true)}
            className="px-3 py-1.5 text-xs font-semibold border transition-colors"
            style={{ fontFamily: 'var(--font-display)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', background: 'transparent', color: 'var(--accent)', borderColor: 'var(--accent)', borderRadius: 4, cursor: 'pointer' }}
          >
            Detect New Files
          </button>
        </div>
        {tracksLoading ? (
          <div className="flex items-center gap-2 py-2">
            <PollyLoading size={28} />
            <p className="text-xs" style={{ fontFamily: 'var(--font-body)', color: 'var(--text-faint)' }}>loading…</p>
          </div>
        ) : tracks.length === 0 ? (
          <p className="text-xs" style={{ fontFamily: 'var(--font-body)', color: 'var(--text-faint)' }}>No downloaded tracks yet.</p>
        ) : (
          <div ref={trackListRef} className="max-h-80 overflow-y-auto" style={{ position: 'relative' }}>
            <div className="relative w-full" style={{ height: trackVirtualizer.getTotalSize() }}>
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
                      background: 'var(--bg-surface)',
                      border: '1px solid var(--border)',
                      borderRadius: 4,
                    }}
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <div
                        className="w-6 h-6 rounded-full flex items-center justify-center shrink-0"
                        style={{ background: track.status === 'READY' || track.status === 'ERROR' ? 'var(--accent)' : 'var(--border)' }}
                      >
                        <span style={{ fontSize: 16, color: track.status === 'READY' || track.status === 'ERROR' ? 'var(--text-primary)' : 'var(--text-secondary)' }}>✓</span>
                      </div>
                      <div className="min-w-0">
                        <p className="text-xs truncate" style={{ fontFamily: 'var(--font-body)', color: 'var(--text-primary)' }}>{track.title}</p>
                        <p className="text-xs truncate" style={{ fontFamily: 'var(--font-body)', color: 'var(--text-secondary)' }}>{(track.artist_credit || track.artist)} — {track.album}</p>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => void handleDeleteTrack(track.id)}
                      className="p-1 rounded transition-colors shrink-0"
                      style={{ color: 'var(--text-faint)', background: 'transparent', border: 'none', cursor: 'pointer' }}
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

      <section>
        <SectionLabel>Cache</SectionLabel>
        <SectionHint>
          Clear cached metadata. Thumbnails include cover art from Cover Art Archive and artist images from fanart.tv.
        </SectionHint>
        <div className="space-y-2">
          {(['searches', 'discography', 'thumbnails'] as const).map((kind) => (
            <div key={kind} className="flex items-center justify-between p-3 rounded" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)', borderRadius: 4 }}>
              <div>
                <p className="text-xs" style={{ fontFamily: 'var(--font-body)', color: 'var(--text-primary)' }}>
                  Cached {kind.charAt(0).toUpperCase() + kind.slice(1)}
                </p>
                <p className="text-xs" style={{ fontFamily: 'var(--font-body)', color: 'var(--text-faint)', fontSize: 13 }}>
                  {kind === 'searches' ? 'Hybrid best-match + similar-tracks (per recording) cache' :
                   kind === 'discography' ? 'Artist data, album lists, and ordering' :
                   'Cover art from Cover Art Archive and fanart.tv artist images'}
                </p>
              </div>
              <div className="flex items-center gap-2">
                {cacheCleared[kind] && (
                  <span className="text-xs tabular-nums" style={{ fontFamily: 'var(--font-body)', color: cacheCleared[kind] === 'Cleared' ? 'var(--color-success-strong)' : 'var(--color-danger)' }}>
                    {cacheCleared[kind]}
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => void handleClearCache(kind)}
                  className="px-3 py-1 text-xs border transition-colors"
                  style={{ fontFamily: 'var(--font-display)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.1em', background: 'transparent', color: 'var(--text-secondary)', borderColor: 'var(--border)', borderRadius: 4, cursor: 'pointer' }}
                >
                  Clear
                </button>
              </div>
            </div>
          ))}
        </div>
      </section>

      <ReconciliationModal open={reconciliationOpen} onClose={() => setReconciliationOpen(false)} />
      <DetectNewFilesModal open={detectNewFilesOpen} onClose={() => setDetectNewFilesOpen(false)} />
    </div>
  )
}
