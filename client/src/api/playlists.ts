import { authFetch, authFetchStream } from '../api'

export interface PlaylistSummary {
  id: number
  title: string
  description?: string | null
  cover_image_url?: string | null
}

export interface PlaylistItemDTO {
  id: number
  position: number
  title: string
  artist: string
  album: string
  mb_recording_id: string
  mb_artist_id: string | null
  mb_release_id: string | null
  mb_release_group_id: string | null
  album_cover: string | null
  track_id: number | null
  is_cached?: boolean
}

export interface PlaylistDetail extends PlaylistSummary {
  items: PlaylistItemDTO[]
}

export async function fetchPlaylistsList(): Promise<PlaylistSummary[]> {
  const res = await authFetch('/playlists')
  if (!res.ok) throw new Error('Failed to fetch playlists')
  return res.json()
}

export async function fetchPlaylistDetail(id: number): Promise<PlaylistDetail> {
  const res = await authFetch(`/playlists/${id}`)
  if (!res.ok) throw new Error('Failed to load playlist')
  return res.json()
}

export async function fetchRecordingCoverFromMb(recordingMbid: string): Promise<string | null> {
  const enc = encodeURIComponent(recordingMbid)
  const res = await authFetch(`/playlists/recordings/${enc}/cover`)
  if (!res.ok) return null
  const data = (await res.json()) as { url?: string | null }
  return typeof data.url === 'string' && data.url ? data.url : null
}

export async function fetchReleaseCoverFromMb(releaseMbid: string): Promise<string | null> {
  const enc = encodeURIComponent(releaseMbid)
  const res = await authFetch(`/playlists/releases/${enc}/cover`)
  if (!res.ok) return null
  const data = (await res.json()) as { url?: string | null }
  return typeof data.url === 'string' && data.url ? data.url : null
}

export async function fetchReleaseGroupCoverFromMb(rgMbid: string): Promise<string | null> {
  const enc = encodeURIComponent(rgMbid)
  const res = await authFetch(`/playlists/release-groups/${enc}/cover`)
  if (!res.ok) return null
  const data = (await res.json()) as { url?: string | null }
  return typeof data.url === 'string' && data.url ? data.url : null
}

export async function createPlaylist(body: {
  title: string
  description?: string | null
  cover_image_url?: string | null
}): Promise<PlaylistSummary> {
  const res = await authFetch('/playlists', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error('Failed to create playlist')
  return res.json()
}

export async function updatePlaylist(
  id: number,
  body: { title?: string | null; description?: string | null; cover_image_url?: string | null },
): Promise<PlaylistSummary> {
  const res = await authFetch(`/playlists/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error('Failed to update playlist')
  return res.json()
}

export async function deletePlaylist(id: number): Promise<void> {
  const res = await authFetch(`/playlists/${id}`, { method: 'DELETE' })
  if (!res.ok) throw new Error('Failed to delete playlist')
}

export interface AddPlaylistItemBody {
  title: string
  artist: string
  album?: string
  mb_recording_id: string
  mb_artist_id?: string | null
  mb_release_id?: string | null
  mb_release_group_id?: string | null
  album_cover?: string | null
  position?: number | null
}

export async function addTrackToPlaylist(
  playlistId: number,
  body: AddPlaylistItemBody,
): Promise<PlaylistItemDTO> {
  const res = await authFetch(`/playlists/${playlistId}/items`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    const msg = typeof data?.detail === 'string' ? data.detail : 'Failed to add track'
    throw new Error(msg)
  }
  return res.json()
}

export async function removeTrackFromPlaylist(
  playlistId: number,
  itemId: number,
): Promise<void> {
  const res = await authFetch(`/playlists/${playlistId}/items/${itemId}`, { method: 'DELETE' })
  if (!res.ok) throw new Error('Failed to remove track')
}

export async function importPlaylistCsv(playlistId: number, file: File): Promise<{
  added: number
  skipped: number
  errors: string[]
  job_id?: number | null
}> {
  const fd = new FormData()
  fd.append('file', file)
  const res = await authFetch(`/playlists/${playlistId}/import/csv`, { method: 'POST', body: fd })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const msg = typeof data?.detail === 'string' ? data.detail : 'Import failed'
    throw new Error(msg)
  }
  return data
}

export interface PlaylistImportJobDTO {
  id: number
  playlist_id: number
  status: string
  created_at: string
  total: number
  matched: number
  unmatched: number
  errored: number
  base_position: number
  error_summary?: string | null
}

export interface PlaylistImportRowDTO {
  id: number
  row_index: number
  desired_position: number
  title: string
  artist: string
  album: string
  query_normalized: string
  state: string
  mb_recording_id?: string | null
  confidence?: number | null
  phase?: string | null
  details_json?: string | null
  error?: string | null
}

export async function fetchPlaylistImportJob(
  playlistId: number,
  jobId: number,
): Promise<PlaylistImportJobDTO> {
  const res = await authFetch(`/playlists/${playlistId}/imports/${jobId}`)
  if (!res.ok) throw new Error('Failed to load import job')
  return res.json()
}

export async function fetchPlaylistImportRows(
  playlistId: number,
  jobId: number,
  opts?: { state?: string; limit?: number; offset?: number },
): Promise<PlaylistImportRowDTO[]> {
  const p = new URLSearchParams()
  if (opts?.state) p.set('state', opts.state)
  if (typeof opts?.limit === 'number') p.set('limit', String(opts.limit))
  if (typeof opts?.offset === 'number') p.set('offset', String(opts.offset))
  const qs = p.toString()
  const res = await authFetch(`/playlists/${playlistId}/imports/${jobId}/rows${qs ? `?${qs}` : ''}`)
  if (!res.ok) throw new Error('Failed to load import rows')
  return res.json()
}

export async function resolvePlaylistImportRow(
  playlistId: number,
  jobId: number,
  rowId: number,
  body: { mb_recording_id: string },
): Promise<PlaylistItemDTO> {
  const res = await authFetch(`/playlists/${playlistId}/imports/${jobId}/rows/${rowId}/resolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const msg = typeof data?.detail === 'string' ? data.detail : 'Failed to resolve import row'
    throw new Error(msg)
  }
  return data
}

export async function rejectPlaylistImportRow(
  playlistId: number,
  jobId: number,
  rowId: number,
): Promise<void> {
  const res = await authFetch(`/playlists/${playlistId}/imports/${jobId}/rows/${rowId}/reject`, {
    method: 'POST',
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    const msg = typeof data?.detail === 'string' ? data.detail : 'Failed to reject suggestion'
    throw new Error(msg)
  }
}

export type CsvImportStreamEvent =
  | { type: 'start'; total: number; job_id?: number }
  | {
      type: 'progress'
      current: number
      total: number
      title: string
      artist: string
      phase: string
      job_id?: number
    }
  | { type: 'added'; title: string; artist: string; mbid: string; phase: string; job_id?: number }
  | {
      type: 'row'
      row_index: number
      state: 'matched' | 'unmatched' | 'error'
      mb_recording_id?: string | null
      confidence?: number | null
      phase?: string | null
      details_json?: string | null
      error?: string | null
      job_id?: number
    }
  | { type: 'done'; total: number; added: number; skipped: number; errors: string[]; job_id?: number }

function parseCsvStreamLine(line: string): CsvImportStreamEvent | null {
  const t = line.trim()
  if (!t) return null
  try {
    return JSON.parse(t) as CsvImportStreamEvent
  } catch {
    return null
  }
}

/** NDJSON stream from POST /playlists/:id/import/csv/stream */
export async function importPlaylistCsvStream(
  playlistId: number,
  file: File,
  onEvent: (e: CsvImportStreamEvent) => void,
  opts?: { signal?: AbortSignal },
): Promise<void> {
  const fd = new FormData()
  fd.append('file', file)
  const res = await authFetchStream(`/playlists/${playlistId}/import/csv/stream`, {
    method: 'POST',
    body: fd,
    signal: opts?.signal,
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    const msg = typeof data?.detail === 'string' ? data.detail : 'Import failed'
    throw new Error(msg)
  }
  if (!res.body) throw new Error('No response body')
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    const parts = buf.split('\n')
    buf = parts.pop() ?? ''
    for (const part of parts) {
      const ev = parseCsvStreamLine(part)
      if (ev) onEvent(ev)
    }
  }
  const tail = parseCsvStreamLine(buf)
  if (tail) onEvent(tail)
}
