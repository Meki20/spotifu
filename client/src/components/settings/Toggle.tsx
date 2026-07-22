// Shared toggle switch used across Settings tabs.
export function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={() => onChange(!on)}
      className="relative w-9 h-5 rounded-full transition-colors cursor-pointer"
      style={{
        background: on ? 'var(--accent)' : 'var(--border)',
        border: 'none',
      }}
    >
      <div
        className="absolute top-0.5 w-3.5 h-3.5 rounded-full transition-all"
        style={{
          background: 'var(--text-primary)',
          left: on ? 20 : 3,
        }}
      />
    </button>
  )
}
