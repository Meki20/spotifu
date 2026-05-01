import { useState, useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useParams, useNavigate } from 'react-router-dom'
import { usePlayerStore } from '../stores/playerStore'
import { useAuthStore } from '../stores/authStore'
import { Play, ArrowLeft } from 'lucide-react'
import * as controller from '../playback/controller'
import { API, authFetch } from '../api'
import { requestMbDownload } from '../stores/downloadBusyStore'
import { useDownloadStates } from '../hooks/useDownloadStates'
import { useArtistPrefetch } from '../hooks/useArtistPrefetch'
import ContextMenu from '../components/ContextMenu'
import TrackRowFull from '../components/TrackRowFull'
import { toTrack } from '../utils/trackHelpers'
import { PollyLoading } from '../components/PollyLoading'
import { fetchReleaseGroupCover } from '../api/covers'

interface ContextMenuState {
  x: number
  y: number
  track: any
}

function albumTrackToControllerTrack(track: any, album: any, cover: string | null) {
  return toTrack(track, {
    album: album?.title ?? '',
    album_cover: cover ?? album?.cover ?? null,
    mb_release_id: album?.mbid || null,
    mb_release_group_id: album?.mb_release_group_id || null,
    mb_artist_id: track?.mb_artist_id || album?.artist_mb_id || null,
    artist_credit: track?.artist_credit ?? null,
  })
}

export default function AlbumPage() {
  const { albumId } = useParams<{ albumId: string }>()
  const navigate = useNavigate()
  const token = useAuthStore((s) => s.token)
  const { currentTrack } = usePlayerStore()
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)

  const { downloadStates, cachedMbIds } = useDownloadStates()

  const { enqueue } = useArtistPrefetch()

  const { data: album, isLoading, error } = useQuery({
    queryKey: ['album', albumId],
    queryFn: async () => {
      const res = await fetch(`${API}/album/${albumId}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      })
      if (!res.ok) throw new Error('Failed to load album')
      return res.json()
    },
    enabled: !!albumId,
    staleTime: 1000 * 60 * 10,
    gcTime: 1000 * 60 * 30,
  })

  const [cover, setCover] = useState<string | null>(null)

  useEffect(() => {
    if (album?.cover) {
      setCover(album.cover)
      return
    }
    if (!albumId) return

    let cancelled = false
    fetchReleaseGroupCover(albumId)
      .then((u) => {
        if (cancelled) return
        if (u) setCover(u)
      })
      .catch(() => {})

    return () => { cancelled = true }
  }, [album?.cover, albumId])

  function downloadTrack(track: any) {
    if (!track?.mb_id) return
    requestMbDownload(authFetch, track.mb_id).catch(console.error)
  }

  function handleContextMenu(e: React.MouseEvent, track: any) {
    e.preventDefault()
    setContextMenu({ x: e.clientX, y: e.clientY, track })
  }

  const displayCover = cover ?? album?.cover ?? null

  function playTrack(track: any) {
    if (!album) return
    const tracks = (album.tracks || []).map((t: any) => albumTrackToControllerTrack(t, album, displayCover))
    const idx = Math.max(0, (album.tracks || []).findIndex((t: any) => t?.mb_id && t.mb_id === track?.mb_id))
    controller.setSystemAndPlay(tracks, idx, { kind: 'album', id: String(albumId || ''), title: album?.title })
  }

  function playAlbumFromStart() {
    if (!album?.tracks?.length) return
    const tracks = album.tracks.map((t: any) => albumTrackToControllerTrack(t, album, displayCover))
    controller.setSystemAndPlay(tracks, 0, { kind: 'album', id: String(albumId || ''), title: album?.title })
  }

  if (isLoading) {
    return (
      <div className="p-6 flex flex-col items-center gap-3" style={{ color: '#4A413C', fontFamily: "'Barlow Semi Condensed', sans-serif" }}>
        <PollyLoading size={48} />
        <span className="text-sm">loading…</span>
      </div>
    )
  }
  if (error) {
    return (
      <div className="p-6" style={{ color: '#b4003e', fontFamily: "'Barlow Semi Condensed', sans-serif" }}>
        Error loading album
      </div>
    )
  }
  if (!album) return null

  const year = album.release_date ? album.release_date.split('-')[0] : ''
  const curMb = currentTrack?.mb_id
  const hasCur = Boolean(curMb)

  return (
    <div className="min-h-full" onClick={() => setContextMenu(null)}>
      <div
        className="flex items-end gap-4 md:gap-6 p-6"
        style={{
          background: 'linear-gradient(180deg, #2E1E19 0%, #0C0906 100%)',
          borderBottom: '1px solid #261A14',
        }}
      >
        <button
          type="button"
          onClick={() => navigate(-1)}
          className="shrink-0 self-center p-2 rounded mb-1"
          style={{ color: '#9A8E84', border: '1px solid #3D2820' }}
          aria-label="Back"
        >
          <ArrowLeft size={20} />
        </button>
        <div
          className="w-44 h-44 md:w-52 md:h-52 shrink-0 rounded overflow-hidden flex items-center justify-center"
          style={{ background: '#231815', boxShadow: '0 12px 40px rgba(0,0,0,0.45)' }}
        >
          {displayCover ? (
            <img
              src={displayCover}
              alt={album.title}
              className="w-full h-full object-cover"
              loading="lazy"
              onError={(e) => { e.currentTarget.style.display = 'none' }}
            />
          ) : (
            <span style={{ fontSize: 48, color: '#3D2820' }}>▦</span>
          )}
        </div>
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
            Album
          </p>
          <h1
            className="text-3xl md:text-4xl font-bold truncate mb-2"
            style={{ fontFamily: "'Barlow Condensed', sans-serif", color: '#E8DDD0' }}
          >
            {album.title}
          </h1>
          <p className="text-sm" style={{ color: '#9A8E84', fontFamily: "'Barlow Semi Condensed', sans-serif" }}>
            {album.artist && (
              <button
                type="button"
                onClick={() => {
                  const aid = album.artist_mb_id
                  if (aid) navigate(`/artist/${aid}`)
                }}
                onMouseEnter={() => {
                  if (album.artist_mb_id) enqueue(album.artist_mb_id)
                }}
                className="hover:underline"
                style={{ color: '#E8DDD0' }}
              >
                {album.artist}
              </button>
            )}
            {year && <span> · {year}</span>}
            {album.nb_tracks && <span> · {album.nb_tracks} songs</span>}
            {album.genres?.length > 0 && <span> · {album.genres.join(', ')}</span>}
          </p>
        </div>
      </div>

      <div className="px-6 py-4 flex items-center gap-4">
        <button
          type="button"
          onClick={playAlbumFromStart}
          disabled={!album.tracks?.length}
          className="w-12 h-12 rounded-full flex items-center justify-center transition-transform hover:scale-105 disabled:opacity-40"
          style={{ background: '#b4003e', color: '#E8DDD0' }}
          aria-label="Play album"
        >
          <Play size={22} fill="currentColor" className="ml-0.5 shrink-0" />
        </button>
      </div>

      <div className="px-6 pb-10">
        <div
          className="grid grid-cols-[auto_1fr_auto] gap-4 px-4 py-2 text-xs uppercase tracking-widest"
          style={{
            fontFamily: "'Barlow Condensed', sans-serif",
            fontWeight: 700,
            color: '#4A413C',
            borderBottom: '1px solid #261A14',
          }}
        >
          <span className="w-8 text-center">#</span>
          <span>Title</span>
          <span className="text-right">Duration</span>
        </div>
        {album.tracks?.map((track: any, i: number) => {
          const tid = track.mb_id
          const isCurrentlyPlaying = hasCur && Boolean(tid) && curMb === tid
          const mbid = tid || ''
          const isCached = Boolean(track.is_cached) || (mbid !== '' && cachedMbIds.has(mbid))
          return (
            <TrackRowFull
              key={track.mb_id || i}
              track={track}
              index={i}
              isPlaying={isCurrentlyPlaying}
              isCached={isCached}
              downloadState={mbid ? downloadStates[mbid] : undefined}
              showAlbum={false}
              showStatus={false}
              showDuration
              showCover={false}
              onPlay={() => playTrack(track)}
              onContextMenu={(e) => handleContextMenu(e, track)}
            />
          )
        })}
      </div>

      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          track={albumTrackToControllerTrack(contextMenu.track, album, displayCover)}
          onPlay={() => { playTrack(contextMenu.track); setContextMenu(null) }}
          onDownload={() => { downloadTrack(contextMenu.track); setContextMenu(null) }}
          onAddToQueue={() => { controller.addToQueue(albumTrackToControllerTrack(contextMenu.track, album, displayCover)); setContextMenu(null) }}
          onGoToArtist={() => {
            const aid = contextMenu.track?.mb_artist_id ?? album?.artist_mb_id
            if (aid) navigate(`/artist/${aid}`)
            setContextMenu(null)
          }}
          onGoToAlbum={() => {
            const albumIdNav = album?.mb_release_group_id || album?.mbid || albumId
            if (albumIdNav) navigate(`/album/${albumIdNav}`)
            setContextMenu(null)
          }}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  )
}
