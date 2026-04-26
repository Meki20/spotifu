import { useQuery } from '@tanstack/react-query'
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

  async function fetchRecentlyAdded(): Promise<any[]> {
    const res = await authFetch('/playlists/recently-added')
    if (!res.ok) throw new Error('Failed to fetch recently added')
    return res.json()
  }

  async function fetchRecentlyPlayed(): Promise<any[]> {
    const res = await authFetch('/playlists/recently-played')
    if (!res.ok) throw new Error('Failed to fetch recently played')
    return res.json()
  }

  const { data: recentlyAdded } = useQuery({
    queryKey: ['recently-added'],
    queryFn: fetchRecentlyAdded,
    enabled: !!token,
    staleTime: 2 * 60 * 1000,
  })

  const { data: recentlyPlayed } = useQuery({
    queryKey: ['recently-played'],
    queryFn: fetchRecentlyPlayed,
    enabled: !!token,
    staleTime: 30 * 1000,
  })

  function playTrack(track: any) {
    controller.play(toTrack(track))
  }

  function handleRecentlyAddedContextMenu(e: React.MouseEvent, track: any) {
    e.preventDefault()
    e.stopPropagation()
    openContextMenu(e.clientX, e.clientY, track)
  }

  function handleRecentlyPlayedContextMenu(e: React.MouseEvent, track: any) {
    e.preventDefault()
    e.stopPropagation()
    openContextMenu(e.clientX, e.clientY, track)
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

      {/* Playlists section */}
      {playlists && playlists.length > 0 && (
        <div className="mb-8">
          <div
            className="flex items-center gap-2.5 mb-3"
            style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 16, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.12em', color: '#5C1A10' }}
          >
            Your Playlists
            <div className="flex-1 h-px" style={{ background: '#261A14' }} />
          </div>
          <div className="grid grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3">
            {playlists.slice(0, 6).map((pl: Playlist) => (
              <Link
                key={pl.id}
                to={`/playlist/${pl.id}`}
                className="relative flex items-center gap-3 px-4 py-3 cursor-pointer border transition-colors hover:border-[#8B2A1A] overflow-hidden"
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

      {/* Recently Added */}
      <div className="mb-6">
        <div
          className="flex items-center gap-2.5 mb-3"
          style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 16, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.12em', color: '#5C1A10' }}
        >
          Recently Added
          <div className="flex-1 h-px" style={{ background: '#261A14' }} />
        </div>
        <div
          className="flex gap-2.5 overflow-x-auto pb-1"
          style={{ maxHeight: 256, overflowY: 'auto' }}
        >
          {recentlyAdded && recentlyAdded.length > 0 ? (
            recentlyAdded.map((track) => (
              <TrackCard key={track.track_id} track={track} onPlay={playTrack} onHoverArtist={(aid, albs) => enqueue(aid, albs)} onContextMenu={(e) => handleRecentlyAddedContextMenu(e, track)} />
            ))
          ) : (
            <p className="text-sm" style={{ color: '#4A413C', fontFamily: "'Barlow Semi Condensed', sans-serif" }}>no tracks added yet</p>
          )}
        </div>
      </div>

      {/* Recently Played */}
      <div>
        <div
          className="flex items-center gap-2.5 mb-3"
          style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 16, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.12em', color: '#5C1A10' }}
        >
          Recently Played
          <div className="flex-1 h-px" style={{ background: '#261A14' }} />
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
                  onPlay={playTrack}
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
    </div>
  )
}