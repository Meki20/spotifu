// Shared section heading + subhint. Theme-aware.

export function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="mb-2 pb-1.5"
      style={{
        fontFamily: 'var(--font-display)',
        fontSize: 15,
        fontWeight: 700,
        textTransform: 'uppercase',
        letterSpacing: '0.12em',
        color: 'var(--accent)',
        borderBottom: '1px solid var(--border-subtle)',
      }}
    >
      {children}
    </div>
  )
}

export function SectionHint({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-xs mb-3" style={{ fontFamily: 'var(--font-body)', color: 'var(--text-secondary)' }}>
      {children}
    </p>
  )
}
