import { useQuery } from '@tanstack/react-query'
import { queryClient } from '../queryClient'
import { useAuthStore } from '../stores/authStore'
import { authFetch } from '../api'
import { Link } from 'react-router-dom'
import * as controller from '../playback/controller'
import { useArtistPrefetch } from '../hooks/useArtistPrefetch'
import TrackCard from '../components/TrackCard'
import TrackRow from '../components/TrackRow'
import { toTrack } from '../utils/trackHelpers'
import { useContextMenuActions } from '../contexts/ContextMenuProvider'

interface Playlist {
  id: number
  title: string
  description?: string | null
  cover_image_url?: string | null
}

async function fetchPlaylists(): Promise<Playlist[]> {
  const res = await authFetch('/playlists')
  if (!res.ok) throw new Error('Failed to fetch playlists')
  return res.json()
}

function getGreeting() {
  const hour = new Date().getHours()
  return hour < 12 ? 'good morning' : hour < 18 ? 'good afternoon' : 'good evening'
}

export default function Home() {
  const token = useAuthStore((s) => s.token)
  const { openContextMenu } = useContextMenuActions()
  const { enqueue } = useArtistPrefetch()

  const { data: playlists } = useQuery({
    queryKey: ['home-playlists'],
    queryFn: fetchPlaylists,
    enabled: !!token,
  })

  async function fetchHottestTracks(): Promise<any[]> {
    const res = await authFetch('/auto-playlists/hottest_tracks/tracks')
    if (!res.ok) {
      if (res.status === 404) return []
      throw new Error('Failed to fetch hottest tracks')
    }
    return res.json()
  }

  const { data: hottestTracksWithDef } = useQuery({
    queryKey: ['hottest-tracks'],
    queryFn: async () => {
      const defRes = await authFetch('/auto-playlists')
      if (!defRes.ok) return null
      const defs = await defRes.json()
      const hottestDef = defs.find((d: any) => d.playlist_type === 'hottest_tracks')
      if (!hottestDef?.is_enabled) return null
      const tracks = await fetchHottestTracks()
      return { definition: hottestDef, tracks }
    },
    enabled: !!token,
    staleTime: 5 * 60 * 1000,
  })

  const showHottestTracks = hottestTracksWithDef && hottestTracksWithDef.tracks.length > 0

  async function fetchTagMix(): Promise<any[]> {
    const res = await authFetch('/auto-playlists/tag_mix/tracks')
    if (!res.ok) {
      if (res.status === 404) return []
      throw new Error('Failed to fetch tag mix')
    }
    return res.json()
  }

  const { data: tagMixWithDef } = useQuery({
    queryKey: ['tag-mix'],
    queryFn: async () => {
      const defRes = await authFetch('/auto-playlists')
      if (!defRes.ok) return null
      const defs = await defRes.json()
      const tagMixDef = defs.find((d: any) => d.playlist_type === 'tag_mix')
      if (!tagMixDef?.is_enabled) return null
      const tracks = await fetchTagMix()
      return { definition: tagMixDef, tracks }
    },
    enabled: !!token,
    staleTime: 5 * 60 * 1000,
  })

  const showTagMix = tagMixWithDef && tagMixWithDef.tracks.length > 0

  async function fetchRecentlyDownloaded(): Promise<{ tracks: any[]; hasPermission: boolean }> {
    const res = await authFetch('/playlists/recently-downloaded')
    if (!res.ok) {
      if (res.status === 403) return { tracks: [], hasPermission: false }
      throw new Error('Failed to fetch recently downloaded')
    }
    return { tracks: await res.json(), hasPermission: true }
  }

  async function fetchRecentlyPlayed(): Promise<any[]> {
    const res = await authFetch('/playlists/recently-played')
    if (!res.ok) throw new Error('Failed to fetch recently played')
    return res.json()
  }

  const { data: recentlyDownloadedData } = useQuery({
    queryKey: ['recently-downloaded'],
    queryFn: fetchRecentlyDownloaded,
    enabled: !!token,
    staleTime: 2 * 60 * 1000,
  })

  const recentlyDownloaded = recentlyDownloadedData?.tracks ?? []
  const showRecentlyDownloaded = recentlyDownloadedData?.hasPermission ?? false

  const { data: recentlyPlayed } = useQuery({
    queryKey: ['recently-played'],
    queryFn: fetchRecentlyPlayed,
    enabled: !!token,
    staleTime: 30 * 1000,
  })

  function playFromRecentlyDownloaded(track: any) {
    const list = (recentlyDownloaded || []).map((t) => toTrack(t))
    const idx = Math.max(0, (recentlyDownloaded || []).findIndex((t) => (t?.mb_id || t?.mbid) === (track?.mb_id || track?.mbid)))
    controller.setSystemAndPlay(list, idx, { kind: 'recently-added' })
  }

  function playFromRecentlyPlayed(track: any) {
    const list = (recentlyPlayed || []).map((t) => toTrack(t))
    const idx = Math.max(0, (recentlyPlayed || []).findIndex((t) => (t?.mb_id || t?.mbid) === (track?.mb_id || track?.mbid)))
    controller.setSystemAndPlay(list, idx, { kind: 'recently-played' })
  }

  function handleRecentlyDownloadedContextMenu(e: React.MouseEvent, track: any) {
    e.preventDefault()
    e.stopPropagation()
    openContextMenu(e.clientX, e.clientY, track)
  }

  function handleRecentlyPlayedContextMenu(e: React.MouseEvent, track: any) {
    e.preventDefault()
    e.stopPropagation()
    openContextMenu(e.clientX, e.clientY, track)
  }

  function refreshRecentlyPlayed() {
    queryClient.invalidateQueries({ queryKey: ['recently-played'] })
  }

  return (
    <div className="p-6 flex-1 overflow-y-auto">
      <div className="mb-6">
        <h1
          className="text-4xl font-bold uppercase leading-none"
          style={{
            fontFamily: "'Barlow Condensed', sans-serif",
            fontWeight: 800,
            textTransform: 'uppercase',
            letterSpacing: '0.04em',
            lineHeight: 0.95,
            color: '#E8DDD0',
          }}
        >
          {getGreeting()}
        </h1>
      </div>

      {(showHottestTracks || showTagMix) && (
        <div className="mb-8">
          <div
            className="flex items-center gap-2.5 mb-3"
            style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 16, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.12em', color: '#b4003e' }}
          >
            For You
            <div className="flex-1 h-px" style={{ background: '#261A14' }} />
          </div>
          <div className="flex flex-wrap gap-3">
            {showHottestTracks && (
              <Link
                to={`/auto-playlist/${hottestTracksWithDef.definition.id}`}
                className="relative flex items-center gap-3 px-4 py-3 cursor-pointer border transition-colors hover:border-[#b4003e] overflow-hidden"
                style={{ background: '#1A1210', borderColor: '#3D2820', borderRadius: 4, display: 'inline-flex', minWidth: 200 }}
              >
                {hottestTracksWithDef.definition.cover_url && (
                    <div
                      className="absolute inset-0 pointer-events-none"
                      style={{
                        backgroundImage: `url(${hottestTracksWithDef.definition.cover_url})`,
                        backgroundSize: 'cover',
                        backgroundPosition: 'center',
                        opacity: 0.15,
                      }}
                    />
                  )}
                  <div
                    className="relative z-10 w-10 h-10 rounded overflow-hidden shrink-0 flex items-center justify-center"
                    style={{ background: '#231815' }}
                  >
                    {hottestTracksWithDef.definition.cover_url ? (
                      <img src={hottestTracksWithDef.definition.cover_url} alt="" className="w-full h-full object-cover" loading="lazy" />
                    ) : (
                      <span style={{ fontSize: 16 }}>▦</span>
                    )}
                  </div>
                  <span
                    className="relative z-10 text-xs truncate"
                    style={{ fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 600, color: '#E8DDD0' }}
                  >
                    {hottestTracksWithDef.definition.name}
                  </span>
              </Link>
            )}
            {showTagMix && (
              <Link
                to={`/auto-playlist/${tagMixWithDef.definition.id}`}
                className="relative flex items-center gap-3 px-4 py-3 cursor-pointer border transition-colors hover:border-[#b4003e] overflow-hidden"
                style={{ background: '#1A1210', borderColor: '#3D2820', borderRadius: 4, display: 'inline-flex', minWidth: 200 }}
              >
                {tagMixWithDef.definition.cover_url && (
                    <div
                      className="absolute inset-0 pointer-events-none"
                      style={{
                        backgroundImage: `url(${tagMixWithDef.definition.cover_url})`,
                        backgroundSize: 'cover',
                        backgroundPosition: 'center',
                        opacity: 0.15,
                      }}
                    />
                  )}
                  <div
                    className="relative z-10 w-10 h-10 rounded overflow-hidden shrink-0 flex items-center justify-center"
                    style={{ background: '#231815' }}
                  >
                    {tagMixWithDef.definition.cover_url ? (
                      <img src={tagMixWithDef.definition.cover_url} alt="" className="w-full h-full object-cover" loading="lazy" />
                    ) : (
                      <span style={{ fontSize: 16 }}>▦</span>
                    )}
                  </div>
                  <span
                    className="relative z-10 text-xs truncate"
                    style={{ fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 600, color: '#E8DDD0' }}
                  >
                    {tagMixWithDef.definition.name}
                  </span>
              </Link>
            )}
          </div>
        </div>
      )}

      {/* Playlists section */}
      {playlists && playlists.length > 0 && (
        <div className="mb-8">
          <div
            className="flex items-center gap-2.5 mb-3"
            style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 16, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.12em', color: '#b4003e' }}
          >
            Your Playlists
            <div className="flex-1 h-px" style={{ background: '#261A14' }} />
          </div>
          <div className="grid grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3">
            {playlists.slice(0, 6).map((pl: Playlist) => (
              <Link
                key={pl.id}
                to={`/playlist/${pl.id}`}
                className="relative flex items-center gap-3 px-4 py-3 cursor-pointer border transition-colors hover:border-[#b4003e] overflow-hidden"
                style={{ background: '#1A1210', borderColor: '#3D2820', borderRadius: 4 }}
              >
                {pl.cover_image_url && (
                  <div
                    className="absolute inset-0 pointer-events-none"
                    style={{
                      backgroundImage: `url(${pl.cover_image_url})`,
                      backgroundSize: 'cover',
                      backgroundPosition: 'center',
                      opacity: 0.15,
                    }}
                  />
                )}
                <div
                  className="relative z-10 w-10 h-10 rounded overflow-hidden shrink-0 flex items-center justify-center"
                  style={{ background: '#231815' }}
                >
                  {pl.cover_image_url ? (
                    <img src={pl.cover_image_url} alt="" className="w-full h-full object-cover" loading="lazy" />
                  ) : (
                    <span style={{ fontSize: 16 }}>▦</span>
                  )}
                </div>
                <span
                  className="relative z-10 text-xs truncate"
                  style={{ fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 600, color: '#E8DDD0' }}
                >
                  {pl.title}
                </span>
              </Link>
            ))}
          </div>
        </div>
      )}

      {/* Recently Played */}
      <div className="mb-6">
        <div
          className="flex items-center gap-2.5 mb-3"
          style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 16, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.12em', color: '#b4003e' }}
        >
          Recently Played
          <div className="flex-1 h-px" style={{ background: '#261A14' }} />
          <button
            onClick={refreshRecentlyPlayed}
            className="p-1.5 rounded hover:bg-[#3D2820] transition-colors"
            title="Refresh recently played"
            style={{ color: '#4A413C' }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 2v6h-6M3 12a9 9 0 0 1 15-6.7L21 8M3 22v-6h6M21 12a9 9 0 0 1-15 6.7L3 16" />
            </svg>
          </button>
        </div>
        <div
          className="flex flex-col gap-0.5 overflow-y-auto"
          style={{ maxHeight: 256 }}
        >
          {recentlyPlayed && recentlyPlayed.length > 0 ? (
            recentlyPlayed.map((track, i) => (
              <div
                key={track.track_id}
                className="flex items-center"
              >
                <span
                  className="w-8 text-center text-xs shrink-0"
                  style={{ fontFamily: "'Barlow Semi Condensed', monospace", color: '#4A413C' }}
                >
                  {i + 1}
                </span>
                <TrackRow
                  track={track}
                  isCached={track.is_cached}
                  onPlay={playFromRecentlyPlayed}
                  onHoverArtist={(aid, albs) => enqueue(aid, albs)}
                  onContextMenu={handleRecentlyPlayedContextMenu}
                  style={{ padding: '8px 16px 8px 0' }}
                />
              </div>
            ))
          ) : (
            <p className="text-sm" style={{ color: '#4A413C', fontFamily: "'Barlow Semi Condensed', sans-serif" }}>no recently played tracks</p>
          )}
        </div>
      </div>

      {showRecentlyDownloaded && (
      <div>
        <div
          className="flex items-center gap-2.5 mb-3"
          style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 16, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.12em', color: '#b4003e' }}
        >
          Recently Downloaded
          <div className="flex-1 h-px" style={{ background: '#261A14' }} />
        </div>
        <div
          className="flex gap-2.5 overflow-x-auto pb-1"
          style={{ maxHeight: 256, overflowY: 'auto' }}
        >
          {recentlyDownloaded && recentlyDownloaded.length > 0 ? (
            recentlyDownloaded.map((track) => (
              <TrackCard key={track.track_id} track={track} onPlay={playFromRecentlyDownloaded} onHoverArtist={(aid, albs) => enqueue(aid, albs)} onContextMenu={(e) => handleRecentlyDownloadedContextMenu(e, track)} />
            ))
          ) : (
            <p className="text-sm" style={{ color: '#4A413C', fontFamily: "'Barlow Semi Condensed', sans-serif" }}>no recently downloaded tracks</p>
          )}
        </div>
      </div>
      )}
    </div>
  )
}