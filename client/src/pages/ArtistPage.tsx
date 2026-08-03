import { useState, useRef, useEffect, useCallback } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useParams, useNavigate } from 'react-router-dom'
import { useAuthStore } from '../stores/authStore'
import { Play, ChevronLeft, ChevronRight, Pencil } from 'lucide-react'
import { getApi, authFetch, mediaUrl } from '../api'
import { useArtistPrefetch } from '../hooks/useArtistPrefetch'
import { useArtistTransitionStore } from '../stores/artistTransitionStore'
import ImagePickerModal from '../components/ImagePickerModal'
import { PollyLoading } from '../components/PollyLoading'
import { useRgCoverWhenVisible } from '../hooks/useRgCoverWhenVisible'
import { rgCoverManager } from '../lib/rgCoverManager'
import * as controller from '../playback/controller'
import { toTrack } from '../utils/trackHelpers'
import TrackRowFull from '../components/TrackRowFull'
import { useDownloadStates } from '../hooks/useDownloadStates'
import { usePlayerStore, type Track } from '../stores/playerStore'
import { useContextMenuActions } from '../contexts/ContextMenuProvider'

function AlbumSkeleton() {
  return (
    <div className="bg-[var(--bg-surface)] p-4 rounded-md animate-pulse shrink-0 w-44">
      <div className="w-full aspect-square bg-[var(--bg-surface-2)] rounded-md mb-3" />
      <div className="h-3 bg-[var(--bg-surface-2)] rounded mb-2" />
      <div className="h-2 bg-[var(--bg-surface-2)] rounded w-2/3" />
    </div>
  )
}

const ALBUM_CARD_BACKDROP_OPACITY = 0.14

function artistAlbumCoverUrl(album: any) {
  const rgId = album.mb_release_group_id
  const fromManager = rgId ? rgCoverManager.peek(rgId).url : null
  return album.cover || fromManager || null
}

/** Dim cover backdrop + foreground art, same idea as library playlist / AlbumCard. */
function ArtistAlbumTile({
  album,
  onClick,
  onVisible,
  narrow,
}: {
  album: any
  onClick: () => void
  /** Fire once when the tile nears the viewport (avoids hover storms). */
  onVisible?: () => void
  narrow?: boolean
}) {
  const rootRef = useRef<HTMLDivElement>(null)
  const visibleFired = useRef(false)
  const rgId = album.mb_release_group_id || null
  const { url: lazyCover } = useRgCoverWhenVisible(rootRef, rgId, 'viewport', {
    rootMargin: '140px',
    threshold: 0.02,
  })

  useEffect(() => {
    if (!onVisible) return
    const el = rootRef.current
    if (!el) return
    const obs = new IntersectionObserver(
      (entries) => {
        if (!entries[0]?.isIntersecting || visibleFired.current) return
        visibleFired.current = true
        onVisible()
      },
      { root: null, rootMargin: '140px', threshold: 0.02 },
    )
    obs.observe(el)
    return () => obs.disconnect()
  }, [onVisible])

  const u = artistAlbumCoverUrl(album) || lazyCover
  return (
    <div
      ref={rootRef}
      className={`bg-[var(--bg-surface)] p-4 rounded-md cursor-pointer transition-colors group relative overflow-hidden hover:bg-[var(--bg-surface-2)] ${narrow ? 'shrink-0 w-44' : ''}`}
      onClick={onClick}
    >
      {u && (
        <div
          className="fx-card-backdrop absolute inset-0 pointer-events-none"
          style={{
            backgroundImage: `url(${u})`,
            backgroundSize: 'cover',
            backgroundPosition: 'center',
            opacity: ALBUM_CARD_BACKDROP_OPACITY,
          }}
        />
      )}
      <div className="relative z-10 w-full aspect-square rounded-md mb-3 flex items-center justify-center overflow-hidden bg-[var(--bg-surface-2)]">
        {u ? (
          <img src={u} alt={album.title} className="w-full h-full object-cover" loading="lazy" />
        ) : (
          <span className="text-[#6a6a6a] text-xs">No Cover</span>
        )}
      </div>
      <p className="relative z-10 font-semibold text-sm truncate text-white">{album.title}</p>
      <p className="relative z-10 text-xs text-[var(--text-secondary)] truncate">{album.release_date?.split('-')[0] ?? ''}</p>
    </div>
  )
}

function HorizontalAlbumStrip({
  albums,
  navigate,
  isLoading,
  artistId,
  onAlbumVisible,
}: {
  albums: any[]
  navigate: any
  isLoading?: boolean
  artistId?: string
  onAlbumVisible?: (albumMbid: string) => void
}) {
  const scrollRef = useRef<HTMLDivElement>(null)

  const scroll = (dir: 'left' | 'right') => {
    if (scrollRef.current) {
      const amount = 200
      scrollRef.current.scrollBy({ left: dir === 'left' ? -amount : amount, behavior: 'smooth' })
    }
  }

  if (isLoading) {
    return (
      <div className="relative flex flex-col items-center gap-3 py-4">
        <PollyLoading size={40} />
        <div className="relative flex items-center w-full">
        <button
          onClick={() => scroll('left')}
          className="absolute left-0 z-10 w-8 h-8 rounded-full bg-black/60 text-white flex items-center justify-center shrink-0 opacity-50 pointer-events-none"
          disabled
        >
          <ChevronLeft size={20} />
        </button>
        <div className="flex gap-4 overflow-x-auto scrollbar-hide px-10">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="bg-[var(--bg-surface)] p-4 rounded-md animate-pulse shrink-0 w-44">
              <div className="w-full aspect-square bg-[var(--bg-surface-2)] rounded-md mb-3" />
              <div className="h-3 bg-[var(--bg-surface-2)] rounded mb-2" />
              <div className="h-2 bg-[var(--bg-surface-2)] rounded w-2/3" />
            </div>
          ))}
        </div>
        <button
          onClick={() => scroll('right')}
          className="absolute right-0 z-10 w-8 h-8 rounded-full bg-black/60 text-white flex items-center justify-center shrink-0 opacity-50 pointer-events-none"
          disabled
        >
          <ChevronRight size={20} />
        </button>
        </div>
      </div>
    )
  }

  if (albums.length === 0) return null

  return (
    <div className="relative flex items-center">
      <button
        onClick={() => scroll('left')}
        className="absolute left-0 z-10 w-8 h-8 rounded-full bg-black/60 hover:bg-black/80 text-white flex items-center justify-center shrink-0"
      >
        <ChevronLeft size={20} />
      </button>
      <div
        ref={scrollRef}
        className="flex gap-4 overflow-x-auto scrollbar-hide px-10"
        style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}
      >
        {albums.map((album: any) => (
          <ArtistAlbumTile
            key={album.mb_release_group_id || album.mb_id}
            album={album}
            narrow
            onClick={() => {
              const id = album.mb_release_group_id || album.mb_id
              if (id) navigate(`/album/${id}`)
            }}
            onVisible={
              artistId && onAlbumVisible
                ? () => {
                    const id = album.mb_release_group_id || album.mb_id
                    if (id) onAlbumVisible(id)
                  }
                : undefined
            }
          />
        ))}
      </div>
      <button
        onClick={() => scroll('right')}
        className="absolute right-0 z-10 w-8 h-8 rounded-full bg-black/60 hover:bg-black/80 text-white flex items-center justify-center shrink-0"
      >
        <ChevronRight size={20} />
      </button>
    </div>
  )
}

function SingleAlbumRow({
  album,
  index,
  onNavigate,
}: {
  album: any
  index: number
  onNavigate: () => void
}) {
  const coverRef = useRef<HTMLDivElement>(null)
  const rgId = album.mb_release_group_id || null
  const { url: lazyCover } = useRgCoverWhenVisible(coverRef, rgId, 'viewport')
  const coverUrl = artistAlbumCoverUrl(album) || lazyCover

  return (
    <div
      className="grid grid-cols-[auto_1fr_1fr] gap-4 px-4 py-3 hover:bg-[var(--bg-surface-2)] rounded cursor-pointer group"
      onClick={onNavigate}
    >
      <div className="relative w-8 h-8 shrink-0 flex items-center justify-center">
        <span className="text-[var(--text-secondary)] text-sm tabular-nums group-hover:hidden">{index + 1}</span>
        <span className="absolute inset-0 hidden group-hover:flex items-center justify-center text-[var(--accent)]">
          <Play size={14} fill="currentColor" className="shrink-0" />
        </span>
      </div>
      <div className="min-w-0 flex items-center gap-3">
        <div ref={coverRef} className="shrink-0">
          {coverUrl ? (
            <img
              src={coverUrl}
              alt={album.title}
              className="w-10 h-10 aspect-square object-cover rounded"
              loading="lazy"
            />
          ) : (
            <div className="w-10 h-10 bg-[var(--bg-surface-2)] rounded flex items-center justify-center">
              <span className="text-[#6a6a6a] text-xs">—</span>
            </div>
          )}
        </div>
        <span className="text-sm text-white truncate">{album.title}</span>
      </div>
      <span className="text-xs text-[var(--text-secondary)] flex items-center">{album.release_date?.split('-')[0] ?? ''}</span>
    </div>
  )
}

export default function ArtistPage() {
  const { artistId } = useParams<{ artistId: string }>()
  const navigate = useNavigate()
  const token = useAuthStore((s) => s.token)
  const [sortField, setSortField] = useState<'year' | 'alpha'>('year')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')

  const [showImagePicker, setShowImagePicker] = useState(false)
  const [revealing, setRevealing] = useState(false)
  const imageContainerRef = useRef<HTMLDivElement>(null)
  const transition = useArtistTransitionStore()

  const { data: topTracksData, isLoading: topTracksLoading } = useQuery({
    queryKey: ['artist-top-tracks', artistId],
    queryFn: async () => {
      const res = await authFetch(`/artist/${artistId}/top-tracks`)
      if (!res.ok) return { tracks: [] }
      return res.json()
    },
    enabled: !!artistId,
    staleTime: 1000 * 60 * 60,
  })

  const { data: artistImages, refetch: refetchImages } = useQuery({
    queryKey: ['artist-images', artistId],
    queryFn: async () => {
      const res = await authFetch(`/artist/${artistId}/images`)
      if (!res.ok) return { banners: [], thumbs: [], banner_idx: 0, picture_idx: 0 }
      return res.json()
    },
    enabled: !!artistId,
  })

  const { data: artist, isLoading, error } = useQuery({
    queryKey: ['artist', artistId],
    queryFn: async () => {
      const res = await fetch(`${getApi()}/artist/${artistId}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      })
      if (!res.ok) throw new Error('Failed to load artist')
      return res.json()
    },
    enabled: !!artistId,
  })

  // Report destination rect for transition animation
  // The artist thumb has a 2px border (border-2) with border-box sizing,
  // so the visible circle is 4px smaller than the element rect.
  useEffect(() => {
    if (
      !transition.isActive ||
      transition.artistMbid !== artistId ||
      !imageContainerRef.current
    )
      return
    const rect = imageContainerRef.current.getBoundingClientRect()
    const border = 2
    transition.setToRect({
      x: rect.left + border,
      y: rect.top + border,
      width: rect.width - border * 2,
      height: rect.height - border * 2,
    })
  }, [transition.isActive, transition.artistMbid, artistId, artistImages, artist])

  // Once travel finishes, fade in the real image and then remove the overlay
  useEffect(() => {
    if (!transition.isActive || transition.artistMbid !== artistId) {
      setRevealing(false)
      return
    }
    if (isLoading || !artistImages) return
    const revealTimer = setTimeout(() => setRevealing(true), 300)
    const endTimer = setTimeout(() => transition.end(), 550)
    return () => {
      clearTimeout(revealTimer)
      clearTimeout(endTimer)
    }
  }, [transition.isActive, transition.artistMbid, artistId, isLoading, artistImages, transition])

  const { data: albumsData, isLoading: albumsLoading } = useQuery({
    queryKey: ['artist-albums', artistId],
    queryFn: async () => {
      const res = await fetch(`${getApi()}/artist/${artistId}/albums`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      })
      if (!res.ok) throw new Error(`Failed to load albums (${res.status})`)
      return res.json()
    },
    enabled: !!artistId,
    retry: 3,
  })

  const { downloadStates, cachedMbIds } = useDownloadStates()
  const currentTrackMb = usePlayerStore((s) => s.currentTrack?.mb_id)
  const { openContextMenu } = useContextMenuActions()
  const [showAllPopular, setShowAllPopular] = useState(false)
  const [popularCovers, setPopularCovers] = useState<Record<string, string>>({})

  const onPopularCoverResolved = useCallback((mbid: string, url: string) => {
    if (!mbid || !url) return
    setPopularCovers((prev) => (prev[mbid] === url ? prev : { ...prev, [mbid]: url }))
    usePlayerStore.setState((s) => {
      const patch = (t: Track) =>
        t.mb_id === mbid && t.album_cover !== url ? { ...t, album_cover: url } : t
      return {
        userQueue: (s.userQueue || []).map(patch),
        systemList: (s.systemList || []).map(patch),
        currentTrack: s.currentTrack ? patch(s.currentTrack) : s.currentTrack,
      }
    })
  }, [])

  const { enqueue, enqueueAlbumsIdle } = useArtistPrefetch()

  useEffect(() => {
    if (!artistId || !albumsData?.albums?.length) return
    const ids = (albumsData.albums as any[])
      .map((a: any) => a.mb_id || a.mb_release_group_id)
      .filter((x: any): x is string => typeof x === 'string' && x.length > 0)
    if (!ids.length) return
    enqueueAlbumsIdle(artistId, ids.slice(0, 8))
  }, [artistId, albumsData?.albums, enqueueAlbumsIdle])

  if (isLoading) {
    return (
      <div className="p-6 flex flex-col items-center gap-3 text-[var(--text-secondary)]">
        <PollyLoading size={48} />
        <span className="text-sm" style={{ fontFamily: "'Barlow Semi Condensed', sans-serif" }}>loading…</span>
      </div>
    )
  }
  if (error) return <div className="p-6 text-red-500">Error loading artist</div>
  if (!artist) return null

  const albums: any[] = albumsData?.albums ?? []

  const albumsOnly = albums.filter((a: any) => a.type?.toLowerCase() === 'album')
  const epsOnly = albums.filter((a: any) => a.type?.toLowerCase() === 'ep')
  const singlesOnly = albums.filter((a: any) => a.type?.toLowerCase() === 'single')

  const sortAlbums = (items: any[]) => {
    return [...items].sort((a, b) => {
      let valA: string, valB: string
      if (sortField === 'year') {
        valA = a.release_date?.split('-')[0] ?? ''
        valB = b.release_date?.split('-')[0] ?? ''
      } else {
        valA = a.title?.toLowerCase() ?? ''
        valB = b.title?.toLowerCase() ?? ''
      }
      if (sortDir === 'asc') return valA.localeCompare(valB)
      return valB.localeCompare(valA)
    })
  }

  const sortedAlbums = sortAlbums(albumsOnly)
  const sortedEps = sortAlbums(epsOnly)
  const sortedSingles = sortAlbums(singlesOnly)

  const bannerUrl = mediaUrl(artistImages?.banner || artist.banner)
  const pictureUrl = mediaUrl(artistImages?.thumb || artist.picture)

  return (
    <div>
      {/* Header with banner + artist image */}
      <div
        className="relative flex items-end gap-6 p-6 overflow-hidden"
        style={{
          minHeight: 320,
          backgroundImage: bannerUrl ? `url(${bannerUrl})` : undefined,
          backgroundSize: 'cover',
          backgroundPosition: 'center',
          backgroundColor: '--bg-base',
        }}
      >
        {/* Gradient overlay for readability */}
        <div className="absolute inset-0 bg-gradient-to-t from-[var(--bg-base)] via-[color-mix(in_srgb,var(--bg-base)_50%,transparent)] to-transparent" />

        {/* Edit button */}
        <button
          onClick={(e) => { e.stopPropagation(); setShowImagePicker(true) }}
          className="absolute bottom-4 right-4 z-20 p-2 rounded-full bg-black/50 text-white hover:bg-black/70 transition-colors"
          title="Edit artist images"
        >
          <Pencil size={16} />
        </button>

        {/* Artist image — placeholder until /images + fanart/DDG return */}
        <div
          ref={imageContainerRef}
          style={{
            opacity: transition.isActive && transition.artistMbid === artistId && !revealing ? 0 : 1,
            transition: 'opacity 200ms ease',
          }}
        >
          {pictureUrl ? (
            <img
              src={pictureUrl}
              alt={artist.name}
              className="w-40 h-40 rounded-full shadow-xl object-cover shrink-0 relative z-10 border-2 border-[#383838]"
              loading="lazy"
              style={{ borderColor: '--bg-surface-2' }}
            />
          ) : (
            <div
              className="w-40 h-40 rounded-full shrink-0 relative z-10 border-2 border-[var(--bg-surface-2)] bg-[var(--bg-surface-2)] animate-pulse"
              aria-hidden
            />
          )}
        </div>
        <div className="relative z-10">
          <p className="text-xs text-white/80 uppercase font-semibold">Artist</p>
          <h1 className="text-4xl font-bold text-white mb-2">{artist.name}</h1>
          {artist.nb_fans > 0 && (
            <p className="text-white/70 text-sm">{artist.nb_fans.toLocaleString()} followers</p>
          )}
        </div>
      </div>

      {/* Popular — Last.fm top tracks resolved through the playlist-import batch resolver */}
      {(() => {
        const popularTracks = (topTracksData?.tracks || []) as any[]
        const visiblePopular = popularTracks.slice(0, showAllPopular ? 10 : 5)
        if (!topTracksLoading && popularTracks.length === 0) return null

        const playPopular = (track: any) => {
          const list = visiblePopular.map((x: any) =>
            toTrack(x, { album_cover: popularCovers[x.mb_id] || x.album_cover || null }),
          )
          const idx = Math.max(0, list.findIndex((x) => x.mb_id === track.mb_id))
          controller.setSystemAndPlay(list, idx, { kind: 'unknown', title: `${artist?.name ?? ''} — Popular` })
        }

        return (
          <div className="px-6 py-4">
            <h2 className="text-xl font-bold text-white mb-4">Popular</h2>
            <div className="text-[var(--text-secondary)] text-xs grid grid-cols-[auto_1fr_1fr_auto] gap-4 py-2 border-b border-[var(--bg-surface-2)] mb-1">
              <span className="w-8 text-center">#</span>
              <span>Title</span>
              <span>Album</span>
              <span></span>
            </div>
            {topTracksLoading ? (
              Array.from({ length: 5 }).map((_, i) => (
                <div
                  key={i}
                  className="grid grid-cols-[auto_1fr_1fr_auto] gap-4 py-2.5 items-center"
                >
                  <div className="w-8 h-4 bg-[var(--bg-surface-2)] rounded animate-pulse" />
                  <div className="h-4 bg-[var(--bg-surface-2)] rounded animate-pulse max-w-[60%]" />
                  <div className="h-4 bg-[var(--bg-surface-2)] rounded animate-pulse max-w-[50%]" />
                  <div className="h-4 bg-[var(--bg-surface-2)] rounded animate-pulse w-8 justify-self-end" />
                </div>
              ))
            ) : (
              visiblePopular.map((t: any, i: number) => (
                <TrackRowFull
                  key={t.mb_id}
                  track={t}
                  index={i}
                  isCached={Boolean(t.is_cached) || cachedMbIds.has(t.mb_id)}
                  isPlaying={Boolean(currentTrackMb) && currentTrackMb === t.mb_id}
                  downloadState={downloadStates[t.mb_id]}
                  playlistStyleCover
                  showDuration={false}
                  onCoverResolved={onPopularCoverResolved}
                  onPlay={playPopular}
                  onContextMenu={(e, track) => {
                    e.preventDefault()
                    e.stopPropagation()
                    const cover = popularCovers[track.mb_id] || track.album_cover || null
                    openContextMenu(e.clientX, e.clientY, { ...track, album_cover: cover })
                  }}
                />
              ))
            )}
            {!topTracksLoading && popularTracks.length > 5 && (
              <button
                type="button"
                onClick={() => setShowAllPopular((v) => !v)}
                className="mt-2 text-xs text-[var(--text-secondary)] hover:text-white transition-colors"
                style={{ fontFamily: "'Barlow Semi Condensed', sans-serif", letterSpacing: '0.04em' }}
              >
                {showAllPopular ? 'Show less' : 'Show more'}
              </button>
            )}
          </div>
        )
      })()}

      {/* Discography */}
      <div className="px-6 py-4">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-bold text-white">Discography</h2>
          <div className="flex items-center gap-2">
            <select
              value={sortField}
              onChange={(e) => setSortField(e.target.value as 'year' | 'alpha')}
              className="bg-[var(--bg-surface-2)] text-white text-sm rounded px-2 py-1 cursor-pointer"
            >
              <option value="year">Year</option>
              <option value="alpha">A-Z</option>
            </select>
            <select
              value={sortDir}
              onChange={(e) => setSortDir(e.target.value as 'asc' | 'desc')}
              className="bg-[var(--bg-surface-2)] text-white text-sm rounded px-2 py-1 cursor-pointer"
            >
              <option value="desc">Descending</option>
              <option value="asc">Ascending</option>
            </select>
          </div>
        </div>

        {/* Albums */}
        {sortedAlbums.length > 0 && (
          <div className="mb-8">
            <h3 className="text-sm font-semibold text-[var(--text-secondary)] uppercase tracking-wider mb-3">Albums</h3>
            <div className="grid grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-4">
              {albumsLoading
                ? Array.from({ length: 6 }).map((_, i) => <AlbumSkeleton key={i} />)
                : sortedAlbums.map((album: any) => (
                    <ArtistAlbumTile
                      key={album.mb_release_group_id || album.mb_id}
                      album={album}
                      onClick={() => {
                        const id = album.mb_release_group_id || album.mb_id
                        if (id) navigate(`/album/${id}`)
                      }}
                      onVisible={() => {
                        const id = album.mb_release_group_id || album.mb_id
                        if (id && artistId) enqueue(artistId, [id])
                      }}
                    />
                  ))
              }
            </div>
          </div>
        )}

        {/* EPs */}
        {(sortedEps.length > 0 || albumsLoading) && (
          <div className="mb-8">
            <h3 className="text-sm font-semibold text-[var(--text-secondary)] uppercase tracking-wider mb-3">EPs</h3>
            <HorizontalAlbumStrip
              albums={sortedEps}
              navigate={navigate}
              isLoading={albumsLoading}
              artistId={artistId ?? undefined}
              onAlbumVisible={(id) => {
                if (artistId) enqueue(artistId, [id])
              }}
            />
          </div>
        )}

        {/* Singles */}
        {sortedSingles.length > 0 && (
          <div>
            <h3 className="text-sm font-semibold text-[var(--text-secondary)] uppercase tracking-wider mb-3">Singles</h3>
            <div className="text-[var(--text-secondary)] text-xs grid grid-cols-[auto_1fr_1fr] gap-4 px-4 py-2 border-b border-[var(--bg-surface-2)] mb-1">
              <span className="w-8 text-center">#</span>
              <span>Title</span>
              <span>Year</span>
            </div>
            {sortedSingles.map((album: any, i: number) => (
              <SingleAlbumRow
                key={album.mb_release_group_id || album.mb_id}
                album={album}
                index={i}
                onNavigate={() => {
                  const id = album.mb_release_group_id || album.mb_id
                  if (id) navigate(`/album/${id}`)
                }}
              />
            ))}
          </div>
        )}
      </div>

      {showImagePicker && (
        <ImagePickerModal
          isOpen={showImagePicker}
          onClose={() => setShowImagePicker(false)}
          artistId={artistId || ''}
          artistName={artist.name}
          banners={artistImages?.banners ?? []}
          thumbs={artistImages?.thumbs ?? []}
          bannerIdx={artistImages?.banner_idx ?? 0}
          pictureIdx={artistImages?.picture_idx ?? 0}
          onSave={async (newBannerIdx, newPictureIdx) => {
            await authFetch(`/artist/${artistId}/images`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ banner_idx: newBannerIdx, picture_idx: newPictureIdx }),
            })
            refetchImages()
          }}
          onRefresh={refetchImages}
        />
      )}
    </div>
  )
}