// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import type { AuthListResult } from '@/shared/types'

const provision = vi.hoisted(() => vi.fn())

vi.mock('@/frontend/lib/settingsApi', () => ({
  getAuthList: vi.fn(),
}))
vi.mock('@/frontend/lib/createSession', () => ({
  createSession: vi.fn(),
}))
vi.mock('@/frontend/lib/useProvisionSession', () => ({
  useProvisionSession: () => provision,
}))

import { NewSessionButton } from '@/frontend/components/NewSessionButton'
import { getAuthList } from '@/frontend/lib/settingsApi'
import { useUiStore } from '@/frontend/store'

// jsdom has no ResizeObserver; Base UI's positioner needs one to exist.
beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
})

const CLAUDE_ONLY: AuthListResult = {
  gitCredentials: [],
  toolAuth: [
    { tool: 'claude', kind: 'oauth', keyPreview: '***host', savedAt: '2026-01-01T00:00:00.000Z' },
  ],
}

beforeEach(() => {
  useUiStore.setState({ settingsOpen: false, settingsSection: 'general', settingsFocusTool: null })
  vi.clearAllMocks()
  vi.mocked(getAuthList).mockResolvedValue(CLAUDE_ONLY)
})

afterEach(cleanup)

/** Render the button and open its tool menu, waiting for the auth list. */
async function openMenu(): Promise<void> {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <NewSessionButton projectSlug="proj" />
    </QueryClientProvider>,
  )
  fireEvent.click(screen.getByRole('button', { name: 'New session' }))
  await waitFor(() => expect(screen.getByText('Claude')).toBeTruthy())
}

describe('NewSessionButton', () => {
  it('creates a session for a tool with credentials', async () => {
    await openMenu()

    await waitFor(() => expect(screen.queryAllByText('Sign in').length).toBe(2))
    fireEvent.click(screen.getByText('Claude'))

    expect(provision).toHaveBeenCalledTimes(1)
    expect(provision.mock.calls[0][0]).toBe('proj')
    expect(provision.mock.calls[0][1]).toBe('claude')
    expect(useUiStore.getState().settingsOpen).toBe(false)
  })

  it('routes a credential-less tool to settings → credentials instead of creating', async () => {
    await openMenu()

    await waitFor(() => expect(screen.queryAllByText('Sign in').length).toBe(2))
    fireEvent.click(screen.getByText('Codex'))

    expect(provision).not.toHaveBeenCalled()
    const state = useUiStore.getState()
    expect(state.settingsOpen).toBe(true)
    expect(state.settingsSection).toBe('credentials')
    expect(state.settingsFocusTool).toBe('codex')
  })
})
