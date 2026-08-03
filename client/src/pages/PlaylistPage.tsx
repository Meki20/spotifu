import { useEffect, useState, useMemo } from 'react'
import { useParams, useNavigate, useLocation } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Play, ArrowLeft, X, FileSpreadsheet, Pencil, Trash2 } from 'lucide-react'
import * as controller from '../playback/controller'
import {
  fetchPlaylistDetail,
  fetchAutoPlaylistDetail,
  updatePlaylist,
  deletePlaylist,
  removeTrackFromPlaylist,
  type PlaylistItemDTO,
} from '../api/playlists'
import { coverManager } from '../lib/coverManager'
import { toTrack, resolveTrackArtUrl, formatDuration } from '../utils/trackHelpers'
import PlaylistTrackCover from '../components/PlaylistTrackCover'
import { usePlayerStore } from '../stores/playerStore'
import { useDownloadStates } from '../hooks/useDownloadStates'
import { useArtistPrefetch } from '../hooks/useArtistPrefetch'
import { useContextMenuActions } from '../contexts/ContextMenuProvider'
import UploadPlaylistModal from '../components/UploadPlaylistModal'
import { PollyLoading } from '../components/PollyLoading'

function itemToPlayableTrack(
  item: PlaylistItemDTO,
  _playlistCover: string | null,
  cachedMbIds: Set<string>,
) {
  const mbid = item.mb_recording_id
  const serverCached = Boolean(item.is_cached)
  const wsOverlay = Boolean(mbid && cachedMbIds.has(mbid))
  const isCached = serverCached || wsOverlay
  // Important: do NOT fall back to playlist cover here.
  // If we do, that "infects" the player/system list with the playlist image and can
  // mask real per-track cached covers (especially for not-yet-downloaded tracks).
  const art = resolveTrackArtUrl(item) ?? coverManager.peek(mbid).url ?? null
  const streamOnlyWhenReady = isCached && item.track_id
  return toTrack(
    {
      mb_id: mbid,
      track_id: item.track_id ?? undefined,
      title: item.title,
      artist: item.artist,
      album: item.album,
      album_cover: art,
      mb_artist_id: item.mb_artist_id,
      mb_release_id: item.mb_release_id,
      mb_release_group_id: item.mb_release_group_id,
      duration: item.duration ?? 0,
      is_cached: isCached,
      local_stream_url: streamOnlyWhenReady ? `/stream/${item.track_id}` : null,
    },
    { album_cover: art },
  )
}

const modalShell = {
  overlay: { background: 'rgba(0,0,0,0.75)' } as const,
  panel: {
    background: 'var(--bg-surface)',
    border: '1px solid var(--border)',
  } as const,
}

export default function PlaylistPage() {
  const { playlistId } = useParams<{ playlistId: string }>()
  const navigate = useNavigate()
  const location = useLocation()
  const isAutoPlaylist = location.pathname.startsWith('/auto-playlist')
  const id = Number(playlistId)

  if (isNaN(id)) {
    return (
      <div className="flex items-center justify-center h-full" style={{ color: 'var(--text-primary)' }}>
        Invalid playlist
      </div>
    )
  }

  const queryClient = useQueryClient()
  const { currentTrack } = usePlayerStore()
  const { downloadStates, cachedMbIds } = useDownloadStates()
  const { enqueue } = useArtistPrefetch()
  const { openContextMenu } = useContextMenuActions()
  const [uploadOpen, setUploadOpen] = useState(false)
  const [renameOpen, setRenameOpen] = useState(false)
  const [renameTitle, setRenameTitle] = useState('')
  const [renameDescription, setRenameDescription] = useState('')
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [coverOpen, setCoverOpen] = useState(false)
  const [coverUrlInput, setCoverUrlInput] = useState('')

  const queryKey = isAutoPlaylist ? ['auto-playlist', id] : ['playlist', id]
  const { data: playlist, isLoading, error, refetch } = useQuery({
    queryKey,
    queryFn: () => isAutoPlaylist ? fetchAutoPlaylistDetail(id) : fetchPlaylistDetail(id),
    enabled: Number.isFinite(id) && id > 0,
  })

  useEffect(() => {
    const items = playlist?.items
    if (!items?.length) return
    const mbids = items
      .map((item) => (item.mb_recording_id || '').trim())
      .filter(Boolean)
    if (mbids.length) coverManager.prime(mbids, 'playlist')
  }, [playlist?.items])

  const renameMutation = useMutation({
    mutationFn: () =>
      updatePlaylist(id, {
        title: renameTitle.trim(),
        description: renameDescription.trim() === '' ? null : renameDescription.trim(),
      }),
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey })
      const previous = queryClient.getQueryData(queryKey)
      const nextTitle = renameTitle.trim()
      const nextDesc = renameDescription.trim() === '' ? null : renameDescription.trim()
      queryClient.setQueryData(
        queryKey,
        (old: Awaited<ReturnType<typeof fetchPlaylistDetail>> | undefined) =>
        old
          ? { ...old, title: nextTitle, description: nextDesc }
          : old,
      )
      return { previous }
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.previous) {
        queryClient.setQueryData(queryKey, ctx.previous)
      }
    },
    onSuccess: () => {
      setRenameOpen(false)
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey })
      queryClient.invalidateQueries({ queryKey: ['playlists'] })
      queryClient.invalidateQueries({ queryKey: ['home-playlists'] })
    },
  })

  const deleteMutation = useMutation({
    mutationFn: () => deletePlaylist(id),
    onSuccess: () => {
      queryClient.removeQueries({ queryKey })
      queryClient.invalidateQueries({ queryKey: ['playlists'] })
      queryClient.invalidateQueries({ queryKey: ['home-playlists'] })
      navigate('/library')
    },
  })

  const removeItemMutation = useMutation({
    mutationFn: (itemId: number) => removeTrackFromPlaylist(id, itemId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKey })
    },
  })

  const coverMutation = useMutation({
    mutationFn: (cover_image_url: string | null) => updatePlaylist(id, { cover_image_url }),
    onSuccess: () => {
      setCoverOpen(false)
      queryClient.invalidateQueries({ queryKey })
      queryClient.invalidateQueries({ queryKey: ['playlists'] })
      queryClient.invalidateQueries({ queryKey: ['home-playlists'] })
    },
  })

  function openRename() {
    if (!playlist) return
    setRenameTitle(playlist.title)
    setRenameDescription(playlist.description ?? '')
    setRenameOpen(true)
  }

  function openCoverEditor() {
    if (!playlist) return
    setCoverUrlInput(playlist.cover_image_url?.trim() ?? '')
    setCoverOpen(true)
  }

  function playItem(item: PlaylistItemDTO) {
    if (!playlist) return
    const cover = playlist.cover_image_url ?? null
    const tracks = playlist.items.map((it) => itemToPlayableTrack(it, cover, cachedMbIds))
    const idx = Math.max(0, playlist.items.findIndex((it) => it.id === item.id))
    controller.setSystemAndPlay(tracks, idx, { kind: 'playlist', id, title: playlist?.title })
  }

  function playAll() {
    if (!playlist?.items?.length) return
    const cover = playlist.cover_image_url ?? null
    const tracks = playlist.items.map((it) => itemToPlayableTrack(it, cover, cachedMbIds))
    controller.setSystemAndPlay(tracks, 0, { kind: 'playlist', id, title: playlist?.title })
  }

  function handleContextMenu(e: React.MouseEvent, item: PlaylistItemDTO) {
    e.preventDefault()
    const normalized = itemToPlayableTrack(item, playlist?.cover_image_url ?? null, cachedMbIds)
    openContextMenu(e.clientX, e.clientY, normalized, {
      onPlay: () => playItem(item),
      onRemoveFromPlaylist: isAutoPlaylist ? undefined : () => removeItemMutation.mutate(item.id),
    })
  }

  if (isLoading) {
    return (
      <div className="p-6 flex flex-col items-center gap-3" style={{ color: 'var(--text-primary)', fontFamily: "'Barlow Semi Condensed', sans-serif" }}>
        <PollyLoading size={48} />
        <span className="text-sm">loading…</span>
      </div>
    )
  }

  if (error || !playlist) {
    return (
      <div className="p-6" style={{ color: 'var(--text-primary)', fontFamily: "'Barlow Semi Condensed', sans-serif" }}>
        Could not load playlist
      </div>
    )
  }

  const cover = playlist.cover_image_url

  return (
    <div key={playlistId} className="min-h-full relative">
      <div
        className="relative z-[1] flex items-end gap-4 md:gap-6 p-6"
        style={{
          background: 'transparent',
          borderBottom: '1px solid var(--border-subtle)',
        }}
      >
        <button
          type="button"
          onClick={() => navigate(-1)}
          className="shrink-0 self-center p-2 rounded"
          style={{ color: 'var(--text-primary)', border: '1px solid var(--border)' }}
          aria-label="Back"
        >
          <ArrowLeft size={20} />
        </button>
        {!isAutoPlaylist ? (
          <button
            type="button"
            onClick={openCoverEditor}
            className="w-44 h-44 md:w-52 md:h-52 shrink-0 rounded overflow-hidden flex items-center justify-center cursor-pointer transition-opacity hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg-base)]"
            style={{ background: 'var(--bg-surface)', boxShadow: '0 12px 40px rgba(0,0,0,0.45)', border: 'none', padding: 0 }}
            aria-label="Change playlist cover"
            title="Change cover art"
          >
            {cover ? (
              <img src={cover} alt="" className="w-full h-full object-cover" loading="lazy" />
            ) : (
              <span style={{ fontSize: 48, color: 'var(--text-primary)' }}>▦</span>
            )}
          </button>
        ) : (
          <div
            className="w-44 h-44 md:w-52 md:h-52 shrink-0 rounded overflow-hidden flex items-center justify-center"
            style={{ background: 'var(--bg-surface)', boxShadow: '0 12px 40px rgba(0,0,0,0.45)', border: 'none', padding: 0 }}
            aria-label="Playlist cover"
          >
            {cover ? (
              <img src={cover} alt="" className="w-full h-full object-cover" loading="lazy" />
            ) : (
              <span style={{ fontSize: 48, color: 'var(--text-primary)' }}>▦</span>
            )}
          </div>
        )}
        <div className="min-w-0 flex-1 pb-1">
          <p
            className="text-xs uppercase mb-1"
            style={{
              fontFamily: "'Barlow Condensed', sans-serif",
              fontWeight: 700,
              letterSpacing: '0.15em',
              color: 'var(--text-primary)',
            }}
          >
            Playlist
          </p>
          <h1
            className="text-3xl md:text-4xl font-bold truncate mb-2"
            style={{ fontFamily: "'Barlow Condensed', sans-serif", color: 'var(--text-primary)' }}
          >
            {playlist.title}
          </h1>
          {playlist.description ? (
            <p className="text-sm mb-2 line-clamp-2" style={{ color: 'var(--text-primary)', fontFamily: "'Barlow Semi Condensed', sans-serif" }}>
              {playlist.description}
            </p>
          ) : null}
          <p className="text-sm" style={{ color: 'var(--text-primary)', fontFamily: "'Barlow Semi Condensed', sans-serif" }}>
            {playlist.items.length} tracks
          </p>
        </div>
      </div>

      <div className="relative z-[1] px-6 py-4 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={playAll}
          disabled={!playlist.items.length}
          className="w-12 h-12 rounded-full flex items-center justify-center transition-transform hover:scale-105 disabled:opacity-40"
          style={{ background: 'var(--bg-surface)', color: 'var(--text-primary)' }}
          aria-label="Play"
        >
          <Play size={22} fill="currentColor" className="ml-0.5" />
        </button>
        {!isAutoPlaylist && (
          <button
            type="button"
            onClick={() => setUploadOpen(true)}
            className="w-11 h-11 rounded flex items-center justify-center transition-colors hover:border-[var(--accent)]"
            style={{
              color: 'var(--text-primary)',
              border: '1px solid var(--border)',
              background: 'transparent',
            }}
            aria-label="Upload CSV"
            title="Upload CSV"
          >
            <FileSpreadsheet size={20} strokeWidth={1.75} />
          </button>
        )}
        {!isAutoPlaylist && (
          <>
            <button
              type="button"
              onClick={openRename}
              className="w-11 h-11 rounded flex items-center justify-center transition-colors hover:border-[var(--accent)]"
              style={{
                color: 'var(--text-primary)',
                border: '1px solid var(--border)',
                background: 'transparent',
              }}
              aria-label="Rename playlist"
              title="Rename"
            >
              <Pencil size={18} strokeWidth={1.75} />
            </button>
            <button
              type="button"
              onClick={() => setDeleteOpen(true)}
              className="w-11 h-11 rounded flex items-center justify-center transition-colors hover:border-[var(--accent)]"
              style={{
                color: 'var(--text-primary)',
                border: '1px solid var(--accent)',
                background: 'transparent',
              }}
              aria-label="Delete playlist"
              title="Delete"
            >
              <Trash2 size={18} strokeWidth={1.75} />
            </button>
          </>
        )}
      </div>

      <div className="relative z-[1] px-6 pb-10 overflow-x-auto">
        <div className="min-w-[720px]">
          <div
            className="grid gap-4 px-1 py-2 text-xs uppercase tracking-widest"
            style={{
              gridTemplateColumns: '2rem 2.25rem minmax(0,1.2fr) minmax(0,1fr) minmax(0,1fr) 3rem',
              fontFamily: "'Barlow Condensed', sans-serif",
              fontWeight: 700,
              color: 'var(--text-primary)',
              borderBottom: '1px solid var(--border-subtle)',
            }}
          >
            <span className="text-center">#</span>
            <span aria-hidden className="inline-block w-9" />
            <span>Title</span>
            <span>Artist</span>
            <span>Album</span>
            <span className="text-right">Duration</span>
          </div>
          {playlist.items.length === 0 ? (
            <p className="py-8 text-sm" style={{ color: 'var(--text-primary)', fontFamily: "'Barlow Semi Condensed', sans-serif" }}>
              No tracks yet. Upload a CSV to import from Spotify exports.
            </p>
          ) : (
            playlist.items.map((item, i) => {
              const mbid = item.mb_recording_id
              const isPlaying = currentTrack?.mb_id === mbid
              const isCached =
                Boolean(item.is_cached) || Boolean(mbid && cachedMbIds.has(mbid))
              const titleColor = isPlaying ? 'var(--text-primary)' : isCached ? 'var(--text-primary)' : 'var(--text-primary)'
              const downloadPercent = mbid ? downloadStates[mbid]?.percent : undefined
              const isDownloading = mbid ? downloadStates[mbid]?.status === 'downloading' : false
              return (
                <div
                  key={item.id}
                  className="grid gap-4 px-1 py-2 items-center rounded cursor-pointer group"
                  style={{
                    gridTemplateColumns: '2rem 2.25rem minmax(0,1.2fr) minmax(0,1fr) minmax(0,1fr) 3rem',
                    borderBottom: '1px solid var(--bg-surface)',
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = 'var(--bg-surface-2)'
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = 'transparent'
                  }}
                  onClick={() => playItem(item)}
                  onContextMenu={(e) => handleContextMenu(e, item)}
                >
                  <div className="relative w-8 h-8 flex items-center justify-center shrink-0 justify-self-center">
                    <span
                      className="text-sm tabular-nums group-hover:hidden"
                      style={{ color: 'var(--text-primary)', fontFamily: "'Barlow Semi Condensed', monospace" }}
                    >
                      {isPlaying ? '▶' : i + 1}
                    </span>
                    <span
                      className="absolute inset-0 hidden group-hover:flex items-center justify-center"
                      style={{ color: 'var(--text-primary)' }}
                    >
                      <Play size={12} fill="currentColor" />
                    </span>
                  </div>
                  <div className="flex items-center justify-center shrink-0">
                    <PlaylistTrackCover item={item} priority="playlist" />
                  </div>
                  <div className="min-w-0">
                    <p
                      className="text-sm truncate"
                      style={{
                        fontFamily: "'Barlow Semi Condensed', monospace",
                        color: titleColor,
                        fontWeight: isPlaying ? 600 : 400,
                      }}
                    >
                      {item.title}
                    </p>
                  </div>
                  <span
                    className="text-sm truncate min-w-0"
                    style={{ fontFamily: "'Barlow Semi Condensed', monospace", color: 'var(--text-primary)' }}
                    onMouseEnter={() => {
                      if (item.mb_artist_id) {
                        enqueue(
                          item.mb_artist_id,
                          item.mb_release_id ? [item.mb_release_id] : undefined,
                        )
                      }
                    }}
                  >
                    {item.artist}
                  </span>
                  <span
                    className="text-sm truncate min-w-0"
                    style={{ fontFamily: "'Barlow Semi Condensed', monospace", color: 'var(--text-primary)' }}
                  >
                    {item.album || '—'}
                  </span>
                  <span
                    className="text-sm tabular-nums text-right shrink-0 flex items-center justify-end"
                    style={{ fontFamily: "'Barlow Semi Condensed', monospace", color: 'var(--text-primary)' }}
                  >
                    {isDownloading ? `${downloadPercent ?? 0}%` : (item.duration ? formatDuration(item.duration) : '—')}
                  </span>
                </div>
              )
            })
          )}
        </div>
      </div>

      {coverOpen && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center p-4"
          style={modalShell.overlay}
          onClick={() => !coverMutation.isPending && setCoverOpen(false)}
        >
          <div
            className="w-full max-w-md rounded-lg overflow-hidden"
            style={modalShell.panel}
            onClick={(e) => e.stopPropagation()}
          >
            <div
              className="flex items-center justify-between px-5 py-4"
              style={{ borderBottom: '1px solid var(--border-subtle)' }}
            >
              <h2
                style={{
                  fontFamily: "'Barlow Condensed', sans-serif",
                  fontWeight: 700,
                  fontSize: 18,
                  textTransform: 'uppercase',
                  letterSpacing: '0.08em',
                  color: 'var(--text-primary)',
                }}
              >
                Playlist cover
              </h2>
              <button
                type="button"
                disabled={coverMutation.isPending}
                onClick={() => setCoverOpen(false)}
                className="p-1 rounded hover:bg-[var(--bg-surface-3)]"
                style={{ color: 'var(--text-primary)' }}
                aria-label="Close"
              >
                <X size={20} />
              </button>
            </div>
            <form
              className="px-5 py-4 space-y-4"
              onSubmit={(e) => {
                e.preventDefault()
                const t = coverUrlInput.trim()
                coverMutation.mutate(t === '' ? null : t)
              }}
            >
              <p className="text-xs" style={{ color: 'var(--text-primary)', fontFamily: "'Barlow Semi Condensed', sans-serif" }}>
                Use a direct link to a JPEG or PNG. Leave empty and save to remove.
              </p>
              <input
                value={coverUrlInput}
                onChange={(e) => setCoverUrlInput(e.target.value)}
                disabled={coverMutation.isPending}
                className="w-full px-3 py-2 text-sm rounded"
                style={{
                  background: 'var(--bg-surface)',
                  border: '1px solid var(--border)',
                  color: 'var(--text-primary)',
                  fontFamily: "'Barlow Semi Condensed', sans-serif",
                }}
                placeholder="https://…"
                autoFocus
              />
              {coverMutation.isError && (
                <p className="text-sm" style={{ color: 'var(--text-primary)' }}>
                  {coverMutation.error instanceof Error ? coverMutation.error.message : 'Save failed'}
                </p>
              )}
              <div className="flex flex-wrap justify-end gap-2">
                {playlist.cover_image_url ? (
                  <button
                    type="button"
                    disabled={coverMutation.isPending}
                    onClick={() => coverMutation.mutate(null)}
                    className="px-4 py-2 text-sm"
                    style={{
                      fontFamily: "'Barlow Condensed', sans-serif",
                      fontWeight: 600,
                      color: 'var(--text-primary)',
                      border: '1px solid var(--accent)',
                      background: 'transparent',
                    }}
                  >
                    Remove image
                  </button>
                ) : null}
                <button
                  type="button"
                  disabled={coverMutation.isPending}
                  onClick={() => setCoverOpen(false)}
                  className="px-4 py-2 text-sm"
                  style={{
                    fontFamily: "'Barlow Condensed', sans-serif",
                    fontWeight: 600,
                    color: 'var(--text-primary)',
                    border: '1px solid var(--border)',
                    background: 'transparent',
                  }}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={coverMutation.isPending}
                  className="px-4 py-2 text-sm"
                  style={{
                    fontFamily: "'Barlow Condensed', sans-serif",
                    fontWeight: 700,
                    textTransform: 'uppercase',
                    letterSpacing: '0.06em',
                    background: 'var(--bg-surface)',
                    color: 'var(--text-primary)',
                    border: 'none',
                  }}
                >
                  {coverMutation.isPending ? 'Saving…' : 'Save'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      <UploadPlaylistModal
        key={uploadOpen ? `csv-${playlist.id}` : 'csv-closed'}
        open={uploadOpen}
        onClose={() => setUploadOpen(false)}
        playlists={[{ id: playlist.id, title: playlist.title, description: playlist.description, cover_image_url: playlist.cover_image_url }]}
        defaultPlaylistId={playlist.id}
        onImported={() => {
          refetch()
        }}
      />

      {renameOpen && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center p-4"
          style={modalShell.overlay}
          onClick={() => !renameMutation.isPending && setRenameOpen(false)}
        >
          <div
            className="w-full max-w-md rounded-lg overflow-hidden"
            style={modalShell.panel}
            onClick={(e) => e.stopPropagation()}
          >
            <div
              className="flex items-center justify-between px-5 py-4"
              style={{ borderBottom: '1px solid var(--border-subtle)' }}
            >
              <h2
                style={{
                  fontFamily: "'Barlow Condensed', sans-serif",
                  fontWeight: 700,
                  fontSize: 18,
                  textTransform: 'uppercase',
                  letterSpacing: '0.08em',
                  color: 'var(--text-primary)',
                }}
              >
                Rename playlist
              </h2>
              <button
                type="button"
                disabled={renameMutation.isPending}
                onClick={() => setRenameOpen(false)}
                className="p-1 rounded hover:bg-[var(--bg-surface-3)]"
                style={{ color: 'var(--text-primary)' }}
                aria-label="Close"
              >
                <X size={20} />
              </button>
            </div>
            <form
              className="px-5 py-4 space-y-4"
              onSubmit={(e) => {
                e.preventDefault()
                if (!renameTitle.trim()) return
                renameMutation.mutate()
              }}
            >
              <div>
                <label
                  className="block text-xs uppercase tracking-widest mb-1.5"
                  style={{ fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 600, color: 'var(--text-primary)' }}
                >
                  Name
                </label>
                <input
                  value={renameTitle}
                  onChange={(e) => setRenameTitle(e.target.value)}
                  disabled={renameMutation.isPending}
                  className="w-full px-3 py-2 text-sm rounded"
                  style={{
                    background: 'var(--bg-surface)',
                    border: '1px solid var(--border)',
                    color: 'var(--text-primary)',
                    fontFamily: "'Barlow Semi Condensed', sans-serif",
                  }}
                  autoFocus
                />
              </div>
              <div>
                <label
                  className="block text-xs uppercase tracking-widest mb-1.5"
                  style={{ fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 600, color: 'var(--text-primary)' }}
                >
                  Description (optional)
                </label>
                <textarea
                  value={renameDescription}
                  onChange={(e) => setRenameDescription(e.target.value)}
                  disabled={renameMutation.isPending}
                  rows={3}
                  className="w-full px-3 py-2 text-sm rounded resize-y min-h-[4rem]"
                  style={{
                    background: 'var(--bg-surface)',
                    border: '1px solid var(--border)',
                    color: 'var(--text-primary)',
                    fontFamily: "'Barlow Semi Condensed', sans-serif",
                  }}
                />
              </div>
              {renameMutation.isError && (
                <p className="text-sm" style={{ color: 'var(--text-primary)' }}>
                  {renameMutation.error instanceof Error ? renameMutation.error.message : 'Save failed'}
                </p>
              )}
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  disabled={renameMutation.isPending}
                  onClick={() => setRenameOpen(false)}
                  className="px-4 py-2 text-sm"
                  style={{
                    fontFamily: "'Barlow Condensed', sans-serif",
                    fontWeight: 600,
                    color: 'var(--text-primary)',
                    border: '1px solid var(--border)',
                    background: 'transparent',
                  }}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={renameMutation.isPending || !renameTitle.trim()}
                  className="px-4 py-2 text-sm"
                  style={{
                    fontFamily: "'Barlow Condensed', sans-serif",
                    fontWeight: 700,
                    textTransform: 'uppercase',
                    letterSpacing: '0.06em',
                    background: 'var(--bg-surface)',
                    color: 'var(--text-primary)',
                    border: 'none',
                  }}
                >
                  {renameMutation.isPending ? 'Saving…' : 'Save'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {deleteOpen && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center p-4"
          style={modalShell.overlay}
          onClick={() => !deleteMutation.isPending && setDeleteOpen(false)}
        >
          <div
            className="w-full max-w-md rounded-lg overflow-hidden p-6"
            style={modalShell.panel}
            onClick={(e) => e.stopPropagation()}
          >
            <h2
              className="mb-2"
              style={{
                fontFamily: "'Barlow Condensed', sans-serif",
                fontWeight: 700,
                fontSize: 18,
                textTransform: 'uppercase',
                letterSpacing: '0.08em',
                color: 'var(--text-primary)',
              }}
            >
              Delete playlist?
            </h2>
            <p className="text-sm mb-6" style={{ color: 'var(--text-primary)', fontFamily: "'Barlow Semi Condensed', sans-serif" }}>
              “{playlist.title}” and all of its tracks in this list will be removed. Cached downloads in your library are
              not deleted.
            </p>
            {deleteMutation.isError && (
              <p className="text-sm mb-4" style={{ color: 'var(--text-primary)' }}>
                {deleteMutation.error instanceof Error ? deleteMutation.error.message : 'Delete failed'}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                disabled={deleteMutation.isPending}
                onClick={() => setDeleteOpen(false)}
                className="px-4 py-2 text-sm"
                style={{
                  fontFamily: "'Barlow Condensed', sans-serif",
                  fontWeight: 600,
                  color: 'var(--text-primary)',
                  border: '1px solid var(--border)',
                  background: 'transparent',
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={deleteMutation.isPending}
                onClick={() => deleteMutation.mutate()}
                className="px-4 py-2 text-sm"
                style={{
                  fontFamily: "'Barlow Condensed', sans-serif",
                  fontWeight: 700,
                  textTransform: 'uppercase',
                  letterSpacing: '0.06em',
                  background: 'var(--bg-surface)',
                  color: 'var(--text-primary)',
                  border: 'none',
                }}
              >
                {deleteMutation.isPending ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
