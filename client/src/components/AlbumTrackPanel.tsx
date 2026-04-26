import { useState } from 'react'
import { X } from 'lucide-react'
import * as controller from '../playback/controller'
import TrackRow from './TrackRow'
import { toTrack } from '../utils/trackHelpers'
import { useContextMenuActions } from '../contexts/ContextMenuProvider'

export interface LibraryTrack {
  mb_id: string | null
  title: string
  artist: string
  duration: number
  is_cached: boolean
}

export interface LibraryAlbum {
  id: string
  title: string
  artist: string
  cover: string | null
  track_count: number
  cached_count: number
  tracks: LibraryTrack[]
  album_key?: string
}

interface AlbumTrackPanelProps {
  album: LibraryAlbum | null
  onClose: () => void
}

export default function AlbumTrackPanel({ album, onClose }: AlbumTrackPanelProps) {
  const [animatingOut, setAnimatingOut] = useState(false)
  const { openContextMenu } = useContextMenuActions()

  function handleClose() {
    setAnimatingOut(true)
    setTimeout(() => {
      setAnimatingOut(false)
      onClose()
    }, 200)
  }

  function playTrack(track: LibraryTrack) {
    controller.play(toTrack(track, {
      album: album?.title ?? '',
      album_cover: album?.cover ?? null,
      mb_release_id: album?.id?.includes('-') ? album.id : null,
    }))
  }

  function handleTrackContextMenu(e: React.MouseEvent, track: LibraryTrack) {
    e.preventDefault()
    e.stopPropagation()
    openContextMenu(e.clientX, e.clientY, track)
  }

  const translateY = album && !animatingOut ? '0%' : '100%'

  /** Keep in sync with PlayerBar height (h-20 = 5rem) */
  const PLAYER_H = '5rem'

  return (
    <>
      {/* Dim only the area above the player so the bar stays visible and interactive */}
      {album && (
        <div
          className="fixed top-0 left-0 right-0 z-20"
          onClick={handleClose}
          style={{ bottom: PLAYER_H, background: 'rgba(0,0,0,0.4)' }}
        />
      )}

      {/* z-30: below the player (z-50) so the sheet slides in underneath the bar */}
      <div
        className="fixed left-0 right-0 z-30"
        style={{
          bottom: PLAYER_H,
          transform: `translateY(${translateY})`,
          transformOrigin: 'bottom center',
          transition: 'transform 200ms ease-out',
          maxHeight: '60vh',
        }}
      >
        <div
          className="rounded-t-xl overflow-hidden"
          style={{
            background: 'rgba(26,18,16,0.97)',
            backdropFilter: 'blur(24px)',
            borderTop: '1px solid #3D2820',
          }}
        >
          {album ? (
            <>
              {/* Header */}
              <div
                className="flex items-center gap-4 px-5 py-4"
                style={{ borderBottom: '1px solid #261A14' }}
              >
                {album.cover && (
                  <img
                    src={album.cover}
                    alt={album.title}
                    className="w-14 h-14 rounded shadow"
                    loading="lazy"
                  />
                )}
                <div className="flex-1 min-w-0">
                  <p
                    className="text-sm font-semibold truncate"
                    style={{ fontFamily: "'Barlow Condensed', sans-serif", color: '#E8DDD0' }}
                  >
                    {album.title}
                  </p>
                  <p
                    className="text-xs truncate"
                    style={{ fontFamily: "'Barlow Semi Condensed', sans-serif", color: '#9A8E84' }}
                  >
                    {album.artist}
                  </p>
                  <p
                    className="text-xs mt-0.5"
                    style={{ fontFamily: "'Barlow Semi Condensed', sans-serif", color: '#b4003e' }}
                  >
                    {album.cached_count} of {album.track_count} cached
                  </p>
                </div>
                <button
                  onClick={handleClose}
                  className="w-8 h-8 flex items-center justify-center rounded-full shrink-0"
                  style={{ background: '#231815', color: '#9A8E84' }}
                >
                  <X size={16} />
                </button>
              </div>

              {/* Track list */}
              <div className="overflow-y-auto" style={{ maxHeight: 'calc(60vh - 90px)' }}>
                {album.tracks.map((track, i) => (
                  <div
                    key={track.mb_id || i}
                    style={{ borderBottom: '1px solid #1A1210', padding: '0 20px' }}
                  >
                    <TrackRow
                      track={track}
                      index={i}
                      showCover={false}
                      isCached={track.is_cached}
                      onPlay={playTrack}
                      onContextMenu={handleTrackContextMenu}
                    />
                  </div>
                ))}
              </div>
            </>
          ) : null}
        </div>
      </div>
    </>
  )
}