import { useState, useEffect, useRef } from 'react'
import { X, ChevronLeft, ChevronRight, Check, XCircle, Loader2, Pencil, Search, ChevronDown, ChevronUp } from 'lucide-react'
import { authFetch } from '../api'

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
  original_album: string
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
}

interface ApplyResult {
  track_id: number
  old_title: string
  old_artist: string
  old_album: string
  new_title: string
  new_artist: string
  new_album: string
}

type Props = {
  open: boolean
  onClose: () => void
}

export default function ReconciliationModal({ open, onClose }: Props) {
  const [page, setPage] = useState(1)
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
  const [applying, setApplying] = useState(false)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [manualMbId, setManualMbId] = useState('')
  const [mbidLoading, setMbidLoading] = useState(false)

  const [additionalExpanded, setAdditionalExpanded] = useState(false)
  const [additionalTracks, setAdditionalTracks] = useState<DownloadedTrack[]>([])
  const [additionalLoading, setAdditionalLoading] = useState(false)
  const [additionalSearch, setAdditionalSearch] = useState('')
  const [additionalOffset, setAdditionalOffset] = useState(0)
  const [additionalHasMore, setAdditionalHasMore] = useState(true)
  const additionalSearchTimeoutRef = useRef<number | null>(null)

  useEffect(() => {
    if (open) {
      setPage(1)
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
    setResolving(true)
    setPage(2)
    setResolveResults([])
    setProcessedCount(0)

    try {
      const response = await authFetch('/settings/reconciliation/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ track_ids: Array.from(selected) }),
      })

      if (!response.ok) {
        const errText = await response.text()
        console.error('Resolve failed:', response.status, errText)
        alert(`Resolve failed: ${response.status} - ${errText}`)
        setResolving(false)
        return
      }

      const data = (await response.json()) as { results: MatchResult[] }
      setResolveResults(data.results)
      setProcessedCount(data.results.length)
    } catch (err) {
      console.error('Resolve error:', err)
      alert(`Resolve error: ${err}`)
    } finally {
      setResolving(false)
    }
  }

  async function acceptMatch(result: MatchResult) {
    if (!result.matched || !result.mb_id) return

    setDecisions((d) => ({ ...d, [result.track_id]: 'accept' }))

    setApplying(true)
    try {
      await authFetch('/settings/reconciliation/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          track_id: result.track_id,
          title: result.matched_title,
          artist: result.matched_artist,
          artist_credit: result.matched_artist_credit,
          album: result.matched_album,
          mb_id: result.mb_id,
          mb_artist_id: result.mb_artist_id,
          mb_release_id: result.mb_release_id,
          mb_release_group_id: result.mb_release_group_id,
          release_date: null,
          genre: null,
        }),
      })
      setApplyResults((prev) => [
        ...prev,
        {
          track_id: result.track_id,
          old_title: result.original_title,
          old_artist: result.original_artist,
          old_album: result.original_album,
          new_title: result.matched_title || result.original_title,
          new_artist: result.matched_artist || result.original_artist,
          new_album: result.matched_album || result.original_album,
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
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.8)' }}
    >
      <div
        className="w-full max-w-2xl max-h-[85vh] flex flex-col rounded-lg overflow-hidden"
        style={{ background: '#1A1210', border: '1px solid #3D2820' }}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between px-6 py-4 shrink-0"
          style={{ borderBottom: '1px solid #3D2820' }}
        >
          <h2
            className="text-xl font-bold"
            style={{ fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 800, color: '#E8DDD0', letterSpacing: '0.02em' }}
          >
            RECONCILE TRACKS
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
        <div className="flex items-center justify-center gap-2 py-3 shrink-0" style={{ borderBottom: '1px solid #3D2820' }}>
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
        <div className="flex-1 overflow-y-auto p-6">
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
                      onClick={() => { const p = Math.max(1, page - 1); setPage(p); fetchTracksAndSelect(p); }}
                      disabled={page <= 1}
                      className="p-2 rounded disabled:opacity-50"
                      style={{ color: '#9A8E84' }}
                    >
                      <ChevronLeft size={20} />
                    </button>
                    <span style={{ fontFamily: "'Barlow Semi Condensed', sans-serif", color: '#9A8E84' }}>
                      Page {page} of {totalPages}
                    </span>
                    <button
                      onClick={() => { const p = Math.min(totalPages, page + 1); setPage(p); fetchTracksAndSelect(p); }}
                      disabled={page >= totalPages}
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
              <div className="flex items-center justify-between mb-4">
                <button
                  onClick={() => setPage(1)}
                  className="flex items-center gap-1 px-3 py-1.5 text-sm border rounded"
                  style={{ fontFamily: "'Barlow Condensed', sans-serif", color: '#9A8E84', borderColor: '#3D2820' }}
                >
                  <ChevronLeft size={16} />
                  Back
                </button>
                <div className="flex items-center gap-2">
                  {resolving && (
                    <div className="flex items-center gap-2" style={{ color: '#b4003e' }}>
                      <Loader2 className="animate-spin" size={16} />
                      <span style={{ fontFamily: "'Barlow Semi Condensed', sans-serif", fontSize: '0.875rem' }}>
                        Processing {processedCount}/{selected.size}...
                      </span>
                    </div>
                  )}
                  <span className="text-sm" style={{ fontFamily: "'Barlow Semi Condensed', sans-serif", color: '#9A8E84' }}>
                    {resolveResults.filter((r) => r.matched).length} resolved •{' '}
                    {resolveResults.filter((r) => !r.matched).length} no match
                  </span>
                </div>
              </div>

              <div className="space-y-4 mb-6">
                {resolveResults.map((result) => {
                  const decision = decisions[result.track_id]
                  return (
                    <div
                      key={result.track_id}
                      className="p-4 rounded"
                      style={{
                        background: decision === 'accept' ? 'rgba(180, 0, 62, 0.1)' : decision === 'reject' ? 'rgba(61, 40, 32, 0.5)' : '#231815',
                        border: `1px solid ${decision === 'accept' ? 'rgba(180, 0, 62, 0.3)' : decision === 'reject' ? '#3D2820' : '#3D2820'}`,
                        opacity: decision === 'reject' ? 0.5 : 1,
                      }}
                    >
                      <div className="flex items-start justify-between gap-4">
                        <div className="flex-1 min-w-0">
                          <p className="text-xs uppercase mb-2" style={{ fontFamily: "'Barlow Condensed', sans-serif", color: '#6B5E56' }}>
                            Original
                          </p>
                          <p className="text-sm" style={{ fontFamily: "'Barlow Semi Condensed', sans-serif", color: '#E8DDD0' }}>
                            {result.original_title}
                          </p>
                          <p className="text-xs" style={{ fontFamily: "'Barlow Semi Condensed', sans-serif", color: '#9A8E84' }}>
                            {result.original_artist} — {result.original_album}
                          </p>
                        </div>
                        <div style={{ color: '#6B5E56', fontSize: 20 }}>→</div>
                        <div className="flex-1 min-w-0">
                          <p className="text-xs uppercase mb-2" style={{ fontFamily: "'Barlow Condensed', sans-serif", color: '#b4003e' }}>
                            Match
                          </p>
                          {result.matched ? (
                            <>
                              <p className="text-sm" style={{ fontFamily: "'Barlow Semi Condensed', sans-serif", color: '#E8DDD0' }}>
                                {result.matched_title}
                              </p>
                              <p className="text-xs" style={{ fontFamily: "'Barlow Semi Condensed', sans-serif", color: '#9A8E84' }}>
                                {result.matched_artist} — {result.matched_album}
                              </p>
                              <p className="text-xs mt-1" style={{ fontFamily: "'Barlow Semi Condensed', sans-serif", color: '#6B5E56' }}>
                                MBID: {result.mb_id?.slice(0, 8)}... • {result.phase === 'Set by user' ? 'Set by user' : `Score: ${result.mb_score}%`}
                              </p>
                            </>
                          ) : (
                            <>
                              <p className="text-sm" style={{ fontFamily: "'Barlow Semi Condensed', sans-serif", color: '#9A8E84' }}>
                                No match found
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

                      {!decision && result.matched && (
                        <div className="flex items-center gap-2 mt-3">
                          <button
                            onClick={() => acceptMatch(result)}
                            disabled={applying}
                            className="p-1.5 rounded"
                            style={{ background: '#b4003e', color: '#E8DDD0' }}
                            title="Accept"
                          >
                            <Check size={16} />
                          </button>
                          <button
                            onClick={() => rejectMatch(result)}
                            className="p-1.5 rounded"
                            style={{ background: '#3D2820', color: '#9A8E84' }}
                            title="Reject"
                          >
                            <XCircle size={16} />
                          </button>
                          <button
                            onClick={() => { setEditingId(result.track_id); setManualMbId(result.mb_id || '') }}
                            className="p-1.5 rounded"
                            style={{ background: '#3D2820', color: '#9A8E84' }}
                            title="Edit MBID"
                          >
                            <Pencil size={16} />
                          </button>
                        </div>
                      )}

                      {editingId === result.track_id && (
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

              <div className="flex items-center justify-between pt-4" style={{ borderTop: '1px solid #3D2820' }}>
                <p className="text-sm" style={{ fontFamily: "'Barlow Semi Condensed', sans-serif", color: '#9A8E84' }}>
                  Accepted: <span style={{ color: '#E8DDD0' }}>{acceptedCount}</span> • Rejected:{' '}
                  <span style={{ color: '#E8DDD0' }}>{rejectedCount}</span> • Pending:{' '}
                  <span style={{ color: '#E8DDD0' }}>{pendingCount}</span>
                </p>
                <button
                  onClick={() => setPage(3)}
                  disabled={pendingCount > 0}
                  className="px-6 py-2 text-sm font-semibold rounded transition-colors"
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
                  {pendingCount > 0 ? `Decide on all first (${pendingCount} pending)` : 'Apply & Close'}
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
                      <div className="text-xs" style={{ fontFamily: "'Barlow Semi Condensed', sans-serif", color: '#E8DDD0' }}>
                        <span style={{ color: '#6B5E56' }}>{result.old_title}</span> → <span style={{ color: '#b4003e' }}>{result.new_title}</span>
                      </div>
                      <div className="text-xs" style={{ fontFamily: "'Barlow Semi Condensed', sans-serif", color: '#9A8E84' }}>
                        {result.old_artist} → {result.new_artist}
                      </div>
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