import { Outlet, Link, useLocation } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import PlayerBar from './PlayerBar'
import NotificationCenter from './NotificationCenter'
import QueuePanel from './QueuePanel'
import { useAudioPlayer } from '../hooks/useAudioPlayer'
import { ChevronLeft, ChevronRight, Home, Library, Search, Settings, Download, Globe } from 'lucide-react'
import { useAuthStore } from '../stores/authStore'
import { usePrefetchSettingsStore } from '../stores/prefetchSettingsStore'
import { authFetch } from '../api'
import { fetchPlaylistsList, fetchAutoPlaylistsList } from '../api/playlists'
import { useEffect, useState } from 'react'

const QUEUE_MIN_WIDTH = 200
const QUEUE_DEFAULT_WIDTH = 320
const QUEUE_MAX_WIDTH = 480

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
  const username = useAuthStore((s) => s.username)
  const [collapsed, setCollapsed] = useState(false)
  const [queuePanelWidth, setQueuePanelWidth] = useState(QUEUE_DEFAULT_WIDTH)
  const [queuePanelClosed, setQueuePanelClosed] = useState(false)

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
    try {
      const w = localStorage.getItem('spotifu.queuePanelWidth')
      if (w) {
        const parsed = Number(w)
        if (!isNaN(parsed) && parsed >= QUEUE_MIN_WIDTH && parsed <= QUEUE_MAX_WIDTH) {
          // eslint-disable-next-line react-hooks/set-state-in-effect
          setQueuePanelWidth(parsed)
        }
      }
      const c = localStorage.getItem('spotifu.queuePanelClosed')
      if (c === '1') setQueuePanelClosed(true)
    } catch {
      // ignore
    }
  }, [])

  const saveQueuePanelWidth = (width: number) => {
    try {
      localStorage.setItem('spotifu.queuePanelWidth', String(width))
    } catch {
      // ignore
    }
  }

  const saveQueuePanelClosed = (closed: boolean) => {
    try {
      localStorage.setItem('spotifu.queuePanelClosed', closed ? '1' : '0')
    } catch {
      // ignore
    }
  }

  useEffect(() => {
    const compute = () => {
      const appW = window.innerWidth || 0
      const screenW = window.screen?.availWidth || window.screen?.width || 0
      const widerThanHalfScreen = screenW > 0 ? appW > screenW * 0.7 : appW >= 1100
      if (!widerThanHalfScreen && !collapsed) {
        // Auto-close queue panel on narrow screens
        if (!queuePanelClosed) {
          setQueuePanelClosed(true)
          saveQueuePanelClosed(true)
        }
      }
    }
    compute()
    window.addEventListener('resize', compute)
    return () => window.removeEventListener('resize', compute)
  }, [collapsed, queuePanelClosed])

  useEffect(() => {
    document.documentElement.dataset.sidebarCollapsed = collapsed ? '1' : '0'
    document.documentElement.dataset.queueVisible = (!queuePanelClosed).toString()
  }, [collapsed, queuePanelClosed])

  useEffect(() => {
    const handler = () => {
      if (queuePanelClosed) {
        setQueuePanelClosed(false)
        setQueuePanelWidth(QUEUE_DEFAULT_WIDTH)
        saveQueuePanelClosed(false)
        saveQueuePanelWidth(QUEUE_DEFAULT_WIDTH)
      } else {
        setQueuePanelClosed(true)
        saveQueuePanelClosed(true)
      }
    }
    window.addEventListener('spotifu:toggle-queue', handler)
    return () => window.removeEventListener('spotifu:toggle-queue', handler)
  }, [queuePanelClosed])

  const { data: sidebarPlaylists } = useQuery({
    queryKey: ['playlists'],
    queryFn: fetchPlaylistsList,
    enabled: !!token,
  })

  const { data: autoPlaylists } = useQuery({
    queryKey: ['auto-playlists'],
    queryFn: fetchAutoPlaylistsList,
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

  type SidebarItem = { id: number; title: string; cover_image_url: string | null; href: string }
  const sidebarItems: SidebarItem[] = [
    ...(sidebarPlaylists ?? []).map((pl) => ({
      id: pl.id,
      title: pl.title,
      cover_image_url: pl.cover_image_url ?? null,
      href: `/playlist/${pl.id}`,
    })),
    ...(autoPlaylists ?? [])
      .filter((ap) => ap.is_enabled && ap.last_generated_at)
      .map((ap) => ({
        id: ap.id,
        title: ap.name,
        cover_image_url: ap.cover_url ?? null,
        href: `/auto-playlist/${ap.id}`,
      })),
  ]

  function navActive(href: string) {
    if (href === '/') return location.pathname === '/'
    if (href === '/library') {
      return location.pathname === '/library' || location.pathname.startsWith('/playlist/')
    }
    return location.pathname === href || location.pathname.startsWith(`${href}/`)
  }

  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden">
      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar */}
        <aside
          className="flex flex-col h-full relative shrink-0 overflow-hidden"
          style={{
            width: sidebarWidthPx,
            background: 'var(--bg-surface)',
            borderRight: '1px solid var(--border)',
            transition: 'width 220ms cubic-bezier(0.2, 0.9, 0.2, 1)',
            willChange: 'width',
          }}
        >
          {/* Circuit pattern overlay */}
          <div
            className="absolute inset-0 pointer-events-none opacity-4"
            style={{
              backgroundImage: `radial-gradient(circle, var(--border) 1px, transparent 1px), linear-gradient(var(--border-subtle) 1px, transparent 1px), linear-gradient(90deg, var(--border-subtle) 1px, transparent 1px)`,
              backgroundSize: '24px 24px',
            }}
          />

          <div className="relative z-10 flex flex-col h-full overflow-hidden">
            {/* Logo / toggle */}
            <div
              className="pt-4 pb-3"
              style={{
                borderBottom: '1px solid var(--border-subtle)',
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
                    className="w-9 h-9 rounded flex items-center justify-center transition-colors hover:border-[var(--accent)]"
                    style={{
                      border: '1px solid var(--border)',
                      background: 'transparent',
                      color: 'var(--text-primary)',
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
                    <div
                      className="text-2xl font-bold tracking-wide"
                      style={{
                        fontFamily: "'Barlow Condensed', sans-serif",
                        fontWeight: 800,
                        textTransform: 'uppercase',
                        letterSpacing: '0.05em',
                        color: 'var(--text-primary)',
                        lineHeight: 1,
                        whiteSpace: 'nowrap',
                      }}
                    >
                      Spoti<span style={{ color: 'var(--text-primary)' }}>FU</span>
                    </div>
                    <button
                      type="button"
                      onClick={() => setCollapsed(true)}
                      className="ml-auto w-9 h-9 rounded flex items-center justify-center transition-colors hover:border-[var(--accent)]"
                      style={{
                        border: '1px solid var(--border)',
                        background: 'transparent',
                        color: 'var(--text-primary)',
                      }}
                      aria-label="Collapse sidebar"
                      title="Collapse"
                    >
                      <ChevronLeft size={18} />
                    </button>
                  </div>
                  <div
                    className="y2k-only"
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: 10,
                      letterSpacing: '0.3em',
                      color: 'var(--text-secondary)',
                      marginTop: 3,
                    }}
                  >
                    セルフィー
                  </div>
                  <div
                    className="y2k-hidden text-sm mt-1"
                    style={{ fontFamily: "'Barlow Semi Condensed', sans-serif", color: 'var(--text-primary)', letterSpacing: '0.05em' }}
                  >
                    local music · soulseek
                  </div>
                </>
              )}
            </div>

            {/* Connection status panel */}
            {!collapsed && (
              <div className="mx-3 mt-3 tf tf-brackets" style={{ padding: 10 }}>
                <div className="flex items-center gap-2.5">
                  <div
                    style={{
                      border: '1px solid var(--border-subtle)',
                      borderRadius: 2,
                      padding: 6,
                      display: 'grid',
                      placeItems: 'center',
                      flexShrink: 0,
                    }}
                  >
                    <Globe size={18} style={{ color: 'var(--text-secondary)' }} />
                  </div>
                  <div
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: 9,
                      letterSpacing: '0.14em',
                      textTransform: 'uppercase',
                      lineHeight: 1.8,
                      color: 'var(--text-secondary)',
                      minWidth: 0,
                    }}
                  >
                    <div style={{ color: 'var(--text-faint)' }}>Connected to</div>
                    <div>Soulseek // Local Network</div>
                    <div className="truncate">User: @{username ?? 'unknown'}</div>
                  </div>
                </div>
              </div>
            )}

            {/* Nav */}
            <nav className="px-0 pt-3 pb-1" aria-label="Navigation">
              <div
                className="px-4 mb-1.5 text-sm tracking-widest"
                style={{
                  fontFamily: "'Barlow Condensed', sans-serif",
                  fontWeight: 700,
                  textTransform: 'uppercase',
                  letterSpacing: '0.15em',
                  color: 'var(--section-title-color, var(--text-primary))',
                  opacity: collapsed ? 0 : 1,
                  transform: collapsed ? 'translateX(-6px)' : 'translateX(0)',
                  transition: 'opacity 120ms ease, transform 220ms cubic-bezier(0.2, 0.9, 0.2, 1)',
                  pointerEvents: collapsed ? 'none' : 'auto',
                }}
              >
                Navigate
              </div>
              <div className={collapsed ? undefined : 'flex flex-col gap-1.5 px-3'}>
                {NAV_ITEMS.map((item) => {
                  const active = navActive(item.id)
                  if (collapsed) {
                    return (
                      <Link
                        key={item.id}
                        to={item.id}
                        className="flex items-center cursor-pointer transition-all duration-150"
                        style={{
                          background: active ? 'color-mix(in srgb, var(--accent) 0.12, transparent)' : 'transparent',
                          borderLeft: active ? '2px solid var(--accent)' : '2px solid transparent',
                          paddingLeft: 0,
                          paddingRight: 0,
                          paddingTop: 10,
                          paddingBottom: 10,
                          justifyContent: 'center',
                          gap: 0,
                          width: '100%',
                        }}
                        title={item.label}
                        aria-label={item.label}
                      >
                        <item.icon
                          size={22}
                          className="w-4 h-4"
                          style={{ color: 'var(--text-primary)' }}
                        />
                      </Link>
                    )
                  }
                  return (
                    <Link
                      key={item.id}
                      to={item.id}
                      className="tf tf-brackets flex items-center cursor-pointer"
                      style={{
                        gap: 12,
                        padding: '7px 12px',
                        borderColor: active ? 'var(--accent)' : undefined,
                        background: active ? 'color-mix(in srgb, var(--accent) 0.08, transparent)' : undefined,
                        textDecoration: 'none',
                      }}
                    >
                      <item.icon
                        size={15}
                        style={{ color: active ? 'var(--accent)' : 'var(--text-secondary)', flexShrink: 0 }}
                      />
                      <span
                        className="text-sm"
                        style={{
                          fontFamily: "'Barlow Semi Condensed', sans-serif",
                          textTransform: 'uppercase',
                          letterSpacing: '0.12em',
                          color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {item.label}
                      </span>
                      {active && (
                        <span
                          className="tfx"
                          style={{ marginLeft: 'auto', color: 'var(--accent)', fontSize: 10 }}
                        >
                          ✕
                        </span>
                      )}
                    </Link>
                  )
                })}
              </div>
            </nav>

            <div className="mx-4 my-2" style={{ height: '1px', background: 'var(--bg-surface)' }} />

            {/* Playlists */}
            <div className="flex-1 overflow-y-auto overflow-x-hidden pb-4">
              <div
                className="px-4 mb-1.5 text-sm tracking-widest flex items-center"
                style={{
                  fontFamily: "'Barlow Condensed', sans-serif",
                  fontWeight: 700,
                  textTransform: 'uppercase',
                  letterSpacing: '0.15em',
                  color: 'var(--section-title-color, var(--text-primary))',
                  opacity: collapsed ? 0 : 1,
                  transform: collapsed ? 'translateX(-6px)' : 'translateX(0)',
                  transition: 'opacity 120ms ease, transform 220ms cubic-bezier(0.2, 0.9, 0.2, 1)',
                  pointerEvents: collapsed ? 'none' : 'auto',
                }}
              >
                Playlists
                <span className="tfx" style={{ marginLeft: 'auto' }}>80BJ93X</span>
              </div>
              <div
                className={collapsed ? 'flex flex-col items-center gap-2 px-2 pt-1' : 'flex flex-col gap-1.5 px-3'}
                style={{ transition: 'all 220ms cubic-bezier(0.2, 0.9, 0.2, 1)' }}
              >
                {sidebarItems.map((pl) => {
                  const href = pl.href
                  const active = location.pathname === href
                  const cover = pl.cover_image_url
                  const tile = playlistTileSize
                  const coverSize = collapsed ? tile : 26
                  if (collapsed) {
                    return (
                      <Link
                        key={pl.id}
                        to={href}
                        className="relative cursor-pointer min-w-0 overflow-hidden focus:outline-none"
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          gap: 0,
                          padding: 0,
                          width: tile,
                          height: tile,
                          borderRadius: 6,
                          background: active ? 'color-mix(in srgb, var(--accent) 0.12, transparent)' : 'var(--bg-surface)',
                          border: 'none',
                          boxShadow: `inset 0 0 0 1px ${active ? 'color-mix(in srgb, var(--accent) 0.55, transparent)' : 'var(--text-primary)'}`,
                          transition: 'width 220ms cubic-bezier(0.2, 0.9, 0.2, 1), height 220ms cubic-bezier(0.2, 0.9, 0.2, 1), padding 220ms cubic-bezier(0.2, 0.9, 0.2, 1), background 120ms ease, border-color 120ms ease',
                        }}
                        title={pl.title}
                        aria-label={pl.title}
                      >
                        <div
                          className="relative shrink-0 overflow-hidden"
                          style={{
                            width: coverSize,
                            height: coverSize,
                            borderRadius: 4,
                            background: 'var(--bg-surface)',
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
                                background: 'var(--bg-surface)',
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
                                color: 'var(--text-primary)',
                                fontSize: 16,
                                letterSpacing: '0.06em',
                              }}
                            >
                              {playlistInitial(pl.title)}
                            </span>
                          )}
                        </div>
                      </Link>
                    )
                  }
                  return (
                    <Link
                      key={pl.id}
                      to={href}
                      className="tf tf-brackets relative cursor-pointer min-w-0 overflow-hidden focus:outline-none flex items-center"
                      style={{
                        gap: 10,
                        padding: '6px 10px',
                        borderColor: active ? 'var(--accent)' : undefined,
                        background: active ? 'color-mix(in srgb, var(--accent) 0.08, transparent)' : undefined,
                        textDecoration: 'none',
                      }}
                      title={pl.title}
                    >
                      {cover && (
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
                      <div
                        className="relative shrink-0 overflow-hidden"
                        style={{
                          width: coverSize,
                          height: coverSize,
                          borderRadius: 2,
                          border: '1px solid var(--border-subtle)',
                          background: 'var(--bg-surface)',
                          display: 'grid',
                          placeItems: 'center',
                        }}
                      >
                        {cover ? (
                          <img
                            src={cover}
                            alt=""
                            className="w-full h-full object-cover block"
                            loading="lazy"
                            style={{
                              background: 'var(--bg-surface)',
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
                              color: 'var(--text-primary)',
                              fontSize: 12,
                              letterSpacing: '0.06em',
                            }}
                          >
                            {playlistInitial(pl.title)}
                          </span>
                        )}
                      </div>
                      <span
                        className="relative z-10 text-xs truncate min-w-0 flex-1"
                        style={{
                          fontFamily: "'Barlow Semi Condensed', sans-serif",
                          textTransform: 'uppercase',
                          letterSpacing: '0.1em',
                          color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {pl.title}
                      </span>
                    </Link>
                  )
                })}
              </div>
            </div>

            {/* Decorative bottom block */}
            {!collapsed && (
              <div className="y2k-only px-3 pb-3 pt-2">
                <div style={{ borderTop: '1px solid var(--border-subtle)', marginBottom: 10 }} />
                <div
                  className="tfxb"
                  style={{ marginBottom: 8, fontSize: 13, letterSpacing: '0.22em', color: 'var(--text-secondary)', fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 800 }}
                >
                  SpotiFU<span style={{ textDecoration: 'line-through', opacity: 0.5 }}> Net</span>work
                </div>
                <div className="tf" style={{ padding: 8, display: 'flex', alignItems: 'center', gap: 10 }}>
                  <Globe size={22} style={{ color: 'var(--text-faint)', flexShrink: 0 }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="tfxb">Priority</div>
                    <div
                      style={{
                        fontFamily: "'Barlow Condensed', sans-serif",
                        fontWeight: 800,
                        fontSize: 26,
                        lineHeight: 1,
                        color: 'var(--text-primary)',
                      }}
                    >
                      4
                    </div>
                  </div>
                  <div
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: 18,
                      color: 'var(--text-secondary)',
                      letterSpacing: '0.1em',
                    }}
                  >
                    058
                  </div>
                </div>
                <div className="tbarcode" style={{ marginTop: 8 }} />
                <div className="tfxb" style={{ marginTop: 6, textAlign: 'right' }}>// User data encrypted</div>
              </div>
            )}
          </div>
        </aside>

        {/* Main content */}
        <main className="flex-1 overflow-y-auto">
          <Outlet />
        </main>

        {/* Right queue strip (resizable) */}
        <QueuePanel
          width={queuePanelClosed ? 0 : queuePanelWidth}
          onWidthChange={(w) => {
            setQueuePanelWidth(w)
            saveQueuePanelWidth(w)
            if (w <= QUEUE_MIN_WIDTH) {
              setQueuePanelClosed(true)
              saveQueuePanelClosed(true)
            } else {
              setQueuePanelClosed(false)
              saveQueuePanelClosed(false)
            }
          }}
          onClose={() => {
            setQueuePanelClosed(true)
            saveQueuePanelClosed(true)
          }}
          onOpen={() => {
            setQueuePanelClosed(false)
            setQueuePanelWidth(QUEUE_DEFAULT_WIDTH)
            saveQueuePanelClosed(false)
            saveQueuePanelWidth(QUEUE_DEFAULT_WIDTH)
          }}
          maxWidth={QUEUE_MAX_WIDTH}
          minWidth={QUEUE_MIN_WIDTH}
        />
      </div>

      <NotificationCenter />
      <PlayerBar />
    </div>
  )
}