import { usePlayerStore, type Track, type RepeatMode } from '../stores/playerStore'
import { subscribeSpotifuWebSocket } from '../spotifuWebSocket'
import { API, authFetch } from '../api'
import { queryClient } from '../queryClient'

class PlaybackController {
  private _audio: HTMLAudioElement
  private _currentTrackId: number | null = null
  private _currentMbId: string | null = null
  private _history: Track[] = []
  private _shuffleOrder: number[] | null = null
  private _initialized = false
  private _playTimeout: ReturnType<typeof setTimeout> | null = null

  constructor() {
    this._audio = new Audio()
  }

  init() {
    if (this._initialized) return
    this._initialized = true

    this._audio.volume = usePlayerStore.getState().volume

    this._audio.addEventListener('timeupdate', () => {
      usePlayerStore.setState({ currentTime: this._audio.currentTime })
    })

    this._audio.addEventListener('durationchange', () => {
      const d = this._audio.duration
      if (d && isFinite(d) && !isNaN(d)) {
        usePlayerStore.setState({ duration: d })
      }
    })

    this._audio.addEventListener('waiting', () => {
      usePlayerStore.setState({ isDownloadBuffering: true })
    })

    this._audio.addEventListener('canplay', () => {
      const { isDownloadBuffering, isPlaying } = usePlayerStore.getState()
      if (isDownloadBuffering) {
        usePlayerStore.setState({ isDownloadBuffering: false })
        if (isPlaying) this._audio.play().catch(() => {})
      }
    })

    this._audio.addEventListener('ended', () => this._onEnded())

    subscribeSpotifuWebSocket((data) => this._handleWsMessage(data as Record<string, unknown>))
  }

  private _clearPlayTimeout() {
    if (this._playTimeout != null) {
      clearTimeout(this._playTimeout)
      this._playTimeout = null
    }
  }

  private _onEnded() {
    const { phase, repeat } = usePlayerStore.getState()

    if (phase === 'streaming' || phase === 'waiting_for_bytes') {
      usePlayerStore.setState({ isDownloadBuffering: true })
      const t = Math.max(0, this._audio.currentTime - 0.5)
      this._clearPlayTimeout()
      this._playTimeout = setTimeout(() => {
        if (!usePlayerStore.getState().isPlaying) return
        this._audio.currentTime = t
        this._audio.play().catch(() => {})
      }, 500)
      return
    }

    if (repeat === 'one') {
      this._audio.currentTime = 0
      this._audio.play().catch(() => {})
      return
    }

    this._skipNextInternal(true)
  }

  private _matchesCurrent(data: Record<string, unknown>): boolean {
    const dataTrId = data.track_id != null ? Number(data.track_id) : null
    const dataMbId = data.mb_id as string | undefined
    if (this._currentTrackId != null && dataTrId != null && this._currentTrackId === dataTrId) return true
    if (this._currentMbId != null && dataMbId && this._currentMbId === dataMbId) return true
    return false
  }

  private _handleWsMessage(data: Record<string, unknown>) {
    if (!this._matchesCurrent(data)) return

    if (data.type === 'download_searching') {
      if (data.track_id != null) this._currentTrackId = Number(data.track_id)
      const ct = usePlayerStore.getState().currentTrack
      if (ct && data.track_id != null) {
        usePlayerStore.setState({ currentTrack: { ...ct, track_id: Number(data.track_id) } })
      }
      return
    }

    if (data.type === 'download_started') {
      if (data.track_id != null) this._currentTrackId = Number(data.track_id)
      const rawUrl = String(data.local_stream_url)
      const fullUrl = rawUrl.startsWith('http') ? rawUrl : `${API}${rawUrl}`
      const duration = data.duration as number | undefined
      const ct = usePlayerStore.getState().currentTrack
      usePlayerStore.setState({
        currentTrack: {
          ...ct!,
          local_stream_url: fullUrl,
          track_id: this._currentTrackId ?? ct?.track_id,
          duration: duration ?? ct?.duration,
        },
        phase: 'streaming',
        ...(duration ? { duration } : {}),
      })
      this._loadAndPlay(fullUrl)
      return
    }

    if (data.type === 'track_ready') {
      if (data.track_id != null) this._currentTrackId = Number(data.track_id)
      usePlayerStore.setState({ phase: 'ready', isDownloadBuffering: false })
      return
    }

    if (data.type === 'download_error') {
      usePlayerStore.setState({ phase: 'error', isPlaying: false })
      return
    }
  }

  private _loadAndPlay(url: string) {
    this._clearPlayTimeout()
    const fullUrl = url.startsWith('http') ? url : `${API}${url}`
    this._audio.src = `${fullUrl}?cb=${Date.now()}`
    this._audio.play().catch((e: unknown) => {
      console.error('[Controller] play() failed:', e)
      usePlayerStore.setState({ isPlaying: false })
    })
    usePlayerStore.setState({ isPlaying: true })
    this._playTimeout = setTimeout(() => {
      if (this._audio.readyState === 0) {
        console.warn('[Controller] play() timeout, recovering')
        this._audio.pause()
        usePlayerStore.setState({ phase: 'error', isPlaying: false })
      }
    }, 15000)
  }

  private _playTrack(track: Track): void {
    this._audio.pause()
    this._audio.src = ''
    this._audio.load()

    this._currentTrackId = track.track_id ?? null
    this._currentMbId = track.mb_id || null

    usePlayerStore.setState({
      currentTrack: track,
      phase: 'resolving',
      isPlaying: false,
      currentTime: 0,
      duration: track.duration ?? 0,
      isDownloadBuffering: false,
    })

    if (track.is_cached && track.track_id) {
      const url = `/stream/${track.track_id}`
      usePlayerStore.setState({
        currentTrack: { ...track, local_stream_url: url, is_cached: true },
        phase: 'ready',
      })
      authFetch(`/play/local/${track.track_id}`).catch(() => {})
      queryClient.invalidateQueries({ queryKey: ['recently-played'] })
      this._loadAndPlay(url)
      return
    }

    authFetch(`/play/musicbrainz/${track.mb_id}`)
      .then(r => r.json())
      .then(data => {
        const ct = usePlayerStore.getState().currentTrack
        const currentPhase = usePlayerStore.getState().phase

        if (currentPhase === 'streaming' || currentPhase === 'ready') {
          if (ct && data.track_id) {
            usePlayerStore.setState({ currentTrack: { ...ct, track_id: data.track_id, is_cached: Boolean(data.local_stream_url) } })
          }
          queryClient.invalidateQueries({ queryKey: ['recently-played'] })
          return
        }

        this._currentTrackId = data.track_id ?? this._currentTrackId

        if (data.local_stream_url) {
          const rawUrl = String(data.local_stream_url)
          const url = rawUrl.startsWith('http') ? rawUrl : `${API}${rawUrl}`
          usePlayerStore.setState({
            currentTrack: { ...ct!, local_stream_url: url, track_id: this._currentTrackId ?? undefined, is_cached: true },
            phase: 'ready',
          })
          queryClient.invalidateQueries({ queryKey: ['recently-played'] })
          this._loadAndPlay(url)
        } else {
          usePlayerStore.setState({
            currentTrack: { ...ct!, track_id: data.track_id ?? undefined },
            phase: 'waiting_for_bytes',
            isPlaying: true,
          })
        }
      })
      .catch(e => {
        console.error('[Controller] fetch failed:', e)
        usePlayerStore.setState({ phase: 'error' })
      })
  }

  private _generateShuffleOrder(length: number, currentIndex: number): number[] {
    const rest = Array.from({ length }, (_, i) => i).filter(i => i !== currentIndex)
    for (let i = rest.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [rest[i], rest[j]] = [rest[j], rest[i]]
    }
    return [currentIndex, ...rest]
  }

  private _skipNextInternal(autoAdvance: boolean) {
    const { queue, queueIndex, repeat, shuffle } = usePlayerStore.getState()

    if (queue.length === 0) {
      usePlayerStore.setState({ isPlaying: false, phase: 'idle' })
      return
    }

    let nextIndex: number | null = null

    if (shuffle && this._shuffleOrder) {
      const curPos = this._shuffleOrder.indexOf(queueIndex)
      const nextPos = curPos + 1
      if (nextPos < this._shuffleOrder.length) {
        nextIndex = this._shuffleOrder[nextPos]
      } else if (repeat === 'all' && autoAdvance) {
        this._shuffleOrder = this._generateShuffleOrder(queue.length, 0)
        nextIndex = this._shuffleOrder[0]
      }
    } else {
      if (queueIndex + 1 < queue.length) {
        nextIndex = queueIndex + 1
      } else if (repeat === 'all' && autoAdvance) {
        nextIndex = 0
      }
    }

    if (nextIndex === null) {
      usePlayerStore.setState({ isPlaying: false })
      return
    }

    const ct = usePlayerStore.getState().currentTrack
    if (ct) this._history = [...this._history.slice(-49), ct]

    usePlayerStore.setState({ queueIndex: nextIndex })
    this._playTrack(queue[nextIndex])
  }

  // --- Public API ---

  play(track: Track): void {
    const { currentTrack } = usePlayerStore.getState()
    if (currentTrack) this._history = [...this._history.slice(-49), currentTrack]
    this._playTrack(track)
  }

  pause(): void {
    this._audio.pause()
    usePlayerStore.setState({ isPlaying: false })
  }

  resume(): void {
    if (this._audio.src) {
      this._audio.play().catch(() => {})
      usePlayerStore.setState({ isPlaying: true })
    }
  }

  togglePlayPause(): void {
    const { isPlaying } = usePlayerStore.getState()
    if (isPlaying) this.pause()
    else this.resume()
  }

  seek(time: number): void {
    const { phase } = usePlayerStore.getState()
    if (phase === 'idle' || phase === 'resolving' || phase === 'waiting_for_bytes') return
    this._audio.currentTime = time
    usePlayerStore.setState({ currentTime: time })
  }

  setVolume(vol: number): void {
    this._audio.volume = vol
    usePlayerStore.setState({ volume: vol })
  }

  addToQueue(track: Track): void {
    const { queue } = usePlayerStore.getState()
    if (this._shuffleOrder) {
      this._shuffleOrder.push(queue.length)
    }
    usePlayerStore.setState({ queue: [...queue, track] })
  }

  insertNext(track: Track): void {
    const { queue, queueIndex } = usePlayerStore.getState()
    const insertAt = queueIndex + 1
    const newQueue = [...queue.slice(0, insertAt), track, ...queue.slice(insertAt)]
    if (this._shuffleOrder) {
      const curShufflePos = this._shuffleOrder.indexOf(queueIndex)
      const shifted = this._shuffleOrder.map(i => i >= insertAt ? i + 1 : i)
      shifted.splice(curShufflePos + 1, 0, insertAt)
      this._shuffleOrder = shifted
    }
    usePlayerStore.setState({ queue: newQueue })
  }

  removeFromQueue(index: number): void {
    const { queue, queueIndex } = usePlayerStore.getState()
    const newQueue = queue.filter((_, i) => i !== index)
    let newIndex = queueIndex
    if (index < queueIndex) newIndex--
    if (this._shuffleOrder) {
      this._shuffleOrder = this._generateShuffleOrder(newQueue.length, newIndex)
    }
    usePlayerStore.setState({ queue: newQueue, queueIndex: newIndex })
  }

  clearQueue(): void {
    usePlayerStore.setState({ queue: [], queueIndex: 0 })
    this._shuffleOrder = null
  }

  skipNext(): void {
    this._skipNextInternal(false)
  }

  skipPrev(): void {
    this._clearPlayTimeout()
    if (this._audio.currentTime > 3) {
      this._audio.currentTime = 0
      usePlayerStore.setState({ currentTime: 0 })
      return
    }
    if (this._history.length > 0) {
      const prev = this._history[this._history.length - 1]
      this._history = this._history.slice(0, -1)
      this._playTrack(prev)
    }
  }

  setShuffle(on: boolean): void {
    const { queueIndex, queue } = usePlayerStore.getState()
    this._shuffleOrder = on ? this._generateShuffleOrder(queue.length, queueIndex) : null
    usePlayerStore.setState({ shuffle: on })
  }

  setRepeat(mode: RepeatMode): void {
    usePlayerStore.setState({ repeat: mode })
  }

  setQueueAndPlay(tracks: Track[], startIndex = 0): void {
    usePlayerStore.setState({ queue: tracks, queueIndex: startIndex })
    this._shuffleOrder = null
    if (tracks.length > 0) this.play(tracks[startIndex])
  }
}

export const controller = new PlaybackController()
export function getController() {
  return controller
}

// Backwards-compatible top-level exports
export function init() {
  controller.init()
}
export function play(track: Track): void {
  controller.play(track)
}
export function pause(): void {
  controller.pause()
}
export function resume(): void {
  controller.resume()
}
export function togglePlayPause(): void {
  controller.togglePlayPause()
}
export function seek(time: number): void {
  controller.seek(time)
}
export function setVolume(vol: number): void {
  controller.setVolume(vol)
}
export function addToQueue(track: Track): void {
  controller.addToQueue(track)
}
export function insertNext(track: Track): void {
  controller.insertNext(track)
}
export function removeFromQueue(index: number): void {
  controller.removeFromQueue(index)
}
export function clearQueue(): void {
  controller.clearQueue()
}
export function skipNext(): void {
  controller.skipNext()
}
export function skipPrev(): void {
  controller.skipPrev()
}
export function setShuffle(on: boolean): void {
  controller.setShuffle(on)
}
export function setRepeat(mode: RepeatMode): void {
  controller.setRepeat(mode)
}
export function setQueueAndPlay(tracks: Track[], startIndex = 0): void {
  controller.setQueueAndPlay(tracks, startIndex)
}