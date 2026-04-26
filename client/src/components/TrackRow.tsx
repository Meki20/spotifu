import { memo } from 'react'
import { Play } from 'lucide-react'
import { displayArtist } from '../utils/trackHelpers'
import { PollyLoading } from './PollyLoading'

interface TrackRowProps {
  track: any
  index?: number
  showAlbum?: boolean
  showStatus?: boolean
  showCover?: boolean
  isPlaying?: boolean
  isCached?: boolean
  downloadState?: { status: string; percent?: number }
  onPlay: (track: any) => void
  onContextMenu?: (e: React.MouseEvent, track: any) => void
  onHoverArtist?: (artistId: string, albumIds?: string[]) => void
  style?: React.CSSProperties
}

const TrackRowImpl = ({
  track,
  index,
  showAlbum = false,
  showStatus = false,
  showCover = true,
  isPlaying = false,
  isCached = false,
  downloadState,
  onPlay,
  onContextMenu,
  onHoverArtist,
  style,
}: TrackRowProps) => {
  const titleColor = isCached ? '#E8DDD0' : '#4A413C'

  return (
    <div
      className="grid gap-4 px-4 py-2 cursor-pointer group transition-all duration-150"
      style={
        showAlbum
          ? { gridTemplateColumns: 'auto 1fr 1fr auto', ...style }
          : { gridTemplateColumns: 'auto 1fr auto', ...style }
      }
      onClick={() => onPlay(track)}
      onContextMenu={onContextMenu ? (e) => onContextMenu(e, track) : undefined}
    >
      {/* Index / play icon */}
      <div className="relative w-8 h-8 shrink-0 flex items-center justify-center">
        {index != null && (
          <span
            className="text-sm group-hover:hidden"
            style={{ fontFamily: "'Barlow Semi Condensed', monospace", color: isPlaying ? '#C4391F' : '#4A413C' }}
          >
            {isPlaying ? '▶' : index + 1}
          </span>
        )}
        <span
          className="absolute inset-0 hidden group-hover:flex items-center justify-center"
          style={{ color: '#1DB954' }}
        >
          <Play size={12} fill="currentColor" />
        </span>
      </div>

      {/* Title + artist + cover */}
      <div className="flex items-center gap-2.5 min-w-0">
        {showCover && track.album_cover && (
          <img
            src={track.album_cover}
            alt={track.album || ''}
            className="w-8 h-8 rounded shrink-0"
            loading="lazy"
          />
        )}
        <div className="min-w-0">
          <p
            className="text-sm truncate"
            style={{ fontFamily: "'Barlow Semi Condensed', monospace", color: titleColor }}
          >
            {track.title}
          </p>
          <p
            className="text-xs truncate mt-0.5"
            style={{ fontFamily: "'Barlow Semi Condensed', monospace", color: '#9A8E84' }}
            onMouseEnter={() => {
              if (track.mb_artist_id && onHoverArtist) {
                onHoverArtist(track.mb_artist_id, track.mb_release_id ? [track.mb_release_id] : [])
              }
            }}
          >
            {displayArtist(track)}
          </p>
        </div>
      </div>

      {/* Album column */}
      {showAlbum && (
        <span
          className="text-sm truncate flex items-center"
          style={{ fontFamily: "'Barlow Semi Condensed', monospace", color: '#9A8E84' }}
        >
          {track.album}
        </span>
      )}

      {/* Status / duration */}
      {showStatus && (
        <span
          className="text-sm flex items-center justify-end gap-1.5"
          style={{ fontFamily: "'Barlow Semi Condensed', monospace", color: '#4A413C' }}
        >
          {downloadState?.status === 'downloading' ? (
            <>
              <PollyLoading size={18} />
              <span>{downloadState.percent ?? 0}%</span>
            </>
          ) : isCached ? (
            '✓'
          ) : (
            '—'
          )}
        </span>
      )}
    </div>
  )
}

export default memo(TrackRowImpl, (prev, next) => {
  return (
    prev.track?.mb_id === next.track?.mb_id &&
    prev.track?.track_id === next.track?.track_id &&
    prev.downloadState?.status === next.downloadState?.status &&
    prev.downloadState?.percent === next.downloadState?.percent &&
    prev.isPlaying === next.isPlaying &&
    prev.isCached === next.isCached &&
    prev.onPlay === next.onPlay
  )
})