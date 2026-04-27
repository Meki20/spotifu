import { authFetch } from '../api'

export async function fetchRecordingCover(recordingMbid: string): Promise<string | null> {
  const enc = encodeURIComponent(recordingMbid)
  const res = await authFetch(`/covers/recordings/${enc}`)
  if (!res.ok) return null
  const data = (await res.json()) as { url?: string | null }
  return typeof data.url === 'string' && data.url ? data.url : null
}

export async function fetchReleaseGroupCover(rgMbid: string): Promise<string | null> {
  const enc = encodeURIComponent(rgMbid)
  const res = await authFetch(`/covers/release-groups/${enc}`)
  if (!res.ok) return null
  const data = (await res.json()) as { url?: string | null }
  return typeof data.url === 'string' && data.url ? data.url : null
}

