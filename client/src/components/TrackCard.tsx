import { memo } from 'react'

const BACKDROP_OPACITY = 0.14

interface TrackCardProps {
  track: any
  size?: number
  onPlay: (track: any) => void
  onHoverArtist?: (artistId: string, albumIds?: string[]) => void
  onContextMenu?: (e: React.MouseEvent, track: any) => void
}

const TrackCardImpl = ({ track, size = 96, onPlay, onHoverArtist, onContextMenu }: TrackCardProps) => {
  const cover = track.album_cover as string | null | undefined
  return (
    <div
      className="flex flex-col items-center gap-2 px-3 py-3 rounded cursor-pointer border shrink-0 transition-colors hover:border-[#8B2A1A] group relative overflow-hidden"
      style={{
        background: '#1A1210',
        borderColor: '#3D2820',
        width: size + 48,
      }}
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
          <img
            src={cover}
            alt={track.title}
            className="rounded"
            style={{ width: size, height: size, objectFit: 'cover' }}
            loading="lazy"
          />
        ) : (
          <div
            className="rounded flex items-center justify-center shrink-0"
            style={{ width: size, height: size, background: '#231815' }}
          >
            <span style={{ fontSize: Math.floor(size * 0.25), color: '#4A413C' }}>▦</span>
          </div>
        )}
        <div className="w-full text-center min-w-0">
          <p
            className="text-xs truncate"
            style={{ fontFamily: "'Barlow Semi Condensed', sans-serif", fontWeight: 600, color: '#E8DDD0' }}
          >
            {track.title}
          </p>
          <p
            className="text-xs truncate mt-0.5"
            style={{ fontFamily: "'Barlow Semi Condensed', sans-serif", color: '#9A8E84' }}
          >
            {track.artist}
          </p>
        </div>
      </div>
    </div>
  )
}

export default memo(TrackCardImpl, (prev, next) => {
  return (
    prev.track?.mb_id === next.track?.mb_id &&
    prev.track?.track_id === next.track?.track_id &&
    prev.onPlay === next.onPlay
  )
})
