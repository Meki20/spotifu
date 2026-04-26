import { create } from 'zustand'

export type PlaybackPhase = 'idle' | 'resolving' | 'waiting_for_bytes' | 'streaming' | 'ready' | 'error'
export type RepeatMode = 'off' | 'one' | 'all'

export interface Track {
  mb_id: string
  track_id?: number
  title: string
  artist: string
  album: string
  album_cover: string | null
  preview_url: string | null
  duration?: number
  is_cached?: boolean
  local_stream_url?: string | null
  mb_release_id?: string | null
  mb_artist_id?: string | null
}

interface PlayerState {
  currentTrack: Track | null
  queue: Track[]
  queueIndex: number
  isPlaying: boolean
  volume: number
  currentTime: number
  duration: number
  phase: PlaybackPhase
  shuffle: boolean
  repeat: RepeatMode
  isDownloadBuffering: boolean
  setCurrentTrack: (track: Track) => void
  setQueue: (tracks: Track[], index?: number) => void
  setIsPlaying: (playing: boolean) => void
  setVolume: (vol: number) => void
  setCurrentTime: (t: number) => void
  setDuration: (d: number) => void
  setPhase: (p: PlaybackPhase) => void
  setShuffle: (s: boolean) => void
  setRepeat: (r: RepeatMode) => void
  setIsDownloadBuffering: (b: boolean) => void
  resetPlayer: () => void
}

export const usePlayerStore = create<PlayerState>((set) => ({
  currentTrack: null,
  queue: [],
  queueIndex: 0,
  isPlaying: false,
  volume: 0.8,
  currentTime: 0,
  duration: 0,
  phase: 'idle',
  shuffle: false,
  repeat: 'off',
  isDownloadBuffering: false,
  setCurrentTrack: (track) => set({ currentTrack: track }),
  setQueue: (tracks, index = 0) => set({ queue: tracks, queueIndex: index }),
  setIsPlaying: (playing) => set({ isPlaying: playing }),
  setVolume: (vol) => set({ volume: vol }),
  setCurrentTime: (t) => set({ currentTime: t }),
  setDuration: (d) => set({ duration: d }),
  setPhase: (p) => set({ phase: p }),
  setShuffle: (s) => set({ shuffle: s }),
  setRepeat: (r) => set({ repeat: r }),
  setIsDownloadBuffering: (b) => set({ isDownloadBuffering: b }),
  resetPlayer: () => set({ currentTime: 0, duration: 0, phase: 'idle', isDownloadBuffering: false }),
}))
