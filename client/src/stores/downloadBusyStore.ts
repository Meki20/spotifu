import { create } from 'zustand'

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
    return await authFetchImpl(`/play/download/musicbrainz/${mbid}`, { method: 'POST' })
  } finally {
    end(mbid)
  }
}
