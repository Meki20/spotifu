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
  const ar = (track.artist || '').trim()
  if (ac && ac.toLowerCase() !== 'unknown artist') return ac
  return ar || ac
}

export function formatDuration(secs: number): string {
  if (!secs && secs !== 0) return ''
  const m = Math.floor(secs / 60)
  const s = Math.floor(secs % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

/** Match a track row from a list (local imports use ``track_id``; MB tracks use ``mb_id``). */
export function indexOfTrackInList(list: any[], track: any): number {
  const tid = track?.track_id ?? track?.id
  if (tid != null) {
    const byId = list.findIndex((t) => (t?.track_id ?? t?.id) === tid)
    if (byId >= 0) return byId
  }
  const mb = (track?.mb_id || track?.mbid || '').trim()
  if (mb) {
    const byMb = list.findIndex((t) => (t?.mb_id || t?.mbid || '').trim() === mb)
    if (byMb >= 0) return byMb
  }
  return -1
}