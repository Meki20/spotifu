import TrackRow from './TrackRow'

interface TrackRowFullProps {
  track: any
  index?: number
  isPlaying?: boolean
  isCached?: boolean
  downloadState?: { status: string; percent?: number }
  onPlay: (track: any) => void
  onContextMenu?: (e: React.MouseEvent, track: any) => void
  onHoverArtist?: (artistId: string, albumIds?: string[]) => void
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
  onPlay,
  onContextMenu,
  onHoverArtist,
}: TrackRowFullProps) {
  return (
    <TrackRow
      track={track}
      index={index}
      showAlbum
      showStatus
      showCover
      isPlaying={isPlaying}
      isCached={isCached}
      downloadState={downloadState}
      onPlay={onPlay}
      onContextMenu={onContextMenu}
      onHoverArtist={onHoverArtist}
    />
  )
}