import { X, ListMusic, Computer, PanelLeft, PanelRight } from 'lucide-react'
import { useEffect, useMemo, useRef, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from 'react-router-dom'
import { useShallow } from 'zustand/react/shallow'
import { usePlayerStore, type Track, type PlayerState } from '../stores/playerStore'
import * as controller from '../playback/controller'
import { authFetch, mediaUrl } from '../api'
import { useCoverWhenVisible } from '../hooks/useCoverWhenVisible'
import type { CoverPriority } from '../lib/coverManager'

function QueueCover({ track, className, priority = 'prefetch' }: { track: Track; className: string; priority?: CoverPriority }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const { url } = useCoverWhenVisible(containerRef, track.mb_id, priority)
  const src = track.album_cover || url
  return (
    <div ref={containerRef} className={className} style={{ background: 'var(--bg-surface)' }}>
      {src && <img src={src} alt="" className="w-full h-full object-cover block" loading="lazy" />}
    </div>
  )
}

function NowPlayingCard({ track }: { track: Track }) {
  const navigate = useNavigate()
  const displayStr = (track.artist_credit || track.artist || '').trim()
  const artists = displayStr.split(',').map((s) => s.trim()).filter(Boolean)
  const mainArtistName = artists[0] || ''
  const extraArtists = artists.slice(1)

  const goToArtistByName = async (name: string) => {
    try {
      const res = await authFetch(`/artist?q=${encodeURIComponent(name)}`)
      if (!res.ok) return
      const data = (await res.json()) as { artist_mbid?: string }
      if (data.artist_mbid) {
        navigate(`/artist/${data.artist_mbid}`)
      }
    } catch {
      // ignore
    }
  }
  return (
    <div className="w-full">
      <div
        className="w-full aspect-square rounded-md overflow-hidden relative"
        style={{
          background: 'var(--bg-surface)',
          boxShadow: '0 14px 40px rgba(0,0,0,0.55), 0 2px 0 rgba(255,255,255,0.03) inset',
        }}
      >
        <QueueCover track={track} className="w-full h-full object-cover block" priority="viewport" />
        {!track.mb_id && !track.mb_artist_id && !track.mb_release_id && !track.mb_release_group_id && (
          <div
            className="absolute top-2 right-2 p-1.5 rounded"
            style={{ background: 'rgba(0,0,0,0.6)' }}
          >
            <Computer size={16} className="text-[var(--text-secondary)]" />
          </div>
        )}
      </div>

      <div className="pt-3">
        <div
          className="text-sm font-semibold leading-snug"
          style={{
            fontFamily: "'Barlow Semi Condensed', sans-serif",
            color: 'var(--text-primary)',
          }}
        >
          {track.title}
        </div>
        <div className="text-[11px] mt-1" style={{ fontFamily: "'Barlow Semi Condensed', sans-serif", color: 'color-mix(in srgb, var(--text-primary) 0.70, transparent)' }}>
          <span
            className={track.mb_artist_id ? 'hover:underline cursor-pointer' : 'cursor-default'}
            style={{ color: 'color-mix(in srgb, var(--text-primary) 0.70, transparent)' }}
            onClick={(e) => {
              e.stopPropagation()
              track.mb_artist_id && navigate(`/artist/${track.mb_artist_id}`)
            }}
          >
            {mainArtistName}
          </span>
          {extraArtists.map((name, i) => (
            <span
              key={i}
              className="hover:underline cursor-pointer"
              style={{ color: 'color-mix(in srgb, var(--text-primary) 0.70, transparent)' }}
              onClick={(e) => {
                e.stopPropagation()
                goToArtistByName(name)
              }}
            >
              {`, ${name}`}
            </span>
          ))}
        </div>
        <div
          className="text-[11px] mt-0.5 truncate"
          style={{ fontFamily: "'Barlow Semi Condensed', sans-serif", color: 'color-mix(in srgb, var(--text-primary) 0.50, transparent)' }}
        >
          <span
            className={track.mb_release_id || track.mb_release_group_id ? 'hover:underline cursor-pointer' : 'cursor-default'}
            style={{ color: 'color-mix(in srgb, var(--text-primary) 0.50, transparent)' }}
            onClick={(e) => {
              e.stopPropagation()
              const albumId = track.mb_release_id || track.mb_release_group_id
              albumId && navigate(`/album/${albumId}`)
            }}
          >
            {track.album}
          </span>
        </div>
      </div>
    </div>
  )
}

function TrackRow({
  track,
  right,
  onClick,
  onRemove,
}: {
  track: Track
  right?: ReactNode
  onClick?: () => void
  onRemove?: () => void
}) {
  const navigate = useNavigate()
  return (
    <div
      className="relative group flex items-center gap-3 px-3 py-2 rounded-md cursor-pointer"
      onClick={onClick}
      style={{
        background: 'color-mix(in srgb, var(--bg-surface) 0.7, transparent)',
        border: '1px solid color-mix(in srgb, var(--border) 0.65, transparent)',
      }}
    >
      <div
        className="shrink-0 rounded-md overflow-hidden relative"
        style={{ width: 30, height: 30, background: 'var(--bg-surface)' }}
      >
        <QueueCover track={track} className="w-full h-full object-cover block" />
        {!track.mb_id && !track.mb_artist_id && !track.mb_release_id && !track.mb_release_group_id && (
          <div
            className="absolute top-0 right-0 p-0.5"
            style={{ background: 'rgba(0,0,0,0.6)' }}
          >
            <Computer size={10} className="text-[var(--text-secondary)]" />
          </div>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-xs font-semibold truncate" style={{ fontFamily: "'Barlow Semi Condensed', sans-serif", color: 'var(--text-primary)' }}>
          {track.title}
        </div>
        <div className="text-[11px] truncate" style={{ fontFamily: "'Barlow Semi Condensed', sans-serif", color: 'color-mix(in srgb, var(--text-primary) 0.65, transparent)' }}>
          <span
            className={track.mb_artist_id ? 'hover:underline cursor-pointer' : 'cursor-default'}
            style={{ color: 'color-mix(in srgb, var(--text-primary) 0.65, transparent)' }}
            onClick={(e) => {
              e.stopPropagation()
              track.mb_artist_id && navigate(`/artist/${track.mb_artist_id}`)
            }}
          >
            {track.artist}
          </span>
        </div>
      </div>
      <div className="shrink-0 flex items-center gap-2">
        {right}
        {onRemove && (
          <button
            type="button"
            className="opacity-0 group-hover:opacity-100 transition-opacity rounded-md grid place-items-center"
            onClick={(e) => {
              e.stopPropagation()
              onRemove()
            }}
            style={{ width: 24, height: 24, color: 'var(--text-primary)', background: 'rgba(0,0,0,0.12)' }}
            aria-label="Remove from queue"
          >
            <X size={14} />
          </button>
        )}
      </div>
    </div>
  )
}

export type QueuePanelProps = {
  width: number
  onWidthChange: (width: number) => void
  onClose: () => void
  onOpen: () => void
  maxWidth: number
  minWidth?: number
}

export default function QueuePanel({ width, onWidthChange, onClose, onOpen, maxWidth, minWidth = 0 }: QueuePanelProps) {
  const isClosed = width === 0
  const {
    currentTrack,
    userQueue,
    systemLookahead,
    systemSource,
    systemList,
    systemIndex,
  } = usePlayerStore(
    useShallow((s: PlayerState) => ({
      currentTrack: s.currentTrack,
      userQueue: s.userQueue,
      systemLookahead: s.systemLookahead,
      systemSource: s.systemSource,
      systemList: s.systemList,
      systemIndex: s.systemIndex,
    })),
  )

  const isEmpty = !currentTrack && userQueue.length === 0 && systemLookahead.length === 0

  const aboutArtist = useMemo(() => {
    const t = currentTrack
    if (!t) return null
    const raw = (t.artist_credit || t.artist || '').trim()
    const first = raw.split(',')[0]?.split('&')[0]?.split(' feat. ')[0]?.split(' ft. ')[0]?.trim() || raw || 'Unknown artist'
    return {
      id: t.mb_artist_id || null,
      name: first,
    }
  }, [currentTrack])

  const { data: artistImages } = useQuery({
    queryKey: ['queue-artist-images', aboutArtist?.id, aboutArtist?.name],
    queryFn: async () => {
      if (!aboutArtist?.id) return { banner: null as string | null }
      const qs = aboutArtist.name ? `?artist_name=${encodeURIComponent(aboutArtist.name)}` : ''
      const res = await authFetch(`/artist/${aboutArtist.id}/images${qs}`)
      if (!res.ok) return { banner: null as string | null }
      return res.json() as Promise<{ banner?: string | null }>
    },
    enabled: !!aboutArtist?.id,
    staleTime: 1000 * 60 * 10,
    gcTime: 1000 * 60 * 30,
    refetchOnWindowFocus: false,
  })

  const queryClient = useQueryClient()
  const prevTrackIdRef = useRef(currentTrack?.mb_id || null)

  useEffect(() => {
    const prevId = prevTrackIdRef.current
    const newId = currentTrack?.mb_id || null

    if (prevId !== newId && prevId !== null) {
      queryClient.invalidateQueries({ queryKey: ['queue-artist-images'] })
    }

    prevTrackIdRef.current = newId
  }, [currentTrack, queryClient])

  const sourceLabel = useMemo(() => {
    if (!systemSource) return 'Next from system'
    if (systemSource.kind === 'album') return systemSource.title ? `Next from album • ${systemSource.title}` : 'Next from album'
    if (systemSource.kind === 'playlist') return systemSource.title ? `Next from playlist • ${systemSource.title}` : 'Next from playlist'
    if (systemSource.kind === 'recently-added') return 'Next from recently added'
    if (systemSource.kind === 'recently-played') return 'Next from recently played'
    if (systemSource.kind === 'search') return `Next from search • ${systemSource.query}`
    return systemSource.title ? `Next from • ${systemSource.title}` : 'Next from system'
  }, [systemSource])

  const panelRef = useRef<HTMLDivElement>(null)

  const handleDragMouseDown = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const startX = e.clientX
    const startWidth = width
    document.body.style.cursor = 'ew-resize'
    document.body.style.userSelect = 'none'

    const onMouseMove = (moveEvent: MouseEvent) => {
      const dx = startX - moveEvent.clientX
      let newWidth = startWidth + dx

      if (newWidth <= minWidth) {
        newWidth = 0
      } else if (newWidth > maxWidth) {
        newWidth = maxWidth
      } else if (newWidth < minWidth) {
        newWidth = minWidth
      }

      if (panelRef.current) {
        panelRef.current.style.width = `${newWidth}px`
      }
    }

    const onMouseUp = (moveEvent: MouseEvent) => {
      const dx = startX - moveEvent.clientX
      let finalWidth = startWidth + dx

      if (finalWidth <= minWidth) {
        finalWidth = 0
      } else if (finalWidth > maxWidth) {
        finalWidth = maxWidth
      } else if (finalWidth < minWidth) {
        finalWidth = minWidth
      }

      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
      if (panelRef.current) {
        panelRef.current.style.width = ''
      }
      onWidthChange(finalWidth)
    }

    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
  }

  return (
    <div
      ref={panelRef}
      className="flex flex-col h-full relative shrink-0 overflow-hidden"
      style={{
        width: width,
        opacity: isClosed ? 0 : 1,
        background: 'var(--bg-surface)',
        borderLeft: '1px solid var(--bg-surface)',
        transition: 'width 220ms cubic-bezier(0.2, 0.9, 0.2, 1), opacity 120ms ease',
        willChange: 'width, opacity',
      }}
    >
      {/* Drag handle on the LEFT edge */}
      {width > 0 && (
        <div
          role="separator"
          aria-valuenow={width}
          aria-valuemin={0}
          aria-valuemax={maxWidth}
          aria-label="Queue panel resizer"
          onMouseDown={handleDragMouseDown}
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            bottom: 0,
            width: 6,
            cursor: 'ew-resize',
            zIndex: 20,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {/* Grabber indicator — vertical dots */}
          <div
            style={{
              width: 2,
              height: 40,
              borderRadius: 1,
              background: 'var(--bg-surface)',
              display: 'flex',
              flexDirection: 'column',
              gap: 3,
              justifyContent: 'center',
              alignItems: 'center',
            }}
          >
            {[...Array(5)].map((_, i) => (
              <div key={i} style={{ width: 2, height: 2, borderRadius: '50%', background: 'var(--bg-surface)' }} />
            ))}
          </div>
        </div>
      )}

      {/* Circuit pattern overlay */}
      <div
        className="fx-circuit absolute inset-0 pointer-events-none opacity-4"
        style={{
          backgroundImage: `radial-gradient(circle, var(--border) 1px, transparent 1px), linear-gradient(var(--border-subtle) 1px, transparent 1px), linear-gradient(90deg, var(--border-subtle) 1px, transparent 1px)`,
          backgroundSize: '24px 24px',
        }}
      />

      <div className="relative z-10 flex flex-col h-full overflow-hidden">
        {/* Header */}
        <div
          className="pt-4 pb-3"
          style={{
            borderBottom: '1px solid var(--border-subtle)',
            paddingLeft: 16,
            paddingRight: 16,
            transition: 'padding 220ms cubic-bezier(0.2, 0.9, 0.2, 1)',
          }}
        >
          <div className="flex items-center gap-2">
            <div
              className="w-8 h-8 rounded-sm grid place-items-center shrink-0"
              style={{ border: '1px solid var(--border)', color: 'var(--text-primary)' }}
              aria-hidden
            >
              <ListMusic size={16} />
            </div>
            <div
              className="text-2xl font-bold tracking-wide flex-1"
              style={{
                fontFamily: "'Barlow Condensed', sans-serif",
                fontWeight: 800,
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
                color: 'var(--text-primary)',
                lineHeight: 1,
                whiteSpace: 'nowrap',
              }}
            >
              Queue
            </div>
          </div>
        </div>

        {/* Scrollable content */}
        <div className="flex-1 overflow-y-auto" style={{ overscrollBehavior: 'contain' }}>
          {isEmpty ? (
            <div className="px-4 py-6">
              <div className="w-20 mx-auto">
                <img
                  src="/assets/brand/polly_512x512.png"
                  alt=""
                  aria-hidden
                  className="select-none w-full"
                  draggable={false}
                  style={{ objectFit: 'contain' }}
                />
              </div>
              <div
                className="mt-4 text-center text-sm"
                style={{ fontFamily: "'Barlow Semi Condensed', sans-serif", color: 'color-mix(in srgb, var(--text-primary) 0.70, transparent)' }}
              >
                Queue is empty
              </div>
            </div>
          ) : (
            <div>
              <div className="px-4 pb-3 pt-3">
                <div className="text-xs mb-2" style={{ fontFamily: "'Barlow Condensed', sans-serif", color: 'var(--text-primary)', letterSpacing: '0.14em', fontWeight: 800, textTransform: 'uppercase' }}>
                  Now playing
                </div>
                {currentTrack ? (
                  <NowPlayingCard track={currentTrack} />
                ) : (
                  <div className="text-xs" style={{ fontFamily: "'Barlow Semi Condensed', sans-serif", color: 'color-mix(in srgb, var(--text-primary) 0.45, transparent)' }}>
                    Nothing playing
                  </div>
                )}
              </div>

              <div className="px-4 pb-3">
            <div
              className="text-xs mb-2"
              style={{
                fontFamily: "'Barlow Condensed', sans-serif",
                color: 'var(--text-primary)',
                letterSpacing: '0.14em',
                fontWeight: 800,
                textTransform: 'uppercase',
              }}
            >
              About the artist
            </div>

            <div className="rounded-md overflow-hidden" style={{ border: '1px solid color-mix(in srgb, var(--border) 0.5, transparent)', background: 'color-mix(in srgb, var(--bg-surface) 0.35, transparent)' }}>
              <div className="w-full" style={{ height: 92, background: '--bg-surface' }}>
                {artistImages?.banner ? (
                  <img src={mediaUrl(artistImages.banner)} alt="" className="w-full h-full object-cover block" loading="lazy" />
                ) : (
                  <div className="w-full h-full animate-pulse" style={{ background: 'linear-gradient(90deg, color-mix(in srgb, var(--bg-surface) 1, transparent) 0%, color-mix(in srgb, var(--bg-surface) 1, transparent) 50%, color-mix(in srgb, var(--bg-surface) 1, transparent) 100%)' }} />
                )}
              </div>

              <div className="px-3 pt-3 pb-3">
                {aboutArtist?.id ? (
                  <Link
                    to={`/artist/${aboutArtist.id}`}
                    className="inline-block font-semibold"
                    style={{ fontFamily: "'Barlow Semi Condensed', sans-serif", color: 'var(--text-primary)' }}
                  >
                    {aboutArtist.name}
                  </Link>
                ) : (
                  <div className="font-semibold" style={{ fontFamily: "'Barlow Semi Condensed', sans-serif", color: 'var(--text-primary)' }}>
                    {aboutArtist?.name || 'Unknown artist'}
                  </div>
                )}

                {/* Placeholder description skeleton (intentional infinite loading for now). */}
                <div className="mt-2 flex flex-col gap-2">
                  <div className="h-2 rounded animate-pulse" style={{ background: 'color-mix(in srgb, var(--text-primary) 0.10, transparent)' }} />
                  <div className="h-2 rounded animate-pulse" style={{ background: 'color-mix(in srgb, var(--text-primary) 0.10, transparent)', width: '92%' }} />
                  <div className="h-2 rounded animate-pulse" style={{ background: 'color-mix(in srgb, var(--text-primary) 0.10, transparent)', width: '78%' }} />
                </div>
              </div>
            </div>
          </div>

          <div className="px-4 pb-3">
          <div className="flex items-center justify-between mb-2">
            <div className="text-xs" style={{ fontFamily: "'Barlow Condensed', sans-serif", color: 'var(--text-primary)', letterSpacing: '0.14em', fontWeight: 800, textTransform: 'uppercase' }}>
              Up next (your queue)
            </div>
            <button
              type="button"
              onClick={() => controller.clearUserQueue()}
              className="text-[11px] px-2 py-1 rounded-md"
              style={{ fontFamily: "'Barlow Condensed', sans-serif", letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--text-primary)', background: 'color-mix(in srgb, var(--bg-surface) 0.6, transparent)', border: '1px solid color-mix(in srgb, var(--border) 0.75, transparent)' }}
              disabled={userQueue.length === 0}
              title="Clear your queue"
            >
              Clear
            </button>
          </div>
          <div className="flex flex-col gap-2">
            {userQueue.length === 0 ? (
              <div className="text-xs" style={{ fontFamily: "'Barlow Semi Condensed', sans-serif", color: 'color-mix(in srgb, var(--text-primary) 0.45, transparent)' }}>
                No queued tracks
              </div>
            ) : (
              userQueue.map((t, idx) => (
                <TrackRow
                  key={`${t.mb_id}_${idx}`}
                  track={t}
                  onClick={() => controller.play(t)}
                  onRemove={() => controller.removeFromUserQueue(idx)}
                />
              ))
            )}
          </div>
          </div>

          <div className="px-4 pb-6">
          <div className="text-xs mb-2" style={{ fontFamily: "'Barlow Condensed', sans-serif", color: 'var(--text-primary)', letterSpacing: '0.14em', fontWeight: 800, textTransform: 'uppercase' }}>
            {sourceLabel}
          </div>
          <div className="flex flex-col gap-2">
            {systemLookahead.length === 0 ? (
              <div className="text-xs" style={{ fontFamily: "'Barlow Semi Condensed', sans-serif", color: 'color-mix(in srgb, var(--text-primary) 0.45, transparent)' }}>
                Nothing queued from system
              </div>
            ) : (
              systemLookahead.map((t, i) => {
                const absoluteIndex = systemIndex + 1 + i
                return (
                  <TrackRow
                    key={`${t.mb_id}_${absoluteIndex}`}
                    track={t}
                    onClick={() => {
                      usePlayerStore.getState().setSystemIndex(absoluteIndex)
                      controller.play(systemList[absoluteIndex])
                    }}
                  />
                )
              })
            )}
          </div>
          </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

