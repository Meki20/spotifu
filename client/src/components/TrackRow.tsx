import { memo } from 'react'
import { Play, Computer } from 'lucide-react'
import { displayArtist, formatDuration } from '../utils/trackHelpers'
import { PollyLoading } from './PollyLoading'
import PlaylistTrackCover from './PlaylistTrackCover'

function isLocalTrack(track: any): boolean {
  return !track.mb_id && !track.mb_artist_id && !track.mb_release_id && !track.mb_release_group_id
}

interface TrackRowProps {
  track: any
  index?: number
  showAlbum?: boolean
  showStatus?: boolean
  showDuration?: boolean
  showCover?: boolean
  /** Pulse placeholder while batch cover URLs are still loading (``mb_id`` but no ``album_cover``). */
  coverBatchLoading?: boolean
  /** Same per-row cover resolution as playlist (``resolveTrackArtUrl`` + ``GET /covers/recordings`` + img fallback). */
  playlistStyleCover?: boolean
  onCoverResolved?: (recordingMbid: string, url: string) => void
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
  showDuration = false,
  showCover = true,
  coverBatchLoading = false,
  playlistStyleCover = false,
  onCoverResolved,
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
            style={{ fontFamily: "'Barlow Semi Condensed', monospace", color: isPlaying ? '#b4003e' : '#4A413C' }}
          >
            {isPlaying ? '▶' : index + 1}
          </span>
        )}
        <span
          className="absolute inset-0 hidden group-hover:flex items-center justify-center"
          style={{ color: '#b4003e' }}
        >
          <Play size={12} fill="currentColor" />
        </span>
      </div>

      {/* Title + artist + cover */}
      <div className="flex items-center gap-2.5 min-w-0">
        {showCover && playlistStyleCover && (track.mb_id || track.mb_recording_id) && (
          <PlaylistTrackCover
            item={track}
            className="w-8 h-8 rounded shrink-0"
            onResolved={
              onCoverResolved
                ? (url) => {
                    const id = String(track.mb_recording_id || track.mb_id || '').trim()
                    if (id) onCoverResolved(id, url)
                  }
                : undefined
            }
          />
        )}
        {showCover && !playlistStyleCover && track.album_cover && (
          <div className="relative w-8 h-8 rounded shrink-0 overflow-hidden">
            <img
              src={track.album_cover}
              alt={track.album || ''}
              className="w-full h-full object-cover"
              loading="lazy"
            />
            {isLocalTrack(track) && (
              <div
                className="absolute top-0 right-0 p-0.5"
                style={{ background: 'rgba(0,0,0,0.6)' }}
              >
                <Computer size={10} className="text-[#9A8E84]" />
              </div>
            )}
          </div>
        )}
        {showCover && !playlistStyleCover && !track.album_cover && track.mb_id && coverBatchLoading && (
          <div className="w-8 h-8 rounded shrink-0 animate-pulse bg-[#231815]" aria-hidden />
        )}
        {showCover && !playlistStyleCover && !track.album_cover && track.mb_id && !coverBatchLoading && (
          <div className="w-8 h-8 rounded shrink-0 bg-[#231815]" aria-hidden />
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
      {!showStatus && showDuration && (
        <span
          className="text-xs tabular-nums text-right shrink-0"
          style={{ fontFamily: "'Barlow Semi Condensed', monospace", color: '#4A413C' }}
        >
          {downloadState?.status === 'downloading' ? `${downloadState.percent ?? 0}%` : formatDuration(track.duration)}
        </span>
      )}
    </div>
  )
}

export default memo(TrackRowImpl, (prev, next) => {
  return (
    prev.track?.mb_id === next.track?.mb_id &&
    prev.track?.track_id === next.track?.track_id &&
    prev.track?.album_cover === next.track?.album_cover &&
    prev.coverBatchLoading === next.coverBatchLoading &&
    prev.playlistStyleCover === next.playlistStyleCover &&
    prev.onCoverResolved === next.onCoverResolved &&
    prev.downloadState?.status === next.downloadState?.status &&
    prev.downloadState?.percent === next.downloadState?.percent &&
    prev.isPlaying === next.isPlaying &&
    prev.isCached === next.isCached &&
    prev.showDuration === next.showDuration &&
    prev.onPlay === next.onPlay
  )
})