import { useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Play, ArrowLeft, X, FileSpreadsheet, Pencil, Trash2 } from 'lucide-react'
import * as controller from '../playback/controller'
import { authFetch } from '../api'
import { requestMbDownload } from '../stores/downloadBusyStore'
import {
  fetchPlaylistDetail,
  updatePlaylist,
  deletePlaylist,
  removeTrackFromPlaylist,
  type PlaylistItemDTO,
} from '../api/playlists'
import { toTrack, resolveTrackArtUrl } from '../utils/trackHelpers'
import PlaylistTrackCover from '../components/PlaylistTrackCover'
import { usePlayerStore } from '../stores/playerStore'
import { useDownloadStates } from '../hooks/useDownloadStates'
import { useArtistPrefetch } from '../hooks/useArtistPrefetch'
import ContextMenu from '../components/ContextMenu'
import UploadPlaylistModal from '../components/UploadPlaylistModal'
import AddToPlaylistModal, { type AddToPlaylistTrack } from '../components/AddToPlaylistModal'
import { PollyLoading } from '../components/PollyLoading'

function itemToPlayableTrack(
  item: PlaylistItemDTO,
  playlistCover: string | null,
  cachedMbIds: Set<string>,
) {
  const mbid = item.mb_recording_id
  const serverCached = Boolean(item.is_cached)
  const wsOverlay = Boolean(mbid && cachedMbIds.has(mbid))
  const isCached = serverCached || wsOverlay
  const art = resolveTrackArtUrl(item) ?? playlistCover
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
      duration: 0,
      is_cached: isCached,
      local_stream_url: streamOnlyWhenReady ? `/stream/${item.track_id}` : null,
    },
    { album_cover: art },
  )
}

const modalShell = {
  overlay: { background: 'rgba(0,0,0,0.75)' } as const,
  panel: {
    background: '#1A1210',
    border: '1px solid #3D2820',
  } as const,
}

export default function PlaylistPage() {
  const { playlistId } = useParams<{ playlistId: string }>()
  const id = Number(playlistId)
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { currentTrack } = usePlayerStore()
  const { downloadStates, cachedMbIds } = useDownloadStates()
  const { enqueue } = useArtistPrefetch()
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; item: PlaylistItemDTO } | null>(null)
  const [uploadOpen, setUploadOpen] = useState(false)
  const [renameOpen, setRenameOpen] = useState(false)
  const [renameTitle, setRenameTitle] = useState('')
  const [renameDescription, setRenameDescription] = useState('')
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [coverOpen, setCoverOpen] = useState(false)
  const [coverUrlInput, setCoverUrlInput] = useState('')
  const [addPlOpen, setAddPlOpen] = useState(false)
  const [addPlTrack, setAddPlTrack] = useState<AddToPlaylistTrack | null>(null)

  const { data: playlist, isLoading, error, refetch } = useQuery({
    queryKey: ['playlist', id],
    queryFn: () => fetchPlaylistDetail(id),
    enabled: Number.isFinite(id) && id > 0,
  })

  function persistResolvedCover(itemId: number, mbid: string, url: string) {
    // If the list already resolved an image URL (primary or fallback),
    // persist it onto the playlist item so the player can reuse it without extra fetches.
    queryClient.setQueryData(['playlist', id], (old: Awaited<ReturnType<typeof fetchPlaylistDetail>> | undefined) => {
      if (!old) return old
      const cur = old.items.find((it) => it.id === itemId)
      if (cur?.album_cover === url) return old
      return {
        ...old,
        items: old.items.map((it) => (it.id === itemId ? { ...it, album_cover: url } : it)),
      }
    })

    usePlayerStore.setState((s) => {
      const nextQueue = s.queue.map((t) =>
        t.mb_id === mbid && t.album_cover !== url ? { ...t, album_cover: url } : t,
      )
      const nextCurrent =
        s.currentTrack && s.currentTrack.mb_id === mbid && s.currentTrack.album_cover !== url
          ? { ...s.currentTrack, album_cover: url }
          : s.currentTrack
      return { queue: nextQueue, currentTrack: nextCurrent }
    })
  }

  const renameMutation = useMutation({
    mutationFn: () =>
      updatePlaylist(id, {
        title: renameTitle.trim(),
        description: renameDescription.trim() === '' ? null : renameDescription.trim(),
      }),
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey: ['playlist', id] })
      const previous = queryClient.getQueryData<Awaited<ReturnType<typeof fetchPlaylistDetail>>>(['playlist', id])
      const nextTitle = renameTitle.trim()
      const nextDesc = renameDescription.trim() === '' ? null : renameDescription.trim()
      queryClient.setQueryData(
        ['playlist', id],
        (old: Awaited<ReturnType<typeof fetchPlaylistDetail>> | undefined) =>
        old
          ? { ...old, title: nextTitle, description: nextDesc }
          : old,
      )
      return { previous }
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.previous) {
        queryClient.setQueryData(['playlist', id], ctx.previous)
      }
    },
    onSuccess: () => {
      setRenameOpen(false)
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['playlist', id] })
      queryClient.invalidateQueries({ queryKey: ['playlists'] })
      queryClient.invalidateQueries({ queryKey: ['home-playlists'] })
    },
  })

  const deleteMutation = useMutation({
    mutationFn: () => deletePlaylist(id),
    onSuccess: () => {
      queryClient.removeQueries({ queryKey: ['playlist', id] })
      queryClient.invalidateQueries({ queryKey: ['playlists'] })
      queryClient.invalidateQueries({ queryKey: ['home-playlists'] })
      navigate('/library')
    },
  })

  const removeItemMutation = useMutation({
    mutationFn: (itemId: number) => removeTrackFromPlaylist(id, itemId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['playlist', id] })
    },
  })

  const coverMutation = useMutation({
    mutationFn: (cover_image_url: string | null) => updatePlaylist(id, { cover_image_url }),
    onSuccess: () => {
      setCoverOpen(false)
      queryClient.invalidateQueries({ queryKey: ['playlist', id] })
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
    controller.play(itemToPlayableTrack(item, cover, cachedMbIds))
  }

  function playAll() {
    if (!playlist?.items?.length) return
    const cover = playlist.cover_image_url ?? null
    const tracks = playlist.items.map((it) => itemToPlayableTrack(it, cover, cachedMbIds))
    controller.setQueueAndPlay(tracks, 0)
  }

  function downloadItem(item: PlaylistItemDTO) {
    requestMbDownload(authFetch, item.mb_recording_id).catch(console.error)
  }

  if (!Number.isFinite(id) || id <= 0) {
    return (
      <div className="p-6" style={{ color: '#9A8E84', fontFamily: "'Barlow Semi Condensed', sans-serif" }}>
        Invalid playlist
      </div>
    )
  }

  if (isLoading) {
    return (
      <div className="p-6 flex flex-col items-center gap-3" style={{ color: '#4A413C', fontFamily: "'Space Mono', monospace" }}>
        <PollyLoading size={48} />
        <span className="text-sm">loading…</span>
      </div>
    )
  }

  if (error || !playlist) {
    return (
      <div className="p-6" style={{ color: '#b4003e', fontFamily: "'Barlow Semi Condensed', sans-serif" }}>
        Could not load playlist
      </div>
    )
  }

  const cover = playlist.cover_image_url

  return (
    <div key={playlistId} className="min-h-full relative" onClick={() => setContextMenu(null)}>
      {cover ? (
        <div
          className="absolute inset-x-0 top-0 h-64 md:h-80 pointer-events-none overflow-hidden"
          style={{ zIndex: 0 }}
        >
          <div
            className="absolute inset-0"
            style={{
              backgroundImage: `url(${cover})`,
              backgroundSize: 'cover',
              backgroundPosition: 'center',
              opacity: 0.18,
            }}
          />
          <div
            className="absolute inset-0"
            style={{
              background: 'linear-gradient(180deg, rgba(12,9,6,0.55) 0%, #0C0906 100%)',
            }}
          />
        </div>
      ) : null}
      <div
        className="relative z-[1] flex items-end gap-4 md:gap-6 p-6"
        style={{
          background: 'linear-gradient(180deg, #2E1E19 0%, #0C0906 100%)',
          borderBottom: '1px solid #261A14',
        }}
      >
        <button
          type="button"
          onClick={() => navigate(-1)}
          className="shrink-0 self-center p-2 rounded"
          style={{ color: '#9A8E84', border: '1px solid #3D2820' }}
          aria-label="Back"
        >
          <ArrowLeft size={20} />
        </button>
        <button
          type="button"
          onClick={openCoverEditor}
          className="w-44 h-44 md:w-52 md:h-52 shrink-0 rounded overflow-hidden flex items-center justify-center cursor-pointer transition-opacity hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#b4003e] focus-visible:ring-offset-2 focus-visible:ring-offset-[#0C0906]"
          style={{ background: '#231815', boxShadow: '0 12px 40px rgba(0,0,0,0.45)', border: 'none', padding: 0 }}
          aria-label="Change playlist cover"
          title="Change cover art"
        >
          {cover ? (
            <img src={cover} alt="" className="w-full h-full object-cover" loading="lazy" />
          ) : (
            <span style={{ fontSize: 48, color: '#3D2820' }}>▦</span>
          )}
        </button>
        <div className="min-w-0 flex-1 pb-1">
          <p
            className="text-xs uppercase mb-1"
            style={{
              fontFamily: "'Barlow Condensed', sans-serif",
              fontWeight: 700,
              letterSpacing: '0.15em',
              color: '#b4003e',
            }}
          >
            Playlist
          </p>
          <h1
            className="text-3xl md:text-4xl font-bold truncate mb-2"
            style={{ fontFamily: "'Barlow Condensed', sans-serif", color: '#E8DDD0' }}
          >
            {playlist.title}
          </h1>
          {playlist.description ? (
            <p className="text-sm mb-2 line-clamp-2" style={{ color: '#9A8E84', fontFamily: "'Barlow Semi Condensed', sans-serif" }}>
              {playlist.description}
            </p>
          ) : null}
          <p className="text-sm" style={{ color: '#4A413C', fontFamily: "'Space Mono', monospace" }}>
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
          style={{ background: '#b4003e', color: '#E8DDD0' }}
          aria-label="Play"
        >
          <Play size={22} fill="currentColor" className="ml-0.5" />
        </button>
        <button
          type="button"
          onClick={() => setUploadOpen(true)}
          className="w-11 h-11 rounded flex items-center justify-center transition-colors hover:border-[#b4003e]"
          style={{
            color: '#E8DDD0',
            border: '1px solid #3D2820',
            background: 'transparent',
          }}
          aria-label="Upload CSV"
          title="Upload CSV"
        >
          <FileSpreadsheet size={20} strokeWidth={1.75} />
        </button>
        <button
          type="button"
          onClick={openRename}
          className="w-11 h-11 rounded flex items-center justify-center transition-colors hover:border-[#b4003e]"
          style={{
            color: '#E8DDD0',
            border: '1px solid #3D2820',
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
          className="w-11 h-11 rounded flex items-center justify-center transition-colors hover:border-[#b4003e]"
          style={{
            color: '#b4003e',
            border: '1px solid #b4003e',
            background: 'transparent',
          }}
          aria-label="Delete playlist"
          title="Delete"
        >
          <Trash2 size={18} strokeWidth={1.75} />
        </button>
      </div>

      <div className="relative z-[1] px-6 pb-10 overflow-x-auto">
        <div className="min-w-[720px]">
          <div
            className="grid gap-4 px-1 py-2 text-xs uppercase tracking-widest"
            style={{
              gridTemplateColumns: '2rem 2.25rem minmax(0,1.2fr) minmax(0,1fr) minmax(0,1fr) 3rem',
              fontFamily: "'Barlow Condensed', sans-serif",
              fontWeight: 700,
              color: '#4A413C',
              borderBottom: '1px solid #261A14',
            }}
          >
            <span className="text-center">#</span>
            <span aria-hidden className="inline-block w-9" />
            <span>Title</span>
            <span>Artist</span>
            <span>Album</span>
            <span className="text-right"> </span>
          </div>
          {playlist.items.length === 0 ? (
            <p className="py-8 text-sm" style={{ color: '#4A413C', fontFamily: "'Barlow Semi Condensed', sans-serif" }}>
              No tracks yet. Upload a CSV to import from Spotify exports.
            </p>
          ) : (
            playlist.items.map((item, i) => {
              const mbid = item.mb_recording_id
              const isPlaying = currentTrack?.mb_id === mbid
              const isCached =
                Boolean(item.is_cached) || Boolean(mbid && cachedMbIds.has(mbid))
              const titleColor = isPlaying ? '#b4003e' : isCached ? '#E8DDD0' : '#4A413C'
              const downloadPercent = mbid ? downloadStates[mbid]?.percent : undefined
              const isDownloading = mbid ? downloadStates[mbid]?.status === 'downloading' : false
              return (
                <div
                  key={item.id}
                  className="grid gap-4 px-1 py-2 items-center rounded cursor-pointer group"
                  style={{
                    gridTemplateColumns: '2rem 2.25rem minmax(0,1.2fr) minmax(0,1fr) minmax(0,1fr) 3rem',
                    borderBottom: '1px solid #1A1210',
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = '#1A1210'
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = 'transparent'
                  }}
                  onClick={() => playItem(item)}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    setContextMenu({ x: e.clientX, y: e.clientY, item })
                  }}
                >
                  <div className="relative w-8 h-8 flex items-center justify-center shrink-0 justify-self-center">
                    <span
                      className="text-sm tabular-nums group-hover:hidden"
                      style={{ color: '#4A413C', fontFamily: "'Barlow Semi Condensed', monospace" }}
                    >
                      {isPlaying ? '▶' : i + 1}
                    </span>
                    <span
                      className="absolute inset-0 hidden group-hover:flex items-center justify-center"
                      style={{ color: '#b4003e' }}
                    >
                      <Play size={12} fill="currentColor" />
                    </span>
                  </div>
                  <div className="flex items-center justify-center shrink-0">
                    <PlaylistTrackCover
                      item={item}
                      onResolved={(url) => persistResolvedCover(item.id, item.mb_recording_id, url)}
                    />
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
                    style={{ fontFamily: "'Barlow Semi Condensed', monospace", color: '#9A8E84' }}
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
                    style={{ fontFamily: "'Barlow Semi Condensed', monospace", color: '#9A8E84' }}
                  >
                    {item.album || '—'}
                  </span>
                  <span
                    className="text-sm tabular-nums text-right shrink-0 flex items-center justify-end"
                    style={{ fontFamily: "'Barlow Semi Condensed', monospace", color: '#4A413C' }}
                  >
                    {isDownloading ? `${downloadPercent ?? 0}%` : isCached ? '✓' : '—'}
                  </span>
                </div>
              )
            })
          )}
        </div>
      </div>

      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          track={{
            title: contextMenu.item.title,
            artist: contextMenu.item.artist,
            mb_id: contextMenu.item.mb_recording_id,
            mb_artist_id: contextMenu.item.mb_artist_id,
            mb_release_id: contextMenu.item.mb_release_id,
            mb_release_group_id: contextMenu.item.mb_release_group_id,
            album: contextMenu.item.album,
            album_cover: contextMenu.item.album_cover,
          }}
          onPlay={() => {
            playItem(contextMenu.item)
            setContextMenu(null)
          }}
          onDownload={() => {
            downloadItem(contextMenu.item)
            setContextMenu(null)
          }}
          onAddToQueue={() => {
            controller.addToQueue(
              itemToPlayableTrack(contextMenu.item, playlist.cover_image_url ?? null, cachedMbIds),
            )
            setContextMenu(null)
          }}
          onGoToArtist={() => {
            const aid = contextMenu.item.mb_artist_id
            if (aid) navigate(`/artist/${aid}`)
            setContextMenu(null)
          }}
          onGoToAlbum={() => {
            const rg = contextMenu.item.mb_release_group_id ?? contextMenu.item.mb_release_id
            if (rg) navigate(`/album/${rg}`)
            setContextMenu(null)
          }}
          onAddToPlaylist={() => {
            const it = contextMenu.item
            setAddPlTrack({
              title: it.title,
              artist: it.artist,
              album: it.album,
              album_cover: it.album_cover,
              mb_id: it.mb_recording_id,
              mb_artist_id: it.mb_artist_id,
              mb_release_id: it.mb_release_id,
              mb_release_group_id: it.mb_release_group_id,
            })
            setContextMenu(null)
            setAddPlOpen(true)
          }}
          onRemoveFromPlaylist={() => {
            const itemId = contextMenu.item.id
            setContextMenu(null)
            removeItemMutation.mutate(itemId)
          }}
          onClose={() => setContextMenu(null)}
        />
      )}

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
              style={{ borderBottom: '1px solid #261A14' }}
            >
              <h2
                style={{
                  fontFamily: "'Barlow Condensed', sans-serif",
                  fontWeight: 700,
                  fontSize: 18,
                  textTransform: 'uppercase',
                  letterSpacing: '0.08em',
                  color: '#E8DDD0',
                }}
              >
                Playlist cover
              </h2>
              <button
                type="button"
                disabled={coverMutation.isPending}
                onClick={() => setCoverOpen(false)}
                className="p-1 rounded hover:bg-[#2E1E19]"
                style={{ color: '#9A8E84' }}
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
              <p className="text-xs" style={{ color: '#9A8E84', fontFamily: "'Barlow Semi Condensed', sans-serif" }}>
                Use a direct link to a JPEG or PNG. Leave empty and save to remove.
              </p>
              <input
                value={coverUrlInput}
                onChange={(e) => setCoverUrlInput(e.target.value)}
                disabled={coverMutation.isPending}
                className="w-full px-3 py-2 text-sm rounded"
                style={{
                  background: '#231815',
                  border: '1px solid #3D2820',
                  color: '#E8DDD0',
                  fontFamily: "'Barlow Semi Condensed', sans-serif",
                }}
                placeholder="https://…"
                autoFocus
              />
              {coverMutation.isError && (
                <p className="text-sm" style={{ color: '#b4003e' }}>
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
                      color: '#b4003e',
                      border: '1px solid #b4003e',
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
                    color: '#9A8E84',
                    border: '1px solid #3D2820',
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
                    background: '#b4003e',
                    color: '#E8DDD0',
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

      <AddToPlaylistModal
        open={addPlOpen}
        track={addPlTrack}
        excludePlaylistId={id}
        onClose={() => {
          setAddPlOpen(false)
          setAddPlTrack(null)
        }}
      />

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
              style={{ borderBottom: '1px solid #261A14' }}
            >
              <h2
                style={{
                  fontFamily: "'Barlow Condensed', sans-serif",
                  fontWeight: 700,
                  fontSize: 18,
                  textTransform: 'uppercase',
                  letterSpacing: '0.08em',
                  color: '#E8DDD0',
                }}
              >
                Rename playlist
              </h2>
              <button
                type="button"
                disabled={renameMutation.isPending}
                onClick={() => setRenameOpen(false)}
                className="p-1 rounded hover:bg-[#2E1E19]"
                style={{ color: '#9A8E84' }}
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
                  style={{ fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 600, color: '#b4003e' }}
                >
                  Name
                </label>
                <input
                  value={renameTitle}
                  onChange={(e) => setRenameTitle(e.target.value)}
                  disabled={renameMutation.isPending}
                  className="w-full px-3 py-2 text-sm rounded"
                  style={{
                    background: '#231815',
                    border: '1px solid #3D2820',
                    color: '#E8DDD0',
                    fontFamily: "'Barlow Semi Condensed', sans-serif",
                  }}
                  autoFocus
                />
              </div>
              <div>
                <label
                  className="block text-xs uppercase tracking-widest mb-1.5"
                  style={{ fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 600, color: '#b4003e' }}
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
                    background: '#231815',
                    border: '1px solid #3D2820',
                    color: '#E8DDD0',
                    fontFamily: "'Barlow Semi Condensed', sans-serif",
                  }}
                />
              </div>
              {renameMutation.isError && (
                <p className="text-sm" style={{ color: '#b4003e' }}>
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
                    color: '#9A8E84',
                    border: '1px solid #3D2820',
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
                    background: '#b4003e',
                    color: '#E8DDD0',
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
                color: '#E8DDD0',
              }}
            >
              Delete playlist?
            </h2>
            <p className="text-sm mb-6" style={{ color: '#9A8E84', fontFamily: "'Barlow Semi Condensed', sans-serif" }}>
              “{playlist.title}” and all of its tracks in this list will be removed. Cached downloads in your library are
              not deleted.
            </p>
            {deleteMutation.isError && (
              <p className="text-sm mb-4" style={{ color: '#b4003e' }}>
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
                  color: '#9A8E84',
                  border: '1px solid #3D2820',
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
                  background: '#b4003e',
                  color: '#E8DDD0',
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
