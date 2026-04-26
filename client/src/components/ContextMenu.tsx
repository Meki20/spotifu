import { useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { displayArtist } from '../utils/trackHelpers'

interface ContextMenuProps {
  x: number
  y: number
  track: unknown
  onPlay: () => void
  onDownload?: () => void
  onAddToQueue?: () => void
  onGoToArtist?: () => void
  onGoToAlbum?: () => void
  onAddToPlaylist?: () => void
  onRemoveFromPlaylist?: () => void
  onClose: () => void
}

type TrackLike = Record<string, unknown>

function asTrackLike(t: unknown): TrackLike | null {
  return t != null && typeof t === 'object' ? (t as TrackLike) : null
}

function getStr(t: unknown, key: string): string {
  const obj = asTrackLike(t)
  const v = obj ? obj[key] : null
  return typeof v === 'string' ? v : v == null ? '' : String(v)
}

export default function ContextMenu({
  x,
  y,
  track,
  onPlay,
  onDownload,
  onAddToQueue,
  onGoToArtist,
  onGoToAlbum,
  onAddToPlaylist,
  onRemoveFromPlaylist,
  onClose,
}: ContextMenuProps) {
  const ref = useRef<HTMLDivElement | null>(null)
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: x, top: y })

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) {
      setPos({ left: x, top: y })
      return
    }

    const margin = 8
    const rect = el.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight

    let left = x
    let top = y

    // Prefer opening above the pointer if there isn't enough space below.
    if (top + rect.height > vh - margin) top = y - rect.height

    // Clamp within viewport.
    if (left + rect.width > vw - margin) left = vw - rect.width - margin
    if (left < margin) left = margin
    if (top + rect.height > vh - margin) top = vh - rect.height - margin
    if (top < margin) top = margin

    setPos({ left, top })
  }, [x, y])

  return createPortal(
    <div
      className="fixed z-[60] min-w-48 py-1 text-sm"
      style={{
        left: pos.left,
        top: pos.top,
        background: '#1A1210',
        border: '1px solid #3D2820',
        borderRadius: 4,
      }}
      ref={ref}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation() }}
    >
      {track != null && (
      <div
        className="px-4 py-2"
        style={{ borderBottom: '1px solid #261A14' }}
      >
        <p
          className="truncate"
          style={{ fontFamily: "'Barlow Semi Condensed', sans-serif", color: '#E8DDD0' }}
        >
          {getStr(track, 'title')}
        </p>
        <p
          className="text-xs truncate mt-0.5"
          style={{ fontFamily: "'Barlow Semi Condensed', sans-serif", color: '#9A8E84' }}
        >
          {displayArtist({ artist: getStr(track, 'artist'), artist_credit: getStr(track, 'artist_credit') })}
        </p>
      </div>
      )}

      <button
        className="w-full text-left px-4 py-2 hover:bg-[#2E1E19] transition-colors"
        style={{ fontFamily: "'Barlow Semi Condensed', sans-serif", color: '#E8DDD0' }}
        onClick={() => { onPlay(); onClose() }}
      >
        Play
      </button>

      {onDownload && (
        <button
          className="w-full text-left px-4 py-2 hover:bg-[#2E1E19] transition-colors"
          style={{ fontFamily: "'Barlow Semi Condensed', sans-serif", color: '#E8DDD0' }}
          onClick={() => { onDownload(); onClose() }}
        >
          Download Full Track
        </button>
      )}

      {onAddToQueue && (
        <button
          className="w-full text-left px-4 py-2 hover:bg-[#2E1E19] transition-colors"
          style={{ fontFamily: "'Barlow Semi Condensed', sans-serif", color: '#E8DDD0' }}
          onClick={() => { onAddToQueue(); onClose() }}
        >
          Add to queue
        </button>
      )}

      {onGoToArtist && (
        <button
          className="w-full text-left px-4 py-2 hover:bg-[#2E1E19] transition-colors"
          style={{ fontFamily: "'Barlow Semi Condensed', sans-serif", color: '#E8DDD0' }}
          onClick={() => { onGoToArtist(); onClose() }}
        >
          Go to artist
        </button>
      )}

      {onGoToAlbum && (
        <button
          className="w-full text-left px-4 py-2 hover:bg-[#2E1E19] transition-colors"
          style={{ fontFamily: "'Barlow Semi Condensed', sans-serif", color: '#E8DDD0' }}
          onClick={() => { onGoToAlbum(); onClose() }}
        >
          Go to album
        </button>
      )}

      {onAddToPlaylist && (
        <button
          className="w-full text-left px-4 py-2 hover:bg-[#2E1E19] transition-colors"
          style={{ fontFamily: "'Barlow Semi Condensed', sans-serif", color: '#E8DDD0' }}
          onClick={() => { onAddToPlaylist(); onClose() }}
        >
          Add to playlist
        </button>
      )}

      {onRemoveFromPlaylist && (
        <div className="mt-1 pt-1" style={{ borderTop: '1px solid #261A14' }}>
          <button
            className="w-full text-left px-4 py-2 hover:bg-[#2E1E19] transition-colors"
            style={{ fontFamily: "'Barlow Semi Condensed', sans-serif", color: '#b4003e' }}
            onClick={() => { onRemoveFromPlaylist(); onClose() }}
          >
            Remove from this playlist
          </button>
        </div>
      )}
    </div>,
    document.body
  )
}