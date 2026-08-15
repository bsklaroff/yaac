// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { CreatingPlaceholder } from '#components/CreatingPlaceholder'
import { useUiStore } from '#store'
import type { ProvisioningWorktreeEntry } from '@yaac/shared/types'

afterEach(() => {
  cleanup()
  useUiStore.setState({ provisionRetries: {} })
})

const failed = (over: Partial<ProvisioningWorktreeEntry> = {}): ProvisioningWorktreeEntry => ({
  worktreeId: 'w1',
  projectSlug: 'demo',
  tool: 'claude',
  kind: 'create',
  message: '',
  createdAt: '2026-01-01 00:00:00',
  error: 'a tool is missing',
  ...over,
})

/**
 * The failure half of the row. What matters here is which recoveries it
 * offers: a retry closure only this browser session holds, and — for a
 * missing tool — an install yaac is actually able to run.
 */
describe('CreatingPlaceholder', () => {
  it('offers Install and retry for a tool yaac can fetch', () => {
    useUiStore.setState({ provisionRetries: { w1: vi.fn() } })
    render(<CreatingPlaceholder creating={failed({
      errorCode: 'MISSING_TOOL', installable: true,
    })} />)
    expect(screen.getByRole('button', { name: 'Install and retry' })).toBeTruthy()
  })

  it('withholds it for a tool that comes from a system package manager', () => {
    // socat: the retry would re-run the create, install nothing, and fail
    // with the identical error — a button that reads as a fix already tried.
    // The message still names the command to run by hand.
    useUiStore.setState({ provisionRetries: { w1: vi.fn() } })
    render(<CreatingPlaceholder creating={failed({
      errorCode: 'MISSING_TOOL',
      installable: false,
      error: '"socat" is not on this host\'s PATH — install it (apt install socat)',
    })} />)
    expect(screen.queryByRole('button', { name: 'Install and retry' })).toBeNull()
    expect(screen.getByText(/apt install socat/)).toBeTruthy()
    // Still dismissable — the row is the user's to clear either way.
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeTruthy()
  })

  it('withholds it after a reload, which cannot have kept the retry', () => {
    // The closure holding the create's parameters dies with the tab; the
    // failure message is what tells a reloaded row how to recover.
    render(<CreatingPlaceholder creating={failed({
      errorCode: 'MISSING_TOOL', installable: true,
    })} />)
    expect(screen.queryByRole('button', { name: 'Install and retry' })).toBeNull()
  })

  it('shows progress rather than recoveries while it is still working', () => {
    render(<CreatingPlaceholder creating={{
      ...failed(), error: undefined, message: 'Pulling image…',
    }} />)
    expect(screen.getByText('Pulling image…')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull()
  })
})
