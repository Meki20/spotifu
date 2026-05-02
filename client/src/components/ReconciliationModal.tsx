import { useState, useEffect, useRef } from 'react'
import { X, ChevronLeft, ChevronRight, Check, XCircle, Loader2, Pencil, Search, ChevronDown, ChevronUp } from 'lucide-react'
import { authFetch } from '../api'
import { fetchReleaseGroupCover } from '../api/covers'

interface ReconciliationTrack {
  id: number
  title: string
  artist: string
  artist_credit: string | null
  album: string
  mb_id: string | null
  mb_artist_id: string | null
  mb_release_id: string | null
  mb_release_group_id: string | null
  missing_fields: string[]
}

interface ReconciliationResponse {
  tracks: ReconciliationTrack[]
  total: number
  page: number
  page_size: number
  total_pages: number
}

interface DownloadedTrack {
  id: number
  title: string
  artist: string
  artist_credit: string | null
  album: string
  status: string
  mb_id: string | null
}

interface DownloadedTracksResponse {
  tracks: DownloadedTrack[]
}

interface MatchResult {
  track_id: number
  original_title: string
  original_artist: string
  original_artist_credit: string | null
  original_album: string
  original_mb_release_group_id: string | null
  original_tags: string | null
  matched_title: string | null
  matched_artist: string | null
  matched_artist_credit: string | null
  matched_album: string | null
  mb_id: string | null
  mb_artist_id: string | null
  mb_release_id: string | null
  mb_release_group_id: string | null
  mb_score: number | null
  phase: string | null
  matched: boolean
  tags: string | null
}

interface ApplyResult {
  track_id: number
  old_title: string
  old_artist: string
  old_artist_credit: string | null
  old_album: string
  new_title: string
  new_artist: string
  new_artist_credit: string | null
  new_album: string
  old_cover_art: string | null
  new_cover_art: string | null
}

type Props = {
  open: boolean
  onClose: () => void
}

export default function ReconciliationModal({ open, onClose }: Props) {
  const [page, setPage] = useState(1)
  const [trackPage, setTrackPage] = useState(1)
  const [totalPages, setTotalPages] = useState(1)
  const [totalTracks, setTotalTracks] = useState(0)
  const [tracks, setTracks] = useState<ReconciliationTrack[]>([])
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [loading, setLoading] = useState(false)
  const [resolving, setResolving] = useState(false)
  const [processedCount, setProcessedCount] = useState(0)
  const [resolveResults, setResolveResults] = useState<MatchResult[]>([])
  const [decisions, setDecisions] = useState<Record<number, 'accept' | 'reject' | null>>({})
  const [applyResults, setApplyResults] = useState<ApplyResult[]>([])
  const [coverArt, setCoverArt] = useState<Record<number, { old: string | null; new: string | null }>>({})
  const [applying, setApplying] = useState(false)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [manualMbId, setManualMbId] = useState('')
  const [mbidLoading, setMbidLoading] = useState(false)
  const [editedTags, setEditedTags] = useState<Record<number, string[]>>({})
  const [addingTagId, setAddingTagId] = useState<number | null>(null)
  const [newTagInput, setNewTagInput] = useState('')

  const [additionalExpanded, setAdditionalExpanded] = useState(false)
  const [additionalTracks, setAdditionalTracks] = useState<DownloadedTrack[]>([])
  const [additionalLoading, setAdditionalLoading] = useState(false)
  const [additionalSearch, setAdditionalSearch] = useState('')
  const [additionalOffset, setAdditionalOffset] = useState(0)
  const [additionalHasMore, setAdditionalHasMore] = useState(true)
  const additionalSearchTimeoutRef = useRef<number | null>(null)
  const resolutionControllerRef = useRef<AbortController | null>(null)

  useEffect(() => {
    if (open) {
      setPage(1)
      setTrackPage(1)
      setResolveResults([])
      setDecisions({})
      setApplyResults([])
      setSelected(new Set())
      setAdditionalExpanded(false)
      setAdditionalTracks([])
      setAdditionalSearch('')
      setAdditionalOffset(0)
      fetchTracksAndSelect(1)
    }
  }, [open])

  useEffect(() => {
    if (additionalExpanded && additionalTracks.length === 0 && !additionalLoading) {
      fetchAdditionalTracks(true)
    }
  }, [additionalExpanded])

  async function fetchTracksAndSelect(pageNum: number) {
    setLoading(true)
    try {
      const res = await authFetch(`/settings/reconciliation/tracks?page=${pageNum}&page_size=20`)
      const data = (await res.json()) as ReconciliationResponse
      setTracks(data.tracks)
      setTotalPages(data.total_pages)
      setTotalTracks(data.total)
      if (pageNum === 1 && selected.size === 0) {
        setSelected(new Set(data.tracks.map((t) => t.id)))
      }
    } catch (err) {
      console.error(err)
    } finally {
      setLoading(false)
    }
  }

  

  function toggleTrack(id: number) {
    const next = new Set(selected)
    if (next.has(id)) {
      next.delete(id)
    } else {
      next.add(id)
    }
    setSelected(next)
  }

  function selectAll() {
    setSelected(new Set(tracks.map((t) => t.id)))
  }

  function deselectAll() {
    setSelected(new Set())
  }

  async function fetchAdditionalTracks(reset = false) {
    if (reset) {
      setAdditionalOffset(0)
      setAdditionalTracks([])
    }
    setAdditionalLoading(true)
    try {
      const excludeIds = Array.from(selected).join(',')
      const res = await authFetch(
        `/settings/tracks?limit=20&offset=${reset ? 0 : additionalOffset}&search=${encodeURIComponent(additionalSearch)}&exclude_ids=${excludeIds}`
      )
      const data = (await res.json()) as DownloadedTracksResponse
      if (reset) {
        setAdditionalTracks(data.tracks)
      } else {
        setAdditionalTracks((prev) => [...prev, ...data.tracks])
      }
      setAdditionalOffset((reset ? 0 : additionalOffset) + data.tracks.length)
      setAdditionalHasMore(data.tracks.length === 20)
    } catch (err) {
      console.error(err)
    } finally {
      setAdditionalLoading(false)
    }
  }

  function handleAdditionalSearchChange(value: string) {
    setAdditionalSearch(value)
    if (additionalSearchTimeoutRef.current) {
      window.clearTimeout(additionalSearchTimeoutRef.current)
    }
    additionalSearchTimeoutRef.current = window.setTimeout(() => {
      fetchAdditionalTracks(true)
    }, 400)
  }

  function toggleAdditionalTrack(id: number) {
    const next = new Set(selected)
    if (next.has(id)) {
      next.delete(id)
    } else {
      next.add(id)
    }
    setSelected(next)
  }

  async function loadMoreAdditional() {
    if (!additionalLoading && additionalHasMore) {
      await fetchAdditionalTracks(false)
    }
  }

  async function runResolution() {
    resolutionControllerRef.current = new AbortController()
    const controller = resolutionControllerRef.current
    setResolving(true)
    setPage(2)
    setResolveResults([])
    setProcessedCount(0)
    setCoverArt({})

    try {
      const response = await authFetch('/settings/reconciliation/resolve/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ track_ids: Array.from(selected) }),
        signal: controller.signal,
      })

      if (!response.ok) {
        const errText = await response.text()
        console.error('Resolve failed:', response.status, errText)
        alert(`Resolve failed: ${response.status} - ${errText}`)
        setResolving(false)
        return
      }

      const reader = response.body?.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      while (reader) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          try {
            const data = JSON.parse(line.slice(6))
            if (data.type === 'start') {
              // Total tracks announced
            } else if (data.type === 'result') {
              const result = data.result as MatchResult
              setResolveResults(prev => {
                const existing = prev.findIndex(r => r.track_id === result.track_id)
                if (existing >= 0) {
                  const updated = [...prev]
                  updated[existing] = result
                  return updated
                }
                return [...prev, result]
              })
              setProcessedCount(prev => prev + 1)

              // Fetch cover art for this result
              if (result.original_mb_release_group_id && !coverArt[result.track_id]?.old) {
                const oldUrl = await fetchReleaseGroupCover(result.original_mb_release_group_id)
                setCoverArt(prev => ({
                  ...prev,
                  [result.track_id]: { ...prev[result.track_id], old: oldUrl }
                }))
              }
              if (result.matched && result.mb_release_group_id && !coverArt[result.track_id]?.new) {
                const newUrl = await fetchReleaseGroupCover(result.mb_release_group_id)
                setCoverArt(prev => ({
                  ...prev,
                  [result.track_id]: { ...prev[result.track_id], new: newUrl }
                }))
              }
            } else if (data.type === 'done') {
              break
            }
          } catch (e) {
            console.error('Failed to parse SSE message:', e)
          }
        }
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        console.log('Resolution cancelled')
      } else {
        console.error('Resolve error:', err)
        alert(`Resolve error: ${err}`)
      }
    } finally {
      setResolving(false)
    }
  }

  useEffect(() => {
    return () => {
      if (resolutionControllerRef.current) {
        resolutionControllerRef.current.abort()
      }
      setResolving(false)
    }
  }, [])

  async function acceptMatch(result: MatchResult) {
    if (!result.matched || !result.mb_id) return

    setDecisions((d) => ({ ...d, [result.track_id]: 'accept' }))

    setApplying(true)
    try {
      const res = await authFetch('/settings/reconciliation/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          track_id: result.track_id,
          title: result.matched_title || result.original_title || '',
          artist: result.matched_artist || result.original_artist || '',
          artist_credit: result.matched_artist_credit,
          album: result.matched_album || result.original_album || '',
          mb_id: result.mb_id || null,
          mb_artist_id: result.mb_artist_id,
          mb_release_id: result.mb_release_id,
          mb_release_group_id: result.mb_release_group_id,
          release_date: null,
          tags: JSON.stringify(editedTags[result.track_id] ?? getResultTags(result)),
        }),
      })

      if (!res.ok) {
        const errText = await res.text()
        console.error('Apply failed:', res.status, errText)
      }

      const newCoverArt = result.mb_release_group_id
        ? await fetchReleaseGroupCover(result.mb_release_group_id)
        : null

      setCoverArt((prev) => ({
        ...prev,
        [result.track_id]: { old: prev[result.track_id]?.old ?? null, new: newCoverArt },
      }))

      setApplyResults((prev) => [
        ...prev,
        {
          track_id: result.track_id,
          old_title: result.original_title,
          old_artist: result.original_artist,
          old_artist_credit: result.original_artist_credit,
          old_album: result.original_album,
          new_title: result.matched_title || result.original_title,
          new_artist: result.matched_artist || result.original_artist,
          new_artist_credit: result.matched_artist_credit,
          new_album: result.matched_album || result.original_album,
          old_cover_art: null,
          new_cover_art: newCoverArt,
        },
      ])
    } catch (err) {
      console.error(err)
    } finally {
      setApplying(false)
    }
  }

  function rejectMatch(result: MatchResult) {
    setDecisions((d) => ({ ...d, [result.track_id]: 'reject' }))
  }

  function getResultTags(result: MatchResult): string[] {
    if (editedTags[result.track_id]) return editedTags[result.track_id]
    try {
      const tags = JSON.parse(result.tags || '[]')
      return Array.isArray(tags) ? tags : []
    } catch {
      return []
    }
  }

  function removeTag(result: MatchResult, tagToRemove: string) {
    const currentTags = getResultTags(result)
    setEditedTags((prev) => ({
      ...prev,
      [result.track_id]: currentTags.filter((t) => t !== tagToRemove),
    }))
  }

  function addTag(result: MatchResult) {
    const trimmed = newTagInput.trim()
    if (!trimmed) return
    const currentTags = getResultTags(result)
    if (currentTags.includes(trimmed)) {
      setNewTagInput('')
      setAddingTagId(null)
      return
    }
    setEditedTags((prev) => ({
      ...prev,
      [result.track_id]: [...currentTags, trimmed],
    }))
    setNewTagInput('')
    setAddingTagId(null)
  }

  async function handleManualMbidSearch(result: MatchResult) {
    if (!manualMbId.trim()) return

    setMbidLoading(true)
    try {
      const res = await authFetch('/search/mb/recording/' + manualMbId.trim(), {
        method: 'GET',
      })
      if (!res.ok) throw new Error('Failed to fetch MB recording')
      const meta = await res.json()

      if (meta && meta.mbid) {
        const updatedResult = {
          ...result,
          matched_title: meta.title,
          matched_artist: meta.artist,
          matched_artist_credit: meta.artist_credit,
          matched_album: meta.album,
          mb_id: meta.mbid,
          mb_artist_id: meta.mb_artist_id || null,
          mb_release_id: meta.mb_release_id || null,
          mb_release_group_id: meta.mb_release_group_id || null,
          mb_score: null,
          phase: 'Set by user',
          matched: true,
        }

setResolveResults(prev => prev.map(r => r.track_id === result.track_id ? updatedResult : r))
        setEditingId(null)
        setManualMbId('')
      }
    } catch (err) {
      console.error('MBID lookup failed:', err)
      alert('Failed to resolve MBID')
    } finally {
      setMbidLoading(false)
    }
  }

  const acceptedCount = Object.values(decisions).filter((d) => d === 'accept').length
  const rejectedCount = Object.values(decisions).filter((d) => d === 'reject').length
  const pendingCount = resolveResults.length - acceptedCount - rejectedCount

  if (!open) return null

  return (
<div
        className="fixed inset-0 z-50 flex items-start justify-center pt-4 pb-24 px-4"
        style={{ background: 'rgba(0,0,0,0.8)', overflowY: 'auto' }}
      >
        <div
          className="w-full max-w-3xl max-h-[calc(100vh-140px)] flex flex-col rounded-lg overflow-hidden"
          style={{ background: '#1A1210', border: '1px solid #3D2820' }}
        >
          {/* Header */}
          <div
            className="flex items-center justify-between px-4 py-2 shrink-0"
            style={{ borderBottom: '1px solid #3D2820' }}
          >
            <h2
              className="text-lg font-bold"
              style={{ fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 800, color: '#E8DDD0', letterSpacing: '0.02em' }}
            >
              RECONCILE
            </h2>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-[#3D2820]"
            style={{ color: '#9A8E84' }}
          >
            <X size={20} />
          </button>
        </div>

        {/* Page indicator */}
        <div className="flex items-center justify-center gap-3 py-2 shrink-0" style={{ borderBottom: '1px solid #3D2820' }}>
          <div
            className="w-8 h-8 rounded flex items-center justify-center text-sm font-semibold"
            style={{
              background: page >= 1 ? '#b4003e' : '#3D2820',
              color: page >= 1 ? '#E8DDD0' : '#6B5E56',
              fontFamily: "'Barlow Condensed', sans-serif",
            }}
          >
            1
          </div>
          <div
            className="w-8 h-8 rounded flex items-center justify-center text-sm font-semibold"
            style={{
              background: page >= 2 ? '#b4003e' : '#3D2820',
              color: page >= 2 ? '#E8DDD0' : '#6B5E56',
              fontFamily: "'Barlow Condensed', sans-serif",
            }}
          >
            2
          </div>
          <div
            className="w-8 h-8 rounded flex items-center justify-center text-sm font-semibold"
            style={{
              background: page >= 3 ? '#b4003e' : '#3D2820',
              color: page >= 3 ? '#E8DDD0' : '#6B5E56',
              fontFamily: "'Barlow Condensed', sans-serif",
            }}
          >
            3
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-3">
          {page === 1 && (
            <>
              <p className="text-sm mb-4" style={{ fontFamily: "'Barlow Semi Condensed', sans-serif", color: '#9A8E84' }}>
                {totalTracks} tracks need reconciliation. Select the ones you want to resolve against MusicBrainz.
              </p>

              {loading ? (
                <div className="flex items-center gap-2 py-8 justify-center">
                  <Loader2 className="animate-spin" size={24} style={{ color: '#b4003e' }} />
                  <span style={{ fontFamily: "'Barlow Semi Condensed', sans-serif", color: '#9A8E84' }}>Loading tracks...</span>
                </div>
              ) : (
                <>
                  <div className="space-y-2 mb-4">
                    {tracks.map((track) => (
                      <label
                        key={track.id}
                        className="flex items-center gap-3 p-3 rounded cursor-pointer"
                        style={{ background: '#231815', border: '1px solid #3D2820' }}
                      >
                        <input
                          type="checkbox"
                          checked={selected.has(track.id)}
                          onChange={() => toggleTrack(track.id)}
                          className="w-4 h-4"
                          style={{ accentColor: '#b4003e' }}
                        />
                        <div className="flex-1 min-w-0">
                          <p className="text-sm truncate" style={{ fontFamily: "'Barlow Semi Condensed', sans-serif", color: '#E8DDD0' }}>
                            {track.title}
                          </p>
                          <p className="text-xs truncate" style={{ fontFamily: "'Barlow Semi Condensed', sans-serif", color: '#9A8E84' }}>
                            {track.artist} — {track.album}
                          </p>
                          <p className="text-xs" style={{ fontFamily: "'Barlow Semi Condensed', sans-serif", color: '#b4003e' }}>
                            Missing: {track.missing_fields.join(', ')}
                          </p>
                        </div>
                      </label>
                    ))}
                  </div>

                  {/* Pagination */}
                  <div className="flex items-center justify-between mb-4">
                    <button
                      onClick={() => { const p = Math.max(1, trackPage - 1); setTrackPage(p); fetchTracksAndSelect(p); }}
                      disabled={trackPage <= 1}
                      className="p-2 rounded disabled:opacity-50"
                      style={{ color: '#9A8E84' }}
                    >
                      <ChevronLeft size={20} />
                    </button>
                    <span style={{ fontFamily: "'Barlow Semi Condensed', sans-serif", color: '#9A8E84' }}>
                      Page {trackPage} of {totalPages}
                    </span>
                    <button
                      onClick={() => { const p = Math.min(totalPages, trackPage + 1); setTrackPage(p); fetchTracksAndSelect(p); }}
                      disabled={trackPage >= totalPages}
                      className="p-2 rounded disabled:opacity-50"
                      style={{ color: '#9A8E84' }}
                    >
                      <ChevronRight size={20} />
                    </button>
                  </div>

                  <div className="mt-6 pt-4" style={{ borderTop: '1px solid #3D2820' }}>
                    <button
                      onClick={() => setAdditionalExpanded(!additionalExpanded)}
                      className="flex items-center justify-between w-full p-3 rounded"
                      style={{
                        background: '#1A1210',
                        border: '1px solid #3D2820',
                      }}
                    >
                      <div className="flex items-center gap-2">
                        {additionalExpanded ? <ChevronUp size={16} style={{ color: '#b4003e' }} /> : <ChevronDown size={16} style={{ color: '#9A8E84' }} />}
                        <span style={{ fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 600, color: '#E8DDD0', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                          Additional Tracks
                        </span>
                        {selected.size > 0 && (
                          <span
                            className="text-xs px-1.5 py-0.5 rounded"
                            style={{ fontFamily: "'Barlow Semi Condensed', sans-serif", background: '#b4003e', color: '#E8DDD0' }}
                          >
                            {selected.size} selected
                          </span>
                        )}
                      </div>
                      {!additionalExpanded && (
                        <span style={{ fontFamily: "'Barlow Semi Condensed', sans-serif", color: '#6B5E56', fontSize: '0.75rem' }}>
                          {additionalTracks.length > 0 ? `${additionalTracks.length} loaded` : 'click to browse'}
                        </span>
                      )}
                    </button>

                    {additionalExpanded && (
                      <div className="mt-3 space-y-3">
                        <div className="flex items-center gap-2">
                          <input
                            type="text"
                            value={additionalSearch}
                            onChange={(e) => handleAdditionalSearchChange(e.target.value)}
                            placeholder="Search tracks..."
                            className="flex-1 px-3 py-2 text-sm rounded"
                            style={{
                              background: '#1A1210',
                              border: '1px solid #3D2820',
                              color: '#E8DDD0',
                              fontFamily: "'Barlow Semi Condensed', sans-serif",
                            }}
                          />
                        </div>

                        {additionalLoading && additionalTracks.length === 0 ? (
                          <div className="flex items-center gap-2 py-4 justify-center">
                            <Loader2 className="animate-spin" size={20} style={{ color: '#b4003e' }} />
                            <span style={{ fontFamily: "'Barlow Semi Condensed', sans-serif", color: '#9A8E84' }}>Loading...</span>
                          </div>
                        ) : additionalTracks.length === 0 ? (
                          <div className="py-4 text-center" style={{ fontFamily: "'Barlow Semi Condensed', sans-serif", color: '#6B5E56' }}>
                            No additional tracks found
                          </div>
                        ) : (
                          <>
                            <div className="space-y-2 max-h-48 overflow-y-auto">
                              {additionalTracks.map((track) => (
                                <label
                                  key={track.id}
                                  className="flex items-center gap-3 p-2 rounded cursor-pointer"
                                  style={{ background: '#231815', border: '1px solid #3D2820' }}
                                >
                                  <input
                                    type="checkbox"
                                    checked={selected.has(track.id)}
                                    onChange={() => toggleAdditionalTrack(track.id)}
                                    className="w-4 h-4"
                                    style={{ accentColor: '#b4003e' }}
                                  />
                                  <div className="flex-1 min-w-0">
                                    <p className="text-sm truncate" style={{ fontFamily: "'Barlow Semi Condensed', sans-serif", color: '#E8DDD0' }}>
                                      {track.title}
                                    </p>
                                    <p className="text-xs truncate" style={{ fontFamily: "'Barlow Semi Condensed', sans-serif", color: '#9A8E84' }}>
                                      {track.artist} — {track.album}
                                    </p>
                                  </div>
                                </label>
                              ))}
                            </div>

                            {additionalHasMore && (
                              <button
                                onClick={loadMoreAdditional}
                                disabled={additionalLoading}
                                className="w-full py-2 text-xs border rounded"
                                style={{
                                  fontFamily: "'Barlow Condensed', sans-serif",
                                  color: '#9A8E84',
                                  borderColor: '#3D2820',
                                }}
                              >
                                {additionalLoading ? 'Loading...' : 'Load more'}
                              </button>
                            )}
                          </>
                        )}
                      </div>
                    )}
                  </div>

                  <div className="flex items-center justify-between">
                    <div className="flex gap-2">
                      <button
                        onClick={deselectAll}
                        className="px-3 py-1.5 text-xs border rounded"
                        style={{ fontFamily: "'Barlow Condensed', sans-serif", color: '#9A8E84', borderColor: '#3D2820' }}
                      >
                        Deselect All
                      </button>
                      <button
                        onClick={selectAll}
                        className="px-3 py-1.5 text-xs border rounded"
                        style={{ fontFamily: "'Barlow Condensed', sans-serif", color: '#9A8E84', borderColor: '#3D2820' }}
                      >
                        Select All
                      </button>
                    </div>
                    <button
                      onClick={runResolution}
                      disabled={selected.size === 0 || resolving}
                      className="px-6 py-2 text-sm font-semibold rounded transition-colors"
                      style={{
                        fontFamily: "'Barlow Condensed', sans-serif",
                        fontWeight: 600,
                        textTransform: 'uppercase',
                        letterSpacing: '0.05em',
                        background: selected.size === 0 ? '#3D2820' : '#b4003e',
                        color: selected.size === 0 ? '#6B5E56' : '#E8DDD0',
                        cursor: selected.size === 0 ? 'not-allowed' : 'pointer',
                      }}
                    >
                      {resolving ? (
                        <span className="flex items-center gap-2">
                          <Loader2 className="animate-spin" size={16} />
                          Resolving...
                        </span>
                      ) : (
                        `Run (${selected.size}) →`
                      )}
                    </button>
                  </div>
                </>
              )}
            </>
          )}

          {page === 2 && (
            <>
              <div className="flex items-center justify-between mb-2">
                <button
                  onClick={() => setPage(1)}
                  className="flex items-center gap-1 px-2 py-1 text-xs border rounded"
                  style={{ fontFamily: "'Barlow Condensed', sans-serif", color: '#9A8E84', borderColor: '#3D2820' }}
                >
                  <ChevronLeft size={14} />
                  Back
                </button>
                <div className="flex items-center gap-2">
                  {resolving && (
                    <div className="flex items-center gap-2" style={{ color: '#b4003e' }}>
                      <Loader2 className="animate-spin" size={14} />
                      <span style={{ fontFamily: "'Barlow Semi Condensed', sans-serif", fontSize: '0.75rem' }}>
                        {processedCount}/{selected.size}
                      </span>
                    </div>
                  )}
                  <span className="text-xs" style={{ fontFamily: "'Barlow Semi Condensed', sans-serif", color: '#9A8E84' }}>
                    {resolveResults.filter((r) => r.matched).length} found • {resolveResults.filter((r) => !r.matched).length} no match
                  </span>
                </div>
              </div>

              <div className="space-y-2 mb-4">
                {resolveResults.map((result) => {
                  const decision = decisions[result.track_id]
                  return (
                    <div
                      key={result.track_id}
                      className="p-3 rounded"
                      style={{
                        background: decision === 'accept' ? 'rgba(180, 0, 62, 0.1)' : decision === 'reject' ? 'rgba(61, 40, 32, 0.5)' : '#231815',
                        border: `1px solid ${decision === 'accept' ? 'rgba(180, 0, 62, 0.3)' : decision === 'reject' ? '#3D2820' : '#3D2820'}`,
                        opacity: decision === 'reject' ? 0.5 : 1,
                      }}
                    >
                      <div className="flex items-start justify-between gap-4">
                        <div className="flex items-start gap-3 flex-1 min-w-0">
                          <div
                            className="w-12 h-12 rounded shrink-0 overflow-hidden"
                            style={{ background: '#1A1210', border: '1px solid #3D2820' }}
                          >
                            {result.original_mb_release_group_id &&
                              coverArt[result.track_id]?.old ? (
                              <img
                                src={coverArt[result.track_id].old!}
                                alt="Cover"
                                className="w-full h-full object-cover"
                              />
                            ) : (
                              <div className="w-full h-full flex items-center justify-center" style={{ color: '#3D2820' }}>
                                <span className="text-xs" style={{ fontFamily: "'Barlow Condensed', sans-serif" }}>—</span>
                              </div>
                            )}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-1 mb-0.5">
                              <p className="text-xs truncate" style={{ fontFamily: "'Barlow Semi Condensed', sans-serif", color: '#E8DDD0' }}>
                                {result.original_title}
                              </p>
                            </div>
                            <p className="text-xs truncate" style={{ fontFamily: "'Barlow Semi Condensed', sans-serif", color: '#9A8E84' }}>
                              {result.original_artist}
                            </p>
                            {result.original_artist_credit && (
                              <p className="text-xs truncate" style={{ fontFamily: "'Barlow Semi Condensed', sans-serif", color: '#6B5E56' }}>
                                {result.original_artist_credit}
                              </p>
                            )}
                            {result.original_tags && (() => {
                              try {
                                const tags = JSON.parse(result.original_tags)
                                return Array.isArray(tags) && tags.length > 0 ? (
                                  <div className="flex flex-wrap gap-1 mt-0.5">
                                    {tags.map((tag: string) => (
                                      <span
                                        key={tag}
                                        className="text-xs px-1 py-0.5 rounded"
                                        style={{ background: '#3D2820', color: '#9A8E84', fontFamily: "'Barlow Semi Condensed', sans-serif" }}
                                      >
                                        {tag}
                                      </span>
                                    ))}
                                  </div>
                                ) : null
                              } catch {
                                return null
                              }
                            })()}
                          </div>
                        </div>
                        <div style={{ color: '#6B5E56', fontSize: 16 }}>→</div>
                        <div className="flex items-start gap-2 flex-1 min-w-0">
                          <div
                            className="w-12 h-12 rounded shrink-0 overflow-hidden"
                            style={{ background: '#1A1210', border: '1px solid #3D2820' }}
                          >
                            {result.matched && result.mb_release_group_id && coverArt[result.track_id]?.new ? (
                              <img
                                src={coverArt[result.track_id].new!}
                                alt="Cover"
                                className="w-full h-full object-cover"
                              />
                            ) : !result.matched || !result.mb_release_group_id ? (
                              <div className="w-full h-full flex items-center justify-center" style={{ color: '#3D2820' }}>
                                <span className="text-xs" style={{ fontFamily: "'Barlow Condensed', sans-serif" }}>—</span>
                              </div>
                            ) : (
                              <div className="w-full h-full flex items-center justify-center" style={{ color: '#3D2820' }}>
                                <Loader2 className="animate-spin" size={16} />
                              </div>
                            )}
                          </div>
                          <div className="flex-1 min-w-0">
                            {result.matched ? (
                              <>
                                <div className="flex items-center gap-1 mb-0.5">
                                  <p className="text-xs truncate" style={{ fontFamily: "'Barlow Semi Condensed', sans-serif", color: '#E8DDD0' }}>
                                    {result.matched_title}
                                  </p>
                                </div>
                                <p className="text-xs truncate" style={{ fontFamily: "'Barlow Semi Condensed', sans-serif", color: '#9A8E84' }}>
                                  {result.matched_artist}
                                </p>
                                {result.matched_artist_credit && (
                                  <p className="text-xs truncate" style={{ fontFamily: "'Barlow Semi Condensed', sans-serif", color: '#6B5E56' }}>
                                    {result.matched_artist_credit}
                                  </p>
                                )}
                                <p className="text-xs truncate" style={{ fontFamily: "'Barlow Semi Condensed', sans-serif", color: '#6B5E56' }}>
                                  {result.matched_album}
                                </p>
                                <p className="text-xs" style={{ fontFamily: "'Barlow Semi Condensed', sans-serif", color: '#6B5E56' }}>
                                  {result.phase === 'Set by user' ? 'Manual' : result.mb_score != null ? `Score: ${result.mb_score}%` : null}
                                </p>
                                <div className="flex flex-wrap gap-1 mt-0.5">
                                  {getResultTags(result).map((tag: string) => (
                                    <span
                                      key={tag}
                                      className="group relative text-xs px-1 py-0.5 rounded flex items-center gap-0.5 cursor-pointer"
                                      style={{ background: '#b4003e33', color: '#E8DDD0', fontFamily: "'Barlow Semi Condensed', sans-serif" }}
                                      onClick={() => removeTag(result, tag)}
                                      title="Click to remove"
                                    >
                                      <span className="group-hover:brightness-150 transition-all">{tag}</span>
                                      <span className="opacity-0 group-hover:opacity-100 transition-opacity ml-0.5" style={{ color: '#E8DDD0' }}>
                                        <X size={10} />
                                      </span>
                                    </span>
                                  ))}
                                  {addingTagId === result.track_id ? (
                                    <input
                                      type="text"
                                      value={newTagInput}
                                      onChange={(e) => setNewTagInput(e.target.value)}
                                      onKeyDown={(e) => { if (e.key === 'Enter') addTag(result); if (e.key === 'Escape') { setAddingTagId(null); setNewTagInput('') } }}
                                      onBlur={() => { addTag(result) }}
                                      autoFocus
                                      className="w-20 px-1 py-0.5 text-xs rounded"
                                      style={{ background: '#1A1210', border: '1px solid #b4003e', color: '#E8DDD0', fontFamily: "'Barlow Semi Condensed', sans-serif" }}
                                    />
                                  ) : (
                                    <button
                                      onClick={() => setAddingTagId(result.track_id)}
                                      className="text-xs px-1 py-0.5 rounded"
                                      style={{ background: '#3D2820', color: '#9A8E84', fontFamily: "'Barlow Semi Condensed', sans-serif" }}
                                    >
                                      +
                                    </button>
                                  )}
                                  {getResultTags(result).length > 0 && (
                                    <button
                                      onClick={() => setEditedTags((prev) => ({ ...prev, [result.track_id]: [] }))}
                                      className="text-xs px-1 py-0.5 rounded"
                                      style={{ background: '#3D2820', color: '#6B5E56', fontFamily: "'Barlow Semi Condensed', sans-serif" }}
                                      title="Clear all tags"
                                    >
                                      Clear
                                    </button>
                                  )}
                                </div>
                              </>
                            ) : (
                              <>
                                <p className="text-xs" style={{ fontFamily: "'Barlow Semi Condensed', sans-serif", color: '#9A8E84' }}>
                                  No match
                                </p>
                                {!decision && (
                                  <button
                                    onClick={() => { setEditingId(result.track_id); setManualMbId('') }}
                                    className="flex items-center gap-1 mt-2 text-xs"
                                    style={{ fontFamily: "'Barlow Condensed', sans-serif", color: '#b4003e' }}
                                  >
                                    <Pencil size={12} />
                                    Enter MBID manually
                                  </button>
                                )}
                              </>
                            )}
                          </div>
                        </div>
                      </div>

                      {!decision && result.matched && (
                        <div className="flex items-center gap-1.5 mt-2">
                          <button
                            onClick={() => acceptMatch(result)}
                            disabled={applying}
                            className="p-1 rounded"
                            style={{ background: '#b4003e', color: '#E8DDD0' }}
                            title="Accept"
                          >
                            <Check size={14} />
                          </button>
                          <button
                            onClick={() => rejectMatch(result)}
                            className="p-1.5 rounded"
                            style={{ background: '#3D2820', color: '#9A8E84' }}
                            title="Reject"
                          >
                            <XCircle size={16} />
                          </button>
                          {result.mb_score != null && (
                            <button
                              onClick={() => { setEditingId(result.track_id); setManualMbId(result.mb_id || '') }}
                              className="p-1.5 rounded"
                              style={{ background: '#3D2820', color: '#9A8E84' }}
                              title="Edit MBID"
                            >
                              <Pencil size={16} />
                            </button>
                          )}
                        </div>
                      )}

                      {editingId === result.track_id && result.mb_score != null && (
                        <div className="mt-3 p-3 rounded" style={{ background: '#231815', border: '1px solid #3D2820' }}>
                          <div className="flex items-center gap-2">
                            <input
                              type="text"
                              value={manualMbId}
                              onChange={(e) => setManualMbId(e.target.value)}
                              placeholder="Enter MB recording ID"
                              className="flex-1 px-3 py-1.5 text-xs rounded"
                              style={{
                                background: '#1A1210',
                                border: '1px solid #3D2820',
                                color: '#E8DDD0',
                                fontFamily: "'Barlow Semi Condensed', sans-serif",
                              }}
                            />
                            <button
                              onClick={() => handleManualMbidSearch(result)}
                              disabled={mbidLoading || !manualMbId.trim()}
                              className="p-1.5 rounded"
                              style={{
                                background: mbidLoading ? '#3D2820' : '#b4003e',
                                color: '#E8DDD0',
                                cursor: mbidLoading ? 'not-allowed' : 'pointer',
                              }}
                              title="Search by MBID"
                            >
                              {mbidLoading ? <Loader2 size={16} className="animate-spin" /> : <Search size={16} />}
                            </button>
                            <button
                              onClick={() => { setEditingId(null); setManualMbId('') }}
                              className="p-1.5 rounded"
                              style={{ background: '#3D2820', color: '#9A8E84' }}
                              title="Cancel"
                            >
                              <X size={16} />
                            </button>
                          </div>
                        </div>
                      )}

                      {decision === 'accept' && (
                        <div className="flex items-center gap-1 mt-3" style={{ color: '#b4003e' }}>
                          <Check size={14} />
                          <span className="text-xs" style={{ fontFamily: "'Barlow Semi Condensed', sans-serif", color: '#b4003e' }}>Accepted</span>
                        </div>
                      )}
                      {decision === 'reject' && (
                        <div className="flex items-center gap-1 mt-3" style={{ color: '#6B5E56' }}>
                          <XCircle size={14} />
                          <span className="text-xs" style={{ fontFamily: "'Barlow Semi Condensed', sans-serif", color: '#6B5E56' }}>Rejected</span>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>

              <div className="flex items-center justify-between pt-3" style={{ borderTop: '1px solid #3D2820' }}>
                <p className="text-xs" style={{ fontFamily: "'Barlow Semi Condensed', sans-serif", color: '#9A8E84' }}>
                  {acceptedCount} ✓ • {rejectedCount} ✗ • {pendingCount} pending
                </p>
                <button
                  onClick={() => setPage(3)}
                  disabled={pendingCount > 0}
                  className="px-4 py-1.5 text-xs font-semibold rounded transition-colors"
                  style={{
                    fontFamily: "'Barlow Condensed', sans-serif",
                    fontWeight: 600,
                    textTransform: 'uppercase',
                    letterSpacing: '0.05em',
                    background: pendingCount > 0 ? '#3D2820' : '#b4003e',
                    color: pendingCount > 0 ? '#6B5E56' : '#E8DDD0',
                    cursor: pendingCount > 0 ? 'not-allowed' : 'pointer',
                  }}
                >
                  {pendingCount > 0 ? `${pendingCount} pending` : 'Apply'}
                </button>
              </div>
            </>
          )}

          {page === 3 && (
            <>
              <div className="text-center mb-6">
                <div className="w-16 h-16 rounded-full mx-auto mb-4 flex items-center justify-center" style={{ background: 'rgba(180, 0, 62, 0.2)' }}>
                  <Check size={32} style={{ color: '#b4003e' }} />
                </div>
                <h3
                  className="text-xl font-bold mb-2"
                  style={{ fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 800, color: '#E8DDD0' }}
                >
                  Reconciliation Complete
                </h3>
                <p className="text-sm" style={{ fontFamily: "'Barlow Semi Condensed', sans-serif", color: '#9A8E84' }}>
                  {acceptedCount} tracks updated, {rejectedCount} skipped
                </p>
              </div>

              {applyResults.length > 0 && (
                <div className="space-y-3">
                  <p className="text-xs uppercase" style={{ fontFamily: "'Barlow Condensed', sans-serif", color: '#6B5E56' }}>
                    Changes Applied
                  </p>
                  {applyResults.map((result) => (
                    <div
                      key={result.track_id}
                      className="p-3 rounded"
                      style={{ background: '#231815', border: '1px solid #3D2820' }}
                    >
                      <div className="flex items-center gap-3 mb-2">
                        <div
                          className="w-12 h-12 rounded overflow-hidden shrink-0"
                          style={{ background: '#1A1210', border: '1px solid #3D2820' }}
                        >
                          {coverArt[result.track_id]?.old ? (
                            <img src={coverArt[result.track_id].old!} alt="Old cover" className="w-full h-full object-cover" />
                          ) : (
                            <div className="w-full h-full flex items-center justify-center" style={{ color: '#3D2820', fontSize: '0.5rem', fontFamily: "'Barlow Condensed', sans-serif" }}>No Cover</div>
                          )}
                        </div>
                        <span style={{ color: '#6B5E56', fontSize: 20 }}>→</span>
                        <div
                          className="w-12 h-12 rounded overflow-hidden shrink-0"
                          style={{ background: '#1A1210', border: '1px solid #3D2820' }}
                        >
                          {coverArt[result.track_id]?.new ? (
                            <img src={coverArt[result.track_id].new!} alt="New cover" className="w-full h-full object-cover" />
                          ) : (
                            <div className="w-full h-full flex items-center justify-center" style={{ color: '#3D2820', fontSize: '0.5rem', fontFamily: "'Barlow Condensed', sans-serif" }}>No Cover</div>
                          )}
                        </div>
                      </div>
                      <div className="text-xs" style={{ fontFamily: "'Barlow Semi Condensed', sans-serif", color: '#E8DDD0' }}>
                        <span style={{ color: '#6B5E56' }}>{result.old_title}</span> → <span style={{ color: '#b4003e' }}>{result.new_title}</span>
                      </div>
                      <div className="text-xs" style={{ fontFamily: "'Barlow Semi Condensed', sans-serif", color: '#9A8E84' }}>
                        {result.old_artist} → {result.new_artist}
                      </div>
                      {(result.old_artist_credit || result.new_artist_credit) && (
                        <div className="text-xs" style={{ fontFamily: "'Barlow Semi Condensed', sans-serif", color: '#6B5E56' }}>
                          {(result.old_artist_credit || '—')} → {result.new_artist_credit || '—'}
                        </div>
                      )}
                      <div className="text-xs" style={{ fontFamily: "'Barlow Semi Condensed', sans-serif", color: '#9A8E84' }}>
                        {result.old_album} → {result.new_album}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}