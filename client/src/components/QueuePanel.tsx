import { X, ChevronLeft, ChevronRight, ListMusic } from 'lucide-react'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { usePlayerStore, type Track } from '../stores/playerStore'
import * as controller from '../playback/controller'

function TrackRow({
  track,
  right,
  onClick,
  onRemove,
}: {
  track: Track
  right?: ReactNode
  onClick?: () => void
  onRemove?: () => void
}) {
  return (
    <div
      className="relative group flex items-center gap-3 px-3 py-2 rounded-md cursor-pointer"
      onClick={onClick}
      style={{
        background: 'rgba(26,18,16,0.7)',
        border: '1px solid rgba(61,40,32,0.65)',
      }}
    >
      <div
        className="shrink-0 rounded-md overflow-hidden"
        style={{ width: 30, height: 30, background: '#231815' }}
      >
        {track.album_cover ? (
          <img src={track.album_cover} alt="" className="w-full h-full object-cover block" loading="lazy" />
        ) : null}
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-xs font-semibold truncate" style={{ fontFamily: "'Barlow Semi Condensed', sans-serif", color: '#E8DDD0' }}>
          {track.title}
        </div>
        <div className="text-[11px] truncate" style={{ fontFamily: "'Space Mono', monospace", color: 'rgba(232,221,208,0.65)' }}>
          {track.artist}
        </div>
      </div>
      <div className="shrink-0 flex items-center gap-2">
        {right}
        {onRemove && (
          <button
            type="button"
            className="opacity-0 group-hover:opacity-100 transition-opacity rounded-md grid place-items-center"
            onClick={(e) => {
              e.stopPropagation()
              onRemove()
            }}
            style={{ width: 24, height: 24, color: '#9A8E84', background: 'rgba(0,0,0,0.12)' }}
            aria-label="Remove from queue"
          >
            <X size={14} />
          </button>
        )}
      </div>
    </div>
  )
}

export type QueuePanelProps = {
  collapsed?: boolean
  setCollapsed?: (v: boolean) => void
}

const QueuePanel = ({ collapsed: collapsedProp, setCollapsed: setCollapsedProp }: QueuePanelProps) => {
  const [collapsedLocal, setCollapsedLocal] = useState(false)
  const collapsed = collapsedProp ?? collapsedLocal
  const setCollapsed = setCollapsedProp ?? ((v: boolean) => setCollapsedLocal(v))

  useEffect(() => {
    if (collapsedProp !== undefined) return
    try {
      const v = localStorage.getItem('spotifu.queueCollapsed')
      if (v === '1') setCollapsedLocal(true)
    } catch {
      // ignore
    }
  }, [collapsedProp])

  useEffect(() => {
    if (collapsedProp !== undefined) return
    try {
      localStorage.setItem('spotifu.queueCollapsed', collapsedLocal ? '1' : '0')
    } catch {
      // ignore
    }
  }, [collapsedLocal, collapsedProp])
  const {
    currentTrack,
    userQueue,
    systemLookahead,
    systemSource,
    systemList,
    systemIndex,
  } = usePlayerStore(
    useShallow((s) => ({
      currentTrack: s.currentTrack,
      userQueue: s.userQueue,
      systemLookahead: s.systemLookahead,
      systemSource: s.systemSource,
      systemList: s.systemList,
      systemIndex: s.systemIndex,
    })),
  )

  const sourceLabel = useMemo(() => {
    if (!systemSource) return 'Next from system'
    if (systemSource.kind === 'album') return systemSource.title ? `Next from album • ${systemSource.title}` : 'Next from album'
    if (systemSource.kind === 'playlist') return systemSource.title ? `Next from playlist • ${systemSource.title}` : 'Next from playlist'
    if (systemSource.kind === 'recently-added') return 'Next from recently added'
    if (systemSource.kind === 'recently-played') return 'Next from recently played'
    if (systemSource.kind === 'search') return `Next from search • ${systemSource.query}`
    return systemSource.title ? `Next from • ${systemSource.title}` : 'Next from system'
  }, [systemSource])

  const widthPx = collapsed ? 60 : 320

  return (
    <div
      className="flex flex-col h-full relative shrink-0 overflow-hidden"
      style={{
        width: widthPx,
        background: '#231815',
        borderLeft: '1px solid #3D2820',
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
        {/* Header / toggle */}
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
              <div
                className="w-9 h-9 rounded-sm grid place-items-center"
                style={{ border: '1px solid #3D2820', background: 'transparent', color: '#9A8E84' }}
                aria-hidden
              >
                <ListMusic size={18} />
              </div>
              <button
                type="button"
                onClick={() => setCollapsed(false)}
                className="w-9 h-9 rounded flex items-center justify-center transition-colors hover:border-[#b4003e]"
                style={{ border: '1px solid #3D2820', background: 'transparent', color: '#9A8E84' }}
                aria-label="Expand queue"
                title="Expand"
              >
                <ChevronLeft size={18} />
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <div
                className="w-8 h-8 rounded-sm grid place-items-center shrink-0"
                style={{ border: '1px solid #3D2820', color: '#9A8E84' }}
                aria-hidden
              >
                <ListMusic size={16} />
              </div>
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
                Queue
              </div>
              <button
                type="button"
                onClick={() => setCollapsed(true)}
                className="ml-auto w-9 h-9 rounded flex items-center justify-center transition-colors hover:border-[#b4003e]"
                style={{ border: '1px solid #3D2820', background: 'transparent', color: '#9A8E84' }}
                aria-label="Collapse queue"
                title="Collapse"
              >
                <ChevronRight size={18} />
              </button>
            </div>
          )}
        </div>

        {/* Body */}
        <div
          style={{
            opacity: collapsed ? 0 : 1,
            pointerEvents: collapsed ? 'none' : 'auto',
            transition: 'opacity 120ms ease',
          }}
        >
        <div className="px-4 pb-3 pt-3">
          <div className="text-xs mb-2" style={{ fontFamily: "'Barlow Condensed', sans-serif", color: '#4A413C', letterSpacing: '0.14em', fontWeight: 800, textTransform: 'uppercase' }}>
            Now playing
          </div>
          {currentTrack ? (
            <TrackRow
              track={currentTrack}
              right={
                <div className="text-[10px]" style={{ fontFamily: "'Space Mono', monospace", color: 'rgba(232,221,208,0.5)' }}>
                  now
                </div>
              }
            />
          ) : (
            <div className="text-xs" style={{ fontFamily: "'Space Mono', monospace", color: 'rgba(232,221,208,0.45)' }}>
              Nothing playing
            </div>
          )}
        </div>

        <div className="px-4 pb-3">
          <div className="flex items-center justify-between mb-2">
            <div className="text-xs" style={{ fontFamily: "'Barlow Condensed', sans-serif", color: '#4A413C', letterSpacing: '0.14em', fontWeight: 800, textTransform: 'uppercase' }}>
              Up next (your queue)
            </div>
            <button
              type="button"
              onClick={() => controller.clearUserQueue()}
              className="text-[11px] px-2 py-1 rounded-md"
              style={{ fontFamily: "'Barlow Condensed', sans-serif", letterSpacing: '0.12em', textTransform: 'uppercase', color: '#9A8E84', background: 'rgba(26,18,16,0.6)', border: '1px solid rgba(61,40,32,0.75)' }}
              disabled={userQueue.length === 0}
              title="Clear your queue"
            >
              Clear
            </button>
          </div>
          <div className="flex flex-col gap-2">
            {userQueue.length === 0 ? (
              <div className="text-xs" style={{ fontFamily: "'Space Mono', monospace", color: 'rgba(232,221,208,0.45)' }}>
                No queued tracks
              </div>
            ) : (
              userQueue.map((t, idx) => (
                <TrackRow
                  key={`${t.mb_id}_${idx}`}
                  track={t}
                  onClick={() => controller.play(t)}
                  onRemove={() => controller.removeFromUserQueue(idx)}
                />
              ))
            )}
          </div>
        </div>

        <div className="px-4 pb-6">
          <div className="text-xs mb-2" style={{ fontFamily: "'Barlow Condensed', sans-serif", color: '#4A413C', letterSpacing: '0.14em', fontWeight: 800, textTransform: 'uppercase' }}>
            {sourceLabel}
          </div>
          <div className="flex flex-col gap-2">
            {systemLookahead.length === 0 ? (
              <div className="text-xs" style={{ fontFamily: "'Space Mono', monospace", color: 'rgba(232,221,208,0.45)' }}>
                Nothing queued from system
              </div>
            ) : (
              systemLookahead.map((t, i) => {
                const absoluteIndex = systemIndex + 1 + i
                return (
                  <TrackRow
                    key={`${t.mb_id}_${absoluteIndex}`}
                    track={t}
                    onClick={() => {
                      usePlayerStore.getState().setSystemIndex(absoluteIndex)
                      controller.play(systemList[absoluteIndex])
                    }}
                  />
                )
              })
            )}
          </div>
        </div>
        </div>
      </div>
    </div>
  )
}

export default QueuePanel

