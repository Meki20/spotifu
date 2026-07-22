import { useState, useEffect } from 'react'
import { X, Eye, Search, Trash2, Download, Check, AlertCircle, Loader2 } from 'lucide-react'
import { authFetch, mediaUrl } from '../api'

interface ImagePickerModalProps {
  isOpen: boolean
  onClose: () => void
  artistId: string
  artistName: string
  banners: string[]
  thumbs: string[]
  bannerIdx: number
  pictureIdx: number
  onSave: (bannerIdx: number, pictureIdx: number) => void
  onRefresh: () => void
}

type ToastType = 'success' | 'error' | null

interface Toast {
  message: string
  type: ToastType
}

const FONT_HEADING = "'Barlow Condensed', sans-serif"
const FONT_BODY = "'Barlow Semi Condensed', sans-serif"

export default function ImagePickerModal({
  isOpen,
  onClose,
  artistId,
  artistName,
  banners,
  thumbs,
  bannerIdx,
  pictureIdx,
  onSave,
  onRefresh,
}: ImagePickerModalProps) {
  const [localBannerIdx, setLocalBannerIdx] = useState(bannerIdx)
  const [localPictureIdx, setLocalPictureIdx] = useState(pictureIdx)
  const [showSearch, setShowSearch] = useState(false)
  const [searchQuery, setSearchQuery] = useState(`${artistName} artist square`)
  const [searchType, setSearchType] = useState<'square' | 'banner'>('square')
  const [searchResults, setSearchResults] = useState<string[]>([])
  const [searchLoading, setSearchLoading] = useState(false)
  const [downloading, setDownloading] = useState<string | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [toast, setToast] = useState<Toast>({ message: '', type: null })

  useEffect(() => {
    setLocalBannerIdx(bannerIdx)
    setLocalPictureIdx(pictureIdx)
  }, [bannerIdx, pictureIdx])

  useEffect(() => {
    if (!isOpen) return
    onRefresh()
  }, [isOpen])

  useEffect(() => {
    if (toast.type) {
      const t = setTimeout(() => setToast({ message: '', type: null }), 2500)
      return () => clearTimeout(t)
    }
  }, [toast])

  if (!isOpen) return null

  const handleSave = () => {
    onSave(localBannerIdx, localPictureIdx)
    onClose()
  }

  const handleSearch = async () => {
    if (!searchQuery.trim()) return
    setSearchLoading(true)
    setSearchResults([])
    try {
      const res = await authFetch(`/artist/${artistId}/ddg-search?type=${searchType}&q=${encodeURIComponent(searchQuery.trim())}`)
      if (res.ok) {
        const data = await res.json()
        setSearchResults(data.results || [])
      }
    } catch (err) {
      console.error('DDG search failed:', err)
    } finally {
      setSearchLoading(false)
    }
  }

  const showToast = (message: string, type: ToastType) => {
    setToast({ message, type })
  }

  const handleDownload = async (url: string, kind: 'banner' | 'thumb') => {
    setDownloading(url)
    try {
      const res = await authFetch(`/artist/${artistId}/images/download`, {
        method: 'POST',
        body: JSON.stringify({ url, kind }),
      })
      const data = await res.json()
      if (res.ok) {
        showToast('Image downloaded', 'success')
        onRefresh()
      } else {
        showToast(data.detail || 'Download failed', 'error')
      }
    } catch (err) {
      console.error('Download failed:', err)
      showToast('Download failed', 'error')
    } finally {
      setDownloading(null)
    }
  }

  const handleDelete = async (kind: 'banner' | 'thumb', idx: number) => {
    try {
      const res = await authFetch(
        `/artist/${artistId}/images/local?kind=${kind}&idx=${idx}`,
        { method: 'DELETE' }
      )
      if (res.ok) {
        showToast('Image removed', 'success')
        onRefresh()
      }
    } catch (err) {
      console.error('Delete failed:', err)
      showToast('Failed to remove image', 'error')
    }
  }

  const localIdx = (url: string): number | null => {
    const m = url.match(/\/covers\/artist-local\/[^/]+\/(?:banner|thumb)\/(\d+)$/)
    return m ? parseInt(m[1]) : null
  }

  const handleTypeChange = (type: 'square' | 'banner') => {
    setSearchType(type)
    setSearchQuery(`${artistName} artist ${type}`)
    setSearchResults([])
  }

  return (
    <>
      {/* Toast */}
      {toast.type && (
        <div
          className="fixed top-4 right-4 z-[60] px-4 py-3 rounded flex items-center gap-2 shadow-xl"
          style={{
            background: 'var(--bg-surface)',
            border: `1px solid ${toast.type === 'success' ? 'var(--border)' : '#7a1a1a'}`,
            fontFamily: FONT_BODY,
            color: toast.type === 'success' ? 'var(--text-primary)' : 'var(--text-primary)',
          }}
        >
          {toast.type === 'success' ? <Check size={15} /> : <AlertCircle size={15} />}
          <span className="text-sm">{toast.message}</span>
        </div>
      )}

      {/* Preview overlay */}
      {previewUrl && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center"
          style={{ background: 'rgba(0,0,0,0.92)' }}
          onClick={() => setPreviewUrl(null)}
        >
          <button
            onClick={() => setPreviewUrl(null)}
            className="absolute top-4 right-4 p-1 rounded"
            style={{ color: 'var(--text-primary)' }}
          >
            <X size={24} />
          </button>
          <img
            src={previewUrl}
            alt="Preview"
            className="max-w-[90vw] max-h-[90vh] object-contain"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}

      <div
        className="fixed inset-0 z-50 flex items-center justify-center"
        style={{ background: 'rgba(0,0,0,0.8)' }}
      >
        <div
          className="w-[860px] max-h-[85vh] flex flex-col rounded-lg overflow-hidden"
          style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}
        >
          {/* Header */}
          <div
            className="flex items-center justify-between px-5 py-4 shrink-0"
            style={{ borderBottom: '1px solid var(--border)' }}
          >
            <h2
              className="text-lg font-bold tracking-wide uppercase"
              style={{ fontFamily: FONT_HEADING, fontWeight: 800, color: 'var(--text-primary)', letterSpacing: '0.04em' }}
            >
              Artist Images
            </h2>
            <button
              onClick={onClose}
              className="p-1 rounded"
              style={{ color: 'var(--text-primary)' }}
              onMouseEnter={e => (e.currentTarget.style.background = 'var(--border)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
            >
              <X size={18} />
            </button>
          </div>

          {/* Body */}
          <div className="flex gap-5 p-5 overflow-auto flex-1">

            {/* Banner picker */}
            <div className="flex-1 min-w-0">
              <p
                className="text-xs uppercase mb-3 tracking-widest"
                style={{ fontFamily: FONT_HEADING, color: 'var(--text-primary)', letterSpacing: '0.1em' }}
              >
                Banner
              </p>
              <div className="space-y-2 max-h-[280px] overflow-y-auto pr-1">
                {banners.length === 0 && (
                  <p className="text-sm" style={{ fontFamily: FONT_BODY, color: 'var(--text-primary)' }}>No banners available</p>
                )}
                {banners.map((url, i) => {
                  const lidx = localIdx(url)
                  const selected = i === localBannerIdx
                  return (
                    <div
                      key={i}
                      onClick={() => setLocalBannerIdx(i)}
                      className="relative cursor-pointer rounded overflow-hidden group"
                      style={{ border: `1px solid ${selected ? 'var(--border)' : 'var(--border)'}` }}
                    >
                      <div className="w-full aspect-[16/6]" style={{ background: '--bg-base' }}>
                        <img
                          src={mediaUrl(url)}
                          alt={`Banner ${i + 1}`}
                          className="w-full h-full object-cover"
                          loading="lazy"
                        />
                      </div>
                      {selected && (
                        <div className="absolute inset-0 pointer-events-none" style={{ background: 'color-mix(in srgb, var(--accent) 0.12, transparent)' }} />
                      )}
                      <div
                        className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-2"
                        style={{ background: 'rgba(0,0,0,0.65)' }}
                      >
                        <button
                          onClick={(e) => { e.stopPropagation(); setPreviewUrl(mediaUrl(url) ?? url) }}
                          className="p-1.5 rounded"
                          style={{ background: 'rgba(255,255,255,0.1)', color: 'var(--text-primary)' }}
                          title="Preview"
                        >
                          <Eye size={13} />
                        </button>
                        {lidx !== null && (
                          <button
                            onClick={(e) => { e.stopPropagation(); handleDelete('banner', lidx) }}
                            className="p-1.5 rounded"
                            style={{ background: 'rgba(255,255,255,0.1)', color: 'var(--text-primary)' }}
                            title="Delete"
                          >
                            <Trash2 size={13} />
                          </button>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>

            {/* Thumbnail picker */}
            <div className="flex-1 min-w-0">
              <p
                className="text-xs uppercase mb-3 tracking-widest"
                style={{ fontFamily: FONT_HEADING, color: 'var(--text-primary)', letterSpacing: '0.1em' }}
              >
                Thumbnail
              </p>
              <div className="grid grid-cols-3 gap-3 max-h-[280px] overflow-y-auto pr-1">
                {thumbs.length === 0 && (
                  <p className="text-sm col-span-3" style={{ fontFamily: FONT_BODY, color: 'var(--text-primary)' }}>No thumbnails available</p>
                )}
                {thumbs.map((url, i) => {
                  const lidx = localIdx(url)
                  const selected = i === localPictureIdx
                  return (
                    <div
                      key={i}
                      onClick={() => setLocalPictureIdx(i)}
                      className="relative cursor-pointer rounded-full overflow-hidden aspect-square group"
                      style={{ border: `2px solid ${selected ? 'var(--border)' : 'var(--border)'}` }}
                    >
                      <img
                        src={mediaUrl(url)}
                        alt={`Thumbnail ${i + 1}`}
                        className="w-full h-full object-cover"
                        loading="lazy"
                      />
                      {selected && (
                        <div className="absolute inset-0 pointer-events-none" style={{ background: 'color-mix(in srgb, var(--accent) 0.12, transparent)' }} />
                      )}
                      <div
                        className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-1.5"
                        style={{ background: 'rgba(0,0,0,0.65)' }}
                      >
                        <button
                          onClick={(e) => { e.stopPropagation(); setPreviewUrl(mediaUrl(url) ?? url) }}
                          className="p-1 rounded-full"
                          style={{ background: 'rgba(255,255,255,0.1)', color: 'var(--text-primary)' }}
                          title="Preview"
                        >
                          <Eye size={11} />
                        </button>
                        {lidx !== null && (
                          <button
                            onClick={(e) => { e.stopPropagation(); handleDelete('thumb', lidx) }}
                            className="p-1 rounded-full"
                            style={{ background: 'rgba(255,255,255,0.1)', color: 'var(--text-primary)' }}
                            title="Delete"
                          >
                            <Trash2 size={11} />
                          </button>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>

            {/* Search panel */}
            {showSearch && (
              <div className="flex-1 min-w-0 pl-5" style={{ borderLeft: '1px solid var(--border)' }}>
                <p
                  className="text-xs uppercase mb-3 tracking-widest"
                  style={{ fontFamily: FONT_HEADING, color: 'var(--text-primary)', letterSpacing: '0.1em' }}
                >
                  Search Online
                </p>

                <div className="flex gap-1.5 mb-3">
                  {(['square', 'banner'] as const).map((t) => (
                    <button
                      key={t}
                      onClick={() => handleTypeChange(t)}
                      className="px-3 py-1 text-xs rounded"
                      style={{
                        fontFamily: FONT_HEADING,
                        background: searchType === t ? 'var(--bg-surface)' : 'var(--bg-surface)',
                        color: searchType === t ? 'var(--text-primary)' : 'var(--text-primary)',
                        letterSpacing: '0.04em',
                      }}
                    >
                      {t === 'square' ? 'Thumbnails' : 'Banners'}
                    </button>
                  ))}
                </div>

                <div className="flex gap-2 mb-3">
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                    className="flex-1 px-3 py-1.5 text-sm rounded outline-none"
                    style={{
                      fontFamily: FONT_BODY,
                      background: '--bg-base',
                      border: '1px solid var(--border)',
                      color: 'var(--text-primary)',
                    }}
                    placeholder="Search query…"
                  />
                  <button
                    onClick={handleSearch}
                    disabled={searchLoading || !searchQuery.trim()}
                    className="p-1.5 rounded disabled:opacity-30"
                    style={{ background: 'var(--bg-surface)', color: 'var(--text-primary)' }}
                  >
                    {searchLoading ? <Loader2 size={15} className="animate-spin" /> : <Search size={15} />}
                  </button>
                </div>

                <div className="space-y-2 max-h-[220px] overflow-y-auto pr-1">
                  {!searchLoading && searchResults.length === 0 && (
                    <p className="text-sm" style={{ fontFamily: FONT_BODY, color: 'var(--text-primary)' }}>
                      {searchQuery ? 'No results' : ''}
                    </p>
                  )}
                  {searchResults.map((url, i) => (
                    <div
                      key={i}
                      className="relative rounded overflow-hidden group"
                      style={{ border: '1px solid var(--border)' }}
                    >
                      <img
                        src={url}
                        alt={`Result ${i + 1}`}
                        className="w-full h-20 object-cover cursor-pointer"
                        loading="lazy"
                        onClick={() => setPreviewUrl(url)}
                      />
                      <div
                        className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-2"
                        style={{ background: 'rgba(0,0,0,0.65)' }}
                      >
                        <button
                          onClick={() => setPreviewUrl(url)}
                          className="p-1.5 rounded"
                          style={{ background: 'rgba(255,255,255,0.1)', color: 'var(--text-primary)' }}
                          title="Preview"
                        >
                          <Eye size={13} />
                        </button>
                        <button
                          onClick={() => handleDownload(url, searchType === 'square' ? 'thumb' : 'banner')}
                          disabled={downloading === url}
                          className="p-1.5 rounded disabled:opacity-30"
                          style={{ background: 'var(--bg-surface)', color: 'var(--text-primary)' }}
                          title="Download"
                        >
                          {downloading === url
                            ? <Loader2 size={13} className="animate-spin" />
                            : <Download size={13} />
                          }
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Footer */}
          <div
            className="flex justify-between items-center px-5 py-3.5 shrink-0"
            style={{ borderTop: '1px solid var(--border)' }}
          >
            <button
              onClick={() => setShowSearch(!showSearch)}
              className="px-3 py-1.5 text-xs rounded"
              style={{
                fontFamily: FONT_HEADING,
                letterSpacing: '0.05em',
                background: showSearch ? 'var(--bg-surface)' : 'transparent',
                color: showSearch ? 'var(--text-primary)' : 'var(--text-primary)',
                border: '1px solid var(--border)',
              }}
            >
              {showSearch ? 'Hide Search' : 'Search Online'}
            </button>
            <div className="flex gap-2">
              <button
                onClick={onClose}
                className="px-4 py-1.5 text-sm rounded"
                style={{
                  fontFamily: FONT_HEADING,
                  letterSpacing: '0.05em',
                  color: 'var(--text-primary)',
                  border: '1px solid var(--border)',
                }}
              >
                Cancel
              </button>
              <button
                onClick={handleSave}
                className="px-4 py-1.5 text-sm font-semibold rounded"
                style={{
                  fontFamily: FONT_HEADING,
                  letterSpacing: '0.05em',
                  background: 'var(--bg-surface)',
                  color: 'var(--text-primary)',
                }}
              >
                Save
              </button>
            </div>
          </div>

        </div>
      </div>
    </>
  )
}
