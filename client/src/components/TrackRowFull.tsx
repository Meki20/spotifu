import TrackRow from './TrackRow'

interface TrackRowFullProps {
  track: any
  index?: number
  isPlaying?: boolean
  isCached?: boolean
  downloadState?: { status: string; percent?: number }
  coverBatchLoading?: boolean
  playlistStyleCover?: boolean
  showAlbum?: boolean
  showStatus?: boolean
  showDuration?: boolean
  showCover?: boolean
  onCoverResolved?: (recordingMbid: string, url: string) => void
  onPlay: (track: any) => void
  onContextMenu?: (e: React.MouseEvent, track: any) => void
  onHoverArtist?: (artistId: string, albumIds?: string[]) => void
  style?: React.CSSProperties
}

/**
 * TrackRowFull — full row with index, title+cover, artist, album, status.
 * Used by Search results, AlbumPage, ArtistPage.
 */
export default function TrackRowFull({
  track,
  index,
  isPlaying = false,
  isCached = false,
  downloadState,
  coverBatchLoading = false,
  playlistStyleCover = false,
  showAlbum = true,
  showStatus = true,
  showDuration = false,
  showCover = true,
  onCoverResolved,
  onPlay,
  onContextMenu,
  onHoverArtist,
  style,
}: TrackRowFullProps) {
  return (
    <TrackRow
      track={track}
      index={index}
      showAlbum={showAlbum}
      showStatus={showStatus}
      showDuration={showDuration}
      showCover={showCover}
      coverBatchLoading={coverBatchLoading}
      playlistStyleCover={playlistStyleCover}
      onCoverResolved={onCoverResolved}
      isPlaying={isPlaying}
      isCached={isCached}
      downloadState={downloadState}
      onPlay={onPlay}
      onContextMenu={onContextMenu}
      onHoverArtist={onHoverArtist}
      style={style}
    />
  )
}