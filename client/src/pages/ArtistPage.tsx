import { useState, useRef, useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useParams, useNavigate } from 'react-router-dom'
import { useAuthStore } from '../stores/authStore'
import { Play, ChevronLeft, ChevronRight, Pencil } from 'lucide-react'
import { API, authFetch } from '../api'
import { useArtistPrefetch } from '../hooks/useArtistPrefetch'
import ImagePickerModal from '../components/ImagePickerModal'
import { PollyLoading } from '../components/PollyLoading'
import { fetchReleaseGroupCover } from '../api/covers'

function AlbumSkeleton() {
  return (
    <div className="bg-[#181818] p-4 rounded-md animate-pulse shrink-0 w-44">
      <div className="w-full aspect-square bg-[#282828] rounded-md mb-3" />
      <div className="h-3 bg-[#282828] rounded mb-2" />
      <div className="h-2 bg-[#282828] rounded w-2/3" />
    </div>
  )
}

const ALBUM_CARD_BACKDROP_OPACITY = 0.14

function artistAlbumCoverUrl(album: any, covers?: Record<string, string>) {
  return album.cover || (album.mb_release_group_id && covers?.[album.mb_release_group_id]) || null
}

/** Dim cover backdrop + foreground art, same idea as library playlist / AlbumCard. */
function ArtistAlbumTile({
  album,
  covers,
  onClick,
  onVisible,
  narrow,
}: {
  album: any
  covers: Record<string, string> | undefined
  onClick: () => void
  /** Fire once when the tile nears the viewport (avoids hover storms). */
  onVisible?: () => void
  narrow?: boolean
}) {
  const rootRef = useRef<HTMLDivElement>(null)
  const visibleFired = useRef(false)

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

  const u = artistAlbumCoverUrl(album, covers)
  return (
    <div
      ref={rootRef}
      className={`bg-[#181818] p-4 rounded-md cursor-pointer transition-colors group relative overflow-hidden hover:bg-[#202020] ${narrow ? 'shrink-0 w-44' : ''}`}
      onClick={onClick}
    >
      {u && (
        <div
          className="absolute inset-0 pointer-events-none"
          style={{
            backgroundImage: `url(${u})`,
            backgroundSize: 'cover',
            backgroundPosition: 'center',
            opacity: ALBUM_CARD_BACKDROP_OPACITY,
          }}
        />
      )}
      <div className="relative z-10 w-full aspect-square rounded-md mb-3 flex items-center justify-center overflow-hidden bg-[#282828]">
        {u ? (
          <img src={u} alt={album.title} className="w-full h-full object-cover" loading="lazy" />
        ) : (
          <span className="text-[#6a6a6a] text-xs">No Cover</span>
        )}
      </div>
      <p className="relative z-10 font-semibold text-sm truncate text-white">{album.title}</p>
      <p className="relative z-10 text-xs text-[#b3b3b3] truncate">{album.release_date?.split('-')[0] ?? ''}</p>
    </div>
  )
}

function HorizontalAlbumStrip({
  albums,
  navigate,
  isLoading,
  covers,
  artistId,
  onAlbumVisible,
}: {
  albums: any[]
  navigate: any
  isLoading?: boolean
  covers?: Record<string, string>
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
            <div key={i} className="bg-[#181818] p-4 rounded-md animate-pulse shrink-0 w-44">
              <div className="w-full aspect-square bg-[#282828] rounded-md mb-3" />
              <div className="h-3 bg-[#282828] rounded mb-2" />
              <div className="h-2 bg-[#282828] rounded w-2/3" />
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
            key={album.mb_id || album.mb_release_group_id}
            album={album}
            covers={covers}
            narrow
            onClick={() => {
              const id = album.mb_id || album.mb_release_group_id
              if (id) navigate(`/album/${id}`)
            }}
            onVisible={
              artistId && onAlbumVisible
                ? () => {
                    const id = album.mb_id || album.mb_release_group_id
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

export default function ArtistPage() {
  const { artistId } = useParams<{ artistId: string }>()
  const navigate = useNavigate()
  const token = useAuthStore((s) => s.token)
  const [sortField, setSortField] = useState<'year' | 'alpha'>('year')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')

  const [showImagePicker, setShowImagePicker] = useState(false)

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
      const res = await fetch(`${API}/artist/${artistId}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      })
      if (!res.ok) throw new Error('Failed to load artist')
      return res.json()
    },
    enabled: !!artistId,
  })

  const { data: albumsData, isLoading: albumsLoading } = useQuery({
    queryKey: ['artist-albums', artistId],
    queryFn: async () => {
      const res = await fetch(`${API}/artist/${artistId}/albums`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      })
      if (!res.ok) throw new Error(`Failed to load albums (${res.status})`)
      return res.json()
    },
    enabled: !!artistId,
    retry: 3,
  })

  const [covers, setCovers] = useState<Record<string, string>>({})

  useEffect(() => {
    if (!albumsData?.albums?.length) return
    const missing = albumsData.albums.filter((a: any) => !a.cover && a.mb_release_group_id)
    if (!missing.length) return

    let cancelled = false

    async function fetchWithConcurrency(mbids: string[], concurrency = 6): Promise<void> {
      for (let i = 0; i < mbids.length; i += concurrency) {
        if (cancelled) break
        const batch = mbids.slice(i, i + concurrency)
        const res = await Promise.allSettled(batch.map((id) => fetchReleaseGroupCover(id)))
        if (cancelled) return
        res.forEach((r, idx) => {
          if (r.status !== 'fulfilled') return
          const url = r.value
          const id = batch[idx]
          if (url && id && !cancelled) setCovers((prev) => ({ ...prev, [id]: url }))
        })
      }
    }

    const ids = missing
      .map((a: any) => a.mb_release_group_id)
      .filter((x: any): x is string => typeof x === 'string' && x.length > 0)

    fetchWithConcurrency(ids)

    return () => { cancelled = true }
  }, [albumsData, artistId])

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
      <div className="p-6 flex flex-col items-center gap-3 text-[#b3b3b3]">
        <PollyLoading size={48} />
        <span className="text-sm" style={{ fontFamily: "'Space Mono', monospace" }}>loading…</span>
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

  const bannerUrl = artistImages?.banner || artist.banner
  const pictureUrl = artistImages?.thumb || artist.picture

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
          backgroundColor: '#121212',
        }}
      >
        {/* Gradient overlay for readability */}
        <div className="absolute inset-0 bg-gradient-to-t from-[#121212] via-[#12121280] to-transparent" />

        {/* Edit button */}
        <button
          onClick={(e) => { e.stopPropagation(); setShowImagePicker(true) }}
          className="absolute bottom-4 right-4 z-20 p-2 rounded-full bg-black/50 text-white hover:bg-black/70 transition-colors"
          title="Edit artist images"
        >
          <Pencil size={16} />
        </button>

        {/* Artist image — placeholder until /images + fanart/DDG return */}
        {pictureUrl ? (
          <img
            src={pictureUrl}
            alt={artist.name}
            className="w-40 h-40 rounded-full shadow-xl object-cover shrink-0 relative z-10 border-2 border-[#383838]"
            loading="lazy"
            style={{ borderColor: '#2A2A2A' }}
          />
        ) : (
          <div
            className="w-40 h-40 rounded-full shrink-0 relative z-10 border-2 border-[#2A2A2A] bg-[#282828] animate-pulse"
            aria-hidden
          />
        )}
        <div className="relative z-10">
          <p className="text-xs text-white/80 uppercase font-semibold">Artist</p>
          <h1 className="text-4xl font-bold text-white mb-2">{artist.name}</h1>
          {artist.nb_fans > 0 && (
            <p className="text-white/70 text-sm">{artist.nb_fans.toLocaleString()} followers</p>
          )}
        </div>
      </div>

      {/* Popular — top tracks will be a dedicated endpoint later */}
      <div className="px-6 py-4">
        <h2 className="text-xl font-bold text-white mb-4">Popular</h2>
        <div className="text-[#b3b3b3] text-xs grid grid-cols-[auto_1fr_1fr_auto] gap-4 py-2 border-b border-[#282828] mb-1">
          <span className="w-8 text-center">#</span>
          <span>Title</span>
          <span>Album</span>
          <span className="text-right">Duration</span>
        </div>
        {Array.from({ length: 5 }).map((_, i) => (
          <div
            key={i}
            className="grid grid-cols-[auto_1fr_1fr_auto] gap-4 py-2.5 items-center"
          >
            <div className="w-8 h-4 bg-[#282828] rounded animate-pulse" />
            <div className="h-4 bg-[#282828] rounded animate-pulse max-w-[60%]" />
            <div className="h-4 bg-[#282828] rounded animate-pulse max-w-[50%]" />
            <div className="h-4 bg-[#282828] rounded animate-pulse w-8 justify-self-end" />
          </div>
        ))}
      </div>

      {/* Discography */}
      <div className="px-6 py-4">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-bold text-white">Discography</h2>
          <div className="flex items-center gap-2">
            <select
              value={sortField}
              onChange={(e) => setSortField(e.target.value as 'year' | 'alpha')}
              className="bg-[#282828] text-white text-sm rounded px-2 py-1 cursor-pointer"
            >
              <option value="year">Year</option>
              <option value="alpha">A-Z</option>
            </select>
            <select
              value={sortDir}
              onChange={(e) => setSortDir(e.target.value as 'asc' | 'desc')}
              className="bg-[#282828] text-white text-sm rounded px-2 py-1 cursor-pointer"
            >
              <option value="desc">Descending</option>
              <option value="asc">Ascending</option>
            </select>
          </div>
        </div>

        {/* Albums */}
        {sortedAlbums.length > 0 && (
          <div className="mb-8">
            <h3 className="text-sm font-semibold text-[#b3b3b3] uppercase tracking-wider mb-3">Albums</h3>
            <div className="grid grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-4">
              {albumsLoading
                ? Array.from({ length: 6 }).map((_, i) => <AlbumSkeleton key={i} />)
                : sortedAlbums.map((album: any) => (
                    <ArtistAlbumTile
                      key={album.mb_id || album.mb_release_group_id}
                      album={album}
                      covers={covers}
                      onClick={() => {
                        const id = album.mb_id || album.mb_release_group_id
                        if (id) navigate(`/album/${id}`)
                      }}
                      onVisible={() => {
                        const id = album.mb_id || album.mb_release_group_id
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
            <h3 className="text-sm font-semibold text-[#b3b3b3] uppercase tracking-wider mb-3">EPs</h3>
            <HorizontalAlbumStrip
              albums={sortedEps}
              navigate={navigate}
              isLoading={albumsLoading}
              covers={covers}
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
            <h3 className="text-sm font-semibold text-[#b3b3b3] uppercase tracking-wider mb-3">Singles</h3>
            <div className="text-[#b3b3b3] text-xs grid grid-cols-[auto_1fr_1fr] gap-4 px-4 py-2 border-b border-[#282828] mb-1">
              <span className="w-8 text-center">#</span>
              <span>Title</span>
              <span>Year</span>
            </div>
            {sortedSingles.map((album: any, i: number) => (
              <div
                key={album.mb_id || album.mb_release_group_id}
                className="grid grid-cols-[auto_1fr_1fr] gap-4 px-4 py-3 hover:bg-[#282828] rounded cursor-pointer group"
                onClick={() => {
                  const id = album.mb_id || album.mb_release_group_id
                  if (id) navigate(`/album/${id}`)
                }}
              >
                <div className="relative w-8 h-8 shrink-0 flex items-center justify-center">
                  <span className="text-[#b3b3b3] text-sm tabular-nums group-hover:hidden">{i + 1}</span>
                  <span className="absolute inset-0 hidden group-hover:flex items-center justify-center text-[#b4003e]">
                    <Play size={14} fill="currentColor" className="shrink-0" />
                  </span>
                </div>
                <div className="min-w-0 flex items-center gap-3">
                  {album.cover || (album.mb_release_group_id && covers[album.mb_release_group_id]) ? (
                    <img
                      src={album.cover || covers[album.mb_release_group_id]}
                      alt={album.title}
                      className="w-10 h-10 aspect-square object-cover rounded shrink-0"
                      loading="lazy"
                    />
                  ) : (
                    <div className="w-10 h-10 bg-[#282828] rounded flex items-center justify-center shrink-0">
                      <span className="text-[#6a6a6a] text-xs">—</span>
                    </div>
                  )}
                  <span className="text-sm text-white truncate">{album.title}</span>
                </div>
                <span className="text-xs text-[#b3b3b3] flex items-center">{album.release_date?.split('-')[0] ?? ''}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {showImagePicker && (
        <ImagePickerModal
          isOpen={showImagePicker}
          onClose={() => setShowImagePicker(false)}
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
        />
      )}
    </div>
  )
}