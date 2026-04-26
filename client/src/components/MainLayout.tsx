import { Outlet, Link, useLocation } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import PlayerBar from './PlayerBar'
import { useAudioPlayer } from '../hooks/useAudioPlayer'
import { Home, Search, Library, Settings } from 'lucide-react'
import { useAuthStore } from '../stores/authStore'
import { fetchPlaylistsList } from '../api/playlists'

const NAV_ITEMS = [
  { id: '/', icon: Home, label: 'Home' },
  { id: '/search', icon: Search, label: 'Search' },
  { id: '/library', icon: Library, label: 'Library' },
  { id: '/settings', icon: Settings, label: 'Settings' },
]

export default function MainLayout() {
  useAudioPlayer()
  const location = useLocation()
  const token = useAuthStore((s) => s.token)
  const { data: sidebarPlaylists } = useQuery({
    queryKey: ['playlists'],
    queryFn: fetchPlaylistsList,
    enabled: !!token,
  })

  function navActive(href: string) {
    if (href === '/') return location.pathname === '/'
    if (href === '/library') {
      return location.pathname === '/library' || location.pathname.startsWith('/playlist/')
    }
    return location.pathname === href || location.pathname.startsWith(`${href}/`)
  }

  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden bg-[#0C0906]">
      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar */}
        <aside
          className="w-60 min-w-60 flex flex-col h-full relative shrink-0"
          style={{ background: '#231815', borderRight: '1px solid #3D2820' }}
        >
          {/* Grain overlay */}
          <div
            className="absolute inset-0 pointer-events-none opacity-7"
            style={{
              backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='200' height='200'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='200' height='200' filter='url(%23n)'/%3E%3C/svg%3E")`,
              backgroundSize: '180px 180px',
            }}
          />
          {/* Circuit pattern overlay */}
          <div
            className="absolute inset-0 pointer-events-none opacity-4"
            style={{
              backgroundImage: `radial-gradient(circle, #3D2820 1px, transparent 1px), linear-gradient(#261A14 1px, transparent 1px), linear-gradient(90deg, #261A14 1px, transparent 1px)`,
              backgroundSize: '24px 24px',
            }}
          />

          <div className="relative z-10 flex flex-col h-full overflow-hidden">
            {/* Logo */}
            <div className="px-4 pt-4 pb-3" style={{ borderBottom: '1px solid #261A14' }}>
              <div className="flex items-center gap-2">
                <img
                  src="/assets/brand/polly_512x512.png"
                  alt="SpotiFU icon"
                  className="w-7 h-7 rounded-sm shrink-0"
                  style={{ imageRendering: 'auto' }}
                />
                <div
                  className="text-2xl font-bold tracking-wide"
                  style={{
                    fontFamily: "'Barlow Condensed', sans-serif",
                    fontWeight: 800,
                    textTransform: 'uppercase',
                    letterSpacing: '0.05em',
                    color: '#E8DDD0',
                    lineHeight: 1,
                  }}
                >
                  Spoti<span style={{ color: '#b4003e' }}>FU</span>
                </div>
              </div>
              <div
                className="text-sm mt-1"
                style={{ fontFamily: "'Barlow Semi Condensed', sans-serif", color: '#4A413C', letterSpacing: '0.05em' }}
              >
                local music · soulseek
              </div>
            </div>

            {/* Nav */}
            <div className="px-0 pt-3 pb-1">
              <div
                className="px-4 mb-1 text-sm tracking-widest"
                style={{ fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.15em', color: '#4A413C' }}
              >
                Navigate
              </div>
              {NAV_ITEMS.map((item) => {
                const active = navActive(item.id)
                return (
                  <Link
                    key={item.id}
                    to={item.id}
                    className="flex items-center gap-3 px-4 py-1.5 cursor-pointer transition-all duration-150"
                    style={{
                      background: active ? 'rgba(180, 0, 62, 0.12)' : 'transparent',
                      borderLeft: active ? '2px solid #b4003e' : '2px solid transparent',
                    }}
                  >
                    <item.icon
                      size={16}
                      className="w-4 h-4"
                      style={{ color: active ? '#b4003e' : '#9A8E84' }}
                    />
                    <span
                      className="text-sm"
                      style={{
                        fontFamily: "'Barlow Semi Condensed', sans-serif",
                        color: active ? '#E8DDD0' : '#9A8E84',
                      }}
                    >
                      {item.label}
                    </span>
                  </Link>
                )
              })}
            </div>

            <div className="mx-4 my-2" style={{ height: '1px', background: '#261A14' }} />

            {/* Playlists */}
            <div className="flex-1 overflow-y-auto overflow-x-hidden pb-4">
              <div
                className="px-4 mb-1 text-sm tracking-widest"
                style={{ fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.15em', color: '#4A413C' }}
              >
                Playlists
              </div>
              <div className="space-y-0.5">
                {sidebarPlaylists?.map((pl) => {
                  const href = `/playlist/${pl.id}`
                  const active = location.pathname === href
                  return (
                    <Link
                      key={pl.id}
                      to={href}
                      className="relative flex items-center gap-2 px-4 py-1.5 cursor-pointer transition-all duration-150 min-w-0 overflow-hidden rounded-r"
                      style={{
                        background: active ? 'rgba(180, 0, 62, 0.12)' : 'transparent',
                        borderLeft: active ? '2px solid #b4003e' : '2px solid transparent',
                      }}
                      title={pl.title}
                    >
                      {pl.cover_image_url && (
                        <div
                          className="absolute inset-0 pointer-events-none rounded-r"
                          style={{
                            backgroundImage: `url(${pl.cover_image_url})`,
                            backgroundSize: 'cover',
                            backgroundPosition: 'center',
                            opacity: 0.12,
                          }}
                        />
                      )}
                      <span
                        className="relative z-10 text-xs truncate min-w-0 flex-1"
                        style={{
                          fontFamily: "'Barlow Semi Condensed', sans-serif",
                          color: active ? '#E8DDD0' : '#9A8E84',
                        }}
                      >
                        {pl.title}
                      </span>
                    </Link>
                  )
                })}
              </div>
            </div>
          </div>
        </aside>

        {/* Main content */}
        <main className="flex-1 overflow-y-auto bg-[#0C0906]">
          <Outlet />
        </main>
      </div>

      <PlayerBar />
    </div>
  )
}