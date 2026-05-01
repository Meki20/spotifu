import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { useArtistTransitionStore, type TransitionRect } from '../stores/artistTransitionStore'

export default function ArtistTransitionOverlay() {
  const { isActive, fromRect, toRect, imageUrl, artistName } = useArtistTransitionStore()
  const [displayRect, setDisplayRect] = useState<TransitionRect | null>(null)
  const hasSetDest = useRef(false)

  useEffect(() => {
    if (!isActive) {
      setDisplayRect(null)
      hasSetDest.current = false
    }
  }, [isActive])

  useEffect(() => {
    if (!isActive || !fromRect || displayRect) return
    setDisplayRect(fromRect)
  }, [isActive, fromRect, displayRect])

  useEffect(() => {
    if (!toRect || !displayRect || hasSetDest.current) return
    hasSetDest.current = true
    requestAnimationFrame(() => {
      setDisplayRect(toRect)
    })
  }, [toRect, displayRect])

  if (!isActive || !displayRect) return null

  const style: CSSProperties = {
    position: 'fixed',
    zIndex: 9999,
    left: 0,
    top: 0,
    width: displayRect.width,
    height: displayRect.height,
    transform: `translate(${displayRect.x}px, ${displayRect.y}px)`,
    borderRadius: '50%',
    overflow: 'hidden',
    transition: hasSetDest.current
      ? 'transform 280ms cubic-bezier(0.25, 0.46, 0.45, 0.94), width 280ms cubic-bezier(0.25, 0.46, 0.45, 0.94), height 280ms cubic-bezier(0.25, 0.46, 0.45, 0.94)'
      : undefined,
    pointerEvents: 'none',
  }

  return (
    <div style={style}>
      {imageUrl ? (
        <img
          src={imageUrl}
          alt=""
          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
        />
      ) : (
        <div
          style={{
            width: '100%',
            height: '100%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: '#231815',
          }}
        >
          <span
            style={{
              fontSize: 56,
              color: '#4A413C',
              fontFamily: "'Barlow Condensed', sans-serif",
              fontWeight: 700,
              textTransform: 'uppercase',
            }}
          >
            {(artistName || '?').charAt(0)}
          </span>
        </div>
      )}
    </div>
  )
}
