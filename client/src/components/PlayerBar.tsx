import { useShallow } from 'zustand/react/shallow'
import { usePlayerStore, type PlayerState } from '../stores/playerStore'
import { seekAudio } from '../hooks/useAudioPlayer'
import * as controller from '../playback/controller'
import { useState, useRef, useEffect, useLayoutEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Play, Pause, SkipBack, SkipForward, Volume2, VolumeX,
  MoreHorizontal, Shuffle, Repeat, Repeat1, Heart, Computer,
  ListMusic,
} from 'lucide-react'
import type { RepeatMode } from '../stores/playerStore'
import AddToPlaylistModal, { type AddToPlaylistTrack } from './AddToPlaylistModal'
import { displayArtist } from '../utils/trackHelpers'
import { useDownloadStates } from '../hooks/useDownloadStates'
import { PollyLoading } from './PollyLoading'
import { useCover } from '../hooks/useCover'

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
    currentTrack, isPlaying, volume,
    phase, isDownloadBuffering, shuffle, repeat,
    setIsPlaying,
  } = usePlayerStore(
    useShallow((s: PlayerState) => ({
      currentTrack: s.currentTrack,
      isPlaying: s.isPlaying,
      volume: s.volume,
      phase: s.phase,
      isDownloadBuffering: s.isDownloadBuffering,
      shuffle: s.shuffle,
      repeat: s.repeat,
      setIsPlaying: s.setIsPlaying,
    })),
  )
  const [contextMenu, setContextMenu] = useState<ContextMenu | null>(null)
  const [contextMenuPos, setContextMenuPos] = useState<{ left: number; top: number } | null>(null)
  const contextMenuRef = useRef<HTMLDivElement>(null)
  const [addPlOpen, setAddPlOpen] = useState(false)
  const [addPlTrack, setAddPlTrack] = useState<AddToPlaylistTrack | null>(null)
  const [liked, setLiked] = useState(false)
  const { downloadStates } = useDownloadStates()
  const trackMbId = currentTrack?.mb_id
  const { url: lazyCover } = useCover(trackMbId, 'viewport')
  const playerCover = currentTrack?.album_cover || lazyCover

  useEffect(() => {
    if (!contextMenu) {
      setContextMenuPos(null)
      return
    }
    const handler = () => setContextMenu(null)
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [contextMenu])

  useLayoutEffect(() => {
    if (!contextMenu || !contextMenuRef.current) {
      setContextMenuPos(null)
      return
    }
    const el = contextMenuRef.current
    const rect = el.getBoundingClientRect()
    const margin = 8
    const vw = window.innerWidth
    const vh = window.innerHeight

    let left = contextMenu.x
    let top = contextMenu.y

    if (top + rect.height > vh - margin) top = contextMenu.y - rect.height
    if (left + rect.width > vw - margin) left = vw - rect.width - margin
    if (left < margin) left = margin
    if (top + rect.height > vh - margin) top = vh - rect.height - margin
    if (top < margin) top = margin

    setContextMenuPos({ left, top })
  }, [contextMenu])

  const isBuffering =
    phase === 'resolving' ||
    phase === 'waiting_for_bytes' ||
    (phase === 'streaming' && isDownloadBuffering)

  const seekBlocked = phase === 'idle' || phase === 'resolving' || phase === 'waiting_for_bytes'

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

  const handleToggleQueue = () => {
    window.dispatchEvent(new CustomEvent('spotifu:toggle-queue'))
  }

  const cycleRepeat = () => {
    const next: RepeatMode = repeat === 'off' ? 'all' : repeat === 'all' ? 'one' : 'off'
    controller.setRepeat(next)
  }

  if (!currentTrack) {
    return (
      <div
        className="fx-glass h-20 flex items-center px-5 shrink-0 relative z-50"
        style={{
          background: 'color-mix(in srgb, var(--bg-surface) 0.92, transparent)',
          borderTop: '1px solid var(--border)',
        }}
      >
        <div className="text-sm" style={{ color: 'var(--text-primary)', fontFamily: "'Barlow Semi Condensed', sans-serif" }}>
          no track playing
        </div>
      </div>
    )
  }

  const mbId = currentTrack.mb_id
  const isDownloadingCurrent =
    Boolean(mbId && downloadStates[mbId]?.status === 'downloading')
  const showMascotInsteadOfHeart = isBuffering || isDownloadingCurrent

  return (
    <>
      <div
        className="fx-glass h-20 flex flex-col shrink-0 relative z-50"
        style={{
          background: 'color-mix(in srgb, var(--bg-surface) 0.92, transparent)',
          borderTop: '1px solid var(--border)',
        }}
      >
        {/* Main row */}
        <div className="flex-1 flex items-center px-5 gap-4 min-h-0">
        {/* Left: now playing */}
        <div
          className="flex items-center gap-2.5 w-64 shrink-0"
          onContextMenu={(e) => handleContextMenu(e, currentTrack)}
        >
          {/* Album art / disc */}
          <div
            className="w-11 h-11 flex items-center justify-center shrink-0"
            style={{
              background: 'var(--bg-surface)',
              border: '1px solid var(--border)',
              borderRadius: 2,
              overflow: 'hidden',
            }}
          >
            {playerCover ? (
              <div className="relative w-full h-full overflow-hidden">
                <img
                  src={playerCover}
                  alt={currentTrack.album || ''}
                  className="w-full h-full object-cover"
                  loading="lazy"
                />
                {!currentTrack.mb_id && !currentTrack.mb_artist_id && !currentTrack.mb_release_id && !currentTrack.mb_release_group_id && (
                  <div
                    className="absolute top-0 right-0 p-0.5"
                    style={{ background: 'rgba(0,0,0,0.6)' }}
                  >
                    <Computer size={10} className="text-[var(--text-secondary)]" />
                  </div>
                )}
              </div>
            ) : (
              <div
                className="w-7 h-7 rounded-full"
                style={{
                  background: 'conic-gradient(from 0deg, var(--accent), var(--accent), var(--accent-faint), var(--accent))',
                  boxShadow: '0 0 10px color-mix(in srgb, var(--accent) 0.5, transparent)',
                }}
              />
            )}
          </div>

          {/* Track info */}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <p
                className="text-sm truncate cursor-pointer hover:underline"
                style={{
                  fontFamily: "'Barlow Semi Condensed', sans-serif",
                  textTransform: 'uppercase',
                  letterSpacing: '0.04em',
                  color: 'var(--text-primary)',
                }}
              >
                {currentTrack.title}
              </p>
              {currentTrack.quality ? (
                <span
                  className="shrink-0 inline-flex items-center px-1.5 py-0.5 text-xs font-medium rounded"
                  style={{
                    color: 'var(--text-primary)',
                    backgroundColor: 'var(--bg-surface)',
                    border: '1px solid var(--accent)',
                    fontFamily: "'Barlow Semi Condensed', sans-serif",
                  }}
                >
                  {currentTrack.quality}
                </span>
              ) : currentTrack.is_cached ? (
                <span
                  className="shrink-0 inline-flex items-center px-1.5 py-0.5 text-xs font-medium rounded animate-pulse"
                  style={{
                    color: 'var(--text-primary)',
                    backgroundColor: 'var(--bg-surface)',
                    border: '1px solid var(--accent)',
                    fontFamily: "'Barlow Semi Condensed', sans-serif",
                  }}
                >
                  ...
                </span>
              ) : null}
            </div>
            <p
              className="text-xs truncate cursor-pointer hover:underline mt-0.5"
              style={{
                fontFamily: "'Barlow Semi Condensed', sans-serif",
                color: 'var(--text-secondary)',
              }}
            >
              {displayArtist(currentTrack)}
            </p>
          </div>

          {/* Heart (Polly while buffering / downloading until playback is ready) */}
          <button
            type="button"
            onClick={() => !showMascotInsteadOfHeart && setLiked(!liked)}
            className="shrink-0 w-7 h-7 flex items-center justify-center"
            disabled={showMascotInsteadOfHeart}
            title={showMascotInsteadOfHeart ? 'Loading…' : liked ? 'Unlike' : 'Like'}
            style={{
              color: liked ? 'var(--accent)' : 'var(--text-secondary)',
              opacity: showMascotInsteadOfHeart ? 1 : undefined,
              cursor: showMascotInsteadOfHeart ? 'default' : 'pointer',
            }}
          >
            {showMascotInsteadOfHeart ? (
              <PollyLoading size={26} />
            ) : (
              <Heart size={14} fill={liked ? 'var(--accent)' : 'none'} />
            )}
          </button>
        </div>

        {/* Center: control buttons */}
        <div className="flex-1 flex items-center justify-center gap-1.5">
          <button
            onClick={() => controller.setShuffle(!shuffle)}
            className="w-7 h-7 flex items-center justify-center transition-colors"
            style={{ color: shuffle ? 'var(--accent)' : 'var(--text-secondary)' }}
            title="Shuffle"
          >
            <Shuffle size={14} />
          </button>
          <button
            onClick={() => controller.skipPrev()}
            className="w-7 h-7 flex items-center justify-center transition-colors"
            style={{ color: 'var(--text-primary)' }}
            title="Previous"
          >
            <SkipBack size={16} />
          </button>
          <button
            onClick={handlePlayPause}
            className="w-8 h-8 flex items-center justify-center transition-colors"
            style={{
              background: 'color-mix(in srgb, var(--accent) 0.1, transparent)',
              border: '1px solid var(--accent)',
              borderRadius: 2,
              color: 'var(--text-primary)',
              boxShadow: '0 0 12px color-mix(in srgb, var(--accent) 0.35, transparent)',
            }}
            title={isPlaying ? 'Pause' : 'Play'}
          >
            {isPlaying ? <Pause size={14} /> : <Play size={14} />}
          </button>
          <button
            onClick={() => controller.skipNext()}
            className="w-7 h-7 flex items-center justify-center transition-colors"
            style={{ color: 'var(--text-primary)' }}
            title="Next"
          >
            <SkipForward size={16} />
          </button>
          <button
            onClick={cycleRepeat}
            className="w-7 h-7 flex items-center justify-center transition-colors"
            style={{ color: repeat !== 'off' ? 'var(--accent)' : 'var(--text-secondary)' }}
            title={repeat === 'off' ? 'No repeat' : repeat === 'all' ? 'Repeat all' : 'Repeat one'}
          >
            {repeat === 'one' ? <Repeat1 size={14} /> : <Repeat size={14} />}
          </button>
        </div>

        {/* Right: volume + queue */}
        <div className="flex items-center gap-2 w-52 shrink-0 justify-end">
          <button
            onClick={handleToggleQueue}
            className="px-1.5 transition-colors"
            style={{ color: 'var(--text-secondary)' }}
            title="Toggle queue"
          >
            <ListMusic size={14} />
          </button>
          <button
            onClick={(e) => setContextMenu({ x: e.clientX, y: e.clientY, track: currentTrack as any })}
            className="px-1.5 transition-colors"
            style={{ color: 'var(--text-secondary)' }}
          >
            <MoreHorizontal size={14} />
          </button>
          {volume > 0 ? (
            <Volume2 size={14} style={{ color: 'var(--text-secondary)' }} />
          ) : (
            <VolumeX size={14} style={{ color: 'var(--text-secondary)' }} />
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
              background: `linear-gradient(to right, var(--text-secondary) ${volume * 100}%, var(--border) ${volume * 100}%)`,
              accentColor: 'var(--text-primary)',
            }}
          />
        </div>
        </div>

        {/* Full-width progress row — isolated so timeupdate doesn't re-render the bar shell */}
        <PlayerProgress seekBlocked={seekBlocked} isBuffering={isBuffering} />
      </div>

      {/* Context Menu */}
      {contextMenu && (
        <div
          ref={contextMenuRef}
          className="fixed z-[60] min-w-48 py-1 text-sm"
          style={{
            left: contextMenuPos?.left ?? contextMenu.x,
            top: contextMenuPos?.top ?? contextMenu.y,
            background: 'var(--bg-surface)',
            border: '1px solid var(--border)',
            borderRadius: 4,
          }}
          onMouseLeave={() => setContextMenu(null)}
        >
          <div className="px-4 py-2" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
            <p className="truncate" style={{ fontFamily: "'Barlow Semi Condensed', sans-serif", color: 'var(--text-primary)' }}>
              {contextMenu.track.title}
            </p>
            <p className="text-xs truncate" style={{ fontFamily: "'Barlow Semi Condensed', sans-serif", color: 'var(--text-primary)' }}>
              {contextMenu.track.artist}
            </p>
          </div>
          <button
            className="w-full text-left px-4 py-2 hover:bg-[var(--bg-surface-3)] transition-colors disabled:opacity-40"
            style={{ fontFamily: "'Barlow Semi Condensed', sans-serif", color: 'var(--text-primary)' }}
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
                mb_artist_id: t.mb_artist_id || null,
                mb_release_id: t.mb_release_id || null,
                mb_release_group_id: t.mb_release_group_id || null,
              })
              setContextMenu(null)
              setAddPlOpen(true)
            }}
          >
            Add to playlist
          </button>
          <button
            className="w-full text-left px-4 py-2 hover:bg-[var(--bg-surface-3)] transition-colors"
            style={{ fontFamily: "'Barlow Semi Condensed', sans-serif", color: 'var(--text-primary)' }}
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
            className="w-full text-left px-4 py-2 hover:bg-[var(--bg-surface-3)] transition-colors"
            style={{ fontFamily: "'Barlow Semi Condensed', sans-serif", color: 'var(--text-primary)' }}
            onClick={() => {
              const track = contextMenu.track as any
              const albumId = track.mb_release_id || track.mb_release_group_id || null
              if (albumId) navigate(`/album/${albumId}`)
              setContextMenu(null)
            }}
          >
            Go to album
          </button>
          <div className="mt-1 pt-1" style={{ borderTop: '1px solid var(--border-subtle)' }}>
            <button
              className="w-full text-left px-4 py-2 hover:bg-[var(--bg-surface-3)] transition-colors"
              style={{ fontFamily: "'Barlow Semi Condensed', sans-serif", color: 'var(--text-primary)' }}
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

/** Owns currentTime subscription so the rest of PlayerBar isn't invalidated every tick. */
function PlayerProgress({ seekBlocked, isBuffering }: { seekBlocked: boolean; isBuffering: boolean }) {
  const currentTime = usePlayerStore((s) => s.currentTime)
  const duration = usePlayerStore((s) => s.duration)
  const [isDragging, setIsDragging] = useState(false)
  const [dragProgress, setDragProgress] = useState(0)
  const progressRef = useRef<HTMLDivElement>(null)

  const progress = duration > 0 ? (currentTime / duration) * 100 : 0
  const displayProgress = isDragging ? dragProgress * 100 : progress

  const calcProgressFromEvent = (e: React.MouseEvent | MouseEvent) => {
    if (!progressRef.current) return 0
    const rect = progressRef.current.getBoundingClientRect()
    return Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
  }

  const handleBarMouseDown = (e: React.MouseEvent) => {
    if (seekBlocked) return
    setIsDragging(true)
    setDragProgress(calcProgressFromEvent(e))
  }

  useEffect(() => {
    if (!isDragging) return
    const handleMouseMove = (e: MouseEvent) => {
      setDragProgress(calcProgressFromEvent(e))
    }
    const handleMouseUp = (e: MouseEvent) => {
      seekAudio(calcProgressFromEvent(e) * duration)
      setIsDragging(false)
    }
    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [isDragging, duration])

  // scaleX stays on the compositor; width:% forces layout every tick.
  const fillScale = Math.max(0, Math.min(1, displayProgress / 100))

  return (
    <div className="flex items-center gap-2 px-5 pb-2">
      <span
        className="text-xs w-9 text-right shrink-0"
        style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)' }}
      >
        {formatTime(currentTime)}
      </span>
      <div
        ref={progressRef}
        className="flex-1 relative cursor-pointer group"
        style={{ height: '14px' }}
      >
        <div
          className="absolute inset-0 cursor-pointer"
          onMouseDown={handleBarMouseDown}
        />
        <div
          className="absolute inset-x-0 top-1/2 -translate-y-1/2 h-px pointer-events-none"
          style={{ background: 'var(--border)' }}
        >
          <div
            className="absolute left-0 top-0 h-full w-full"
            style={{
              background: 'var(--accent)',
              transform: `scaleX(${fillScale})`,
              transformOrigin: 'left center',
              willChange: 'transform',
            }}
          />
          {isBuffering && (
            <div className="absolute top-0 left-0 h-full overflow-hidden w-full">
              <div
                className="h-full"
                style={{
                  animation: 'shimmerSlide 1.2s ease-in-out infinite',
                  background: 'var(--accent)',
                  width: '33%',
                  opacity: 0.5,
                }}
              />
            </div>
          )}
          {!seekBlocked && (
            <div
              className="absolute top-1/2 -translate-y-1/2 w-2 h-2 rounded-full opacity-0 group-hover:opacity-100 transition-opacity"
              style={{
                background: 'var(--accent)',
                left: `calc(${displayProgress}% - 4px)`,
              }}
            />
          )}
        </div>
      </div>
      <span
        className="text-xs w-9 shrink-0"
        style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)', textAlign: 'right' }}
      >
        {formatTime(duration)}
      </span>
    </div>
  )
}