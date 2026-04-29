import { create } from 'zustand'

export type PlaybackPhase = 'idle' | 'resolving' | 'waiting_for_bytes' | 'streaming' | 'ready' | 'error'
export type RepeatMode = 'off' | 'one' | 'all'

export interface Track {
  mb_id: string
  track_id?: number
  title: string
  artist: string
  artist_credit?: string | null
  album: string
  album_cover: string | null
  preview_url: string | null
  duration?: number
  is_cached?: boolean
  local_stream_url?: string | null
  mb_release_id?: string | null
  mb_release_group_id?: string | null
  mb_artist_id?: string | null
  quality?: string | null
}

export type SystemSource =
  | { kind: 'album'; id: string; title?: string }
  | { kind: 'playlist'; id: number; title?: string }
  | { kind: 'recently-added' }
  | { kind: 'recently-played' }
  | { kind: 'search'; query: string }
  | { kind: 'unknown'; title?: string }

interface PlayerState {
  currentTrack: Track | null
  userQueue: Track[]
  systemSource: SystemSource | null
  systemList: Track[]
  systemIndex: number
  systemLookahead: Track[]
  isPlaying: boolean
  volume: number
  currentTime: number
  duration: number
  phase: PlaybackPhase
  shuffle: boolean
  repeat: RepeatMode
  isDownloadBuffering: boolean
  setCurrentTrack: (track: Track) => void
  setSystem: (tracks: Track[], index: number, source?: SystemSource | null) => void
  setSystemIndex: (index: number) => void
  enqueueUser: (track: Track) => void
  dequeueUser: () => Track | null
  removeFromUserQueue: (index: number) => void
  clearUserQueue: () => void
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

function _lookahead(list: Track[], index: number): Track[] {
  const i = Math.max(0, Math.min(index, Math.max(0, list.length - 1)))
  return list.slice(i + 1, i + 1 + 30)
}

export const usePlayerStore = create<PlayerState>((set) => ({
  currentTrack: null,
  userQueue: [],
  systemSource: null,
  systemList: [],
  systemIndex: 0,
  systemLookahead: [],
  isPlaying: false,
  volume: 0.8,
  currentTime: 0,
  duration: 0,
  phase: 'idle',
  shuffle: false,
  repeat: 'off',
  isDownloadBuffering: false,
  setCurrentTrack: (track) => set({ currentTrack: track }),
  setSystem: (tracks, index, source = null) =>
    set({
      systemSource: source,
      systemList: tracks,
      systemIndex: index,
      systemLookahead: _lookahead(tracks, index),
    }),
  setSystemIndex: (index) =>
    set((s) => ({
      systemIndex: index,
      systemLookahead: _lookahead(s.systemList, index),
    })),
  enqueueUser: (track) => set((s) => ({ userQueue: [...s.userQueue, track] })),
  dequeueUser: () => {
    const { userQueue } = usePlayerStore.getState()
    if (!userQueue.length) return null
    const first = userQueue[0]
    set({ userQueue: userQueue.slice(1) })
    return first
  },
  removeFromUserQueue: (index) =>
    set((s) => ({ userQueue: s.userQueue.filter((_, i) => i !== index) })),
  clearUserQueue: () => set({ userQueue: [] }),
  setIsPlaying: (playing) => set({ isPlaying: playing }),
  setVolume: (vol) => set({ volume: vol }),
  setCurrentTime: (t) => set({ currentTime: t }),
  setDuration: (d) => set({ duration: d }),
  setPhase: (p) => set({ phase: p }),
  setShuffle: (s) => set({ shuffle: s }),
  setRepeat: (r) => set({ repeat: r }),
  setIsDownloadBuffering: (b) => set({ isDownloadBuffering: b }),
  resetPlayer: () =>
    set({ currentTime: 0, duration: 0, phase: 'idle', isDownloadBuffering: false }),
}))
