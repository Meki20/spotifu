import { useRef } from 'react'
import { useArtistTransitionStore } from '../stores/artistTransitionStore'

interface ArtistCardProps {
  artist: {
    artist_mbid: string
    name: string
    sort_name?: string | null
    disambiguation?: string | null
    country?: string | null
    type?: string | null
  }
  imageUrl?: string | null
  onClick: (artistMbid: string) => void
}

export default function ArtistCard({ artist, imageUrl, onClick }: ArtistCardProps) {
  const cardRef = useRef<HTMLDivElement>(null)
  const transition = useArtistTransitionStore()

  const handleClick = () => {
    const circle = cardRef.current?.querySelector('[data-transition-circle]') as HTMLElement | null
    if (circle) {
      const rect = circle.getBoundingClientRect()
      transition.start(
        { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
        imageUrl || null,
        artist.name,
        artist.artist_mbid
      )
    }
    onClick(artist.artist_mbid)
  }

  return (
    <div
      ref={cardRef}
      className="p-5 rounded cursor-pointer border transition-all duration-150 relative overflow-hidden flex flex-col items-center"
      style={{
        background: 'var(--bg-surface)',
        borderColor: 'var(--border)',
        borderRadius: 4,
        width: 220,
      }}
      onClick={handleClick}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = 'var(--text-primary)'
        e.currentTarget.style.borderColor = 'var(--text-primary)'
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'var(--text-primary)'
        e.currentTarget.style.borderColor = 'var(--text-primary)'
      }}
    >
      <div
        data-transition-circle
        className="relative z-10 flex items-center justify-center overflow-hidden rounded-full mb-4"
        style={{
          background: 'var(--bg-surface)',
          width: 128,
          height: 128,
        }}
      >
        {imageUrl ? (
          <img
            src={imageUrl}
            alt={artist.name}
            className="w-full h-full object-cover"
            loading="lazy"
          />
        ) : (
          <span
            style={{
              fontSize: 44,
              color: 'var(--text-primary)',
              fontFamily: "'Barlow Condensed', sans-serif",
              fontWeight: 700,
              textTransform: 'uppercase',
            }}
          >
            {artist.name.charAt(0)}
          </span>
        )}
      </div>
      <p
        className="relative z-10 text-base truncate text-center"
        style={{
          fontFamily: "'Barlow Condensed', sans-serif",
          fontWeight: 600,
          color: 'var(--text-primary)',
        }}
      >
        {artist.name}
      </p>
      {artist.disambiguation && (
        <p
          className="relative z-10 text-xs truncate text-center mt-1"
          style={{
            fontFamily: "'Barlow Semi Condensed', sans-serif",
            color: 'var(--text-primary)',
          }}
        >
          {artist.disambiguation}
        </p>
      )}
      <div className="flex gap-2 mt-2">
        {artist.type && (
          <p
            className="relative z-10 text-xs"
            style={{
              fontFamily: "'Barlow Semi Condensed', sans-serif",
              color: 'var(--text-primary)',
            }}
          >
            {artist.type}
          </p>
        )}
        {artist.country && (
          <p
            className="relative z-10 text-xs"
            style={{
              fontFamily: "'Barlow Semi Condensed', sans-serif",
              color: 'var(--text-primary)',
            }}
          >
            {artist.country}
          </p>
        )}
      </div>
    </div>
  )
}
