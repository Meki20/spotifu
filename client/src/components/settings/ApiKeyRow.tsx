// Shared "configured/not configured + input + save" row.
import type React from 'react'

export function ApiKeyRow(props: {
  label: string
  configured: boolean
  value: string
  onChange: (v: string) => void
  onSubmit: (e: React.FormEvent) => void
  loading: boolean
  status: string
  placeholder: string
}) {
  const configured = props.configured
  return (
    <div className="space-y-2">
      <form
        onSubmit={props.onSubmit}
        className="flex items-center gap-2.5 px-3 py-2 rounded"
        style={{
          background: configured ? 'var(--color-success-bg)' : 'var(--bg-surface)',
          border: `1px solid ${configured ? 'var(--color-success-border)' : 'var(--border)'}`,
          borderRadius: 4,
        }}
      >
        <div
          className="w-7 h-7 rounded-full flex items-center justify-center shrink-0"
          title={configured ? 'Configured' : 'Not configured'}
          style={{
            background: configured ? 'var(--color-success-icon-bg)' : 'rgba(107, 83, 72, 0.18)',
            border: `1px solid ${configured ? 'var(--color-success-icon-border)' : 'rgba(107, 83, 72, 0.55)'}`,
            color: configured ? 'var(--color-success)' : 'var(--text-muted)',
            fontFamily: 'var(--font-body)',
            fontSize: 14,
            lineHeight: 1,
          }}
        >
          {configured ? '✓' : '–'}
        </div>

        <div className="min-w-0">
          <div
            className="text-xs uppercase tracking-wider"
            style={{
              fontFamily: 'var(--font-display)',
              fontWeight: 700,
              letterSpacing: '0.12em',
              color: 'var(--text-primary)',
            }}
          >
            {props.label}
          </div>
          <div className="text-[11px]" style={{ fontFamily: 'var(--font-body)', color: 'var(--text-secondary)' }}>
            {configured ? 'set' : 'not set'}
          </div>
        </div>

        <input
          type="text"
          value={props.value}
          onChange={(e) => props.onChange(e.target.value)}
          className="flex-1 min-w-0 px-3 py-2 text-sm"
          style={{
            background: 'var(--bg-base)',
            border: '1px solid var(--border)',
            borderRadius: 4,
            fontFamily: 'var(--font-mono)',
            fontSize: 14,
            color: 'var(--text-primary)',
            padding: '5px 10px',
            outline: 'none',
          }}
          placeholder={props.placeholder}
        />

        <button
          type="submit"
          disabled={props.loading || !props.value}
          className="px-3 py-2 text-sm font-bold transition-colors shrink-0"
          style={{
            background: 'var(--accent)',
            color: 'var(--text-primary)',
            border: 'none',
            cursor: props.loading || !props.value ? 'not-allowed' : 'pointer',
            fontFamily: 'var(--font-display)',
            fontWeight: 700,
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
            opacity: props.loading || !props.value ? 0.5 : 1,
            borderRadius: 4,
            lineHeight: 1,
          }}
          title="Save"
        >
          {props.loading ? '…' : 'Save'}
        </button>
      </form>

      {props.status && (
        <p
          className="text-xs"
          style={{
            color: props.status === 'Saved' ? 'var(--color-success-strong)' : 'var(--color-danger)',
            fontFamily: 'var(--font-body)',
          }}
        >
          {props.status}
        </p>
      )}
    </div>
  )
}
