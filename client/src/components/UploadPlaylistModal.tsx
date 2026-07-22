import { useState, useRef } from 'react'
import { X } from 'lucide-react'
import type { CsvImportStreamEvent, PlaylistSummary } from '../api/playlists'
import {
  createPlaylist,
  importPlaylistCsvStream,
  fetchPlaylistImportRows,
  resolvePlaylistImportRow,
  rejectPlaylistImportRow,
  type PlaylistImportRowDTO,
} from '../api/playlists'

const MAX_LOG = 500
const MAX_FILE_SIZE = 50 * 1024 * 1024 // 50MB

type Props = {
  open: boolean
  onClose: () => void
  playlists: PlaylistSummary[]
  defaultPlaylistId?: number | null
  onImported: () => void
}

type SuccessLogLine = { title: string; artist: string; phase: string }
type RowResult = {
  row_index: number
  state: 'matched' | 'unmatched' | 'error'
  mb_recording_id?: string | null
  confidence?: number | null
  phase?: string | null
  details_json?: string | null
  error?: string | null
}

export default function UploadPlaylistModal({
  open,
  onClose,
  playlists,
  defaultPlaylistId = null,
  onImported,
}: Props) {
  const [selectedId, setSelectedId] = useState<string>(() =>
    defaultPlaylistId != null ? String(defaultPlaylistId) : '',
  )
  const [newTitle, setNewTitle] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [importTotal, setImportTotal] = useState(0)
  const [importCurrent, setImportCurrent] = useState(0)
  const [liveTitle, setLiveTitle] = useState('')
  const [liveArtist, setLiveArtist] = useState('')
  const [livePhase, setLivePhase] = useState('')
  const [jobId, setJobId] = useState<number | null>(null)
  const jobIdRef = useRef<number | null>(null)
  const [activePlaylistId, setActivePlaylistId] = useState<number | null>(null)
  const [unmatched, setUnmatched] = useState<PlaylistImportRowDTO[]>([])
  const [liveUnmatched, setLiveUnmatched] = useState<RowResult[]>([])
  const [liveErrored, setLiveErrored] = useState<RowResult[]>([])
  const [unmatchedBusy, setUnmatchedBusy] = useState(false)
  const [editRowId, setEditRowId] = useState<number | null>(null)
  const [successLog, setSuccessLog] = useState<SuccessLogLine[]>([])
  const inputRef = useRef<HTMLInputElement>(null)
  const streamAbortRef = useRef<AbortController | null>(null)

  if (!open) return null

  function reset() {
    streamAbortRef.current?.abort()
    streamAbortRef.current = null
    setFile(null)
    setMessage(null)
    setBusy(false)
    setNewTitle('')
    setSelectedId(defaultPlaylistId != null ? String(defaultPlaylistId) : '')
    setImportTotal(0)
    setImportCurrent(0)
    setLiveTitle('')
    setLiveArtist('')
    setLivePhase('')
    setJobId(null)
    jobIdRef.current = null
    setActivePlaylistId(null)
    setUnmatched([])
    setLiveUnmatched([])
    setLiveErrored([])
    setUnmatchedBusy(false)
    setEditRowId(null)
    setSuccessLog([])
    if (inputRef.current) inputRef.current.value = ''
  }

  function handleClose() {
    reset()
    onClose()
  }

  function onStreamEvent(e: CsvImportStreamEvent) {
    if (e.type === 'start') {
      setImportTotal(e.total)
      setImportCurrent(0)
      if (typeof e.job_id === 'number') {
        jobIdRef.current = e.job_id
        setJobId(e.job_id)
      }
      return
    }
    if (e.type === 'progress') {
      setImportCurrent(e.current)
      setLiveTitle(e.title)
      setLiveArtist(e.artist)
      setLivePhase(e.phase)
      if (typeof e.job_id === 'number') {
        jobIdRef.current = e.job_id
        setJobId(e.job_id)
      }
      return
    }
    if (e.type === 'added') {
      setSuccessLog((prev) => [
        ...prev.slice(-(MAX_LOG - 1)),
        { title: e.title, artist: e.artist, phase: e.phase },
      ])
      if (typeof e.job_id === 'number') {
        jobIdRef.current = e.job_id
        setJobId(e.job_id)
      }
      return
    }
    if (e.type === 'row') {
      const rr: RowResult = {
        row_index: e.row_index,
        state: e.state,
        mb_recording_id: e.mb_recording_id ?? null,
        confidence: e.confidence ?? null,
        phase: e.phase ?? null,
        details_json: e.details_json ?? null,
        error: e.error ?? null,
      }
      if (e.state === 'unmatched') {
        setLiveUnmatched((prev) => [...prev, rr])
      } else if (e.state === 'error') {
        setLiveErrored((prev) => [...prev, rr])
      }
      if (typeof e.job_id === 'number') {
        jobIdRef.current = e.job_id
        setJobId(e.job_id)
      }
      return
    }
    if (e.type === 'done') {
      const errTail =
        e.errors?.length > 0 ? `\n${e.errors.slice(0, 8).join('\n')}` : ''
      setMessage(`Finished · added ${e.added} · skipped ${e.skipped}${errTail}`)
      setLiveTitle('')
      setLiveArtist('')
      setLivePhase('')
      setImportCurrent(e.total)
      if (typeof e.job_id === 'number') {
        jobIdRef.current = e.job_id
        setJobId(e.job_id)
      }
      onImported()
      setNewTitle('')
      setFile(null)
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  async function refreshUnmatched(playlistId: number, jobId: number) {
    setUnmatchedBusy(true)
    try {
      const rows = await fetchPlaylistImportRows(playlistId, jobId, { state: 'unmatched', limit: 500 })
      setUnmatched(rows)
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Failed to load unmatched rows')
    } finally {
      setUnmatchedBusy(false)
    }
  }

  async function resolveOne(playlistId: number, jobId: number, rowId: number, mbid: string) {
    const trimmed = mbid.trim()
    if (!trimmed) return
    setUnmatchedBusy(true)
    try {
      await resolvePlaylistImportRow(playlistId, jobId, rowId, { mb_recording_id: trimmed })
      await refreshUnmatched(playlistId, jobId)
      onImported()
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Resolve failed')
    } finally {
      setUnmatchedBusy(false)
    }
  }

  async function rejectOne(playlistId: number, jobId: number, rowId: number) {
    setUnmatchedBusy(true)
    try {
      await rejectPlaylistImportRow(playlistId, jobId, rowId)
      await refreshUnmatched(playlistId, jobId)
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Reject failed')
    } finally {
      setUnmatchedBusy(false)
    }
  }

  function handleFileChange(file: File | null) {
    if (file) {
      const ext = file.name.split('.').pop()?.toLowerCase()
      if (ext !== 'csv') {
        setMessage('Only .csv files are supported')
        if (inputRef.current) inputRef.current.value = ''
        setFile(null)
        return
      }
      if (file.size > MAX_FILE_SIZE) {
        setMessage('File exceeds 50MB limit')
        if (inputRef.current) inputRef.current.value = ''
        setFile(null)
        return
      }
    }
    setFile(file)
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setMessage(null)
    if (!file) {
      setMessage('Choose a CSV file')
      return
    }

    setBusy(true)
    setSuccessLog([])
    setImportTotal(0)
    setImportCurrent(0)
    setLiveTitle('')
    setLiveArtist('')
    setLivePhase('')
    setJobId(null)
    jobIdRef.current = null
    setActivePlaylistId(null)
    setUnmatched([])
    setLiveUnmatched([])
    setLiveErrored([])
      setEditRowId(null)
    streamAbortRef.current = new AbortController()
    try {
      let playlistId: number
      if (newTitle.trim()) {
        const pl = await createPlaylist({ title: newTitle.trim() })
        playlistId = pl.id
      } else {
        const id = Number(selectedId)
        if (!id) {
          setMessage('Select a playlist or enter a new playlist name')
          setBusy(false)
          return
        }
        playlistId = id
      }
      setActivePlaylistId(playlistId)

      await importPlaylistCsvStream(playlistId, file, onStreamEvent, {
        signal: streamAbortRef.current?.signal,
      })
      if (jobIdRef.current != null) {
        await refreshUnmatched(playlistId, jobIdRef.current)
      }
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Upload failed')
    } finally {
      setBusy(false)
      streamAbortRef.current = null
    }
  }

  const pct =
    importTotal > 0 ? Math.min(100, Math.round((importCurrent / importTotal) * 100)) : 0
  const showProgress = busy && importTotal > 0

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.75)' }}
      onClick={handleClose}
    >
        <div
          className="w-full max-w-2xl rounded-lg overflow-hidden shadow-xl max-h-[min(92vh,900px)] flex flex-col"
        style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="flex items-center justify-between px-5 py-4 shrink-0"
          style={{ borderBottom: '1px solid var(--border-subtle)' }}
        >
          <h2
            style={{
              fontFamily: "'Barlow Condensed', sans-serif",
              fontWeight: 700,
              fontSize: 18,
              textTransform: 'uppercase',
              letterSpacing: '0.08em',
              color: 'var(--text-primary)',
            }}
          >
            Upload playlist CSV
          </h2>
          <button
            type="button"
            onClick={handleClose}
            className="p-1 rounded transition-colors hover:bg-[var(--bg-surface-3)]"
            style={{ color: 'var(--text-primary)' }}
            aria-label="Close"
          >
            <X size={20} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="px-5 py-4 flex flex-col min-h-0 flex-1 overflow-hidden">
          <p className="text-sm shrink-0 mb-4" style={{ color: 'var(--text-primary)', fontFamily: "'Barlow Semi Condensed', sans-serif" }}>
            Spotify-style export works best (columns: Track Name, Album Name, Artist Name(s)). Rows are matched on
            MusicBrainz without downloading audio.
          </p>

          <div className="shrink-0 mb-4">
            <label
              className="block text-xs uppercase tracking-widest mb-1.5"
              style={{ fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 600, color: 'var(--text-primary)' }}
            >
              Target playlist
            </label>
            <select
              value={selectedId}
              onChange={(e) => setSelectedId(e.target.value)}
              disabled={busy || Boolean(newTitle.trim())}
              className="w-full px-3 py-2 text-sm rounded"
              style={{
                background: 'var(--bg-surface)',
                border: '1px solid var(--border)',
                color: 'var(--text-primary)',
                fontFamily: "'Barlow Semi Condensed', sans-serif",
              }}
            >
              <option value="">— Select —</option>
              {playlists.map((pl) => (
                <option key={pl.id} value={String(pl.id)}>
                  {pl.title}
                </option>
              ))}
            </select>
          </div>

          <div className="shrink-0 mb-4">
            <label
              className="block text-xs uppercase tracking-widest mb-1.5"
              style={{ fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 600, color: 'var(--text-primary)' }}
            >
              Or new playlist name
            </label>
            <input
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              disabled={busy}
              placeholder="Creates playlist, then imports"
              className="w-full px-3 py-2 text-sm rounded"
              style={{
                background: 'var(--bg-surface)',
                border: '1px solid var(--border)',
                color: 'var(--text-primary)',
                fontFamily: "'Barlow Semi Condensed', sans-serif",
              }}
            />
          </div>

          <div className="shrink-0 mb-4">
            <label
              className="block text-xs uppercase tracking-widest mb-1.5"
              style={{ fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 600, color: 'var(--text-primary)' }}
            >
              CSV file
            </label>
            <input
              ref={inputRef}
              type="file"
              accept=".csv,text/csv"
              disabled={busy}
              onChange={(e) => handleFileChange(e.target.files?.[0] ?? null)}
              className="w-full text-sm file:mr-3 file:px-3 file:py-1.5 file:rounded file:border file:text-xs"
              style={{
                color: 'var(--text-primary)',
                fontFamily: "'Barlow Semi Condensed', sans-serif",
              }}
            />
          </div>

          {showProgress && (
            <div className="space-y-2 shrink-0">
              <div
                className="h-2 rounded-full overflow-hidden"
                style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}
              >
                <div
                  className="h-full transition-[width] duration-150 ease-out rounded-full"
                  style={{ width: `${pct}%`, background: 'var(--bg-surface)' }}
                />
              </div>
              <div
                className="rounded px-3 py-2 text-xs"
                style={{
                  background: 'var(--bg-surface)',
                  border: '1px solid var(--border)',
                  color: 'var(--text-primary)',
                  fontFamily: "'Barlow Semi Condensed', sans-serif",
                }}
              >
                <div className="text-[10px] uppercase tracking-widest mb-1" style={{ color: 'var(--text-primary)' }}>
                  Now · row {importCurrent} / {importTotal}
                </div>
                <div className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                  {liveTitle} <span style={{ color: '#7A6E66' }}>—</span> {liveArtist}
                </div>
                <div className="mt-1 text-[11px]" style={{ color: 'var(--text-primary)' }}>
                  {livePhase}
                </div>
              </div>
            </div>
          )}

          {(successLog.length > 0 ||
            (message && !busy) ||
            (!busy && (unmatched.length > 0 || liveUnmatched.length > 0 || liveErrored.length > 0))) && (
            <div className="flex flex-col min-h-0 flex-1 gap-2 overflow-hidden">
              {!busy && (liveUnmatched.length > 0 || liveErrored.length > 0) && (
                <div
                  className="rounded px-3 py-2 text-xs shrink-0"
                  style={{
                    background: 'var(--bg-surface)',
                    border: '1px solid var(--border)',
                    color: 'var(--text-primary)',
                    fontFamily: "'Barlow Semi Condensed', sans-serif",
                  }}
                >
                  <div className="text-[10px] uppercase tracking-widest mb-1" style={{ color: 'var(--text-primary)' }}>
                    Import summary (live)
                  </div>
                  <div>
                    Needs attention: <span style={{ color: 'var(--text-primary)' }}>{liveUnmatched.length}</span> unmatched ·{' '}
                    <span style={{ color: 'var(--text-primary)' }}>{liveErrored.length}</span> errors
                  </div>
                  {liveUnmatched.length > 0 && (
                    <div className="mt-2">
                      <div className="text-[10px] uppercase tracking-widest mb-1" style={{ color: 'var(--text-primary)' }}>
                        Unmatched preview
                      </div>
                      <div className="space-y-1 max-h-24 overflow-y-auto pr-1">
                        {liveUnmatched.slice(0, 12).map((r) => {
                          let suggestedMbid: string | null = null
                          let suggestedTitle: string | null = null
                          let suggestedArtist: string | null = null
                          try {
                            if (r.details_json) {
                              const d = JSON.parse(r.details_json) as { mbid?: string; title?: string; artist_credit?: string; artist?: string }
                              suggestedMbid = typeof d?.mbid === 'string' ? d.mbid : null
                              suggestedTitle = typeof d?.title === 'string' ? d.title : null
                              suggestedArtist =
                                typeof d?.artist_credit === 'string'
                                  ? d.artist_credit
                                  : typeof d?.artist === 'string'
                                    ? d.artist
                                    : null
                            }
                          } catch {
                            // ignore
                          }
                          return (
                            <div key={r.row_index} style={{ color: 'var(--text-primary)' }}>
                              <span style={{ color: 'var(--text-primary)' }}>#{r.row_index + 2}</span>{' '}
                              {suggestedMbid ? (
                                <>
                                  <span style={{ color: 'var(--text-primary)' }}>suggested</span>{' '}
                                  <span style={{ color: 'var(--text-primary)' }}>{suggestedArtist || '—'} — {suggestedTitle || '—'}</span>{' '}
                                  <span style={{ color: 'var(--text-primary)' }}>·</span>{' '}
                                  <span style={{ fontFamily: "'Barlow Semi Condensed', sans-serif", color: 'var(--text-primary)' }}>
                                    {suggestedMbid}
                                  </span>
                                </>
                              ) : (
                                <span style={{ color: 'var(--text-primary)' }}>no suggestion</span>
                              )}
                            </div>
                          )
                        })}
                        {liveUnmatched.length > 12 ? (
                          <div style={{ color: 'var(--text-primary)' }}>…and {liveUnmatched.length - 12} more</div>
                        ) : null}
                      </div>
                      <div className="mt-1 text-[11px]" style={{ color: 'var(--text-primary)' }}>
                        Full unmatched list becomes available after import finishes (below).
                      </div>
                    </div>
                  )}
                </div>
              )}
              {successLog.length > 0 && (
                <>
                  <div
                    className="text-[10px] uppercase tracking-widest"
                    style={{ fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 600, color: 'var(--text-primary)' }}
                  >
                    Imported
                  </div>
                  <div
                    className="rounded p-2 min-h-[80px] max-h-[200px] overflow-y-auto text-xs space-y-1.5"
                    style={{
                      background: 'var(--bg-surface)',
                      border: '1px solid var(--border)',
                      fontFamily: "'Barlow Semi Condensed', sans-serif",
                    }}
                  >
                    {successLog.map((line, i) => (
                      <div key={i} style={{ color: 'var(--text-primary)' }}>
                        <span style={{ color: 'var(--text-primary)' }}>
                          {line.artist} — {line.title}
                        </span>
                        <span style={{ color: 'var(--text-primary)' }}> · </span>
                        <span style={{ color: '#8A7E72' }}>{line.phase}</span>
                      </div>
                    ))}
                  </div>
                </>
              )}
              {message && !busy && (
                <pre
                  className="text-xs whitespace-pre-wrap rounded p-3 shrink-0 max-h-28 overflow-y-auto"
                  style={{
                    background: 'var(--bg-surface)',
                    border: '1px solid var(--border)',
                    color: 'var(--text-primary)',
                    fontFamily: "'Barlow Semi Condensed', sans-serif",
                  }}
                >
                  {message}
                </pre>
              )}
              {!busy && jobId != null && (
                <div className="text-[11px] mt-1" style={{ color: 'var(--text-primary)', fontFamily: "'Barlow Semi Condensed', sans-serif" }}>
                  Import job: {jobId}
                </div>
              )}
              {!busy && jobId != null && (
                <div className="mt-3 flex flex-col min-h-0 flex-1">
                  <div
                    className="flex items-center justify-between text-[10px] uppercase tracking-widest"
                    style={{ fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 600, color: 'var(--text-primary)' }}
                  >
                    <span>Unmatched</span>
                    <button
                      type="button"
                      disabled={unmatchedBusy}
                      onClick={() => {
                        if (activePlaylistId && jobId) refreshUnmatched(activePlaylistId, jobId)
                      }}
                      className="px-2 py-1 rounded"
                      style={{ border: '1px solid var(--border)', color: 'var(--text-primary)' }}
                    >
                      {unmatchedBusy ? 'Loading…' : 'Refresh'}
                    </button>
                  </div>
                  {unmatched.length === 0 ? (
                    <div className="text-xs mt-2" style={{ color: 'var(--text-primary)', fontFamily: "'Barlow Semi Condensed', sans-serif" }}>
                      No unmatched rows.
                    </div>
                  ) : (
                  <div
                    className="rounded p-2 mt-2 flex-1 min-h-0 overflow-y-auto text-xs space-y-2"
                    style={{
                      background: 'var(--bg-surface)',
                      border: '1px solid var(--border)',
                      fontFamily: "'Barlow Semi Condensed', sans-serif",
                    }}
                  >
                      {unmatched.slice(0, 80).map((r) => (
                        <div key={r.id} className="space-y-1 pb-2" style={{ borderBottom: '1px solid color-mix(in srgb, var(--border) 0.6, transparent)' }}>
                          <div style={{ color: 'var(--text-primary)' }}>
                            <span style={{ color: 'var(--text-primary)' }}>#{r.row_index + 2}</span>{' '}
                            <span style={{ color: 'var(--text-primary)' }}>CSV:</span> {r.artist} — {r.title}
                            {r.album ? <span style={{ color: 'var(--text-primary)' }}> · {r.album}</span> : null}
                          </div>
                          {(() => {
                            if (!r.details_json) return null
                            try {
                              const d = JSON.parse(r.details_json) as { title?: string; artist_credit?: string; artist?: string; album?: string; mbid?: string }
                              const st = (d?.title ?? '').trim()
                              const sa = (d?.artist_credit ?? d?.artist ?? '').trim()
                              const salb = (d?.album ?? '').trim()
                              if (!st && !sa && !salb) return null
                              return (
                                <div style={{ color: 'var(--text-primary)' }}>
                                  <span style={{ color: 'var(--text-primary)' }}>Suggested:</span>{' '}
                                  <span style={{ color: 'var(--text-primary)' }}>{sa || '—'} — {st || '—'}</span>
                                  {salb ? <span style={{ color: 'var(--text-primary)' }}> · {salb}</span> : null}
                                </div>
                              )
                            } catch {
                              return null
                            }
                          })()}
                          <div className="flex gap-2 items-center flex-wrap">
                            <button
                              type="button"
                              disabled={unmatchedBusy}
                              className="px-2 py-1 rounded text-xs"
                              style={{ border: '1px solid var(--border)', color: 'var(--text-primary)' }}
                              onClick={() => {
                                const q = encodeURIComponent(`${r.artist} ${r.title}`.trim())
                                window.open(`/search?q=${q}`, '_blank')
                              }}
                              title="Search in app"
                            >
                              Search
                            </button>
                            {r.mb_recording_id ? (
                              <>
                                <button
                                  type="button"
                                  disabled={unmatchedBusy}
                                  className="px-3 py-1 rounded text-xs"
                                  style={{ background: 'var(--bg-surface)', color: 'var(--text-primary)' }}
                                  onClick={() => {
                                    if (activePlaylistId && jobId) resolveOne(activePlaylistId, jobId, r.id, r.mb_recording_id ?? '')
                                  }}
                                  title="Accept suggested match"
                                >
                                  Accept
                                </button>
                                <button
                                  type="button"
                                  disabled={unmatchedBusy}
                                  className="px-3 py-1 rounded text-xs"
                                  style={{ border: '1px solid var(--border)', color: 'var(--text-primary)' }}
                                  onClick={() => {
                                    if (activePlaylistId && jobId) rejectOne(activePlaylistId, jobId, r.id)
                                  }}
                                  title="Reject suggested match"
                                >
                                  Reject
                                </button>
                                <button
                                  type="button"
                                  disabled={unmatchedBusy}
                                  className="px-3 py-1 rounded text-xs"
                                  style={{ border: '1px solid var(--border)', color: 'var(--text-primary)' }}
                                  onClick={() => setEditRowId((prev) => (prev === r.id ? null : r.id))}
                                  title="Manually edit MBID"
                                >
                                  {editRowId === r.id ? 'Hide' : 'Edit'}
                                </button>
                              </>
                            ) : (
                              <button
                                type="button"
                                disabled={unmatchedBusy}
                                className="px-3 py-1 rounded text-xs"
                                style={{ border: '1px solid var(--border)', color: 'var(--text-primary)' }}
                                onClick={() => setEditRowId((prev) => (prev === r.id ? null : r.id))}
                                title="Enter MBID manually"
                              >
                                {editRowId === r.id ? 'Hide' : 'Enter MBID'}
                              </button>
                            )}
                          </div>
                          {editRowId === r.id ? (
                            <div className="flex gap-2 items-center flex-wrap">
                              <input
                                placeholder="MusicBrainz recording MBID"
                                defaultValue={r.mb_recording_id ?? ''}
                                disabled={unmatchedBusy}
                                className="min-w-[280px] flex-1 px-2 py-1 rounded text-xs"
                                style={{
                                  background: 'var(--bg-surface)',
                                  border: '1px solid var(--border)',
                                  color: 'var(--text-primary)',
                                  fontFamily: "'Barlow Semi Condensed', sans-serif",
                                }}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') {
                                    e.preventDefault()
                                    const mbid = (e.target as HTMLInputElement).value
                                    if (activePlaylistId && jobId) resolveOne(activePlaylistId, jobId, r.id, mbid)
                                  }
                                }}
                              />
                              <button
                                type="button"
                                disabled={unmatchedBusy}
                                className="px-3 py-1 rounded text-xs"
                                style={{ background: 'var(--bg-surface)', color: 'var(--text-primary)' }}
                                onClick={(e) => {
                                  const input = (e.currentTarget.parentElement?.querySelector('input') ??
                                    null) as HTMLInputElement | null
                                  const mbid = input?.value ?? ''
                                  if (activePlaylistId && jobId) resolveOne(activePlaylistId, jobId, r.id, mbid)
                                }}
                              >
                                Resolve
                              </button>
                            </div>
                          ) : null}
                          {r.error ? (
                            <div style={{ color: 'var(--text-primary)' }}>Reason: {r.error}</div>
                          ) : r.phase ? (
                            <div style={{ color: 'var(--text-primary)' }}>Phase: {r.phase}</div>
                          ) : null}
                        </div>
                      ))}
                      {unmatched.length > 80 ? (
                        <div style={{ color: 'var(--text-primary)' }}>
                          Showing first 80 of {unmatched.length}. Use Refresh after resolving.
                        </div>
                      ) : null}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-3 pb-1 shrink-0 mt-3" style={{ borderTop: '1px solid var(--border-subtle)' }}>
            <button
              type="button"
              onClick={handleClose}
              disabled={busy}
              className="px-4 py-2 text-sm"
              style={{
                fontFamily: "'Barlow Condensed', sans-serif",
                fontWeight: 600,
                color: 'var(--text-primary)',
                border: '1px solid var(--border)',
                background: 'transparent',
              }}
            >
              Close
            </button>
            <button
              type="submit"
              disabled={busy}
              className="px-4 py-2 text-sm"
              style={{
                fontFamily: "'Barlow Condensed', sans-serif",
                fontWeight: 700,
                textTransform: 'uppercase',
                letterSpacing: '0.06em',
                background: 'var(--bg-surface)',
                color: 'var(--text-primary)',
                border: 'none',
              }}
            >
              {busy ? 'Importing…' : 'Import'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
