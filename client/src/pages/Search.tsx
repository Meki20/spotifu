import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query'
import { useVirtualizer } from '@tanstack/react-virtual'
import { type Track, usePlayerStore } from '../stores/playerStore'
import { useNavigate, useLocation } from 'react-router-dom'
import { subscribeSpotifuWebSocket } from '../spotifuWebSocket'
import { API, authFetch } from '../api'
import { requestMbDownload } from '../stores/downloadBusyStore'
import * as controller from '../playback/controller'
import { useDownloadStates } from '../hooks/useDownloadStates'
import { useArtistPrefetch } from '../hooks/useArtistPrefetch'
import TrackRowFull from '../components/TrackRowFull'
import AlbumCard from '../components/AlbumCard'
import ContextMenu from '../components/ContextMenu'
import AddToPlaylistModal, { type AddToPlaylistTrack } from '../components/AddToPlaylistModal'
import { useContextMenuActions } from '../contexts/ContextMenuProvider'
import { useAuthStore } from '../stores/authStore'
import { PollyLoading } from '../components/PollyLoading'

const MAX_RECENT = 20

interface TrackSection {
  type: string
  label: string
  tracks: Track[]
}

interface HybridSearchResponse {
  intent: string
  sections: TrackSection[]
}

type SearchListRow =
  | { kind: 'track'; track: Track; playIdx: number }
  | { kind: 'sep'; label: string }

const SEARCH_QUERY_MAX_LEN = 200

function isPlausibleSearchQuery(q: string): boolean {
  if (q.length > SEARCH_QUERY_MAX_LEN) return false
  const lower = q.toLowerCase()
  if (lower.includes('websocket connection')) return false
  if (lower.includes('failed to load resource')) return false
  if (lower.includes('net::err_')) return false
  if (/\(anonymous\)\s*@\s*\S+\.(tsx?|jsx?):/i.test(q)) return false
  return true
}

async function searchLocal(q: string): Promise<Track[]> {
  const res = await authFetch(`/search?q=${encodeURIComponent(q)}&local=true`)
  if (!res.ok) throw new Error('Search failed')
  const data = await res.json()
  return data.tracks
}

async function searchHybrid(q: string, signal?: AbortSignal): Promise<HybridSearchResponse> {
  const res = await authFetch(`/search/hybrid?q=${encodeURIComponent(q)}`, { signal })
  if (!res.ok) throw new Error('Search failed')
  return res.json()
}

async function fetchSearchHistory(): Promise<string[]> {
  const res = await authFetch('/search/history')
  if (!res.ok) throw new Error('Failed to fetch search history')
  return res.json()
}

async function clearSearchHistory(): Promise<void> {
  const res = await authFetch('/search/history', { method: 'DELETE' })
  if (!res.ok) throw new Error('Failed to clear search history')
}

type SimilarStreamEvent =
  | { type: 'track'; track: Track }
  | { type: 'done'; notice?: string; cached?: boolean }

function parseNdjsonLine(line: string): SimilarStreamEvent | null {
  const t = line.trim()
  if (!t) return null
  try {
    return JSON.parse(t) as SimilarStreamEvent
  } catch {
    return null
  }
}

interface ContextMenu {
  x: number
  y: number
  track: Track
}


export default function Search() {
  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [localOnly, setLocalOnly] = useState(false)
  const [activeTab, setActiveTab] = useState<'songs' | 'albums'>('songs')
  const [hybridData, setHybridData] = useState<HybridSearchResponse | null>(null)
  const [hybridLoading, setHybridLoading] = useState(false)
  const [hybridError, setHybridError] = useState<Error | null>(null)
  const hybridAbortRef = useRef<AbortController | null>(null)
  const [similarTracks, setSimilarTracks] = useState<Track[]>([])
  const [similarStreamPending, setSimilarStreamPending] = useState(false)
  const [similarNotice, setSimilarNotice] = useState<string | null>(null)
  const similarStreamGenRef = useRef(0)
  const [contextMenu, setContextMenu] = useState<ContextMenu | null>(null)
  const [addPlOpen, setAddPlOpen] = useState(false)
  const [addPlTrack, setAddPlTrack] = useState<AddToPlaylistTrack | null>(null)
  const [focused, setFocused] = useState(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const navigate = useNavigate()
  const { openContextMenu } = useContextMenuActions()
  const location = useLocation()
  const queryClient = useQueryClient()
  const token = useAuthStore((s) => s.token)

  const { downloadStates, cachedMbIds } = useDownloadStates()

  const { enqueue } = useArtistPrefetch({ drainMs: 520 })

  const [cachedIds, setCachedIds] = useState<Set<string>>(new Set())

  const { data: recentSearches = [], refetch: refetchSearchHistory } = useQuery({
    queryKey: ['search-history'],
    queryFn: fetchSearchHistory,
    enabled: !!token,
  })

  const clearHistoryMutation = useMutation({
    mutationFn: clearSearchHistory,
    onSuccess: () => {
      queryClient.setQueryData<string[]>(['search-history'], [])
    },
  })

  function handleClearSearchHistory() {
    clearHistoryMutation.mutate()
  }

  function handleRecentSearchClick(term: string) {
    setQuery(term)
  }

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => setDebouncedQuery(query), 300)
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [query])

  // Abort any in-flight hybrid search immediately on every keystroke
  useEffect(() => {
    hybridAbortRef.current?.abort()
    hybridAbortRef.current = null
  }, [query])

  // Fire hybrid fetch when debounced query settles; abort previous if still running
  useEffect(() => {
    if (localOnly || debouncedQuery.length <= 2 || !isPlausibleSearchQuery(debouncedQuery)) {
      setHybridData(null)
      setHybridLoading(false)
      setHybridError(null)
      return
    }
    const controller = new AbortController()
    hybridAbortRef.current = controller
    setHybridLoading(true)
    setHybridError(null)
    const q = debouncedQuery
    searchHybrid(q, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) {
          setHybridData(result)
          refetchSearchHistory()
          setHybridLoading(false)
        }
      })
      .catch((err) => {
        if (!controller.signal.aborted) {
          setHybridError(err)
          setHybridLoading(false)
        }
      })
    return () => {
      controller.abort()
    }
  }, [debouncedQuery, localOnly])

  useEffect(() => {
    if (location.state?.localOnly === true) setLocalOnly(true)
  }, [location.state])

  useEffect(() => {
    setCachedIds(cachedMbIds)
  }, [cachedMbIds])

  useEffect(() => {
    return subscribeSpotifuWebSocket((data) => {
      if (data.type !== 'track_ready') return
      const mbId = data.mb_id as string | undefined
      if (!mbId) return
      setCachedIds((prev) => new Set([...prev, mbId]))
      setHybridData((old) => {
        if (!old?.sections) return old
        const mark = (t: Track) => (t.mb_id === mbId ? { ...t, is_cached: true } : t)
        return {
          ...old,
          sections: old.sections.map((sec) => ({ ...sec, tracks: sec.tracks.map(mark) })),
        }
      })
    })
  }, [])

  const { data: localResults, isLoading: localLoading, error: localError } = useQuery({
    queryKey: ['search-local', debouncedQuery],
    queryFn: async () => {
      const result = await searchLocal(debouncedQuery)
      return result
    },
    enabled:
      debouncedQuery.length > 2 && localOnly && isPlausibleSearchQuery(debouncedQuery),
  })

  useEffect(() => {
    if (localResults) {
      refetchSearchHistory()
    }
  }, [localResults])

  const isLoading = localOnly ? localLoading : hybridLoading
  const error = localOnly ? localError : hybridError
  const results: Track[] = useMemo(() => {
    return localOnly ? (localResults ?? []) : (hybridData?.sections.flatMap((s) => s.tracks) ?? [])
  }, [localOnly, localResults, hybridData])

  const persistResolvedSearchCover = useCallback(
    (mbid: string, url: string) => {
      if (!mbid || !url) return
      if (localOnly) {
        queryClient.setQueryData(['search-local', debouncedQuery], (old: Track[] | undefined) => {
          if (!old) return old
          return old.map((t) => (t.mb_id === mbid && t.album_cover !== url ? { ...t, album_cover: url } : t))
        })
      } else {
        setHybridData((old) => {
          if (!old?.sections) return old
          return {
            ...old,
            sections: old.sections.map((sec) => ({
              ...sec,
              tracks: sec.tracks.map((t) =>
                t.mb_id === mbid && t.album_cover !== url ? { ...t, album_cover: url } : t,
              ),
            })),
          }
        })
      }
      usePlayerStore.setState((s) => {
        const nextUserQueue = (s.userQueue || []).map((t) =>
          t.mb_id === mbid && t.album_cover !== url ? { ...t, album_cover: url } : t,
        )
        const nextSystemList = (s.systemList || []).map((t) =>
          t.mb_id === mbid && t.album_cover !== url ? { ...t, album_cover: url } : t,
        )
        const nextCurrent =
          s.currentTrack && s.currentTrack.mb_id === mbid && s.currentTrack.album_cover !== url
            ? { ...s.currentTrack, album_cover: url }
            : s.currentTrack
        return { userQueue: nextUserQueue, systemList: nextSystemList, currentTrack: nextCurrent }
      })
    },
    [debouncedQuery, localOnly, queryClient],
  )

  const bestMatchMbid = useMemo(() => {
    if (localOnly) return null
    const t = hybridData?.sections?.[0]?.tracks?.[0]
    return t?.mb_id || null
  }, [hybridData, localOnly])

  // Similar tracks are now returned directly by `/search/hybrid` (as a section),
  // so we don't need the background NDJSON stream here.
  useEffect(() => {
    setSimilarTracks([])
    setSimilarNotice(null)
    setSimilarStreamPending(false)
  }, [debouncedQuery, localOnly])

  const flatListRows: SearchListRow[] = useMemo(() => {
    if (localOnly) {
      return results.map((track, i) => ({ kind: 'track' as const, track, playIdx: i }))
    }
    const topLen = hybridData?.sections?.[0]?.tracks?.length ?? 0
    const relatedLabel =
      hybridData?.sections?.find((s) => s.type === 'related')?.label ?? 'Related tracks'
    const out: SearchListRow[] = []
    for (let i = 0; i < results.length; i++) {
      if (topLen > 0 && i === topLen && results.length > topLen) {
        out.push({ kind: 'sep', label: relatedLabel })
      }
      out.push({ kind: 'track', track: results[i], playIdx: i })
    }
    return out
  }, [results, localOnly, hybridData])

  const rowVirtualizer = useVirtualizer({
    count: flatListRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => (flatListRows[index]?.kind === 'sep' ? 48 : 40),
    overscan: 10,
  })

  if (error) console.error('Search error:', error)

  function playTrack(track: Track) {
    controller.play(track)
  }

  function downloadTrack(track: Track) {
    requestMbDownload(authFetch, track.mb_id)
      .then((r) => (r && r.ok ? r.json() : null))
      .then((data) => {
        if (data && data.status === 'already_downloaded' && data.local_stream_url) {
          const updated: Track = {
            ...track,
            local_stream_url: `${API}${data.local_stream_url}`,
            track_id: data.track_id,
            is_cached: true,
          }
          controller.play(updated)
        }
      })
      .catch(console.error)
  }

  function handleContextMenu(e: React.MouseEvent, track: Track) {
    e.preventDefault()
    setContextMenu({ x: e.clientX, y: e.clientY, track })
  }

  function handleAlbumContextMenu(e: React.MouseEvent, album: any) {
    e.preventDefault()
    e.stopPropagation()
    openContextMenu(e.clientX, e.clientY, { ...album, title: album.title, artist: album.artist })
  }

  const showResults = query.length > 0

  const uniqueAlbums = results
    ? Array.from(new Map(results.map(t => [(t as any).mb_release_group_id ?? t.mb_release_id ?? t.album, t])).values())
    : []

  return (
    <div ref={scrollRef} className="p-6 flex-1 overflow-y-auto" onClick={() => setContextMenu(null)}>
      {/* Search input + local toggle */}
      <div className="flex items-center gap-3 mb-6">
        <div className="relative flex-1">
          <span
            className="absolute left-3 top-1/2 -translate-y-1/2 text-lg"
            style={{ color: '#4A413C' }}
          >
            ◎
          </span>
          <input
            className="w-full px-4 py-3 pl-10 rounded text-sm"
            style={{
              background: '#1A1210',
              border: `1px solid ${focused ? '#b4003e' : '#3D2820'}`,
              fontFamily: "'Barlow Semi Condensed', monospace",
              fontSize: 16,
              color: '#E8DDD0',
              outline: 'none',
            }}
            placeholder="search tracks, albums, artists..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            autoComplete="off"
          />
        </div>
        {/* Local-only toggle pill */}
        <div
          className="flex rounded overflow-hidden border"
          style={{ borderColor: '#3D2820', fontFamily: "'Barlow Condensed', sans-serif", fontSize: 14, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.1em' }}
        >
          <button
            onClick={() => setLocalOnly(false)}
            className="px-3 py-2 transition-colors"
            style={{ background: !localOnly ? '#b4003e' : '#1A1210', color: !localOnly ? '#E8DDD0' : '#9A8E84' }}
          >
            All
          </button>
          <button
            onClick={() => setLocalOnly(true)}
            className="px-3 py-2 transition-colors"
            style={{ background: localOnly ? '#b4003e' : '#1A1210', color: localOnly ? '#E8DDD0' : '#9A8E84' }}
          >
            Local Only
          </button>
        </div>
      </div>

      {/* Recent searches */}
      {!showResults && recentSearches.length > 0 && (
        <div className="mb-6">
          <div className="flex items-center justify-between mb-3">
            <span
              style={{
                fontFamily: "'Barlow Condensed', sans-serif",
                fontSize: 14,
                fontWeight: 600,
                textTransform: 'uppercase',
                letterSpacing: '0.12em',
                color: '#b4003e',
              }}
            >
              Recent Searches
            </span>
            <button
              onClick={handleClearSearchHistory}
              style={{
                fontFamily: "'Barlow Condensed', sans-serif",
                fontSize: 12,
                color: '#9A8E84',
                cursor: 'pointer',
                background: 'none',
                border: 'none',
              }}
            >
              clear
            </button>
          </div>
          <div className="flex flex-wrap gap-2">
            {recentSearches.map((term, i) => (
              <button
                key={i}
                onClick={() => handleRecentSearchClick(term)}
                className="px-3 py-1 rounded text-sm transition-colors"
                style={{
                  background: '#1A1210',
                  border: '1px solid #3D2820',
                  fontFamily: "'Barlow Semi Condensed', sans-serif",
                  color: '#9A8E84',
                  cursor: 'pointer',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.borderColor = '#b4003e'
                  e.currentTarget.style.color = '#E8DDD0'
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.borderColor = '#3D2820'
                  e.currentTarget.style.color = '#9A8E84'
                }}
              >
                {term}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Results / all tracks */}
      <div
        className="flex items-center gap-2.5 mb-3"
        style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 18, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.12em', color: '#b4003e' }}
      >
        {showResults ? `results for "${query}"` : 'All Tracks'}
        <div className="flex-1 h-px" style={{ background: '#261A14' }} />
      </div>

      {isLoading && (
        <div className="flex items-center gap-3 py-2">
          <PollyLoading size={36} />
          <span className="text-sm" style={{ color: '#4A413C', fontFamily: "'Barlow Semi Condensed', sans-serif" }}>
            searching…
          </span>
        </div>
      )}
      {!isLoading && similarStreamPending && !localOnly && bestMatchMbid && (
        <div className="flex items-center gap-3 py-2 mb-1">
          <PollyLoading size={32} />
          <span className="text-sm" style={{ color: '#4A413C', fontFamily: "'Barlow Semi Condensed', sans-serif" }}>
            similar tracks…
          </span>
        </div>
      )}
      {error && (
        <div className="text-base" style={{ color: '#b4003e' }}>Error: {String(error)}</div>
      )}
      {!isLoading && results?.length === 0 && debouncedQuery.length > 2 && (
        <div className="text-base" style={{ color: '#4A413C', fontFamily: "'Barlow Semi Condensed', sans-serif" }}>
          no tracks found
        </div>
      )}

      {/* Songs tab */}
      {!isLoading && activeTab === 'songs' && results && results.length > 0 && (
        <>
          {/* Header row */}
          <div
            className="grid gap-4 px-4 py-2 mb-1"
            style={{ gridTemplateColumns: 'auto 1fr 1fr auto', borderBottom: '1px solid #261A14' }}
          >
            <span className="w-8 text-center text-xs" style={{ color: '#4A413C', fontFamily: "'Barlow Semi Condensed', monospace", fontSize: 15 }}>#</span>
            <span className="text-sm" style={{ color: '#9A8E84', fontFamily: "'Barlow Semi Condensed', monospace" }}>Title</span>
            <span className="text-sm" style={{ color: '#9A8E84', fontFamily: "'Barlow Semi Condensed', monospace" }}>Album</span>
            <span className="text-right text-sm" style={{ color: '#9A8E84', fontFamily: "'Barlow Semi Condensed', monospace" }}>Status</span>
          </div>
          {/* No inner scrolling container: the page itself scrolls. */}
          <div
            style={{
              height: `${rowVirtualizer.getTotalSize()}px`,
              width: '100%',
              position: 'relative',
            }}
          >
            {rowVirtualizer.getVirtualItems().map((virtualRow) => {
              const row = flatListRows[virtualRow.index]
              if (row.kind === 'sep') {
                return (
                  <div
                    key={`search-sep-${virtualRow.index}`}
                    className="flex items-center gap-3 px-4 select-none"
                    style={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      width: '100%',
                      height: `${virtualRow.size}px`,
                      transform: `translateY(${virtualRow.start}px)`,
                    }}
                    role="separator"
                    aria-label={row.label}
                  >
                    <div className="flex-1 h-px shrink-0" style={{ background: '#261A14' }} />
                    <span
                      className="shrink-0 whitespace-nowrap"
                      style={{
                        fontFamily: "'Barlow Condensed', sans-serif",
                        fontSize: 12,
                        fontWeight: 600,
                        letterSpacing: '0.14em',
                        textTransform: 'uppercase',
                        color: '#b4003e',
                      }}
                    >
                      {row.label}
                    </span>
                    <div className="flex-1 h-px shrink-0" style={{ background: '#261A14' }} />
                  </div>
                )
              }
              const { track, playIdx } = row
              const rowKey = track.mb_id || `${virtualRow.index}-${track.title}`
              const downloadState = downloadStates[rowKey]
              const isCached = track.is_cached || cachedIds.has(track.mb_id)
              return (
                <div
                  key={rowKey}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    height: `${virtualRow.size}px`,
                    transform: `translateY(${virtualRow.start}px)`,
                  }}
                >
                  <TrackRowFull
                    track={track}
                    index={playIdx}
                    isCached={isCached}
                    downloadState={downloadState}
                    playlistStyleCover
                    onCoverResolved={persistResolvedSearchCover}
                    onPlay={() => playTrack(track)}
                    onContextMenu={(e) => handleContextMenu(e, track)}
                    onHoverArtist={(artistId, albumIds) => enqueue(artistId, albumIds)}
                  />
                </div>
              )
            })}
          </div>
          {!localOnly && similarNotice && results.length > 0 && (
            <p
              className="mt-3 px-4 text-sm leading-relaxed"
              style={{ color: '#6B625C', fontFamily: "'Barlow Semi Condensed', sans-serif" }}
            >
              {similarNotice}
            </p>
          )}
        </>
      )}

      {/* Albums tab */}
      {!isLoading && activeTab === 'albums' && results && (
        <div className="grid grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
          {uniqueAlbums.map((track) => {
            const albumId = (track as any).mb_release_group_id ?? track.mb_release_id
            return (
              <AlbumCard
                key={(track as any).mb_release_group_id ?? track.mb_release_id ?? track.album}
                album={{ id: albumId ?? track.album, title: track.album, artist: track.artist, cover: track.album_cover }}
                onClick={(id) => id && navigate(`/album/${id}`)}
                onMouseEnter={() => {
                  if (track.mb_artist_id) enqueue(track.mb_artist_id, track.mb_release_id ? [track.mb_release_id] : [])
                }}
                onContextMenu={handleAlbumContextMenu}
              />
            )
          })}
        </div>
      )}

      {/* Tabs for songs/albums */}
      {results && results.length > 0 && (
        <div className="flex gap-2 mt-4">
          {(['songs', 'albums'] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className="px-4 py-1 rounded text-sm font-semibold capitalize transition-colors"
              style={{
                background: activeTab === tab ? '#b4003e' : '#1A1210',
                color: activeTab === tab ? '#E8DDD0' : '#9A8E84',
                border: `1px solid ${activeTab === tab ? '#b4003e' : '#3D2820'}`,
                fontFamily: "'Barlow Condensed', sans-serif",
                fontWeight: 600,
                textTransform: 'uppercase',
                letterSpacing: '0.1em',
              }}
            >
              {tab}
            </button>
          ))}
        </div>
      )}

      {/* Context Menu */}
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          track={contextMenu.track}
          onPlay={() => { playTrack(contextMenu.track); setContextMenu(null) }}
          onDownload={() => { downloadTrack(contextMenu.track); setContextMenu(null) }}
          onAddToQueue={() => { controller.addToQueue(contextMenu.track); setContextMenu(null) }}
          onGoToArtist={() => {
            const t = contextMenu.track
            const artistId = t.mb_artist_id
            if (artistId) navigate(`/artist/${artistId}`)
            setContextMenu(null)
          }}
          onGoToAlbum={() => {
            const t = contextMenu.track as any
            const albumId = t.mb_release_group_id ?? t.mb_release_id
            if (albumId) navigate(`/album/${albumId}`)
            setContextMenu(null)
          }}
          onAddToPlaylist={
            contextMenu.track.mb_id
              ? () => {
                  const t = contextMenu.track as any
                  setAddPlTrack({
                    title: String(t.title ?? ''),
                    artist: String(t.artist ?? ''),
                    album: t.album != null ? String(t.album) : undefined,
                    album_cover: t.album_cover ?? null,
                    mb_id: t.mb_id,
                    mb_artist_id: t.mb_artist_id ?? null,
                    mb_release_id: t.mb_release_id ?? null,
                    mb_release_group_id: t.mb_release_group_id ?? null,
                  })
                  setAddPlOpen(true)
                }
              : undefined
          }
          onClose={() => setContextMenu(null)}
        />
      )}
      <AddToPlaylistModal
        open={addPlOpen}
        track={addPlTrack}
        onClose={() => {
          setAddPlOpen(false)
          setAddPlTrack(null)
        }}
      />
    </div>
  )
}