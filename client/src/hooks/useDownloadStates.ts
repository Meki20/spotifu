import { useState, useEffect } from 'react'
import { subscribeSpotifuWebSocket } from '../spotifuWebSocket'

export interface DownloadState {
  status: 'downloading' | 'error'
  percent?: number
  error?: string
}

export interface DownloadStates {
  [key: string]: DownloadState
}

export function useDownloadStates() {
  const [downloadStates, setDownloadStates] = useState<DownloadStates>({})
  const [cachedMbIds, setCachedMbIds] = useState<Set<string>>(new Set())

  useEffect(() => {
    const unsub = subscribeSpotifuWebSocket((data) => {
      const mb = data.mb_id as string | undefined

      if (data.type === 'download_searching' || data.type === 'download_started') {
        setDownloadStates((prev) => {
          const next = { ...prev }
          if (mb) next[mb] = { status: 'downloading', percent: 0 }
          return next
        })
      } else if (data.type === 'download_progress') {
        const pct = data.percent as number
        setDownloadStates((prev) => {
          const next = { ...prev }
          if (mb) next[mb] = { status: 'downloading', percent: pct }
          return next
        })
      } else if (data.type === 'track_ready') {
        if (mb) setCachedMbIds((prev) => new Set([...prev, mb]))
        setDownloadStates((prev) => {
          const next = { ...prev }
          if (mb) delete next[mb]
          return next
        })
      } else if (data.type === 'download_error') {
        setDownloadStates((prev) => {
          const next = { ...prev }
          if (mb) next[mb] = { status: 'error', error: String(data.error ?? 'Unknown error') }
          return next
        })
      }
    })
    return unsub
  }, [])

  return { downloadStates, cachedMbIds }
}