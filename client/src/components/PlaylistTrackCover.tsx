import { useEffect, useRef, useState } from 'react'
import type { PlaylistItemDTO } from '../api/playlists'
import { useCoverWhenVisible } from '../hooks/useCoverWhenVisible'
import type { CoverPriority } from '../lib/coverManager'
import { resolveTrackArtUrl } from '../utils/trackHelpers'

/** Same shape as playlist rows or search ``Track`` rows (``mb_id`` = recording MBID). */
export type PlaylistTrackCoverItem = Pick<
  PlaylistItemDTO,
  'album_cover' | 'mb_release_id' | 'mb_release_group_id'
> & {
  mb_recording_id?: string | null
  mb_id?: string | null
}

function recordingMbid(item: PlaylistTrackCoverItem): string {
  return (item.mb_recording_id || item.mb_id || '').trim()
}

export default function PlaylistTrackCover({
  item,
  priority = 'playlist',
  onResolved,
  className = 'w-9 h-9 rounded shrink-0',
}: {
  item: PlaylistTrackCoverItem
  priority?: CoverPriority
  onResolved?: (url: string) => void
  /** Tile size / rounding (default matches playlist row). */
  className?: string
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const recId = recordingMbid(item)
  const primary = resolveTrackArtUrl(item)
  const [primaryBroken, setPrimaryBroken] = useState(false)
  const lastEmittedSrcRef = useRef<string | null>(null)
  const onResolvedRef = useRef<typeof onResolved>(onResolved)

  // Only ask the manager if no usable primary URL.
  const needFromManager = Boolean(recId) && (!primary || primaryBroken)
  const { url: managerUrl, isResolved } = useCoverWhenVisible(containerRef, needFromManager ? recId : '', priority)

  useEffect(() => {
    onResolvedRef.current = onResolved
  }, [onResolved])

  const src = primary && !primaryBroken ? primary : (managerUrl || undefined)

  useEffect(() => {
    if (!src) return
    if (lastEmittedSrcRef.current === src) return
    lastEmittedSrcRef.current = src
    onResolvedRef.current?.(src)
  }, [src])

  if (!src) {
    if (needFromManager && !isResolved) {
      return <div ref={containerRef} className={`${className} animate-pulse bg-[#231815]`} aria-hidden />
    }
    return <div ref={containerRef} className={`${className} bg-[#231815]`} aria-hidden />
  }

  return (
    <div ref={containerRef}>
      <img
        key={src}
        src={src}
        alt=""
        className={`${className} object-cover bg-[#231815]`}
        loading="lazy"
        onError={() => {
          if (primary && !primaryBroken) {
            setPrimaryBroken(true)
          }
        }}
      />
    </div>
  )
}
