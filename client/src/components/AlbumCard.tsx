const BACKDROP_OPACITY = 0.14

interface AlbumCardProps {
  album: {
    id: string | number
    title: string
    artist: string
    cover: string | null
    release_date?: string
    [key: string]: any
  }
  onClick: (albumId: string | number) => void
  onMouseEnter?: () => void
  onContextMenu?: (e: React.MouseEvent, album: AlbumCardProps['album']) => void
}

export default function AlbumCard({ album, onClick, onMouseEnter, onContextMenu }: AlbumCardProps) {
  const year = album.release_date ? album.release_date.split('-')[0] : ''

  return (
    <div
      className="p-4 rounded cursor-pointer border transition-all duration-150 relative overflow-hidden"
      style={{
        background: 'var(--bg-surface)',
        borderColor: 'var(--border)',
        borderRadius: 4,
      }}
      onClick={() => onClick(album.id)}
      onContextMenu={onContextMenu ? (e) => onContextMenu(e, album) : undefined}
      onMouseEnter={(e) => {
        onMouseEnter?.()
        e.currentTarget.style.background = 'var(--text-primary)'
        e.currentTarget.style.borderColor = 'var(--text-primary)'
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'var(--text-primary)'
        e.currentTarget.style.borderColor = 'var(--text-primary)'
      }}
    >
      {album.cover && (
        <div
          className="absolute inset-0 pointer-events-none"
          style={{
            backgroundImage: `url(${album.cover})`,
            backgroundSize: 'cover',
            backgroundPosition: 'center',
            opacity: BACKDROP_OPACITY,
          }}
        />
      )}
      <div
        className="relative z-10 w-full aspect-square flex items-center justify-center overflow-hidden rounded mb-3"
        style={{ background: 'var(--bg-surface)' }}
      >
        {album.cover ? (
          <img src={album.cover} alt={album.title} className="w-full h-full object-cover" loading="lazy" />
        ) : (
          <span style={{ fontSize: 16, color: 'var(--text-primary)' }}>▦</span>
        )}
      </div>
      <p
        className="relative z-10 text-sm truncate"
        style={{ fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 600, color: 'var(--text-primary)' }}
      >
        {album.title}
      </p>
      <p
        className="relative z-10 text-sm truncate mt-0.5"
        style={{ fontFamily: "'Barlow Semi Condensed', sans-serif", color: 'var(--text-primary)' }}
      >
        {album.artist}
      </p>
      {year && (
        <p
          className="relative z-10 text-xs mt-1"
          style={{ fontFamily: "'Barlow Semi Condensed', sans-serif", color: 'var(--text-primary)' }}
        >
          {year}
        </p>
      )}
    </div>
  )
}
