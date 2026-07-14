// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import type { AuthListResult } from '@yaac/shared/types'
import type { ProjectBranches } from '#lib/projectApi'

const provision = vi.hoisted(() => vi.fn())

vi.mock('#lib/settingsApi', () => ({
  getAuthList: vi.fn(),
}))
vi.mock('#lib/createSession', () => ({
  createSession: vi.fn(),
}))
vi.mock('#lib/projectApi', () => ({
  getProjectBranches: vi.fn(),
  setProjectReferenceBranch: vi.fn(),
}))
vi.mock('#lib/useProvisionSession', () => ({
  useProvisionSession: () => provision,
}))

import { NewSessionButton } from '#components/NewSessionButton'
import { createSession } from '#lib/createSession'
import { getProjectBranches, setProjectReferenceBranch } from '#lib/projectApi'
import { getAuthList } from '#lib/settingsApi'
import { useUiStore } from '#store'

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

const BRANCHES: ProjectBranches = {
  branches: ['main', 'dev', 'release/2.x'],
  defaultBranch: 'main',
  referenceBranch: null,
}

beforeEach(() => {
  useUiStore.setState({ settingsOpen: false, settingsSection: 'general', settingsFocusTool: null })
  vi.clearAllMocks()
  vi.mocked(getAuthList).mockResolvedValue(CLAUDE_ONLY)
  vi.mocked(getProjectBranches).mockResolvedValue(BRANCHES)
  vi.mocked(setProjectReferenceBranch).mockImplementation((_slug, branch) => Promise.resolve(branch))
})

afterEach(cleanup)

/** Render the button and open its popover, waiting for the auth list. */
async function openMenu(): Promise<void> {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <NewSessionButton projectSlug="proj" />
    </QueryClientProvider>,
  )
  fireEvent.click(screen.getByRole('button', { name: 'New session' }))
  await waitFor(() => expect(screen.getByText('Claude')).toBeTruthy())
}

const branchInput = (): HTMLInputElement =>
  screen.getByLabelText<HTMLInputElement>('Reference branch')

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

  it('renders a labeled trigger in the cta variant', () => {
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <NewSessionButton projectSlug="proj" variant="cta" />
      </QueryClientProvider>,
    )
    // The icon variant's trigger is icon-only; the CTA carries a visible label.
    expect(screen.getByRole('button', { name: /New session/ }).textContent).toContain('New session')
  })

  it('does not focus the branch input on open (no distracting cursor blink)', async () => {
    await openMenu()
    await waitFor(() => expect(branchInput().value).toBe('main'))
    // Focus lands on the popup dialog, not the branch input.
    expect(document.activeElement).not.toBe(branchInput())
    expect(document.activeElement?.getAttribute('role')).toBe('dialog')
  })

  it('prefills the branch input with the project default', async () => {
    vi.mocked(getProjectBranches).mockResolvedValue({ ...BRANCHES, referenceBranch: 'dev' })
    await openMenu()
    await waitFor(() => expect(branchInput().value).toBe('dev'))
  })

  it('creates on the default branch without sending a branch', async () => {
    provision.mockImplementation(
      (_slug, _tool, _kind, sid: string, op: (sid: string, p: () => void) => unknown) => {
        void op(sid, () => {})
      })
    await openMenu()
    await waitFor(() => expect(branchInput().value).toBe('main'))

    fireEvent.click(screen.getByText('Claude'))
    expect(vi.mocked(createSession)).toHaveBeenCalledWith(
      'proj', 'claude', expect.any(Function), expect.any(String), undefined,
    )
  })

  it('typeahead filters the branch list and a picked branch rides the create', async () => {
    provision.mockImplementation(
      (_slug, _tool, _kind, sid: string, op: (sid: string, p: () => void) => unknown) => {
        void op(sid, () => {})
      })
    await openMenu()
    await waitFor(() => expect(branchInput().value).toBe('main'))

    fireEvent.change(branchInput(), { target: { value: 're' } })
    // 'release/2.x' matches; 'dev' does not.
    expect(screen.getByText('release/2.x')).toBeTruthy()
    expect(screen.queryByText('dev')).toBeNull()

    fireEvent.click(screen.getByText('release/2.x'))
    expect(branchInput().value).toBe('release/2.x')

    fireEvent.click(screen.getByText('Claude'))
    expect(vi.mocked(createSession)).toHaveBeenCalledWith(
      'proj', 'claude', expect.any(Function), expect.any(String), 'release/2.x',
    )
  })

  it('pins the picked branch as the project default', async () => {
    await openMenu()
    await waitFor(() => expect(branchInput().value).toBe('main'))

    // Pinning the current default is a no-op — the button is disabled.
    const pin = screen.getByRole('button', { name: 'Set as default branch' })
    expect((pin as HTMLButtonElement).disabled).toBe(true)

    fireEvent.change(branchInput(), { target: { value: 'dev' } })
    expect((pin as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(pin)

    expect(vi.mocked(setProjectReferenceBranch)).toHaveBeenCalledWith('proj', 'dev')
    // The pinned branch becomes the default resolution — pin disables again.
    await waitFor(() => expect((pin as HTMLButtonElement).disabled).toBe(true))
    expect(branchInput().value).toBe('dev')
  })
})
