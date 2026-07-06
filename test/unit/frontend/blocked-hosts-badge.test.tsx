// @vitest-environment jsdom
import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { BlockedHostsBadge } from '@/frontend/components/BlockedHostsBadge'

// jsdom has no ResizeObserver; Base UI's positioner needs one to exist.
beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
})

// Auto-cleanup only registers when vitest runs with globals; this suite
// doesn't, so unmount explicitly to keep the two renders isolated.
afterEach(cleanup)

const HOSTS = ['registry.npmjs.org', 'evil.example.com']

describe('BlockedHostsBadge', () => {
  it('shows the count and no hover tooltip on the trigger', () => {
    render(<BlockedHostsBadge hosts={HOSTS} iconSize={12} />)

    const trigger = screen.getByRole('button', { name: '2 blocked hosts' })
    expect(trigger.textContent).toBe('2 blocked hosts')
    // The host list moved from a hover tooltip into the click popover.
    expect(trigger.getAttribute('title')).toBeNull()
  })

  it('lists the blocked hosts in a popover on click', () => {
    render(<BlockedHostsBadge hosts={HOSTS} iconSize={12} />)

    expect(screen.queryByText('registry.npmjs.org')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '2 blocked hosts' }))

    expect(screen.getByText('Blocked hosts')).toBeTruthy()
    for (const host of HOSTS) expect(screen.getByText(host)).toBeTruthy()
  })
})
