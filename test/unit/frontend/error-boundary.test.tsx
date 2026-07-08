// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { ErrorBoundary } from '@/frontend/components/ErrorBoundary'

function Boom(): never {
  throw new Error('kaboom')
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('ErrorBoundary', () => {
  it('renders children when they do not throw', () => {
    render(<ErrorBoundary><div>hello</div></ErrorBoundary>)
    expect(screen.getByText('hello')).toBeTruthy()
  })

  it('renders a fallback instead of blanking when a child throws', () => {
    // React logs the caught error; silence it so the test output stays clean.
    vi.spyOn(console, 'error').mockImplementation(() => { /* silence */ })
    render(<ErrorBoundary><Boom /></ErrorBoundary>)
    expect(screen.getByText(/something went wrong/i)).toBeTruthy()
    expect(screen.getByText(/kaboom/)).toBeTruthy()
  })

  it('honors a custom fallback', () => {
    vi.spyOn(console, 'error').mockImplementation(() => { /* silence */ })
    render(
      <ErrorBoundary fallback={(e) => <div>custom: {e.message}</div>}>
        <Boom />
      </ErrorBoundary>,
    )
    expect(screen.getByText('custom: kaboom')).toBeTruthy()
  })
})
