// @vitest-environment jsdom
import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { GitAuthFailureBadge } from '#components/GitAuthFailureBadge'
import { useUiStore } from '#store'

// jsdom has no ResizeObserver; Base UI's positioner needs one to exist.
beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
})

// Auto-cleanup only registers when vitest runs with globals; this suite
// doesn't, so unmount explicitly to keep the renders isolated.
afterEach(cleanup)

const FAILURES = [{ host: 'github.com', status: 401, atMs: 1751700000000 }]

describe('GitAuthFailureBadge', () => {
  it('renders a labeled trigger', () => {
    render(<GitAuthFailureBadge projectSlug="proj" failures={FAILURES} iconSize={12} />)

    const trigger = screen.getByRole('button', { name: 'Git authentication failed' })
    expect(trigger.textContent).toBe('git auth')
  })

  it('explains the failure, and its button opens settings on the project\'s credential', () => {
    render(<GitAuthFailureBadge projectSlug="proj" failures={FAILURES} iconSize={12} />)

    expect(screen.queryByText('github.com — HTTP 401')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Git authentication failed' }))

    expect(screen.getByText('Git authentication failed')).toBeTruthy()
    expect(screen.getByText('github.com — HTTP 401')).toBeTruthy()
    expect(screen.getByText(/Assign the project a new credential in Settings/)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Change git credential…' }))
    const state = useUiStore.getState()
    expect(state.settingsOpen).toBe(true)
    expect(state.settingsSection).toBe('credentials')
    expect(state.settingsFocusProject).toBe('proj')
  })
})
