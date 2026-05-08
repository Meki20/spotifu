import { createContext, useContext, useState, useCallback, type ReactNode } from 'react'

export interface ContextMenuOverrides {
  /** Page-specific play (e.g. play in album/search/playlist queue context). */
  onPlay?: () => void
  /** Only used by PlaylistPage; absence hides the menu item. */
  onRemoveFromPlaylist?: () => void
}

interface ContextMenuState {
  x: number
  y: number
  track: any
  overrides?: ContextMenuOverrides
}

interface ContextMenuActions {
  openContextMenu: (x: number, y: number, track: any, overrides?: ContextMenuOverrides) => void
  closeContextMenu: () => void
}

const ContextMenuContext = createContext<ContextMenuState | null>(null)
const ContextMenuActionsContext = createContext<ContextMenuActions | null>(null)

export function ContextMenuProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<ContextMenuState | null>(null)

  const openContextMenu = useCallback(
    (x: number, y: number, track: any, overrides?: ContextMenuOverrides) => {
      setState({ x, y, track, overrides })
    },
    [],
  )

  const closeContextMenu = useCallback(() => {
    setState(null)
  }, [])

  return (
    <ContextMenuActionsContext.Provider value={{ openContextMenu, closeContextMenu }}>
      <ContextMenuContext.Provider value={state}>
        {children}
      </ContextMenuContext.Provider>
    </ContextMenuActionsContext.Provider>
  )
}

export function useContextMenuState() {
  return useContext(ContextMenuContext)
}

export function useContextMenuActions() {
  const ctx = useContext(ContextMenuActionsContext)
  if (!ctx) throw new Error('useContextMenuActions must be used inside ContextMenuProvider')
  return ctx
}