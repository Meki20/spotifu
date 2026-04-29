import { useState, useEffect, useCallback } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { authFetch } from '../api'
import { subscribeSpotifuWebSocket } from '../spotifuWebSocket'

interface SoulseekResult {
  username: string
  path: string
  size: number
  ext: string
}

interface ActiveDownload {
  track_id: number
  title: string
  artist: string
  album: string
  status: string
  percent: number
  bytes_downloaded: number
  speed: number
  filesize: number | null
}

interface DownloadHistory {
  track_id: number
  title: string
  artist: string
  album: string
  status: string
  local_path: string | null
  completed_at: string
}

interface SoulseekStatus {
  connected: boolean
}

interface WsDirectDownloadProgress {
  type: 'direct_download_progress'
  track_id: number
  percent: number
  bytes_downloaded: number
  speed: number
  filesize?: number
}

interface WsDirectDownloadStarted {
  type: 'direct_download_started'
  track_id: number
  local_stream_url: string
}

interface WsDirectDownloadReady {
  type: 'direct_download_ready'
  track_id: number
  local_stream_url: string
  album_cover?: string
}

interface WsDirectDownloadError {
  type: 'direct_download_error'
  track_id: number
  error: string
}

type WsMessage = WsDirectDownloadProgress | WsDirectDownloadStarted | WsDirectDownloadReady | WsDirectDownloadError

async function fetchSoulseekStatus(): Promise<SoulseekStatus> {
  const res = await authFetch('/soulseek/status')
  if (!res.ok) throw new Error('Failed to fetch status')
  return res.json()
}

async function searchSoulseek(query: string): Promise<SoulseekResult[]> {
  const res = await authFetch('/soulseek/search', {
    method: 'POST',
    body: JSON.stringify({ query }),
  })
  if (!res.ok) throw new Error('Search failed')
  const data = await res.json()
  return data.results
}

async function fetchDownloads(): Promise<{ active: ActiveDownload[]; recent: DownloadHistory[] }> {
  const res = await authFetch('/soulseek/downloads')
  if (!res.ok) throw new Error('Failed to fetch downloads')
  return res.json()
}

async function downloadTrack(result: SoulseekResult, title: string, artist: string, album: string) {
  const res = await authFetch('/soulseek/download', {
    method: 'POST',
    body: JSON.stringify({
      username: result.username,
      remote_path: result.path,
      title,
      artist,
      album,
    }),
  })
  if (!res.ok) throw new Error('Download failed')
  return res.json()
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i]
}

function formatSpeed(bytesPerSec: number): string {
  return formatBytes(bytesPerSec) + '/s'
}

export default function Soulseek() {
  const queryClient = useQueryClient()
  const [query, setQuery] = useState('')
  const [searchInput, setSearchInput] = useState('')

  const { data: status } = useQuery({
    queryKey: ['soulseekStatus'],
    queryFn: fetchSoulseekStatus,
    refetchInterval: 5000,
  })

  const { data: searchResults, isLoading: searchLoading, error: searchError, refetch: doSearch } = useQuery({
    queryKey: ['soulseekSearch', query],
    queryFn: () => searchSoulseek(query),
    enabled: false,
  })

  const { data: downloadsData, refetch: refetchDownloads } = useQuery({
    queryKey: ['soulseekDownloads'],
    queryFn: fetchDownloads,
    refetchInterval: 2000,
  })

  const [downloadProgress, setDownloadProgress] = useState<Record<number, ActiveDownload>>({})

  const downloadMutation = useMutation({
    mutationFn: ({ result, title, artist, album }: { result: SoulseekResult; title: string; artist: string; album: string }) =>
      downloadTrack(result, title, artist, album),
    onSuccess: () => {
      refetchDownloads()
    },
    onError: () => {
      refetchDownloads()
    },
  })

  useEffect(() => {
    const unsub = subscribeSpotifuWebSocket((data) => {
      const msg = data as unknown as WsMessage
      if (msg.type === 'direct_download_progress') {
        setDownloadProgress((prev) => ({
          ...prev,
          [msg.track_id]: {
            ...prev[msg.track_id],
            percent: msg.percent,
            bytes_downloaded: msg.bytes_downloaded,
            speed: msg.speed,
            filesize: msg.filesize ?? prev[msg.track_id]?.filesize ?? null,
          },
        }))
      } else if (msg.type === 'direct_download_started') {
        refetchDownloads()
      } else if (msg.type === 'direct_download_ready' || msg.type === 'direct_download_error') {
        refetchDownloads()
        setDownloadProgress((prev) => {
          const next = { ...prev }
          delete next[msg.track_id]
          return next
        })
      }
    })
    return unsub
  }, [refetchDownloads])

  const handleSearch = useCallback((e: React.FormEvent) => {
    e.preventDefault()
    const q = searchInput.trim()
    if (q) {
      setQuery(q)
      searchSoulseek(q).then((results) => {
        queryClient.setQueryData(['soulseekSearch', q], results)
      })
    }
  }, [searchInput, queryClient])

  const connected = status?.connected ?? false

  return (
    <div className="h-full flex flex-col">
      <div className="p-6 pb-4">
        <h1
          className="text-3xl font-bold mb-1"
          style={{ fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 800, color: '#E8DDD0', letterSpacing: '0.02em' }}
        >
          Soulseek
        </h1>
        <p style={{ color: '#9A8E84', fontFamily: "'Barlow Semi Condensed', sans-serif" }}>
          Search and download music directly
        </p>
      </div>

      {!connected && (
        <div className="px-6 pb-4">
          <div
            className="p-4 rounded-md flex items-center gap-3"
            style={{ background: 'rgba(180, 0, 62, 0.15)', border: '1px solid rgba(180, 0, 62, 0.3)' }}
          >
            <span style={{ color: '#b4003e', fontSize: '1.5rem' }}>⚠</span>
            <div>
              <p style={{ color: '#E8DDD0', fontWeight: 600 }}>Soulseek not connected</p>
              <p style={{ color: '#9A8E84', fontSize: '0.875rem' }}>
                Go to <Link to="/settings" style={{ color: '#b4003e', textDecoration: 'underline' }}>Settings</Link> to configure Soulseek credentials
              </p>
            </div>
          </div>
        </div>
      )}

      <div className="px-6 pb-4">
        <form onSubmit={handleSearch} className="flex gap-2">
          <input
            type="text"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search Soulseek (e.g., 'Artist - Title')"
            className="flex-1 px-4 py-2 rounded-md text-sm"
            style={{
              background: '#1A1210',
              border: '1px solid #3D2820',
              color: '#E8DDD0',
              fontFamily: "'Barlow Semi Condensed', sans-serif",
            }}
            disabled={!connected}
          />
          <button
            type="submit"
            disabled={!connected || searchLoading}
            className="px-4 py-2 rounded-md text-sm font-semibold transition-colors"
            style={{
              background: connected ? '#b4003e' : '#3D2820',
              color: connected ? '#E8DDD0' : '#9A8E84',
              cursor: connected ? 'pointer' : 'not-allowed',
            }}
          >
            {searchLoading ? 'Searching...' : 'Search'}
          </button>
        </form>
      </div>

      {searchError && (
        <div className="px-6 pb-4">
          <div
            className="p-3 rounded-md text-sm"
            style={{ background: 'rgba(180, 0, 62, 0.1)', color: '#b4003e' }}
          >
            Search failed: {(searchError as Error).message}
          </div>
        </div>
      )}

      {searchResults && searchResults.length > 0 && (
        <div className="px-6 pb-4">
          <h2
            className="text-sm font-semibold mb-2 tracking-widest"
            style={{
              fontFamily: "'Barlow Condensed', sans-serif",
              textTransform: 'uppercase',
              letterSpacing: '0.15em',
              color: '#4A413C',
            }}
          >
            Results ({searchResults.length})
          </h2>
          <div
            className="rounded-md overflow-hidden"
            style={{ background: '#1A1210', border: '1px solid #3D2820' }}
          >
            {searchResults.slice(0, 20).map((result, idx) => {
              const filename = result.path.split(/[/\\]/).pop() ?? ''
              const isDownloading = downloadMutation.variables?.result.path === result.path
              return (
                <div
                  key={`${result.username}-${result.path}-${idx}`}
                  className="flex items-center justify-between px-4 py-2 border-b"
                  style={{
                    borderColor: idx < searchResults.length - 1 ? '#261A14' : 'transparent',
                  }}
                >
                  <div className="flex-1 min-w-0">
                    <p
                      className="text-sm truncate"
                      style={{ color: '#E8DDD0', fontFamily: "'Barlow Semi Condensed', sans-serif" }}
                      title={filename}
                    >
                      {filename}
                    </p>
                    <p className="text-xs truncate" style={{ color: '#9A8E84' }}>
                      {result.username} · {formatBytes(result.size)} · {result.ext}
                    </p>
                  </div>
                  <button
                    onClick={() => {
                      downloadMutation.mutate({ result, title: '', artist: '', album: '' })
                    }}
                    disabled={isDownloading || downloadMutation.isPending}
                    className="ml-3 px-3 py-1 rounded text-xs font-semibold transition-colors"
                    style={{
                      background: isDownloading ? '#3D2820' : '#b4003e',
                      color: isDownloading ? '#9A8E84' : '#E8DDD0',
                      cursor: isDownloading ? 'not-allowed' : 'pointer',
                    }}
                  >
                    {isDownloading ? '...' : 'Download'}
                  </button>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {searchResults && searchResults.length === 0 && query && !searchLoading && (
        <div className="px-6 pb-4">
          <p style={{ color: '#9A8E84' }}>No results found for "{query}"</p>
        </div>
      )}

      {(downloadsData?.active?.length ?? 0) > 0 && (
        <div className="px-6 pb-4">
          <h2
            className="text-sm font-semibold mb-2 tracking-widest"
            style={{
              fontFamily: "'Barlow Condensed', sans-serif",
              textTransform: 'uppercase',
              letterSpacing: '0.15em',
              color: '#4A413C',
            }}
          >
            Active Downloads
          </h2>
          <div
            className="rounded-md overflow-hidden"
            style={{ background: '#1A1210', border: '1px solid #3D2820' }}
          >
            {downloadsData?.active.map((download) => {
              const progress = downloadProgress[download.track_id]
              const percent = progress?.percent ?? download.percent ?? 0
              const speed = progress?.speed ?? download.speed ?? 0
              return (
                <div
                  key={download.track_id}
                  className="px-4 py-3 border-b"
                  style={{ borderColor: '#261A14' }}
                >
                  <div className="flex items-center justify-between mb-1">
                    <span
                      className="text-sm truncate"
                      style={{ color: '#E8DDD0', fontFamily: "'Barlow Semi Condensed', sans-serif" }}
                    >
                      {download.artist} - {download.title}
                    </span>
                    <span className="text-xs" style={{ color: '#9A8E84' }}>
                      {percent}% · {formatSpeed(speed)}
                    </span>
                  </div>
                  <div
                    className="h-1 rounded-full overflow-hidden"
                    style={{ background: '#261A14' }}
                  >
                    <div
                      className="h-full transition-all"
                      style={{ width: `${percent}%`, background: '#b4003e' }}
                    />
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {(downloadsData?.recent?.length ?? 0) > 0 && (
        <div className="px-6 pb-4 flex-1 overflow-auto">
          <h2
            className="text-sm font-semibold mb-2 tracking-widest"
            style={{
              fontFamily: "'Barlow Condensed', sans-serif",
              textTransform: 'uppercase',
              letterSpacing: '0.15em',
              color: '#4A413C',
            }}
          >
            Recent Downloads
          </h2>
          <div
            className="rounded-md overflow-hidden"
            style={{ background: '#1A1210', border: '1px solid #3D2820' }}
          >
            {downloadsData?.recent.map((item, idx) => (
              <div
                key={`${item.track_id}-${item.completed_at}-${idx}`}
                className="flex items-center justify-between px-4 py-2 border-b"
                style={{ borderColor: idx < (downloadsData.recent.length - 1) ? '#261A14' : 'transparent' }}
              >
                <div className="flex-1 min-w-0">
                  <p
                    className="text-sm truncate"
                    style={{ color: '#E8DDD0', fontFamily: "'Barlow Semi Condensed', sans-serif" }}
                  >
                    {item.artist} - {item.title}
                  </p>
                  <p className="text-xs truncate" style={{ color: '#9A8E84' }}>
                    {item.status === 'completed' ? (
                      <span style={{ color: '#4ADE80' }}>Completed</span>
                    ) : item.status === 'failed' ? (
                      <span style={{ color: '#b4003e' }}>Failed</span>
                    ) : (
                      item.status
                    )}
                  </p>
                </div>
                {item.status === 'completed' && (
                  <span className="text-xs ml-3" style={{ color: '#4A413C' }}>
                    {formatBytes(item.local_path ? 0 : 0)}
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}