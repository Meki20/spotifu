import { memo, useRef } from 'react'
import { Computer } from 'lucide-react'
import { displayArtist } from '../utils/trackHelpers'
import { useCoverWhenVisible } from '../hooks/useCoverWhenVisible'

function isLocalTrack(track: any): boolean {
  return !track.mb_id && !track.mb_artist_id && !track.mb_release_id && !track.mb_release_group_id
}

const BACKDROP_OPACITY = 0.14

interface TrackCardProps {
  track: any
  size?: number
  index?: number
  onPlay: (track: any) => void
  onHoverArtist?: (artistId: string, albumIds?: string[]) => void
  onContextMenu?: (e: React.MouseEvent, track: any) => void
}

const TrackCardImpl = ({ track, size = 96, index, onPlay, onHoverArtist, onContextMenu }: TrackCardProps) => {
  const rootRef = useRef<HTMLDivElement>(null)
  const staticCover = track.album_cover as string | null | undefined
  const { url: lazyCover } = useCoverWhenVisible(
    rootRef,
    staticCover ? null : (track.mb_id as string | undefined),
    'viewport',
  )
  const cover = staticCover || lazyCover
  return (
    <div
      ref={rootRef}
      className="tf tf-brackets flex flex-col items-center gap-2 px-2.5 py-2.5 cursor-pointer shrink-0 group relative overflow-hidden"
      style={{ width: size + 40 }}
      onClick={() => onPlay(track)}
      onContextMenu={onContextMenu ? (e) => onContextMenu(e, track) : undefined}
      onMouseEnter={() => {
        if (track.mb_artist_id && onHoverArtist) {
          onHoverArtist(track.mb_artist_id, track.mb_release_id ? [track.mb_release_id] : [])
        }
      }}
    >
      {cover && (
        <div
          className="absolute inset-0 pointer-events-none"
          style={{
            backgroundImage: `url(${cover})`,
            backgroundSize: 'cover',
            backgroundPosition: 'center',
            opacity: BACKDROP_OPACITY,
          }}
        />
      )}
      <div className="relative z-10 w-full flex flex-col items-center gap-2">
        {cover ? (
          <div
            className="relative overflow-hidden"
            style={{
              width: size,
              height: size,
              border: '1px solid var(--border-subtle)',
              borderRadius: 2,
              padding: 3,
              background: 'var(--bg-base)',
            }}
          >
            <img
              src={cover}
              alt={track.title}
              className="w-full h-full"
              style={{ objectFit: 'cover', borderRadius: 1 }}
              loading="lazy"
              decoding="async"
            />
            {isLocalTrack(track) && (
              <div
                className="absolute top-1 right-1 p-1 rounded"
                style={{ background: 'rgba(0,0,0,0.6)' }}
              >
                <Computer size={14} className="text-[var(--text-secondary)]" />
              </div>
            )}
          </div>
        ) : (
          <div
            className="flex items-center justify-center shrink-0"
            style={{
              width: size,
              height: size,
              background: 'var(--bg-surface)',
              border: '1px solid var(--border-subtle)',
              borderRadius: 2,
            }}
          >
            <span style={{ fontSize: Math.floor(size * 0.25), color: 'var(--text-primary)' }}>▦</span>
          </div>
        )}
        <div className="w-full text-center min-w-0">
          <p
            className="text-xs truncate"
            style={{ fontFamily: "'Barlow Semi Condensed', sans-serif", fontWeight: 600, color: 'var(--text-primary)' }}
          >
            {track.title}
          </p>
          <p
            className="text-xs truncate mt-0.5"
            style={{ fontFamily: "'Barlow Semi Condensed', sans-serif", color: 'var(--text-secondary)' }}
          >
            {displayArtist(track)}
          </p>
          {index !== undefined && (
            <p className="tfxb" style={{ marginTop: 3, textAlign: 'center' }}>
              // TRK_{String(index + 1).padStart(2, '0')}
            </p>
          )}
        </div>
      </div>
    </div>
  )
}

export default memo(TrackCardImpl, (prev, next) => {
  return (
    prev.track?.mb_id === next.track?.mb_id &&
    prev.track?.track_id === next.track?.track_id &&
    prev.track?.album_cover === next.track?.album_cover &&
    prev.index === next.index &&
    prev.onPlay === next.onPlay
  )
})
