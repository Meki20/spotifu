import { create } from 'zustand'

export interface TransitionRect {
  x: number
  y: number
  width: number
  height: number
}

interface ArtistTransitionState {
  isActive: boolean
  fromRect: TransitionRect | null
  imageUrl: string | null
  artistName: string | null
  artistMbid: string | null
  toRect: TransitionRect | null
  start: (fromRect: TransitionRect, imageUrl: string | null, artistName: string, artistMbid: string) => void
  setToRect: (toRect: TransitionRect) => void
  end: () => void
}

export const useArtistTransitionStore = create<ArtistTransitionState>((set) => ({
  isActive: false,
  fromRect: null,
  imageUrl: null,
  artistName: null,
  artistMbid: null,
  toRect: null,
  start: (fromRect, imageUrl, artistName, artistMbid) =>
    set({ isActive: true, fromRect, imageUrl, artistName, artistMbid, toRect: null }),
  setToRect: (toRect) => set({ toRect }),
  end: () =>
    set({ isActive: false, fromRect: null, imageUrl: null, artistName: null, artistMbid: null, toRect: null }),
}))
