import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { useAuthStore } from '../stores/authStore'
import { authFetch } from '../api'
import LibraryDiscStrip from '../components/LibraryDiscStrip'
import AlbumTrackPanel from '../components/AlbumTrackPanel'
import type { LibraryAlbum } from '../components/AlbumTrackPanel'
import UploadPlaylistModal from '../components/UploadPlaylistModal'
import { GripVertical, X } from 'lucide-react'
import { useContextMenuActions } from '../contexts/ContextMenuProvider'
import { PollyLoading } from '../components/PollyLoading'

interface Playlist {
  id: number
  title: string
  description?: string | null
  cover_image_url?: string | null
}

async function fetchPlaylists(): Promise<Playlist[]> {
  const res = await authFetch('/playlists')
  if (!res.ok) throw new Error('Failed to fetch playlists')
  return res.json()
}

async function createPlaylist(title: string): Promise<Playlist> {
  const res = await authFetch('/playlists', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  })
  if (!res.ok) throw new Error('Failed to create playlist')
  return res.json()
}

async function fetchLibraryAlbums() {
  const res = await authFetch('/playlists/albums')
  if (!res.ok) throw new Error('Failed to fetch library albums')
  return res.json()
}

async function saveAlbumOrder(albums: { album_key: string; position: number }[]) {
  const res = await authFetch('/playlists/albums/order', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(albums),
  })
  if (!res.ok) throw new Error('Failed to save order')
  return res.json()
}

function PlaylistCard({
  playlist,
  onContextMenu,
  onOpen,
}: {
  playlist: Playlist
  onContextMenu?: (e: React.MouseEvent, playlist: Playlist) => void
  onOpen?: (playlist: Playlist) => void
}) {
  return (
    <div
      className="p-4 rounded cursor-pointer border transition-all duration-150 relative overflow-hidden"
      style={{
        background: '#1A1210',
        borderColor: '#3D2820',
        borderRadius: 4,
      }}
      onClick={() => onOpen?.(playlist)}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = '#231815'
        e.currentTarget.style.borderColor = '#b4003e'
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = '#1A1210'
        e.currentTarget.style.borderColor = '#3D2820'
      }}
      onContextMenu={onContextMenu ? (e) => onContextMenu(e, playlist) : undefined}
    >
      {playlist.cover_image_url && (
        <div
          className="absolute inset-0 pointer-events-none"
          style={{
            backgroundImage: `url(${playlist.cover_image_url})`,
            backgroundSize: 'cover',
            backgroundPosition: 'center',
            opacity: 0.14,
          }}
        />
      )}
      <div
        className="relative z-10 w-full aspect-square rounded mb-3 flex items-center justify-center overflow-hidden"
        style={{ background: '#231815' }}
      >
        {playlist.cover_image_url ? (
          <img src={playlist.cover_image_url} alt="" className="w-full h-full object-cover" loading="lazy" />
        ) : (
          <span style={{ fontSize: 24, color: '#3D2820' }}>▦</span>
        )}
      </div>
      <p
        className="relative z-10 text-sm truncate"
        style={{ fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 600, color: '#E8DDD0' }}
      >
        {playlist.title}
      </p>
    </div>
  )
}

export default function Library() {
  const navigate = useNavigate()
  const token = useAuthStore((s) => s.token)
  const queryClient = useQueryClient()
  const [showCreate, setShowCreate] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const [selectedAlbum, setSelectedAlbum] = useState<LibraryAlbum | null>(null)
  const [uploadModalOpen, setUploadModalOpen] = useState(false)
  const { openContextMenu } = useContextMenuActions()

  const { data: playlists, isLoading: loadingPlaylists } = useQuery({
    queryKey: ['playlists'],
    queryFn: fetchPlaylists,
    enabled: !!token,
  })

  const { data: libraryAlbums } = useQuery({
    queryKey: ['library-albums'],
    queryFn: fetchLibraryAlbums,
    staleTime: 10 * 60 * 1000,
    enabled: !!token,
  })

  const createMutation = useMutation({
    mutationFn: (title: string) => createPlaylist(title),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['playlists'] })
      queryClient.invalidateQueries({ queryKey: ['home-playlists'] })
      setShowCreate(false)
      setNewTitle('')
    },
  })

  const [showReorder, setShowReorder] = useState(false)
  const [reorderAlbums, setReorderAlbums] = useState<LibraryAlbum[]>([])
  const [draggedIdx, setDraggedIdx] = useState<number | null>(null)

  const saveOrderMutation = useMutation({
    mutationFn: (albums: { album_key: string; position: number }[]) => saveAlbumOrder(albums),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['library-albums'] })
      setShowReorder(false)
    },
  })

  function openReorderModal() {
    if (libraryAlbums) {
      setReorderAlbums([...libraryAlbums])
    }
    setShowReorder(true)
  }

  function handleDragStart(idx: number) {
    setDraggedIdx(idx)
  }

  function handleDragOver(e: React.DragEvent, idx: number) {
    e.preventDefault()
    if (draggedIdx === null || draggedIdx === idx) return
    const items = [...reorderAlbums]
    const [dragged] = items.splice(draggedIdx, 1)
    items.splice(idx, 0, dragged)
    setDraggedIdx(idx)
    setReorderAlbums(items)
  }

  function handleDragEnd() {
    setDraggedIdx(null)
  }

  function saveOrder() {
    const order = reorderAlbums.map((a, i) => ({
      album_key: a.album_key || `${a.artist}|${a.title}`,
      position: i,
    }))
    saveOrderMutation.mutate(order)
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    if (!newTitle.trim()) return
    createMutation.mutate(newTitle)
  }

  function handlePlaylistContextMenu(e: React.MouseEvent, playlist: Playlist) {
    e.preventDefault()
    e.stopPropagation()
    openContextMenu(e.clientX, e.clientY, {
      title: playlist.title,
      artist: 'Playlist',
      playlistId: playlist.id,
    })
  }

  return (
    <div className="p-6 flex-1 overflow-y-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1
            className="text-3xl font-bold uppercase"
            style={{
              fontFamily: "'Barlow Condensed', sans-serif",
              fontWeight: 800,
              textTransform: 'uppercase',
              letterSpacing: '0.04em',
              color: '#E8DDD0',
              lineHeight: 1,
            }}
          >
            Your Library
          </h1>
        </div>
              </div>

      {/* Albums — 3D disc strip */}
      <div className="mb-8">
        <div
          className="flex items-center gap-2.5 mb-4"
          style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 16, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.12em', color: '#b4003e' }}
        >
          Albums
          <div className="flex-1 h-px" style={{ background: '#261A14' }} />
          {libraryAlbums && libraryAlbums.length > 1 && (
            <button
              onClick={openReorderModal}
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
              Reorder
            </button>
          )}
        </div>
        {!libraryAlbums ? (
          <div className="flex items-center gap-2 text-sm" style={{ color: '#4A413C', fontFamily: "'Barlow Semi Condensed', sans-serif" }}>
            <PollyLoading size={28} />
            <span>loading…</span>
          </div>
        ) : libraryAlbums.length === 0 ? (
          <div className="text-sm" style={{ color: '#4A413C', fontFamily: "'Barlow Semi Condensed', sans-serif" }}>no cached albums yet</div>
        ) : (
          <LibraryDiscStrip
            albums={libraryAlbums}
            onDiscClick={(album: any) => setSelectedAlbum(album as LibraryAlbum)}
          />
        )}
      </div>

      {/* Playlists section */}
      <div className="mb-6">
        <div className="flex items-center justify-between mb-4">
          <div
            className="flex items-center gap-2.5"
            style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 16, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.12em', color: '#b4003e' }}
          >
            Playlists
            <div className="h-px flex-1" style={{ background: '#261A14' }} />
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setUploadModalOpen(true)}
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
              Upload CSV
            </button>
            <button
              type="button"
              onClick={() => setShowCreate(!showCreate)}
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
              + Create
            </button>
          </div>
        </div>

        {showCreate && (
          <form onSubmit={handleCreate} className="flex gap-2 mb-4">
            <input
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              placeholder="playlist name"
              className="flex-1 px-3 py-2 text-sm"
              style={{
                background: '#1A1210',
                border: '1px solid #3D2820',
                borderRadius: 4,
                fontFamily: "'Barlow Semi Condensed', sans-serif",
                color: '#E8DDD0',
                outline: 'none',
              }}
            />
            <button
              type="submit"
              className="px-4 py-2 text-sm font-bold transition-colors"
              style={{
                background: '#b4003e',
                color: '#E8DDD0',
                border: 'none',
                cursor: 'pointer',
                fontFamily: "'Barlow Condensed', sans-serif",
                fontWeight: 700,
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
              }}
            >
              Create
            </button>
          </form>
        )}

        {loadingPlaylists && (
          <div className="flex items-center gap-2 text-sm mb-2" style={{ color: '#4A413C', fontFamily: "'Barlow Semi Condensed', sans-serif" }}>
            <PollyLoading size={28} />
            <span>loading…</span>
          </div>
        )}
        {!loadingPlaylists && playlists?.length === 0 && (
          <div className="text-sm" style={{ color: '#4A413C', fontFamily: "'Barlow Semi Condensed', sans-serif" }}>no playlists yet</div>
        )}
        <div className="grid grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
          {playlists?.map((pl) => (
            <PlaylistCard
              key={pl.id}
              playlist={pl}
              onContextMenu={handlePlaylistContextMenu}
              onOpen={(p) => navigate(`/playlist/${p.id}`)}
            />
          ))}
        </div>
      </div>

      <UploadPlaylistModal
        key={uploadModalOpen ? 'library-csv-open' : 'library-csv'}
        open={uploadModalOpen}
        onClose={() => setUploadModalOpen(false)}
        playlists={playlists ?? []}
        onImported={() => {
          queryClient.invalidateQueries({ queryKey: ['playlists'] })
          queryClient.invalidateQueries({ queryKey: ['home-playlists'] })
        }}
      />

      <AlbumTrackPanel album={selectedAlbum} onClose={() => setSelectedAlbum(null)} />

      {/* Reorder Modal */}
      {showReorder && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center"
          style={{ background: 'rgba(0,0,0,0.8)' }}
          onClick={() => setShowReorder(false)}
        >
          <div
            className="w-full max-w-lg max-h-[80vh] flex flex-col rounded p-6"
            style={{ background: '#1A1210', border: '1px solid #3D2820' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-6">
              <h2
                style={{
                  fontFamily: "'Barlow Condensed', sans-serif",
                  fontWeight: 700,
                  fontSize: 20,
                  textTransform: 'uppercase',
                  letterSpacing: '0.1em',
                  color: '#E8DDD0',
                }}
              >
                Reorder Albums
              </h2>
              <button onClick={() => setShowReorder(false)} style={{ color: '#9A8E84' }}>
                <X size={18} />
              </button>
            </div>

            <p className="text-sm mb-4" style={{ color: '#9A8E84', fontFamily: "'Barlow Semi Condensed', sans-serif" }}>
              Drag albums to reorder how they appear in the disc strip.
            </p>

            <div className="flex-1 overflow-y-auto space-y-2 mb-6">
              {reorderAlbums.map((album, idx) => (
                <div
                  key={album.album_key || `${album.artist}|${album.title}`}
                  draggable
                  onDragStart={() => handleDragStart(idx)}
                  onDragOver={(e) => handleDragOver(e, idx)}
                  onDragEnd={handleDragEnd}
                  className="flex items-center gap-3 p-3 rounded cursor-grab active:cursor-grabbing"
                  style={{
                    background: '#231815',
                    border: '1px solid #3D2820',
                    opacity: draggedIdx === idx ? 0.5 : 1,
                  }}
                >
                  <GripVertical size={14} style={{ color: '#4A413C', flexShrink: 0 }} />
                  {album.cover ? (
                    <img
                      src={album.cover}
                      alt={album.title}
                      className="w-10 h-10 rounded object-cover shrink-0"
                      loading="lazy"
                    />
                  ) : (
                    <div
                      className="w-10 h-10 rounded shrink-0"
                      style={{ background: '#3D2820' }}
                    />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="text-sm truncate" style={{ fontFamily: "'Barlow Semi Condensed', sans-serif", color: '#E8DDD0' }}>
                      {album.title}
                    </p>
                    <p className="text-xs truncate" style={{ fontFamily: "'Barlow Semi Condensed', sans-serif", color: '#9A8E84' }}>
                      {album.artist}
                    </p>
                  </div>
                  <span className="text-xs shrink-0" style={{ color: '#4A413C', fontFamily: "'Barlow Semi Condensed', sans-serif" }}>
                    {idx + 1}
                  </span>
                </div>
              ))}
            </div>

            <div className="flex gap-3 justify-end">
              <button
                onClick={() => setShowReorder(false)}
                className="px-4 py-2 text-sm"
                style={{
                  fontFamily: "'Barlow Condensed', sans-serif",
                  fontWeight: 600,
                  textTransform: 'uppercase',
                  letterSpacing: '0.1em',
                  color: '#9A8E84',
                  background: 'transparent',
                  border: '1px solid #3D2820',
                  cursor: 'pointer',
                }}
              >
                Cancel
              </button>
              <button
                onClick={saveOrder}
                disabled={saveOrderMutation.isPending}
                className="px-4 py-2 text-sm font-bold"
                style={{
                  fontFamily: "'Barlow Condensed', sans-serif",
                  fontWeight: 700,
                  textTransform: 'uppercase',
                  letterSpacing: '0.1em',
                  color: '#E8DDD0',
                  background: '#b4003e',
                  border: 'none',
                  cursor: 'pointer',
                  opacity: saveOrderMutation.isPending ? 0.6 : 1,
                }}
              >
                {saveOrderMutation.isPending ? 'Saving...' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}