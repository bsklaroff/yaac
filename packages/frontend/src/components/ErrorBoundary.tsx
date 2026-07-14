import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
  /** Custom fallback; defaults to the built-in "something went wrong" screen. */
  fallback?: (error: Error, reset: () => void) => ReactNode
}

interface State {
  error: Error | null
}

/**
 * Catches render-time exceptions in its subtree and shows a readable fallback
 * instead of a blank screen. Without it, a single unguarded access — e.g. a
 * server/frontend version skew that drops a field the UI indexes into —
 * unmounts the whole React tree, leaving only the window background (a
 * confusing black rectangle with no way to recover but a manual reload).
 */
export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[yaac] render error:', error, info.componentStack)
  }

  private readonly reset = (): void => this.setState({ error: null })

  render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children
    if (this.props.fallback) return this.props.fallback(error, this.reset)
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 bg-bg p-6 text-center">
        <div className="text-text">Something went wrong</div>
        <div className="max-w-md text-sm text-text-faint">
          The app hit an unexpected error. This can happen when the webapp
          and the server are running different versions.
        </div>
        <pre className="max-w-md overflow-auto text-xs text-text-faint">{error.message}</pre>
        <button
          className="rounded bg-base px-3 py-1 text-sm text-text"
          onClick={() => window.location.reload()}
        >
          Reload
        </button>
      </div>
    )
  }
}
