// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import { BlockedHostsBadge } from '#components/BlockedHostsBadge'
import { useUiStore } from '#lib/store'
import { mockFetch, renderWithClient as render, serverError, type FetchMock } from './harness'

// jsdom has no ResizeObserver; Base UI's positioner needs one to exist.
beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
})

// Without vitest globals there is no auto-cleanup, so unmount explicitly.
let server: FetchMock
beforeEach(() => {
  server = mockFetch({ 'POST /api/workspace/sess-1/allow-host': {} })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  useUiStore.setState({ viewedUserId: null })
})

const ALLOW = 'POST /api/workspace/sess-1/allow-host'

const HOSTS = ['registry.npmjs.org', 'evil.example.com']

function openPopover(): void {
  fireEvent.click(screen.getByRole('button', { name: '2 blocked hosts' }))
}

describe('BlockedHostsBadge', () => {
  it('shows the count and no hover tooltip on the trigger', () => {
    render(<BlockedHostsBadge hosts={HOSTS} workspaceId="sess-1" iconSize={12} />)

    const trigger = screen.getByRole('button', { name: '2 blocked hosts' })
    expect(trigger.textContent).toBe('2 blocked hosts')
    // The host list is in the click popover, not a hover tooltip.
    expect(trigger.getAttribute('title')).toBeNull()
  })

  it('lists the blocked hosts in a popover on click', () => {
    render(<BlockedHostsBadge hosts={HOSTS} workspaceId="sess-1" iconSize={12} />)

    expect(screen.queryByText('registry.npmjs.org')).toBeNull()

    openPopover()

    expect(screen.getByText('Blocked hosts')).toBeTruthy()
    for (const host of HOSTS) expect(screen.getByText(host)).toBeTruthy()
  })

  it('reveals the two allow actions only for the clicked host', () => {
    render(<BlockedHostsBadge hosts={HOSTS} workspaceId="sess-1" iconSize={12} />)
    openPopover()

    // Collapsed by default, with no actions shown.
    expect(screen.queryByText('Allow for this workspace')).toBeNull()

    fireEvent.click(screen.getByText('registry.npmjs.org'))

    expect(screen.getByText('Allow for this workspace')).toBeTruthy()
    expect(screen.getByText('Allow permanently for this project')).toBeTruthy()
  })

  it('allows a host for just this workspace (persist:false)', async () => {
    render(<BlockedHostsBadge hosts={HOSTS} workspaceId="sess-1" iconSize={12} />)
    openPopover()
    fireEvent.click(screen.getByText('registry.npmjs.org'))
    fireEvent.click(screen.getByText('Allow for this workspace'))

    await waitFor(() => {
      expect(server.called(ALLOW).map((c) => c.body)).toEqual([{ host: 'registry.npmjs.org', persist: false }])
    })
    // Success collapses the host until the next snapshot drops it.
    await waitFor(() => expect(screen.queryByText('Allow for this workspace')).toBeNull())
  })

  it('allows a host permanently for the project (persist:true)', async () => {
    render(<BlockedHostsBadge hosts={HOSTS} workspaceId="sess-1" iconSize={12} />)
    openPopover()
    fireEvent.click(screen.getByText('evil.example.com'))
    fireEvent.click(screen.getByText('Allow permanently for this project'))

    await waitFor(() => {
      expect(server.called(ALLOW).map((c) => c.body)).toEqual([{ host: 'evil.example.com', persist: true }])
    })
  })

  it('shows a refused allow under the host, and keeps it open', async () => {
    server.route(ALLOW, serverError('VALIDATION', 'host is not valid', 400))
    render(<BlockedHostsBadge hosts={HOSTS} workspaceId="sess-1" iconSize={12} />)
    openPopover()
    fireEvent.click(screen.getByText('evil.example.com'))
    fireEvent.click(screen.getByText('Allow for this workspace'))

    await waitFor(() => expect(screen.getByText('host is not valid')).toBeTruthy())
    expect(screen.getByText('Allow for this workspace')).toBeTruthy()
  })

  it('lists a teammate\'s blocked hosts with no actions', () => {
    useUiStore.setState({ viewedUserId: 'u-ada' })
    render(<BlockedHostsBadge hosts={HOSTS} workspaceId="sess-1" iconSize={12} />)
    openPopover()
    fireEvent.click(screen.getByText('registry.npmjs.org'))
    expect(screen.queryByText('Allow for this workspace')).toBeNull()
    expect(server.called(ALLOW)).toEqual([])
  })
})
