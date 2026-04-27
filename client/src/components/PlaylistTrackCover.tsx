import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { PlaylistItemDTO } from '../api/playlists'
import { fetchRecordingCover } from '../api/covers'
import { resolveTrackArtUrl } from '../utils/trackHelpers'

export default function PlaylistTrackCover({
  item,
  onResolved,
}: {
  item: PlaylistItemDTO
  onResolved?: (url: string) => void
}) {
  const primary = resolveTrackArtUrl(item)
  const [primaryBroken, setPrimaryBroken] = useState(false)
  const [mbFailed, setMbFailed] = useState(false)
  const lastEmittedSrcRef = useRef<string | null>(null)
  const onResolvedRef = useRef<typeof onResolved>(onResolved)
  const needMb = Boolean(item.mb_recording_id) && (!primary || primaryBroken)

  useEffect(() => {
    onResolvedRef.current = onResolved
  }, [onResolved])

  const { data: recUrl, isLoading } = useQuery({
    queryKey: ['playlist-recording-cover', item.mb_recording_id],
    queryFn: () => fetchRecordingCover(item.mb_recording_id),
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
      return <div className="w-9 h-9 rounded shrink-0 animate-pulse bg-[#231815]" aria-hidden />
    }
    return <div className="w-9 h-9 rounded shrink-0 bg-[#231815]" aria-hidden />
  }

  return (
    <img
      key={src}
      src={src}
      alt=""
      className="w-9 h-9 rounded object-cover shrink-0 bg-[#231815]"
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
