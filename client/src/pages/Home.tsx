import { useRef } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useVirtualizer } from '@tanstack/react-virtual'
import { queryClient } from '../queryClient'
import { useAuthStore } from '../stores/authStore'
import { authFetch } from '../api'
import { Link } from 'react-router-dom'
import * as controller from '../playback/controller'
import { useArtistPrefetch } from '../hooks/useArtistPrefetch'
import TrackCard from '../components/TrackCard'
import TrackRow from '../components/TrackRow'
import { toTrack, indexOfTrackInList } from '../utils/trackHelpers'
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
  const username = useAuthStore((s) => s.username)
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
    const idx = Math.max(0, indexOfTrackInList(recentlyDownloaded || [], track))
    controller.setSystemAndPlay(list, idx, { kind: 'recently-added' })
  }

  function playFromRecentlyPlayed(track: any) {
    const list = (recentlyPlayed || []).map((t) => toTrack(t))
    const idx = Math.max(0, indexOfTrackInList(recentlyPlayed || [], track))
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

  const recentlyPlayedScrollRef = useRef<HTMLDivElement>(null)
  const recentlyPlayedVirtualizer = useVirtualizer({
    count: recentlyPlayed?.length ?? 0,
    getScrollElement: () => recentlyPlayedScrollRef.current,
    estimateSize: () => 40,
    overscan: 8,
  })

  const recentlyDownloadedScrollRef = useRef<HTMLDivElement>(null)
  const recentlyDownloadedVirtualizer = useVirtualizer({
    count: recentlyDownloaded?.length ?? 0,
    getScrollElement: () => recentlyDownloadedScrollRef.current,
    estimateSize: () => 146,
    horizontal: true,
    overscan: 4,
  })

  return (
    <div className="p-6 flex-1 overflow-y-auto">
      <div className="mb-6 flex items-start justify-between gap-4">
        <h1
          className="text-4xl font-bold uppercase leading-none"
          style={{
            fontFamily: "'Barlow Condensed', sans-serif",
            fontWeight: 800,
            textTransform: 'uppercase',
            letterSpacing: '0.04em',
            lineHeight: 0.95,
            color: 'var(--text-primary)',
          }}
        >
          {getGreeting()}
        </h1>
        <div className="y2k-only" style={{ textAlign: 'right', flexShrink: 0 }}>
          <div className="tfxb">// System status: Online</div>
          <div className="tfxb">// User: @{username ?? 'unknown'}</div>
          <div className="tfxb">// Protocol: Soulseek v2.08</div>
        </div>
      </div>

      {(showHottestTracks || showTagMix) && (
        <div className="mb-8">
          <div
            className="flex items-center gap-2.5 mb-3"
            style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 16, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.12em', color: 'var(--section-title-color, var(--text-primary))' }}
          >
            For You
            <span className="tfx">//J97</span>
            <div className="flex-1 h-px" style={{ background: 'var(--bg-surface)' }} />
          </div>
          <div className="flex flex-wrap gap-3">
            {[
              showHottestTracks ? hottestTracksWithDef.definition : null,
              showTagMix ? tagMixWithDef.definition : null,
            ]
              .filter(Boolean)
              .map((def: any, idx: number) => (
                <Link
                  key={def.id}
                  to={`/auto-playlist/${def.id}`}
                  className="tf tf-brackets relative flex items-center gap-3 px-3 py-3 cursor-pointer overflow-hidden"
                  style={{ display: 'inline-flex', minWidth: 240, textDecoration: 'none' }}
                >
                  {def.cover_url && (
                    <div
                      className="absolute inset-0 pointer-events-none"
                      style={{
                        backgroundImage: `url(${def.cover_url})`,
                        backgroundSize: 'cover',
                        backgroundPosition: 'center',
                        opacity: 0.15,
                      }}
                    />
                  )}
                  <div
                    className="relative z-10 w-11 h-11 overflow-hidden shrink-0 flex items-center justify-center"
                    style={{
                      background: 'var(--bg-surface)',
                      border: '1px solid var(--border-subtle)',
                      borderRadius: 2,
                    }}
                  >
                    {def.cover_url ? (
                      <img src={def.cover_url} alt="" className="w-full h-full object-cover" loading="lazy" />
                    ) : (
                      <span style={{ fontSize: 16 }}>▦</span>
                    )}
                  </div>
                  <div className="relative z-10 min-w-0">
                    <span
                      className="text-xs truncate block"
                      style={{ fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 600, color: 'var(--text-primary)', letterSpacing: '0.06em', textTransform: 'uppercase' }}
                    >
                      {def.name}
                    </span>
                    <span className="tfxb" style={{ marginTop: 2 }}>// MIX.{String(idx + 1).padStart(2, '0')}</span>
                  </div>
                </Link>
              ))}
          </div>
        </div>
      )}

      {/* Playlists section */}
      {playlists && playlists.length > 0 && (
        <div className="mb-8">
          <div
            className="flex items-center gap-2.5 mb-3"
            style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 16, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.12em', color: 'var(--section-title-color, var(--text-primary))' }}
          >
            Your Playlists
            <div className="flex-1 h-px" style={{ background: 'var(--bg-surface)' }} />
          </div>
          <div className="flex flex-wrap gap-3">
            {playlists.slice(0, 6).map((pl: Playlist, idx: number) => (
              <Link
                key={pl.id}
                to={`/playlist/${pl.id}`}
                className="tf tf-brackets relative flex items-center gap-3 px-3 py-3 cursor-pointer overflow-hidden"
                style={{ display: 'inline-flex', minWidth: 240, textDecoration: 'none' }}
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
                  className="relative z-10 w-11 h-11 overflow-hidden shrink-0 flex items-center justify-center"
                  style={{
                    background: 'var(--bg-surface)',
                    border: '1px solid var(--border-subtle)',
                    borderRadius: 2,
                  }}
                >
                  {pl.cover_image_url ? (
                    <img src={pl.cover_image_url} alt="" className="w-full h-full object-cover" loading="lazy" />
                  ) : (
                    <span style={{ fontSize: 16 }}>▦</span>
                  )}
                </div>
                <div className="relative z-10 min-w-0">
                  <span
                    className="text-xs truncate block"
                    style={{ fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 600, color: 'var(--text-primary)', letterSpacing: '0.06em', textTransform: 'uppercase' }}
                  >
                    {pl.title}
                  </span>
                  <span className="tfxb" style={{ marginTop: 2 }}>// PL.{String(idx + 1).padStart(2, '0')}</span>
                </div>
              </Link>
            ))}
          </div>
        </div>
      )}

      {/* Recently Played */}
      <div className="mb-6">
        <div
          className="flex items-center gap-2.5 mb-3"
          style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 16, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.12em', color: 'var(--section-title-color, var(--text-primary))' }}
        >
          Recently Played
          <div className="flex-1 h-px" style={{ background: 'var(--bg-surface)' }} />
          <button
            onClick={refreshRecentlyPlayed}
            className="p-1.5 rounded hover:bg-[var(--border)] transition-colors"
            title="Refresh recently played"
            style={{ color: 'var(--text-primary)' }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 2v6h-6M3 12a9 9 0 0 1 15-6.7L21 8M3 22v-6h6M21 12a9 9 0 0 1-15 6.7L3 16" />
            </svg>
          </button>
        </div>
        <div
          ref={recentlyPlayedScrollRef}
          className="overflow-y-auto"
          style={{ maxHeight: 256 }}
        >
          {recentlyPlayed && recentlyPlayed.length > 0 ? (
            <div
              className="relative"
              style={{ height: `${recentlyPlayedVirtualizer.getTotalSize()}px` }}
            >
              {recentlyPlayedVirtualizer.getVirtualItems().map((vr) => {
                const track = recentlyPlayed[vr.index]
                return (
                  <div
                    key={track.track_id}
                    data-index={vr.index}
                    ref={recentlyPlayedVirtualizer.measureElement}
                    className="flex items-center"
                    style={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      width: '100%',
                      transform: `translateY(${vr.start}px)`,
                    }}
                  >
                    <span
                      className="w-8 text-center text-xs shrink-0"
                      style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-faint)' }}
                    >
                      {vr.index + 1}
                    </span>
                    <TrackRow
                      track={track}
                      isCached={track.is_cached}
                      playlistStyleCover
                      onPlay={playFromRecentlyPlayed}
                      onHoverArtist={(aid, albs) => enqueue(aid, albs)}
                      onContextMenu={handleRecentlyPlayedContextMenu}
                      style={{ padding: '8px 16px 8px 0' }}
                    />
                  </div>
                )
              })}
            </div>
          ) : (
            <p className="text-sm" style={{ color: 'var(--text-primary)', fontFamily: "'Barlow Semi Condensed', sans-serif" }}>no recently played tracks</p>
          )}
        </div>
      </div>

      {showRecentlyDownloaded && (
      <div>
        <div
          className="flex items-center gap-2.5 mb-3"
          style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 16, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.12em', color: 'var(--section-title-color, var(--text-primary))' }}
        >
          Recently Downloaded
          <div className="flex-1 h-px" style={{ background: 'var(--bg-surface)' }} />
        </div>
        <div
          ref={recentlyDownloadedScrollRef}
          className="overflow-x-auto overflow-y-auto pb-1"
          style={{ maxHeight: 256 }}
        >
          {recentlyDownloaded && recentlyDownloaded.length > 0 ? (
            <div
              className="relative"
              style={{
                width: `${recentlyDownloadedVirtualizer.getTotalSize()}px`,
                height: 190,
              }}
            >
              {recentlyDownloadedVirtualizer.getVirtualItems().map((vr) => {
                const track = recentlyDownloaded[vr.index]
                return (
                  <div
                    key={track.track_id}
                    data-index={vr.index}
                    ref={recentlyDownloadedVirtualizer.measureElement}
                    className="flex"
                    style={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      height: 190,
                      width: vr.size,
                      paddingLeft: 10,
                      transform: `translateX(${vr.start}px)`,
                      alignItems: 'flex-start',
                    }}
                  >
                    <TrackCard
                      track={track}
                      index={vr.index}
                      onPlay={playFromRecentlyDownloaded}
                      onHoverArtist={(aid, albs) => enqueue(aid, albs)}
                      onContextMenu={(e) => handleRecentlyDownloadedContextMenu(e, track)}
                    />
                  </div>
                )
              })}
            </div>
          ) : (
            <p className="text-sm" style={{ color: 'var(--text-primary)', fontFamily: "'Barlow Semi Condensed', sans-serif" }}>no recently downloaded tracks</p>
          )}
        </div>
      </div>
      )}
    </div>
  )
}