import { useState, useEffect, useRef, useMemo } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useVirtualizer } from '@tanstack/react-virtual'
import { type Track } from '../stores/playerStore'
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

const RECENT_SEARCHES_KEY = 'spotifu_recent_searches'
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

async function searchHybrid(q: string): Promise<HybridSearchResponse> {
  const res = await authFetch(`/search/hybrid?q=${encodeURIComponent(q)}`)
  if (!res.ok) throw new Error('Search failed')
  return res.json()
}

type SimilarStreamEvent =
  | { type: 'track'; track: Track }
  | { type: 'done' }

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
  const [similarTracks, setSimilarTracks] = useState<Track[]>([])
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

  const { enqueue } = useArtistPrefetch()

  const [cachedIds, setCachedIds] = useState<Set<string>>(new Set())
  const [recentSearches, setRecentSearches] = useState<string[]>([])

  // Load recent searches from localStorage
  useEffect(() => {
    try {
      const stored = localStorage.getItem(RECENT_SEARCHES_KEY)
      if (stored) setRecentSearches(JSON.parse(stored))
    } catch {}
  }, [])

  // Save search term to recent searches
  function saveSearchTerm(q: string) {
    if (!q.trim() || q.length < 2) return
    const trimmed = q.trim()
    const next = [trimmed, ...recentSearches.filter(s => s !== trimmed)].slice(0, MAX_RECENT)
    setRecentSearches(next)
    localStorage.setItem(RECENT_SEARCHES_KEY, JSON.stringify(next))
  }

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => setDebouncedQuery(query), 300)
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [query])

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
      queryClient.setQueriesData<HybridSearchResponse>(
        { queryKey: ['search-hybrid'] },
        (old) => {
          if (!old?.sections) return old
          const mark = (t: Track) =>
            t.mb_id === mbId ? { ...t, is_cached: true } : t
          return {
            ...old,
            sections: old.sections.map((sec) => ({
              ...sec,
              tracks: sec.tracks.map(mark),
            })),
          }
        }
      )
    })
  }, [queryClient])

  const { data: localResults, isLoading: localLoading, error: localError } = useQuery({
    queryKey: ['search-local', debouncedQuery],
    queryFn: async () => {
      const result = await searchLocal(debouncedQuery)
      saveSearchTerm(debouncedQuery)
      return result
    },
    enabled:
      debouncedQuery.length > 2 && localOnly && isPlausibleSearchQuery(debouncedQuery),
  })

  const { data: hybridData, isLoading: hybridLoading, error: hybridError } = useQuery({
    queryKey: ['search-hybrid', debouncedQuery],
    queryFn: async () => {
      const result = await searchHybrid(debouncedQuery)
      saveSearchTerm(debouncedQuery)
      return result
    },
    enabled:
      debouncedQuery.length > 2 &&
      !localOnly &&
      isPlausibleSearchQuery(debouncedQuery),
  })

  const isLoading = localOnly ? localLoading : hybridLoading
  const error = localOnly ? localError : hybridError
  const baseResults: Track[] = localOnly
    ? (localResults ?? [])
    : (hybridData?.sections.flatMap(s => s.tracks) ?? [])

  const bestMatchMbid = useMemo(() => {
    if (localOnly) return null
    const t = hybridData?.sections?.[0]?.tracks?.[0]
    return t?.mb_id || null
  }, [hybridData, localOnly])

  // Background similar-tracks stream (non-blocking)
  useEffect(() => {
    setSimilarTracks([])
    if (localOnly) return
    if (!bestMatchMbid) return
    if (!debouncedQuery || debouncedQuery.length <= 2) return
    if (!token) return

    const ac = new AbortController()

    ;(async () => {
      try {
        console.debug('[similar] stream start', { mbid: bestMatchMbid, q: debouncedQuery })
        // Use a raw fetch (no 15s timeout) because this is a streaming endpoint.
        const res = await fetch(`${API}/search/similar/${encodeURIComponent(bestMatchMbid)}/stream`, {
          method: 'GET',
          headers: { Authorization: `Bearer ${token}` },
          signal: ac.signal,
        })
        console.debug('[similar] stream response', { ok: res.ok, status: res.status, hasBody: Boolean(res.body) })
        if (!res.ok || !res.body) return
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
            const ev = parseNdjsonLine(part)
            if (!ev) continue
            if (ev.type === 'track' && ev.track?.mb_id) {
              console.debug('[similar] got track', { mbid: ev.track.mb_id, title: ev.track.title, artist: ev.track.artist })
              setSimilarTracks((prev) => {
                if (prev.some((t) => t.mb_id === ev.track.mb_id)) return prev
                if (baseResults.some((t) => t.mb_id === ev.track.mb_id)) return prev
                return [...prev, ev.track]
              })
            } else if (ev.type === 'done') {
              console.debug('[similar] stream done')
            }
          }
        }
      } catch {
        // ignore background stream failures
      }
    })()

    return () => ac.abort()
  }, [bestMatchMbid, debouncedQuery, localOnly, token])

  const results: Track[] = useMemo(() => {
    if (localOnly) return baseResults
    if (similarTracks.length === 0) return baseResults
    return [...baseResults, ...similarTracks]
  }, [baseResults, similarTracks, localOnly])

  const flatResults: { track: Track; playIdx: number }[] = useMemo(() => {
    // For local search: results are already a flat array.
    if (localOnly) return results.map((track, i) => ({ track, playIdx: i }))

    // For hybrid mode we *also* render from `results` so background similar tracks appear.
    // (hybridData.sections only contains the best match.)
    return results.map((track, i) => ({ track, playIdx: i }))
  }, [results, localOnly])

  const rowVirtualizer = useVirtualizer({
    count: flatResults.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 40,
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
    ? Array.from(new Map(results.map(t => [t.mb_release_id ?? t.album, t])).values())
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
              border: `1px solid ${focused ? '#8B2A1A' : '#3D2820'}`,
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
            style={{ background: !localOnly ? '#8B2A1A' : '#1A1210', color: !localOnly ? '#E8DDD0' : '#9A8E84' }}
          >
            All
          </button>
          <button
            onClick={() => setLocalOnly(true)}
            className="px-3 py-2 transition-colors"
            style={{ background: localOnly ? '#8B2A1A' : '#1A1210', color: localOnly ? '#E8DDD0' : '#9A8E84' }}
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
                color: '#5C1A10',
              }}
            >
              Recent Searches
            </span>
            <button
              onClick={() => {
                setRecentSearches([])
                localStorage.removeItem(RECENT_SEARCHES_KEY)
              }}
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
                onClick={() => setQuery(term)}
                className="px-3 py-1 rounded text-sm transition-colors"
                style={{
                  background: '#1A1210',
                  border: '1px solid #3D2820',
                  fontFamily: "'Barlow Semi Condensed', sans-serif",
                  color: '#9A8E84',
                  cursor: 'pointer',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.borderColor = '#8B2A1A'
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
        style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 18, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.12em', color: '#5C1A10' }}
      >
        {showResults ? `results for "${query}"` : 'All Tracks'}
        <div className="flex-1 h-px" style={{ background: '#261A14' }} />
      </div>

      {isLoading && (
        <div className="text-base" style={{ color: '#4A413C', fontFamily: "'Space Mono', monospace" }}>
          loading...
        </div>
      )}
      {error && (
        <div className="text-base" style={{ color: '#C43030' }}>Error: {String(error)}</div>
      )}
      {!isLoading && results?.length === 0 && debouncedQuery.length > 2 && (
        <div className="text-base" style={{ color: '#4A413C', fontFamily: "'Space Mono', monospace" }}>
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
              const { track, playIdx } = flatResults[virtualRow.index]
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
                    onPlay={() => playTrack(track)}
                    onContextMenu={(e) => handleContextMenu(e, track)}
                    onHoverArtist={(artistId, albumIds) => enqueue(artistId, albumIds)}
                  />
                </div>
              )
            })}
          </div>
        </>
      )}

      {/* Albums tab */}
      {!isLoading && activeTab === 'albums' && results && (
        <div className="grid grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
          {uniqueAlbums.map((track) => {
            const albumId = track.mb_release_id
            return (
              <AlbumCard
                key={track.mb_release_id ?? track.album}
                album={{ id: albumId ?? track.album, title: track.album, artist: track.artist, cover: track.album_cover }}
                onClick={(id) => id && navigate(`/album/${id}`)}
                onMouseEnter={() => {
                  if (track.mb_artist_id) enqueue(track.mb_artist_id, albumId ? [albumId] : [])
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
                background: activeTab === tab ? '#8B2A1A' : '#1A1210',
                color: activeTab === tab ? '#E8DDD0' : '#9A8E84',
                border: `1px solid ${activeTab === tab ? '#8B2A1A' : '#3D2820'}`,
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