import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { X } from 'lucide-react'
import { fetchPlaylistsList, addTrackToPlaylist, type PlaylistSummary } from '../api/playlists'

const modalShell = {
  overlay: { background: 'rgba(0,0,0,0.75)' } as const,
  panel: { background: '#1A1210', border: '1px solid #3D2820' } as const,
}

export type AddToPlaylistTrack = {
  title: string
  artist: string
  album?: string
  album_cover?: string | null
  mb_id: string
  mb_artist_id?: string | null
  mb_release_id?: string | null
  mb_release_group_id?: string | null
}

function normalizeTrack(t: AddToPlaylistTrack) {
  const album = t.album ?? ''
  if (!t.mb_id) throw new Error('This track is missing a MusicBrainz recording id (cannot add to playlist).')
  return {
    title: t.title,
    artist: t.artist,
    album,
    mb_recording_id: t.mb_id,
    mb_artist_id: t.mb_artist_id ?? null,
    mb_release_id: t.mb_release_id ?? null,
    mb_release_group_id: t.mb_release_group_id ?? null,
    album_cover: t.album_cover ?? null,
  }
}

export default function AddToPlaylistModal({
  open,
  onClose,
  track,
  onAdded,
  excludePlaylistId,
}: {
  open: boolean
  onClose: () => void
  track: AddToPlaylistTrack | null
  onAdded?: (playlist: PlaylistSummary) => void
  /** When set, that playlist is hidden (e.g. current playlist when copying elsewhere). */
  excludePlaylistId?: number
}) {
  const queryClient = useQueryClient()
  const { data: playlists, isLoading } = useQuery({
    queryKey: ['playlists'],
    queryFn: fetchPlaylistsList,
    enabled: open,
  })
  const [err, setErr] = useState('')
  const [q, setQ] = useState('')
  const [selected, setSelected] = useState<Set<number>>(() => new Set())
  const [saving, setSaving] = useState(false)

  const list = useMemo(() => {
    const base = playlists?.filter((pl) => (excludePlaylistId == null ? true : pl.id !== excludePlaylistId)) ?? []
    const needle = q.trim().toLowerCase()
    if (!needle) return base
    return base.filter((pl) => String(pl.title ?? '').toLowerCase().includes(needle))
  }, [playlists, excludePlaylistId, q])

  function toggle(pl: PlaylistSummary) {
    setErr('')
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(pl.id)) next.delete(pl.id)
      else next.add(pl.id)
      return next
    })
  }

  async function save() {
    if (!track) return
    if (selected.size === 0) return
    setErr('')
    setSaving(true)
    try {
      const body = normalizeTrack(track)
      const ids = Array.from(selected)
      const chosen = (playlists ?? []).filter((pl) => ids.includes(pl.id))

      const results = await Promise.allSettled(ids.map((id) => addTrackToPlaylist(id, body)))

      const failed: string[] = []
      results.forEach((r, idx) => {
        if (r.status === 'rejected') {
          const msg = r.reason instanceof Error ? r.reason.message : 'Add failed'
          const name = chosen[idx]?.title ?? `Playlist ${ids[idx]}`
          failed.push(`${name}: ${msg}`)
        }
      })

      await queryClient.invalidateQueries({ queryKey: ['playlists'] })
      await queryClient.invalidateQueries({ queryKey: ['home-playlists'] })
      await Promise.all(ids.map((id) => queryClient.invalidateQueries({ queryKey: ['playlist', id] })))

      chosen.forEach((pl) => onAdded?.(pl))

      if (failed.length > 0) {
        setErr(failed.slice(0, 3).join('\n') + (failed.length > 3 ? `\n…and ${failed.length - 3} more` : ''))
        return
      }

      onClose()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Add failed')
    } finally {
      setSaving(false)
    }
  }

  if (!open || !track) return null
  const selectedCount = selected.size

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-4"
      style={modalShell.overlay}
      onClick={() => onClose()}
    >
      <div
        className="w-full max-w-md rounded-lg overflow-hidden"
        style={modalShell.panel}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="flex items-center justify-between px-4 py-3"
          style={{ borderBottom: '1px solid #261A14' }}
        >
          <div className="min-w-0">
            <h2
              style={{
                fontFamily: "'Barlow Condensed', sans-serif",
                fontWeight: 700,
                fontSize: 16,
                textTransform: 'uppercase',
                letterSpacing: '0.08em',
                color: '#E8DDD0',
              }}
            >
              Add to playlist
            </h2>
            <p className="text-xs truncate mt-0.5" style={{ color: '#9A8E84', fontFamily: "'Barlow Semi Condensed', sans-serif" }}>
              {track.title} · {track.artist}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded hover:bg-[#2E1E19]"
            style={{ color: '#9A8E84' }}
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>
        <div className="px-4 pt-3 pb-2">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search playlists…"
            className="w-full px-3 py-2 rounded border text-sm outline-none"
            style={{
              fontFamily: "'Barlow Semi Condensed', sans-serif",
              color: '#E8DDD0',
              background: '#140E0C',
              borderColor: '#3D2820',
            }}
          />
          <div className="flex items-center justify-between mt-2">
            <span className="text-xs" style={{ color: '#9A8E84', fontFamily: "'Barlow Semi Condensed', sans-serif" }}>
              {selectedCount === 0 ? 'Select one or more playlists' : `${selectedCount} selected`}
            </span>
            <button
              type="button"
              className="text-xs underline-offset-2 hover:underline disabled:opacity-50"
              style={{ color: '#9A8E84', fontFamily: "'Barlow Semi Condensed', sans-serif" }}
              disabled={selectedCount === 0 || saving}
              onClick={() => setSelected(new Set())}
            >
              Clear
            </button>
          </div>
        </div>
        {err && (
          <p
            className="px-4 pb-2 text-xs whitespace-pre-line"
            style={{ color: '#C43030', fontFamily: "'Barlow Semi Condensed', sans-serif" }}
          >
            {err}
          </p>
        )}
        <ul className="max-h-72 overflow-y-auto py-1">
          {isLoading && (
            <li className="px-4 py-3 text-sm" style={{ color: '#4A413C', fontFamily: "'Space Mono', monospace" }}>Loading…</li>
          )}
          {!isLoading && (!playlists || playlists.length === 0) && (
            <li className="px-4 py-3 text-sm" style={{ color: '#4A413C', fontFamily: "'Barlow Semi Condensed', sans-serif" }}>No playlists. Create one in the library.</li>
          )}
          {!isLoading && playlists && playlists.length > 0 && list.length === 0 && (
            <li className="px-4 py-3 text-sm" style={{ color: '#4A413C', fontFamily: "'Barlow Semi Condensed', sans-serif" }}>
              {q.trim() ? 'No playlists match your search.' : 'No other playlists to add to.'}
            </li>
          )}
          {list.map((pl) => (
            <li key={pl.id}>
              <label
                className="flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-[#2E1E19] cursor-pointer"
                style={{ fontFamily: "'Barlow Semi Condensed', sans-serif", color: '#E8DDD0' }}
              >
                <input
                  type="checkbox"
                  checked={selected.has(pl.id)}
                  onChange={() => toggle(pl)}
                  disabled={saving}
                  className="accent-[#C4391F]"
                />
                <span className="truncate">{pl.title}</span>
              </label>
            </li>
          ))}
        </ul>
        <div
          className="flex items-center justify-end gap-2 px-4 py-3"
          style={{ borderTop: '1px solid #261A14' }}
        >
          <button
            type="button"
            className="px-3 py-2 rounded text-sm transition-colors hover:bg-[#2E1E19]"
            style={{ fontFamily: "'Barlow Semi Condensed', sans-serif", color: '#E8DDD0' }}
            onClick={onClose}
            disabled={saving}
          >
            Cancel
          </button>
          <button
            type="button"
            className="px-3 py-2 rounded text-sm transition-colors disabled:opacity-50"
            style={{
              fontFamily: "'Barlow Semi Condensed', sans-serif",
              color: '#140E0C',
              background: selectedCount === 0 ? '#4A413C' : '#C4391F',
            }}
            disabled={selectedCount === 0 || saving}
            onClick={save}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}
