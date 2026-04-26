import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { PlaylistItemDTO } from '../api/playlists'
import { fetchRecordingCoverFromMb } from '../api/playlists'
import { resolveTrackArtUrl } from '../utils/trackHelpers'

export default function PlaylistTrackCover({ item }: { item: PlaylistItemDTO }) {
  const primary = resolveTrackArtUrl(item)
  const [primaryBroken, setPrimaryBroken] = useState(false)
  const [mbFailed, setMbFailed] = useState(false)
  const needMb = Boolean(item.mb_recording_id) && (!primary || primaryBroken)
  const { data: mbUrl, isLoading } = useQuery({
    queryKey: ['playlist-recording-cover', item.mb_recording_id],
    queryFn: () => fetchRecordingCoverFromMb(item.mb_recording_id),
    enabled: needMb,
    staleTime: 7 * 24 * 60 * 60 * 1000,
  })
  const src = primary && !primaryBroken ? primary : mbUrl || undefined

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
