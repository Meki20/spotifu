import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { PlaylistItemDTO } from '../api/playlists'
import { fetchRecordingCover } from '../api/covers'
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
  onResolved,
  className = 'w-9 h-9 rounded shrink-0',
}: {
  item: PlaylistTrackCoverItem
  onResolved?: (url: string) => void
  /** Tile size / rounding (default matches playlist row). */
  className?: string
}) {
  const recId = recordingMbid(item)
  const primary = resolveTrackArtUrl(item)
  const [primaryBroken, setPrimaryBroken] = useState(false)
  const [mbFailed, setMbFailed] = useState(false)
  const lastEmittedSrcRef = useRef<string | null>(null)
  const onResolvedRef = useRef<typeof onResolved>(onResolved)
  const needMb = Boolean(recId) && (!primary || primaryBroken)

  useEffect(() => {
    onResolvedRef.current = onResolved
  }, [onResolved])

  const { data: recUrl, isLoading } = useQuery({
    queryKey: ['playlist-recording-cover', recId],
    queryFn: () => fetchRecordingCover(recId),
    enabled: needMb,
    staleTime: 30 * 24 * 60 * 60 * 1000,
  })
  const src = primary && !primaryBroken ? primary : recUrl || undefined

  useEffect(() => {
    if (!src) return
    if (lastEmittedSrcRef.current === src) return
    lastEmittedSrcRef.current = src
    onResolvedRef.current?.(src)
  }, [src])

  if (!src || mbFailed) {
    if (needMb && isLoading) {
      return <div className={`${className} animate-pulse bg-[#231815]`} aria-hidden />
    }
    return <div className={`${className} bg-[#231815]`} aria-hidden />
  }

  return (
    <img
      key={src}
      src={src}
      alt=""
      className={`${className} object-cover bg-[#231815]`}
      loading="lazy"
      onError={() => {
        if (primary && !primaryBroken) {
          setMbFailed(false)
          setPrimaryBroken(true)
        } else {
          setMbFailed(true)
        }
      }}
    />
  )
}
