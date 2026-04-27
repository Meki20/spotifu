import { create } from 'zustand'
import { notify } from './notificationStore'

type S = { busy: Record<string, true> }

export const useDownloadBusyStore = create<S & { start: (k: string) => void; end: (k: string) => void; isBusy: (k: string) => boolean }>(
  (set, get) => ({
    busy: {},
    isBusy: (k: string) => k in get().busy,
    start: (k: string) => set((s) => (k in s.busy ? s : { busy: { ...s.busy, [k]: true } })),
    end: (k: string) =>
      set((s) => {
        if (!s.busy[k]) return s
        const next = { ...s.busy }
        delete next[k]
        return { busy: next as Record<string, true> }
      }),
  })
)

export async function requestMbDownload(
  authFetchImpl: (path: string, init?: RequestInit) => Promise<Response>,
  mbid: string
): Promise<Response | void> {
  const { start, end, isBusy } = useDownloadBusyStore.getState()
  if (isBusy(mbid)) return
  start(mbid)
  try {
    async function sleep(ms: number) {
      await new Promise<void>((r) => setTimeout(r, ms))
    }

    async function waitForSoulseekConnected(timeoutMs = 10000): Promise<boolean> {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        const res = await authFetchImpl('/settings')
        const settings = res.ok ? await res.json().catch(() => null) : null
        if (settings && settings.soulseek_connected === true) return true
        await sleep(400)
      }
      return false
    }

    // Guard: require Soulseek connection before initiating downloads.
    try {
      const settingsRes = await authFetchImpl('/settings')
      const settings = settingsRes.ok ? await settingsRes.json().catch(() => null) : null
      if (settings && settings.soulseek_connected === false) {
        notify({
          kind: 'warning',
          title: 'Downloading unavailable',
          description: 'Connect to Soulseek to download tracks.',
          actions: [
            {
              text: 'Connect',
              variant: 'green',
              onClick: async () => {
                const res = await authFetchImpl('/settings/soulseek/connect', { method: 'POST' })
                if (!res.ok) {
                  const data = await res.json().catch(() => ({}))
                  const msg = typeof data?.detail === 'string' ? data.detail : 'Failed to connect'
                  notify({ kind: 'error', title: 'Soulseek connect failed', description: msg })
                  return
                }
                notify({ kind: 'info', title: 'Connecting…', description: 'Trying to connect to Soulseek.' })
                const ok = await waitForSoulseekConnected(12000)
                if (!ok) {
                  notify({ kind: 'error', title: 'Still disconnected', description: 'Soulseek did not connect in time.' })
                  return
                }
                // Slight delay before starting the download pipeline.
                await sleep(1000)
                await requestMbDownload(authFetchImpl, mbid)
              },
            },
            { text: 'Cancel', variant: 'neutral' },
          ],
        })
        return
      }
    } catch {
      // If settings fetch fails, fall through and attempt download anyway.
    }
    return await authFetchImpl(`/play/download/musicbrainz/${mbid}`, { method: 'POST' })
  } finally {
    end(mbid)
  }
}
