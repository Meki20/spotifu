/** Single shared WebSocket to the API; components subscribe with callbacks. */
import { getWsUrl } from './config/resolveApi'
import { useConnectionStore } from './config/connectionStore'
import { useAuthStore } from './stores/authStore'

export type SpotifuWsMessage = {
  type?: string
  [key: string]: unknown
}

export const WS_RECONNECT = 'spotifu:reconnect'

type Listener = (msg: SpotifuWsMessage) => void

let socket: WebSocket | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let pingTimer: ReturnType<typeof setTimeout> | null = null
let pongWatchdog: ReturnType<typeof setTimeout> | null = null
let pingOutstanding = false
let nextBackoffAttempt = 0
const listeners = new Set<Listener>()

const PING_MS = 30_000
const PONG_TIMEOUT_MS = 60_000

function buildWsUrl(): string {
  const base = getWsUrl()
  const token = useAuthStore.getState().token
  if (!token) return base
  const sep = base.includes('?') ? '&' : '?'
  return `${base}${sep}token=${encodeURIComponent(token)}`
}

function getBackoffDelay(attempt: number): number {
  const base = Math.min(30, 2 ** attempt) * 1000
  return base + Math.random() * 1000
}

function clearPongWatchdog() {
  if (pongWatchdog != null) {
    clearTimeout(pongWatchdog)
    pongWatchdog = null
  }
}

function schedulePongWatchdog() {
  clearPongWatchdog()
  pongWatchdog = setTimeout(() => {
    if (pingOutstanding) {
      console.warn('[WS] pong timeout, closing')
      socket?.close()
    }
  }, PONG_TIMEOUT_MS)
}

function scheduleReconnect() {
  if (reconnectTimer != null || listeners.size === 0) return
  const attempt = nextBackoffAttempt
  nextBackoffAttempt += 1
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    connect()
  }, getBackoffDelay(attempt))
}

function startPing() {
  stopPing()
  pingTimer = setTimeout(() => {
    if (socket?.readyState === WebSocket.OPEN) {
      pingOutstanding = true
      socket.send(JSON.stringify({ type: 'ping' }))
      schedulePongWatchdog()
    }
    startPing()
  }, PING_MS)
}

function stopPing() {
  if (pingTimer != null) {
    clearTimeout(pingTimer)
    pingTimer = null
  }
  clearPongWatchdog()
  pingOutstanding = false
}

function connect() {
  if (
    socket?.readyState === WebSocket.OPEN ||
    socket?.readyState === WebSocket.CONNECTING
  ) {
    return
  }

  const token = useAuthStore.getState().token
  if (!token) return

  socket = new WebSocket(buildWsUrl())

  socket.onmessage = (event) => {
    const raw = event.data as string
    if (raw === 'pong') {
      pingOutstanding = false
      clearPongWatchdog()
      return
    }
    let data: SpotifuWsMessage
    try {
      data = JSON.parse(raw) as SpotifuWsMessage
    } catch {
      return
    }
    pingOutstanding = false
    clearPongWatchdog()
    if (data.type === 'pong') {
      return
    }
    listeners.forEach((fn) => {
      try {
        fn(data)
      } catch {
        /* listener fault isolation */
      }
    })
  }

  socket.onopen = () => {
    nextBackoffAttempt = 0
    pingOutstanding = false
    clearPongWatchdog()
    startPing()
    listeners.forEach((fn) => {
      try {
        fn({ type: WS_RECONNECT } as SpotifuWsMessage)
      } catch {
        /* listener fault isolation */
      }
    })
  }

  socket.onerror = (err) => {
    console.error('[WS] error', err)
  }

  socket.onclose = () => {
    stopPing()
    socket = null
    scheduleReconnect()
  }
}

export function reconnectWebSocket() {
  if (socket) {
    socket.close()
    socket = null
  }
  if (reconnectTimer != null) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  nextBackoffAttempt = 0
  connect()
}

useConnectionStore.subscribe((state, prev) => {
  if (state.apiBaseUrl !== prev.apiBaseUrl) {
    reconnectWebSocket()
  }
})

useAuthStore.subscribe((state, prev) => {
  if (state.token !== prev.token) {
    reconnectWebSocket()
  }
})

export function subscribeSpotifuWebSocket(listener: Listener): () => void {
  listeners.add(listener)
  connect()
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) {
      if (reconnectTimer != null) {
        clearTimeout(reconnectTimer)
        reconnectTimer = null
      }
      if (socket) {
        socket.close()
        socket = null
      }
    }
  }
}
