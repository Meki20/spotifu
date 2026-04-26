import type { ReactNode } from 'react'

interface TrackListProps {
  tracks?: any[]
  maxHeight?: string | number
  className?: string
  style?: React.CSSProperties
  children: ReactNode
}

export default function TrackList({
  maxHeight,
  className = '',
  style,
  children,
}: TrackListProps) {
  return (
    <div
      className={`overflow-y-auto pb-1 ${className}`}
      style={
        maxHeight
          ? { maxHeight, overflowY: 'auto', ...style }
          : { overflowY: 'auto', ...style }
      }
    >
      {children}
    </div>
  )
}