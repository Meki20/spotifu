import { useEffect, useMemo, useState } from 'react'
import { X, Info, AlertTriangle, AlertCircle, CheckCircle2 } from 'lucide-react'
import { useNotificationStore, type NotificationItem, type NotificationKind, type NotificationAction } from '../stores/notificationStore'

function kindIcon(kind: NotificationKind) {
  if (kind === 'success') return CheckCircle2
  if (kind === 'warning') return AlertTriangle
  if (kind === 'error') return AlertCircle
  return Info
}

function kindColors(kind: NotificationKind) {
  switch (kind) {
    case 'success':
      return { icon: '#22c55e', title: '#E8DDD0' }
    case 'warning':
      return { icon: '#f59e0b', title: '#E8DDD0' }
    case 'error':
      return { icon: '#ef4444', title: '#E8DDD0' }
    default:
      return { icon: '#b4003e', title: '#E8DDD0' }
  }
}

function actionStyles(a: NotificationAction) {
  switch (a.variant) {
    case 'red':
      return {
        background: 'rgba(239, 68, 68, 0.12)',
        color: '#FEE2E2',
      } as const
    case 'green':
      return {
        background: 'rgba(34, 197, 94, 0.12)',
        color: '#DCFCE7',
      } as const
    default:
      return {
        background: 'rgba(232, 221, 208, 0.06)',
        color: '#E8DDD0',
      } as const
  }
}

function NotificationToast({ item }: { item: NotificationItem }) {
  const dismiss = useNotificationStore((s) => s.dismiss)
  const [show, setShow] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const [hovered, setHovered] = useState(false)

  const Icon = useMemo(() => kindIcon(item.kind), [item.kind])
  const colors = useMemo(() => kindColors(item.kind), [item.kind])

  useEffect(() => {
    const t = window.setTimeout(() => setShow(true), 10)
    return () => window.clearTimeout(t)
  }, [])

  useEffect(() => {
    if (hovered || leaving) return
    const ms = Math.max(600, item.dismissAfterMs ?? 3000)
    const deadline = (item.createdAt || Date.now()) + ms
    const remaining = Math.max(0, deadline - Date.now())
    const t = window.setTimeout(() => {
      setLeaving(true)
      window.setTimeout(() => dismiss(item.id), 220)
    }, remaining)
    return () => window.clearTimeout(t)
  }, [dismiss, hovered, item.createdAt, item.dismissAfterMs, item.id, leaving])

  function close() {
    setLeaving(true)
    window.setTimeout(() => dismiss(item.id), 220)
  }

  return (
    <div
      className="relative overflow-hidden rounded-xl"
      style={{
        background: 'rgba(26,18,16,0.98)',
        border: 'none',
        boxShadow: '0 12px 36px rgba(0,0,0,0.55)',
        transform: leaving ? 'translateY(6px) scale(0.985)' : show ? 'translateY(0) scale(1)' : 'translateY(10px) scale(0.985)',
        opacity: leaving ? 0 : show ? 1 : 0,
        transition: 'transform 220ms cubic-bezier(0.2, 0.9, 0.2, 1), opacity 180ms ease',
      }}
      role="status"
      aria-live="polite"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <button
        type="button"
        onClick={close}
        className="absolute top-2 right-2 grid place-items-center rounded-md"
        style={{
          width: 28,
          height: 28,
          background: 'rgba(0,0,0,0.18)',
          border: 'none',
          color: '#C7B8AA',
        }}
        aria-label="Dismiss notification"
      >
        <X size={16} />
      </button>

      <div className="relative z-10 p-3 pr-10">
        <div className="flex gap-3 items-start">
          <div
            className="shrink-0 rounded-lg grid place-items-center"
            style={{
              width: 34,
              height: 34,
              background: 'rgba(0,0,0,0.22)',
              border: 'none',
              color: colors.icon,
              boxShadow: 'inset 0 0 0 1px rgba(0,0,0,0.18)',
            }}
            aria-hidden
          >
            <Icon size={18} />
          </div>

          <div className="min-w-0 flex-1">
            <div
              className="text-sm font-semibold leading-snug"
              style={{
                fontFamily: "'Barlow Semi Condensed', sans-serif",
                color: colors.title,
                letterSpacing: '0.02em',
              }}
            >
              {item.title}
            </div>
            {item.description && (
              <div
                className="text-xs mt-1 leading-snug"
                style={{
                  fontFamily: "'Barlow Semi Condensed', sans-serif",
                  color: 'rgba(232,221,208,0.72)',
                }}
              >
                {item.description}
              </div>
            )}

            {item.actions && item.actions.length > 0 && (
              <div className="flex flex-wrap gap-2 mt-3">
                {item.actions.slice(0, 3).map((a, idx) => (
                  <button
                    key={`${item.id}_${idx}_${a.text}`}
                    type="button"
                    onClick={() => {
                      try {
                        a.onClick?.()
                      } finally {
                        if (a.dismiss !== false) close()
                      }
                    }}
                    className="px-2.5 py-1 rounded-md text-xs font-semibold"
                    style={{
                      fontFamily: "'Barlow Condensed', sans-serif",
                      letterSpacing: '0.08em',
                      textTransform: 'uppercase',
                      border: 'none',
                      ...actionStyles(a),
                    }}
                  >
                    {a.text}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

export default function NotificationCenter() {
  const items = useNotificationStore((s) => s.items)

  if (!items.length) return null

  return (
    <div
      className="fixed left-1/2 -translate-x-1/2 z-50 flex flex-col gap-2"
      style={{
        bottom: 92, // sits above PlayerBar
        width: 'min(92vw, 520px)',
        maxWidth: 'min(33vw, 520px)',
      }}
    >
      {items.map((it) => (
        <NotificationToast key={it.id} item={it} />
      ))}
    </div>
  )
}

