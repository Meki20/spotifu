import { useEffect } from 'react'
import { useContextMenuActions } from '../contexts/ContextMenuProvider'

/**
 * Closes the global context menu on every click outside the menu itself.
 * Safe to call from any component — the effect is a no-op if already attached.
 */
export function useCloseContextMenuOnOutsideClick() {
  const { closeContextMenu } = useContextMenuActions()

  useEffect(() => {
    function handler() {
      closeContextMenu()
    }

    document.addEventListener('click', handler)
    return () => document.removeEventListener('click', handler)
  }, [closeContextMenu])
}

/**
 * useContextMenuHandler returns a bound right-click handler to pass to `onContextMenu`
 * on any track-aware element. Only elements with this handler will show the custom menu.
 *
 * Usage:
 *   const handler = useContextMenuHandler((e) => e.currentTarget.__track)
 *   <div onContextMenu={handler} />
 */
export function useContextMenuHandler(getTrack: (e: React.MouseEvent) => any) {
  const { openContextMenu } = useContextMenuActions()

  return (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    openContextMenu(e.clientX, e.clientY, getTrack(e))
  }
}
