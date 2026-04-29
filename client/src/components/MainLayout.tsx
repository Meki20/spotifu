import { Outlet, Link, useLocation } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import PlayerBar from './PlayerBar'
import NotificationCenter from './NotificationCenter'
import QueuePanel from './QueuePanel'
import { useAudioPlayer } from '../hooks/useAudioPlayer'
import { ChevronLeft, ChevronRight, Home, Library, Search, Settings, Download } from 'lucide-react'
import { useAuthStore } from '../stores/authStore'
import { usePrefetchSettingsStore } from '../stores/prefetchSettingsStore'
import { authFetch } from '../api'
import { fetchPlaylistsList } from '../api/playlists'
import { useEffect, useState } from 'react'

const NAV_ITEMS = [
  { id: '/', icon: Home, label: 'Home' },
  { id: '/search', icon: Search, label: 'Search' },
  { id: '/library', icon: Library, label: 'Library' },
  { id: '/soulseek', icon: Download, label: 'Soulseek' },
  { id: '/settings', icon: Settings, label: 'Settings' },
]

export default function MainLayout() {
  useAudioPlayer()
  const location = useLocation()
  const token = useAuthStore((s) => s.token)
  const [collapsed, setCollapsed] = useState(false)
  const [queueVisible, setQueueVisible] = useState(true)

  useEffect(() => {
    try {
      const v = localStorage.getItem('spotifu.sidebarCollapsed')
      if (v === '1') setCollapsed(true)
    } catch {
      // ignore
    }
  }, [])

  useEffect(() => {
    try {
      localStorage.setItem('spotifu.sidebarCollapsed', collapsed ? '1' : '0')
    } catch {
      // ignore
    }
  }, [collapsed])

  useEffect(() => {
    const compute = () => {
      const appW = window.innerWidth || 0
      const screenW = window.screen?.availWidth || window.screen?.width || 0
      const widerThanHalfScreen = screenW > 0 ? appW > screenW * 0.7 : appW >= 1100
      setQueueVisible(widerThanHalfScreen || collapsed)
    }
    compute()
    window.addEventListener('resize', compute)
    return () => window.removeEventListener('resize', compute)
  }, [collapsed])

  useEffect(() => {
    document.documentElement.dataset.sidebarCollapsed = collapsed ? '1' : '0'
    document.documentElement.dataset.queueVisible = queueVisible ? '1' : '0'
  }, [collapsed, queueVisible])

  const { data: sidebarPlaylists } = useQuery({
    queryKey: ['playlists'],
    queryFn: fetchPlaylistsList,
    enabled: !!token,
  })

  useEffect(() => {
    if (!token) {
      usePrefetchSettingsStore.getState().resetToDefaults()
      return
    }
    authFetch('/settings/preferences')
      .then((r) => r.json())
      .then((data: { prefetch?: Record<string, unknown> }) => {
        usePrefetchSettingsStore.getState().applyServerPrefetch(data.prefetch)
      })
      .catch(() => {
        /* keep persisted local prefs */
      })
  }, [token])

  const sidebarWidthPx = collapsed ? 60 : 240
  const playlistTileSize = collapsed ? 42 : 0
  const playlistInitial = (title: string) => {
    const t = (title || '').trim()
    return (t[0] || '•').toUpperCase()
  }

  function navActive(href: string) {
    if (href === '/') return location.pathname === '/'
    if (href === '/library') {
      return location.pathname === '/library' || location.pathname.startsWith('/playlist/')
    }
    return location.pathname === href || location.pathname.startsWith(`${href}/`)
  }

  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden bg-[#100B04]">
      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar */}
        <aside
          className="flex flex-col h-full relative shrink-0 overflow-hidden"
          style={{
            width: sidebarWidthPx,
            background: '#231815',
            borderRight: '1px solid #3D2820',
            transition: 'width 220ms cubic-bezier(0.2, 0.9, 0.2, 1)',
            willChange: 'width',
          }}
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
            {/* Logo / toggle */}
            <div
              className="pt-4 pb-3"
              style={{
                borderBottom: '1px solid #261A14',
                paddingLeft: collapsed ? 0 : 16,
                paddingRight: collapsed ? 0 : 16,
                transition: 'padding 220ms cubic-bezier(0.2, 0.9, 0.2, 1)',
              }}
            >
              {collapsed ? (
                <div className="flex flex-col items-center justify-center gap-2">
                  <img
                    src="/assets/brand/polly_512x512.png"
                    alt="SpotiFU icon"
                    className="w-9 h-9 rounded-sm shrink-0"
                    style={{ imageRendering: 'auto' }}
                  />
                  <button
                    type="button"
                    onClick={() => setCollapsed(false)}
                    className="w-9 h-9 rounded flex items-center justify-center transition-colors hover:border-[#b4003e]"
                    style={{
                      border: '1px solid #3D2820',
                      background: 'transparent',
                      color: '#9A8E84',
                    }}
                    aria-label="Expand sidebar"
                    title="Expand"
                  >
                    <ChevronRight size={18} />
                  </button>
                </div>
              ) : (
                <>
                  <div className="flex items-center gap-2">
                    <img
                      src="/assets/brand/polly_512x512.png"
                      alt="SpotiFU icon"
                      className="w-8 h-8 rounded-sm shrink-0"
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
                        whiteSpace: 'nowrap',
                      }}
                    >
                      Spoti<span style={{ color: '#b4003e' }}>FU</span>
                    </div>
                    <button
                      type="button"
                      onClick={() => setCollapsed(true)}
                      className="ml-auto w-9 h-9 rounded flex items-center justify-center transition-colors hover:border-[#b4003e]"
                      style={{
                        border: '1px solid #3D2820',
                        background: 'transparent',
                        color: '#9A8E84',
                      }}
                      aria-label="Collapse sidebar"
                      title="Collapse"
                    >
                      <ChevronLeft size={18} />
                    </button>
                  </div>
                  <div
                    className="text-sm mt-1"
                    style={{ fontFamily: "'Barlow Semi Condensed', sans-serif", color: '#4A413C', letterSpacing: '0.05em' }}
                  >
                    local music · soulseek
                  </div>
                </>
              )}
            </div>

            {/* Nav */}
            <nav className="px-0 pt-3 pb-1" aria-label="Navigation">
              <div
                className="px-4 mb-1 text-sm tracking-widest"
                style={{
                  fontFamily: "'Barlow Condensed', sans-serif",
                  fontWeight: 700,
                  textTransform: 'uppercase',
                  letterSpacing: '0.15em',
                  color: '#4A413C',
                  opacity: collapsed ? 0 : 1,
                  transform: collapsed ? 'translateX(-6px)' : 'translateX(0)',
                  transition: 'opacity 120ms ease, transform 220ms cubic-bezier(0.2, 0.9, 0.2, 1)',
                  pointerEvents: collapsed ? 'none' : 'auto',
                }}
              >
                Navigate
              </div>
              {NAV_ITEMS.map((item) => {
                const active = navActive(item.id)
                return (
                  <Link
                    key={item.id}
                    to={item.id}
                    className="flex items-center cursor-pointer transition-all duration-150"
                    style={{
                      background: active ? 'rgba(180, 0, 62, 0.12)' : 'transparent',
                      borderLeft: active ? '2px solid #b4003e' : '2px solid transparent',
                      paddingLeft: collapsed ? 0 : 16,
                      paddingRight: collapsed ? 0 : 16,
                      paddingTop: collapsed ? 10 : 6,
                      paddingBottom: collapsed ? 10 : 6,
                      justifyContent: collapsed ? 'center' : 'flex-start',
                      gap: collapsed ? 0 : 12,
                      width: '100%',
                    }}
                    title={collapsed ? item.label : undefined}
                    aria-label={collapsed ? item.label : undefined}
                  >
                    <item.icon
                      size={collapsed ? 22 : 16}
                      className="w-4 h-4"
                      style={{ color: active ? '#b4003e' : '#9A8E84' }}
                    />
                    <span
                      className="text-sm"
                      style={{
                        fontFamily: "'Barlow Semi Condensed', sans-serif",
                        color: active ? '#E8DDD0' : '#9A8E84',
                        opacity: collapsed ? 0 : 1,
                        width: collapsed ? 0 : 'auto',
                        overflow: 'hidden',
                        whiteSpace: 'nowrap',
                        transition: 'opacity 120ms ease',
                      }}
                    >
                      {item.label}
                    </span>
                  </Link>
                )
              })}
            </nav>

            <div className="mx-4 my-2" style={{ height: '1px', background: '#261A14' }} />

            {/* Playlists */}
            <div className="flex-1 overflow-y-auto overflow-x-hidden pb-4">
              <div
                className="px-4 mb-1 text-sm tracking-widest"
                style={{
                  fontFamily: "'Barlow Condensed', sans-serif",
                  fontWeight: 700,
                  textTransform: 'uppercase',
                  letterSpacing: '0.15em',
                  color: '#4A413C',
                  opacity: collapsed ? 0 : 1,
                  transform: collapsed ? 'translateX(-6px)' : 'translateX(0)',
                  transition: 'opacity 120ms ease, transform 220ms cubic-bezier(0.2, 0.9, 0.2, 1)',
                  pointerEvents: collapsed ? 'none' : 'auto',
                }}
              >
                Playlists
              </div>
              <div
                className={collapsed ? 'flex flex-col items-center gap-2 px-2 pt-1' : 'space-y-0.5'}
                style={{ transition: 'all 220ms cubic-bezier(0.2, 0.9, 0.2, 1)' }}
              >
                {sidebarPlaylists?.map((pl) => {
                  const href = `/playlist/${pl.id}`
                  const active = location.pathname === href
                  const cover = pl.cover_image_url
                  const tile = playlistTileSize
                  const coverSize = collapsed ? tile : 26
                  return (
                    <Link
                      key={pl.id}
                      to={href}
                      className="relative cursor-pointer min-w-0 overflow-hidden focus:outline-none"
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: collapsed ? 'center' : 'flex-start',
                        gap: collapsed ? 0 : 10,
                        paddingLeft: collapsed ? 0 : 16,
                        paddingRight: collapsed ? 0 : 16,
                        paddingTop: collapsed ? 0 : 6,
                        paddingBottom: collapsed ? 0 : 6,
                        width: collapsed ? tile : '100%',
                        height: collapsed ? tile : 'auto',
                        marginLeft: collapsed ? 0 : undefined,
                        marginRight: collapsed ? 0 : undefined,
                        borderRadius: collapsed ? 6 : 4,
                        background: active ? 'rgba(180, 0, 62, 0.12)' : collapsed ? '#1A1210' : 'transparent',
                        border: 'none',
                        boxShadow: collapsed
                          ? `inset 0 0 0 1px ${active ? 'rgba(180, 0, 62, 0.55)' : '#3D2820'}`
                          : `inset 2px 0 0 0 ${active ? '#b4003e' : 'transparent'}`,
                        transition: 'width 220ms cubic-bezier(0.2, 0.9, 0.2, 1), height 220ms cubic-bezier(0.2, 0.9, 0.2, 1), padding 220ms cubic-bezier(0.2, 0.9, 0.2, 1), background 120ms ease, border-color 120ms ease',
                      }}
                      title={pl.title}
                      aria-label={collapsed ? pl.title : undefined}
                    >
                      {cover && !collapsed && (
                        <div
                          className="absolute inset-0 pointer-events-none"
                          style={{
                            backgroundImage: `url(${cover})`,
                            backgroundSize: 'cover',
                            backgroundPosition: 'center',
                            opacity: 0.12,
                          }}
                        />
                      )}
                      {/* Cover / initial */}
                      <div
                        className="relative shrink-0 overflow-hidden"
                        style={{
                          width: coverSize,
                          height: coverSize,
                          borderRadius: 4,
                          background: '#231815',
                          display: 'grid',
                          placeItems: 'center',
                          transition: 'width 220ms cubic-bezier(0.2, 0.9, 0.2, 1), height 220ms cubic-bezier(0.2, 0.9, 0.2, 1)',
                        }}
                      >
                        {cover ? (
                          <img
                            src={cover}
                            alt=""
                            className="w-full h-full object-cover block"
                            loading="lazy"
                            style={{
                              background: '#1A1210',
                              transform: 'scale(1.015)',
                              transformOrigin: 'center',
                              backfaceVisibility: 'hidden',
                            }}
                          />
                        ) : (
                          <span
                            style={{
                              fontFamily: "'Barlow Condensed', sans-serif",
                              fontWeight: 800,
                              color: '#E8DDD0',
                              fontSize: collapsed ? 16 : 12,
                              letterSpacing: '0.06em',
                            }}
                          >
                            {playlistInitial(pl.title)}
                          </span>
                        )}
                      </div>

                      {/* Expanded-only title */}
                      <span
                        className="relative z-10 text-xs truncate min-w-0 flex-1"
                        style={{
                          fontFamily: "'Barlow Semi Condensed', sans-serif",
                          color: active ? '#E8DDD0' : '#9A8E84',
                          opacity: collapsed ? 0 : 1,
                          width: collapsed ? 0 : 'auto',
                          overflow: 'hidden',
                          whiteSpace: 'nowrap',
                          transition: 'opacity 120ms ease',
                          pointerEvents: collapsed ? 'none' : 'auto',
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
        <main className="flex-1 overflow-y-auto bg-[#100B04]">
          <Outlet />
        </main>

        {/* Right queue strip (reactive, not user-toggleable) */}
        <QueuePanel />
      </div>

      <NotificationCenter />
      <PlayerBar />
    </div>
  )
}