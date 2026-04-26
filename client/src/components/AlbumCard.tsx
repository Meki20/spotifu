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
        background: '#1A1210',
        borderColor: '#3D2820',
        borderRadius: 4,
      }}
      onClick={() => onClick(album.id)}
      onContextMenu={onContextMenu ? (e) => onContextMenu(e, album) : undefined}
      onMouseEnter={(e) => {
        onMouseEnter?.()
        e.currentTarget.style.background = '#231815'
        e.currentTarget.style.borderColor = '#b4003e'
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = '#1A1210'
        e.currentTarget.style.borderColor = '#3D2820'
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
        style={{ background: '#231815' }}
      >
        {album.cover ? (
          <img src={album.cover} alt={album.title} className="w-full h-full object-cover" loading="lazy" />
        ) : (
          <span style={{ fontSize: 16, color: '#4A413C' }}>▦</span>
        )}
      </div>
      <p
        className="relative z-10 text-sm truncate"
        style={{ fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 600, color: '#E8DDD0' }}
      >
        {album.title}
      </p>
      <p
        className="relative z-10 text-sm truncate mt-0.5"
        style={{ fontFamily: "'Barlow Semi Condensed', sans-serif", color: '#9A8E84' }}
      >
        {album.artist}
      </p>
      {year && (
        <p
          className="relative z-10 text-xs mt-1"
          style={{ fontFamily: "'Barlow Semi Condensed', sans-serif", color: '#4A413C' }}
        >
          {year}
        </p>
      )}
    </div>
  )
}
