import { useShallow } from 'zustand/react/shallow'
import { usePlayerStore } from '../stores/playerStore'
import { seekAudio } from '../hooks/useAudioPlayer'
import * as controller from '../playback/controller'
import { useState, useRef, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Play, Pause, SkipBack, SkipForward, Volume2, VolumeX,
  MoreHorizontal, Shuffle, Repeat, Repeat1, Heart,
} from 'lucide-react'
import type { RepeatMode } from '../stores/playerStore'
import AddToPlaylistModal, { type AddToPlaylistTrack } from './AddToPlaylistModal'
import { displayArtist } from '../utils/trackHelpers'

interface ContextMenu {
  x: number
  y: number
  track: {
    title: string
    artist: string
    album_cover: string | null
    mb_id: string
    mb_release_id?: string | null
    mb_artist_id?: string | null
  }
}

function formatTime(secs: number) {
  if (!secs || isNaN(secs)) return '0:00'
  const m = Math.floor(secs / 60)
  const s = Math.floor(secs % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

export default function PlayerBar() {
  const navigate = useNavigate()
  const {
    currentTrack, isPlaying, volume, currentTime, duration,
    phase, isDownloadBuffering, shuffle, repeat,
    setIsPlaying,
  } = usePlayerStore(
    useShallow((s) => ({
      currentTrack: s.currentTrack,
      isPlaying: s.isPlaying,
      volume: s.volume,
      currentTime: s.currentTime,
      duration: s.duration,
      phase: s.phase,
      isDownloadBuffering: s.isDownloadBuffering,
      shuffle: s.shuffle,
      repeat: s.repeat,
      setIsPlaying: s.setIsPlaying,
    })),
  )
  const [contextMenu, setContextMenu] = useState<ContextMenu | null>(null)
  const [addPlOpen, setAddPlOpen] = useState(false)
  const [addPlTrack, setAddPlTrack] = useState<AddToPlaylistTrack | null>(null)
  const [liked, setLiked] = useState(false)
  const progressRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!contextMenu) return
    const handler = () => setContextMenu(null)
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [contextMenu])

  const progress = duration > 0 ? (currentTime / duration) * 100 : 0

  const isBuffering =
    phase === 'resolving' ||
    phase === 'waiting_for_bytes' ||
    (phase === 'streaming' && isDownloadBuffering)

  const seekBlocked = phase === 'idle' || phase === 'resolving' || phase === 'waiting_for_bytes'

  const handleProgressClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!progressRef.current || seekBlocked) return
    const rect = progressRef.current.getBoundingClientRect()
    const pct = (e.clientX - rect.left) / rect.width
    seekAudio(pct * duration)
  }

  const handleContextMenu = (e: React.MouseEvent, track: typeof currentTrack) => {
    e.preventDefault()
    setContextMenu({ x: e.clientX, y: e.clientY, track: track as any })
  }

  const handlePlayPause = () => {
    if (isPlaying) {
      controller.pause()
    } else {
      controller.resume()
    }
    setIsPlaying(!isPlaying)
  }

  const cycleRepeat = () => {
    const next: RepeatMode = repeat === 'off' ? 'all' : repeat === 'all' ? 'one' : 'off'
    controller.setRepeat(next)
  }

  if (!currentTrack) {
    return (
      <div
        className="h-20 flex items-center px-5 shrink-0 relative z-50"
        style={{
          background: 'rgba(26,18,16,0.92)',
          backdropFilter: 'blur(20px)',
          borderTop: '1px solid #3D2820',
        }}
      >
        <div className="text-sm" style={{ color: '#4A413C', fontFamily: "'Space Mono', monospace" }}>
          no track playing
        </div>
      </div>
    )
  }

  return (
    <>
      <div
        className="h-20 flex items-center px-5 gap-4 shrink-0 relative z-50"
        style={{
          background: 'rgba(26,18,16,0.92)',
          backdropFilter: 'blur(20px)',
          borderTop: '1px solid #3D2820',
        }}
      >
        {/* Left: now playing */}
        <div
          className="flex items-center gap-2.5 w-64 shrink-0"
          onContextMenu={(e) => handleContextMenu(e, currentTrack)}
        >
          {/* Album art / disc */}
          <div
            className="w-12 h-12 rounded flex items-center justify-center shrink-0 border"
            style={{
              background: 'linear-gradient(135deg, #5C1A10, #2A100A)',
              borderColor: '#3D2820',
              borderRadius: 6,
              overflow: 'hidden',
            }}
          >
            {currentTrack.album_cover ? (
              <img
                src={currentTrack.album_cover}
                alt={currentTrack.album || ''}
                className="w-full h-full object-cover"
                loading="lazy"
              />
            ) : (
              <div
                className="w-7 h-7 rounded-full"
                style={{
                  background: 'conic-gradient(from 0deg, #8B2A1A, #C4391F, #2A100A, #8B2A1A)',
                  boxShadow: '0 0 10px rgba(139, 42, 26, 0.6)',
                }}
              />
            )}
          </div>

          {/* Track info */}
          <div className="min-w-0 flex-1">
            <p
              className="text-sm truncate cursor-pointer hover:underline"
              style={{
                fontFamily: "'Barlow Semi Condensed', sans-serif",
                color: '#E8DDD0',
              }}
            >
              {currentTrack.title}
            </p>
            <p
              className="text-sm truncate cursor-pointer hover:underline mt-0.5"
              style={{
                fontFamily: "'Barlow Semi Condensed', sans-serif",
                color: '#9A8E84',
              }}
            >
              {displayArtist(currentTrack)}
            </p>
          </div>

          {/* Heart */}
          <button
            onClick={() => setLiked(!liked)}
            className="shrink-0"
            style={{ color: liked ? '#8B2A1A' : '#4A413C' }}
          >
            <Heart size={14} fill={liked ? '#8B2A1A' : 'none'} />
          </button>
        </div>

        {/* Center: controls + progress */}
        <div className="flex-1 flex flex-col items-center gap-1.5">
          {/* Control buttons */}
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => controller.setShuffle(!shuffle)}
              className="w-7 h-7 flex items-center justify-center transition-colors"
              style={{ color: shuffle ? '#8B2A1A' : '#9A8E84' }}
              title="Shuffle"
            >
              <Shuffle size={14} />
            </button>
            <button
              onClick={() => controller.skipPrev()}
              className="w-7 h-7 flex items-center justify-center transition-colors"
              style={{ color: '#9A8E84' }}
              title="Previous"
            >
              <SkipBack size={16} />
            </button>
            <button
              onClick={handlePlayPause}
              className="w-9 h-9 flex items-center justify-center transition-colors rounded"
              style={{
                background: '#8B2A1A',
                color: '#E8DDD0',
                boxShadow: '0 0 12px rgba(139, 42, 26, 0.4)',
              }}
              title={isPlaying ? 'Pause' : 'Play'}
            >
              {isPlaying ? <Pause size={14} /> : <Play size={14} />}
            </button>
            <button
              onClick={() => controller.skipNext()}
              className="w-7 h-7 flex items-center justify-center transition-colors"
              style={{ color: '#9A8E84' }}
              title="Next"
            >
              <SkipForward size={16} />
            </button>
            <button
              onClick={cycleRepeat}
              className="w-7 h-7 flex items-center justify-center transition-colors"
              style={{ color: repeat !== 'off' ? '#8B2A1A' : '#9A8E84' }}
              title={repeat === 'off' ? 'No repeat' : repeat === 'all' ? 'Repeat all' : 'Repeat one'}
            >
              {repeat === 'one' ? <Repeat1 size={14} /> : <Repeat size={14} />}
            </button>
          </div>

          {/* Progress bar */}
          <div className="flex items-center gap-2 w-full">
            <span
              className="text-sm w-10 text-right"
              style={{ fontFamily: "'Barlow Semi Condensed', sans-serif", color: '#4A413C' }}
            >
              {formatTime(currentTime)}
            </span>
            <div
              ref={progressRef}
              className="flex-1 h-0.5 relative cursor-pointer group"
              style={{ background: '#3D2820', borderRadius: 1 }}
              onClick={handleProgressClick}
            >
              {/* Fill */}
              <div
                className="absolute left-0 top-0 h-full rounded"
                style={{
                  width: `${progress}%`,
                  background: '#8B2A1A',
                  boxShadow: '0 0 6px rgba(139, 42, 26, 0.5)',
                }}
              />
              {/* Buffering */}
              {isBuffering && (
                <div className="absolute top-0 left-0 h-full overflow-hidden w-full">
                  <div
                    className="h-full"
                    style={{
                      animation: 'shimmerSlide 1.2s ease-in-out infinite',
                      background: '#9A8E84',
                      width: '33%',
                    }}
                  />
                </div>
              )}
              {/* Handle */}
              {!seekBlocked && (
                <div
                  className="absolute top-1/2 -translate-y-1/2 w-2 h-2 rounded-full opacity-0 group-hover:opacity-100 transition-opacity"
                  style={{
                    background: '#C4391F',
                    left: `calc(${progress}% - 4px)`,
                    boxShadow: '0 0 6px rgba(139, 42, 26, 0.7)',
                  }}
                />
              )}
            </div>
            <span
              className="text-sm w-10"
              style={{ fontFamily: "'Barlow Semi Condensed', sans-serif", color: '#4A413C', textAlign: 'right' }}
            >
              {formatTime(duration)}
            </span>
          </div>
        </div>

        {/* Right: volume + download badge */}
        <div className="flex items-center gap-2 w-52 shrink-0 justify-end">
          <button
            onClick={(e) => setContextMenu({ x: e.clientX, y: e.clientY, track: currentTrack as any })}
            className="px-1.5 transition-colors"
            style={{ color: '#4A413C' }}
          >
            <MoreHorizontal size={14} />
          </button>
          {volume > 0 ? (
            <Volume2 size={14} style={{ color: '#9A8E84' }} />
          ) : (
            <VolumeX size={14} style={{ color: '#9A8E84' }} />
          )}
          <input
            type="range"
            min="0"
            max="1"
            step="0.01"
            value={volume}
            onChange={(e) => controller.setVolume(Number(e.target.value))}
            className="w-16 h-0.5 appearance-none cursor-pointer rounded"
            style={{
              background: `linear-gradient(to right, #9A8E84 ${volume * 100}%, #3D2820 ${volume * 100}%)`,
              accentColor: '#9A8E84',
            }}
          />
                  </div>
      </div>

      {/* Context Menu */}
      {contextMenu && (
        <div
          className="fixed z-[60] min-w-48 py-1 text-sm"
          style={{
            left: contextMenu.x,
            top: contextMenu.y,
            background: '#1A1210',
            border: '1px solid #3D2820',
            borderRadius: 4,
          }}
          onMouseLeave={() => setContextMenu(null)}
        >
          <div className="px-4 py-2" style={{ borderBottom: '1px solid #261A14' }}>
            <p className="truncate" style={{ fontFamily: "'Barlow Semi Condensed', sans-serif", color: '#E8DDD0' }}>
              {contextMenu.track.title}
            </p>
            <p className="text-xs truncate" style={{ fontFamily: "'Barlow Semi Condensed', sans-serif", color: '#9A8E84' }}>
              {contextMenu.track.artist}
            </p>
          </div>
          <button
            className="w-full text-left px-4 py-2 hover:bg-[#2E1E19] transition-colors disabled:opacity-40"
            style={{ fontFamily: "'Barlow Semi Condensed', sans-serif", color: '#E8DDD0' }}
            disabled={!contextMenu.track.mb_id}
            onClick={() => {
              const t = contextMenu.track as any
              if (!t.mb_id) return
              setAddPlTrack({
                title: String(t.title ?? ''),
                artist: String(t.artist_credit ?? t.artist ?? ''),
                album: t.album != null ? String(t.album) : undefined,
                album_cover: t.album_cover ?? null,
                mb_id: t.mb_id,
                mb_artist_id: t.mb_artist_id ?? null,
                mb_release_id: t.mb_release_id ?? null,
                mb_release_group_id: t.mb_release_group_id ?? null,
              })
              setContextMenu(null)
              setAddPlOpen(true)
            }}
          >
            Add to playlist
          </button>
          <button
            className="w-full text-left px-4 py-2 hover:bg-[#2E1E19] transition-colors"
            style={{ fontFamily: "'Barlow Semi Condensed', sans-serif", color: '#E8DDD0' }}
            onClick={() => {
              const track = contextMenu.track as any
              const artistId = track.mb_artist_id
              if (artistId) navigate(`/artist/${artistId}`)
              setContextMenu(null)
            }}
          >
            Go to artist
          </button>
          <button
            className="w-full text-left px-4 py-2 hover:bg-[#2E1E19] transition-colors"
            style={{ fontFamily: "'Barlow Semi Condensed', sans-serif", color: '#E8DDD0' }}
            onClick={() => {
              const track = contextMenu.track as any
              const albumId = track.mb_release_group_id ?? track.mb_release_id ?? null
              if (albumId) navigate(`/album/${albumId}`)
              setContextMenu(null)
            }}
          >
            Go to album
          </button>
          <div className="mt-1 pt-1" style={{ borderTop: '1px solid #261A14' }}>
            <button
              className="w-full text-left px-4 py-2 hover:bg-[#2E1E19] transition-colors"
              style={{ fontFamily: "'Barlow Semi Condensed', sans-serif", color: '#C43030' }}
              onClick={() => {
                setContextMenu(null)
                usePlayerStore.setState({ currentTrack: null, isPlaying: false, phase: 'idle' })
              }}
            >
              Remove from playing
            </button>
          </div>
        </div>
      )}
      <AddToPlaylistModal
        open={addPlOpen}
        track={addPlTrack}
        onClose={() => {
          setAddPlOpen(false)
          setAddPlTrack(null)
        }}
      />
    </>
  )
}