import { useState, useEffect } from 'react'
import { X, ChevronLeft, Check, XCircle, Loader2 } from 'lucide-react'
import { authFetch } from '../api'
import { queryClient } from '../queryClient'

interface LocalFileInfo {
  path: string
  filename: string
  size: number
}

interface ExtractedTrack {
  track_id: number
  path: string
  extracted_title: string
  extracted_artist: string
  extracted_album: string
  quality: string | null
}

type Props = {
  open: boolean
  onClose: () => void
}

export default function DetectNewFilesModal({ open, onClose }: Props) {
  const [page, setPage] = useState(1)
  const [files, setFiles] = useState<LocalFileInfo[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(false)
  const [importing, setImporting] = useState(false)
  const [extractedTracks, setExtractedTracks] = useState<ExtractedTrack[]>([])
  const [decisions, setDecisions] = useState<Record<number, 'accept' | 'reject' | null>>({})
  const [editingId, setEditingId] = useState<number | null>(null)
  const [editForm, setEditForm] = useState({ title: '', artist: '', album: '' })
  const [applyResults, setApplyResults] = useState<{ accepted: number; rejected: number; results: any[] } | null>(null)
  const [applying, setApplying] = useState(false)
  const [exiting, setExiting] = useState<Record<number, 'accept' | 'reject'>>({})

  const EXIT_MS = 260

  useEffect(() => {
    if (open) {
      setPage(1)
      setFiles([])
      setSelected(new Set())
      setExtractedTracks([])
      setDecisions({})
      setExiting({})
      setApplyResults(null)
      scanFiles()
    }
  }, [open])

  async function scanFiles() {
    setLoading(true)
    try {
      const res = await authFetch('/settings/local-files/scan')
      const data = await res.json()
      setFiles(data.files || [])
      if (data.files && data.files.length > 0) {
        setSelected(new Set(data.files.map((f: LocalFileInfo) => f.path)))
      }
    } catch (err) {
      console.error(err)
    } finally {
      setLoading(false)
    }
  }

  function toggleFile(path: string) {
    const next = new Set(selected)
    if (next.has(path)) {
      next.delete(path)
    } else {
      next.add(path)
    }
    setSelected(next)
  }

  function selectAll() {
    setSelected(new Set(files.map((f) => f.path)))
  }

  function deselectAll() {
    setSelected(new Set())
  }

  async function runImport() {
    setImporting(true)
    setPage(2)

    try {
      const selectedFiles = files.filter((f) => selected.has(f.path))
      const res = await authFetch('/settings/local-files/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          files: selectedFiles.map((f) => ({
            path: f.path,
            title: f.filename.replace(/\.[^/.]+$/, ''),  // Use filename without extension as initial title
            artist: 'Unknown Artist',
            album: 'Unknown Album',
          })),
        }),
      })

      const data = await res.json()
      setExtractedTracks(data.tracks || [])
    } catch (err) {
      console.error(err)
      alert('Import failed: ' + err)
    } finally {
      setImporting(false)
    }
  }

  function decideTrack(track: ExtractedTrack, action: 'accept' | 'reject') {
    const id = track.track_id
    if (decisions[id] || exiting[id]) return
    setExiting((e) => ({ ...e, [id]: action }))
    window.setTimeout(() => {
      setDecisions((d) => ({ ...d, [id]: action }))
      setExiting((e) => {
        const next = { ...e }
        delete next[id]
        return next
      })
    }, EXIT_MS)
  }

  function acceptTrack(track: ExtractedTrack) {
    decideTrack(track, 'accept')
  }

  function rejectTrack(track: ExtractedTrack) {
    decideTrack(track, 'reject')
  }

  function acceptAllPending() {
    const pending = extractedTracks.filter((t) => !decisions[t.track_id] && !exiting[t.track_id])
    pending.forEach((track, i) => {
      window.setTimeout(() => decideTrack(track, 'accept'), i * 35)
    })
  }

  function startEdit(track: ExtractedTrack) {
    setEditingId(track.track_id)
    setEditForm({
      title: track.extracted_title,
      artist: track.extracted_artist,
      album: track.extracted_album,
    })
  }

  function saveEdit(track: ExtractedTrack) {
    setExtractedTracks((prev) =>
      prev.map((t) =>
        t.track_id === track.track_id
          ? { ...t, extracted_title: editForm.title, extracted_artist: editForm.artist, extracted_album: editForm.album }
          : t
      )
    )
    setEditingId(null)
    decideTrack(track, 'accept')
  }

  async function applyDecisions() {
    setApplying(true)

    try {
      const items = extractedTracks.map((t) => ({
        track_id: t.track_id,
        action: decisions[t.track_id] || 'reject',
        title: decisions[t.track_id] === 'accept' ? t.extracted_title : null,
        artist: decisions[t.track_id] === 'accept' ? t.extracted_artist : null,
        album: decisions[t.track_id] === 'accept' ? t.extracted_album : null,
      }))

      const res = await authFetch('/settings/local-files/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items }),
      })

      const data = await res.json()
      setApplyResults(data)
      queryClient.invalidateQueries({ queryKey: ['recently-downloaded'] })
      setPage(3)
    } catch (err) {
      console.error(err)
      alert('Apply failed: ' + err)
    } finally {
      setApplying(false)
    }
  }

  const acceptedCount = Object.values(decisions).filter((d) => d === 'accept').length
  const rejectedCount = Object.values(decisions).filter((d) => d === 'reject').length
  const pendingCount = extractedTracks.filter(
    (t) => !decisions[t.track_id] && !exiting[t.track_id],
  ).length
  const visibleReviewTracks = extractedTracks.filter((t) => !decisions[t.track_id])

  function formatSize(bytes: number) {
    if (bytes < 1024) return bytes + ' B'
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
  }

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.8)' }}
    >
      <div
        className="w-full max-w-2xl max-h-[85vh] flex flex-col rounded-lg overflow-hidden"
        style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between px-6 py-4 shrink-0"
          style={{ borderBottom: '1px solid var(--border)' }}
        >
          <h2
            className="text-xl font-bold"
            style={{ fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 800, color: 'var(--text-primary)', letterSpacing: '0.02em' }}
          >
            DETECT NEW FILES
          </h2>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-[var(--border)]"
            style={{ color: 'var(--text-primary)' }}
          >
            <X size={20} />
          </button>
        </div>

        {/* Page indicator */}
        <div className="flex items-center justify-center gap-2 py-3 shrink-0" style={{ borderBottom: '1px solid var(--border)' }}>
          <div
            className="w-8 h-8 rounded flex items-center justify-center text-sm font-semibold"
            style={{
              background: page >= 1 ? 'var(--bg-surface)' : 'var(--bg-surface)',
              color: page >= 1 ? 'var(--text-primary)' : 'var(--text-primary)',
              fontFamily: "'Barlow Condensed', sans-serif",
            }}
          >
            1
          </div>
          <div
            className="w-8 h-8 rounded flex items-center justify-center text-sm font-semibold"
            style={{
              background: page >= 2 ? 'var(--bg-surface)' : 'var(--bg-surface)',
              color: page >= 2 ? 'var(--text-primary)' : 'var(--text-primary)',
              fontFamily: "'Barlow Condensed', sans-serif",
            }}
          >
            2
          </div>
          <div
            className="w-8 h-8 rounded flex items-center justify-center text-sm font-semibold"
            style={{
              background: page >= 3 ? 'var(--bg-surface)' : 'var(--bg-surface)',
              color: page >= 3 ? 'var(--text-primary)' : 'var(--text-primary)',
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
              <p className="text-sm mb-4" style={{ fontFamily: "'Barlow Semi Condensed', sans-serif", color: 'var(--text-primary)' }}>
                {files.length} new audio files found in cache folder. Select the files you want to import.
              </p>

              {loading ? (
                <div className="flex items-center gap-2 py-8 justify-center">
                  <Loader2 className="animate-spin" size={24} style={{ color: 'var(--text-primary)' }} />
                  <span style={{ fontFamily: "'Barlow Semi Condensed', sans-serif", color: 'var(--text-primary)' }}>Scanning cache folder...</span>
                </div>
              ) : files.length === 0 ? (
                <p className="text-sm py-8 text-center" style={{ fontFamily: "'Barlow Semi Condensed', sans-serif", color: 'var(--text-primary)' }}>
                  No new audio files found in the cache folder.
                </p>
              ) : (
                <>
                  <div className="space-y-2 mb-4 max-h-80 overflow-y-auto">
                    {files.map((file) => (
                      <label
                        key={file.path}
                        className="flex items-center gap-3 p-3 rounded cursor-pointer"
                        style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}
                      >
                        <input
                          type="checkbox"
                          checked={selected.has(file.path)}
                          onChange={() => toggleFile(file.path)}
                          className="w-4 h-4"
                          style={{ accentColor: 'var(--text-primary)' }}
                        />
                        <div className="flex-1 min-w-0">
                          <p className="text-sm truncate" style={{ fontFamily: "'Barlow Semi Condensed', sans-serif", color: 'var(--text-primary)' }}>
                            {file.filename}
                          </p>
                          <p className="text-xs" style={{ fontFamily: "'Barlow Semi Condensed', sans-serif", color: 'var(--text-primary)' }}>
                            {formatSize(file.size)}
                          </p>
                        </div>
                      </label>
                    ))}
                  </div>

                  <div className="flex items-center justify-between">
                    <div className="flex gap-2">
                      <button
                        onClick={deselectAll}
                        className="px-3 py-1.5 text-xs border rounded"
                        style={{ fontFamily: "'Barlow Condensed', sans-serif", color: 'var(--text-primary)', borderColor: 'var(--border)' }}
                      >
                        Deselect All
                      </button>
                      <button
                        onClick={selectAll}
                        className="px-3 py-1.5 text-xs border rounded"
                        style={{ fontFamily: "'Barlow Condensed', sans-serif", color: 'var(--text-primary)', borderColor: 'var(--border)' }}
                      >
                        Select All
                      </button>
                    </div>
                    <button
                      onClick={runImport}
                      disabled={selected.size === 0 || importing}
                      className="px-6 py-2 text-sm font-semibold rounded transition-colors"
                      style={{
                        fontFamily: "'Barlow Condensed', sans-serif",
                        fontWeight: 600,
                        textTransform: 'uppercase',
                        letterSpacing: '0.05em',
                        background: selected.size === 0 ? 'var(--bg-surface)' : 'var(--bg-surface)',
                        color: selected.size === 0 ? 'var(--text-primary)' : 'var(--text-primary)',
                        cursor: selected.size === 0 ? 'not-allowed' : 'pointer',
                      }}
                    >
                      {importing ? (
                        <span className="flex items-center gap-2">
                          <Loader2 className="animate-spin" size={16} />
                          Importing...
                        </span>
                      ) : (
                        `Import (${selected.size}) →`
                      )}
                    </button>
                  </div>
                </>
              )}
            </>
          )}

          {page === 2 && (
            <>
              <div className="flex items-center justify-between mb-4 gap-2 flex-wrap">
                <button
                  onClick={() => setPage(1)}
                  className="flex items-center gap-1 px-3 py-1.5 text-sm border rounded"
                  style={{ fontFamily: "'Barlow Condensed', sans-serif", color: 'var(--text-primary)', borderColor: 'var(--border)' }}
                >
                  <ChevronLeft size={16} />
                  Back
                </button>
                <div className="flex items-center gap-2 flex-wrap">
                  {pendingCount > 0 && !importing && (
                    <button
                      type="button"
                      onClick={acceptAllPending}
                      className="px-3 py-1.5 text-xs font-semibold border rounded"
                      style={{
                        fontFamily: "'Barlow Condensed', sans-serif",
                        textTransform: 'uppercase',
                        letterSpacing: '0.05em',
                        color: 'var(--text-primary)',
                        background: 'var(--bg-surface)',
                        borderColor: 'var(--border)',
                      }}
                    >
                      Accept All ({pendingCount})
                    </button>
                  )}
                  {importing && (
                    <div className="flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
                      <Loader2 className="animate-spin" size={16} />
                      <span style={{ fontFamily: "'Barlow Semi Condensed', sans-serif", fontSize: '0.875rem' }}>
                        Processing...
                      </span>
                    </div>
                  )}
                  <span className="text-sm" style={{ fontFamily: "'Barlow Semi Condensed', sans-serif", color: 'var(--text-primary)' }}>
                    {extractedTracks.length} files imported
                  </span>
                </div>
              </div>

              <div className="space-y-4 mb-6 max-h-96 overflow-x-hidden overflow-y-auto">
                {visibleReviewTracks.length === 0 && !importing && pendingCount === 0 && extractedTracks.length > 0 && (
                  <p className="text-sm py-6 text-center" style={{ fontFamily: "'Barlow Semi Condensed', sans-serif", color: 'var(--text-primary)' }}>
                    All tracks reviewed — apply when ready.
                  </p>
                )}
                {visibleReviewTracks.map((track) => {
                  const exitAction = exiting[track.track_id]
                  return (
                    <div
                      key={track.track_id}
                      className="p-4 rounded"
                      style={{
                        background: 'var(--bg-surface)',
                        border: '1px solid var(--border)',
                        transform: exitAction ? 'translateX(110%)' : 'translateX(0)',
                        opacity: exitAction ? 0 : 1,
                        maxHeight: exitAction ? 0 : 600,
                        marginBottom: exitAction ? 0 : undefined,
                        paddingTop: exitAction ? 0 : undefined,
                        paddingBottom: exitAction ? 0 : undefined,
                        overflow: 'hidden',
                        transition: `transform ${EXIT_MS}ms ease-in, opacity ${EXIT_MS}ms ease-in, max-height ${EXIT_MS}ms ease-in, margin ${EXIT_MS}ms ease-in, padding ${EXIT_MS}ms ease-in`,
                      }}
                    >
                      <div className="flex items-start justify-between gap-4">
                        <div className="flex-1 min-w-0">
                          <p className="text-xs uppercase mb-2" style={{ fontFamily: "'Barlow Condensed', sans-serif", color: 'var(--text-primary)' }}>
                            File
                          </p>
                          <p className="text-sm" style={{ fontFamily: "'Barlow Semi Condensed', sans-serif", color: 'var(--text-primary)' }}>
                            {track.path.split('/').pop()}
                          </p>
                          {track.quality && (
                            <p className="text-xs mt-1" style={{ fontFamily: "'Barlow Semi Condensed', sans-serif", color: 'var(--text-primary)' }}>
                              {track.quality}
                            </p>
                          )}
                        </div>
                        <div style={{ color: 'var(--text-primary)', fontSize: 20 }}>→</div>
                        <div className="flex-1 min-w-0">
                          <p className="text-xs uppercase mb-2" style={{ fontFamily: "'Barlow Condensed', sans-serif", color: 'var(--text-primary)' }}>
                            Extracted
                          </p>
                          <p className="text-sm" style={{ fontFamily: "'Barlow Semi Condensed', sans-serif", color: 'var(--text-primary)' }}>
                            {track.extracted_title}
                          </p>
                          <p className="text-xs" style={{ fontFamily: "'Barlow Semi Condensed', sans-serif", color: 'var(--text-primary)' }}>
                            {track.extracted_artist} — {track.extracted_album}
                          </p>
                        </div>
                      </div>

                      {!exitAction && (
                        <div className="flex items-center gap-2 mt-3">
                          <button
                            onClick={() => acceptTrack(track)}
                            className="p-1.5 rounded"
                            style={{ background: 'var(--bg-surface)', color: 'var(--text-primary)' }}
                            title="Accept"
                          >
                            <Check size={16} />
                          </button>
                          <button
                            onClick={() => rejectTrack(track)}
                            className="p-1.5 rounded"
                            style={{ background: 'var(--bg-surface)', color: 'var(--text-primary)' }}
                            title="Reject"
                          >
                            <XCircle size={16} />
                          </button>
                          <button
                            onClick={() => startEdit(track)}
                            className="p-1.5 rounded text-xs"
                            style={{ background: 'var(--bg-surface)', color: 'var(--text-primary)' }}
                            title="Edit"
                          >
                            Edit
                          </button>
                        </div>
                      )}

                      {editingId === track.track_id && (
                        <div className="mt-3 p-3 rounded" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}>
                          <div className="space-y-2">
                            <input
                              type="text"
                              value={editForm.title}
                              onChange={(e) => setEditForm((f) => ({ ...f, title: e.target.value }))}
                              placeholder="Title"
                              className="w-full px-3 py-1.5 text-xs rounded"
                              style={{
                                background: 'var(--bg-surface)',
                                border: '1px solid var(--border)',
                                color: 'var(--text-primary)',
                                fontFamily: "'Barlow Semi Condensed', sans-serif",
                              }}
                            />
                            <input
                              type="text"
                              value={editForm.artist}
                              onChange={(e) => setEditForm((f) => ({ ...f, artist: e.target.value }))}
                              placeholder="Artist"
                              className="w-full px-3 py-1.5 text-xs rounded"
                              style={{
                                background: 'var(--bg-surface)',
                                border: '1px solid var(--border)',
                                color: 'var(--text-primary)',
                                fontFamily: "'Barlow Semi Condensed', sans-serif",
                              }}
                            />
                            <input
                              type="text"
                              value={editForm.album}
                              onChange={(e) => setEditForm((f) => ({ ...f, album: e.target.value }))}
                              placeholder="Album"
                              className="w-full px-3 py-1.5 text-xs rounded"
                              style={{
                                background: 'var(--bg-surface)',
                                border: '1px solid var(--border)',
                                color: 'var(--text-primary)',
                                fontFamily: "'Barlow Semi Condensed', sans-serif",
                              }}
                            />
                            <div className="flex gap-2">
                              <button
                                onClick={() => saveEdit(track)}
                                className="px-3 py-1.5 text-xs rounded"
                                style={{ background: 'var(--bg-surface)', color: 'var(--text-primary)', fontFamily: "'Barlow Condensed', sans-serif" }}
                              >
                                Save
                              </button>
                              <button
                                onClick={() => setEditingId(null)}
                                className="px-3 py-1.5 text-xs rounded"
                                style={{ background: 'var(--bg-surface)', color: 'var(--text-primary)', fontFamily: "'Barlow Condensed', sans-serif" }}
                              >
                                Cancel
                              </button>
                            </div>
                          </div>
                        </div>
                      )}

                    </div>
                  )
                })}
              </div>

              <div className="flex items-center justify-between pt-4" style={{ borderTop: '1px solid var(--border)' }}>
                <p className="text-sm" style={{ fontFamily: "'Barlow Semi Condensed', sans-serif", color: 'var(--text-primary)' }}>
                  Accepted: <span style={{ color: 'var(--text-primary)' }}>{acceptedCount}</span> • Rejected:{' '}
                  <span style={{ color: 'var(--text-primary)' }}>{rejectedCount}</span> • Pending:{' '}
                  <span style={{ color: 'var(--text-primary)' }}>{pendingCount}</span>
                </p>
                <button
                  onClick={applyDecisions}
                  disabled={pendingCount > 0 || Object.keys(exiting).length > 0 || applying}
                  className="px-6 py-2 text-sm font-semibold rounded transition-colors"
                  style={{
                    fontFamily: "'Barlow Condensed', sans-serif",
                    fontWeight: 600,
                    textTransform: 'uppercase',
                    letterSpacing: '0.05em',
                    background: pendingCount > 0 || Object.keys(exiting).length > 0 ? 'var(--bg-surface)' : 'var(--bg-surface)',
                    color: pendingCount > 0 || Object.keys(exiting).length > 0 ? 'var(--text-primary)' : 'var(--text-primary)',
                    cursor: pendingCount > 0 || Object.keys(exiting).length > 0 ? 'not-allowed' : 'pointer',
                  }}
                >
                  {applying ? (
                    <span className="flex items-center gap-2">
                      <Loader2 className="animate-spin" size={16} />
                      Applying...
                    </span>
                  ) : pendingCount > 0 || Object.keys(exiting).length > 0 ? (
                    `Decide on all first (${pendingCount + Object.keys(exiting).length} pending)`
                  ) : (
                    'Apply & Close'
                  )}
                </button>
              </div>
            </>
          )}

          {page === 3 && (
            <>
              <div className="text-center mb-6">
                <div className="w-16 h-16 rounded-full mx-auto mb-4 flex items-center justify-center" style={{ background: 'color-mix(in srgb, var(--accent) 0.2, transparent)' }}>
                  <Check size={32} style={{ color: 'var(--text-primary)' }} />
                </div>
                <h3
                  className="text-xl font-bold mb-2"
                  style={{ fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 800, color: 'var(--text-primary)' }}
                >
                  Import Complete
                </h3>
                <p className="text-sm" style={{ fontFamily: "'Barlow Semi Condensed', sans-serif", color: 'var(--text-primary)' }}>
                  {applyResults?.accepted || 0} tracks imported, {applyResults?.rejected || 0} skipped
                </p>
              </div>

              {applyResults && applyResults.results.length > 0 && (
                <div className="space-y-3">
                  <p className="text-xs uppercase" style={{ fontFamily: "'Barlow Condensed', sans-serif", color: 'var(--text-primary)' }}>
                    Results
                  </p>
                  {applyResults.results.map((result) => (
                    <div
                      key={result.track_id}
                      className="p-3 rounded"
                      style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}
                    >
                      {result.status === 'accepted' ? (
                        <>
                          <div className="text-xs" style={{ fontFamily: "'Barlow Semi Condensed', sans-serif", color: 'var(--text-primary)' }}>
                            <span style={{ color: 'var(--text-primary)' }}>{result.title}</span>
                          </div>
                          <div className="text-xs" style={{ fontFamily: "'Barlow Semi Condensed', sans-serif", color: 'var(--text-primary)' }}>
                            {result.artist} — {result.album}
                          </div>
                        </>
                      ) : (
                        <div className="text-xs" style={{ fontFamily: "'Barlow Semi Condensed', sans-serif", color: 'var(--text-primary)' }}>
                          Rejected
                        </div>
                      )}
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