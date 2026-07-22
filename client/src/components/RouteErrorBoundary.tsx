import { Component, type ReactNode } from 'react'

type P = { children: ReactNode; name?: string }
type S = { err: Error | null }

export default class RouteErrorBoundary extends Component<P, S> {
  state: S = { err: null }

  static getDerivedStateFromError(err: Error): S {
    return { err }
  }

  override componentDidCatch(e: Error) {
    console.error(
      this.props.name ? `Route [${this.props.name}]` : 'Route',
      e
    )
  }

  override render() {
    if (this.state.err) {
      return (
        <div
          className="flex flex-col items-center justify-center h-full p-8 gap-4"
          style={{ color: 'var(--text-primary)', fontFamily: "'Barlow Semi Condensed', sans-serif" }}
        >
          <p className="text-sm">Something went wrong{this.props.name ? ` in ${this.props.name}` : ''}.</p>
          <p className="text-xs text-[var(--text-secondary)] max-w-md break-words">{this.state.err.message}</p>
          <button
            type="button"
            className="px-3 py-1.5 text-xs rounded border border-[var(--text-faint)] hover:bg-[var(--text-primary)] transition"
            onClick={() => {
              this.setState({ err: null })
            }}
          >
            Retry
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
