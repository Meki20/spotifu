import { type Track } from '../stores/playerStore'

/** Cover URL from stored URL only (covers resolved server-side). */
export function resolveTrackArtUrl(input: {
  album_cover?: string | null
  mb_release_id?: string | null
  mb_release_group_id?: string | null
}): string | null {
  if (input.album_cover) return input.album_cover
  return null
}

export function toTrack(raw: any, extras?: Partial<Track>): Track {
  const track_id = raw.track_id ?? raw.id ?? undefined
  return {
    mb_id: raw.mb_id ?? raw.mbid ?? '',
    track_id,
    title: raw.title ?? '',
    artist: raw.artist ?? '',
    artist_credit: raw.artist_credit ?? null,
    album: raw.album ?? '',
    album_cover: raw.album_cover ?? raw.cover ?? null,
    preview_url: raw.preview_url ?? null,
    duration: raw.duration ?? 0,
    is_cached: raw.is_cached === true,
    local_stream_url: raw.local_stream_url ?? (raw.is_cached && track_id ? `/stream/${track_id}` : null),
    mb_release_id: raw.mb_release_id || null,
    mb_release_group_id: raw.mb_release_group_id || null,
    mb_artist_id: raw.mb_artist_id ?? null,
    quality: raw.quality ?? null,
    ...extras,
  }
}

export function displayArtist(track: { artist: string; artist_credit?: string | null }): string {
  const ac = (track.artist_credit || '').trim()
  return ac || (track.artist || '')
}

export function formatDuration(secs: number): string {
  if (!secs && secs !== 0) return ''
  const m = Math.floor(secs / 60)
  const s = Math.floor(secs % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}