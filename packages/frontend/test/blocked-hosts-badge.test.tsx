// @vitest-environment jsdom
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import { BlockedHostsBadge } from '#components/BlockedHostsBadge'
import { allowBlockedHost } from '#lib/blockedHostsApi'

vi.mock('#lib/blockedHostsApi', () => ({
  allowBlockedHost: vi.fn(() => Promise.resolve()),
}))

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
afterEach(() => {
  cleanup()
  vi.mocked(allowBlockedHost).mockClear()
})

const HOSTS = ['registry.npmjs.org', 'evil.example.com']

function openPopover(): void {
  fireEvent.click(screen.getByRole('button', { name: '2 blocked hosts' }))
}

describe('BlockedHostsBadge', () => {
  it('shows the count and no hover tooltip on the trigger', () => {
    render(<BlockedHostsBadge hosts={HOSTS} worktreeId="sess-1" iconSize={12} />)

    const trigger = screen.getByRole('button', { name: '2 blocked hosts' })
    expect(trigger.textContent).toBe('2 blocked hosts')
    // The host list moved from a hover tooltip into the click popover.
    expect(trigger.getAttribute('title')).toBeNull()
  })

  it('lists the blocked hosts in a popover on click', () => {
    render(<BlockedHostsBadge hosts={HOSTS} worktreeId="sess-1" iconSize={12} />)

    expect(screen.queryByText('registry.npmjs.org')).toBeNull()

    openPopover()

    expect(screen.getByText('Blocked hosts')).toBeTruthy()
    for (const host of HOSTS) expect(screen.getByText(host)).toBeTruthy()
  })

  it('reveals the two allow actions only for the clicked host', () => {
    render(<BlockedHostsBadge hosts={HOSTS} worktreeId="sess-1" iconSize={12} />)
    openPopover()

    // Collapsed by default — no actions shown.
    expect(screen.queryByText('Allow for this session')).toBeNull()

    fireEvent.click(screen.getByText('registry.npmjs.org'))

    expect(screen.getByText('Allow for this session')).toBeTruthy()
    expect(screen.getByText('Allow permanently for this project')).toBeTruthy()
  })

  it('allows a host for just this session (persist:false)', async () => {
    render(<BlockedHostsBadge hosts={HOSTS} worktreeId="sess-1" iconSize={12} />)
    openPopover()
    fireEvent.click(screen.getByText('registry.npmjs.org'))
    fireEvent.click(screen.getByText('Allow for this session'))

    await waitFor(() => {
      expect(allowBlockedHost).toHaveBeenCalledWith('sess-1', 'registry.npmjs.org', { persist: false })
    })
  })

  it('allows a host permanently for the project (persist:true)', async () => {
    render(<BlockedHostsBadge hosts={HOSTS} worktreeId="sess-1" iconSize={12} />)
    openPopover()
    fireEvent.click(screen.getByText('evil.example.com'))
    fireEvent.click(screen.getByText('Allow permanently for this project'))

    await waitFor(() => {
      expect(allowBlockedHost).toHaveBeenCalledWith('sess-1', 'evil.example.com', { persist: true })
    })
  })
})
