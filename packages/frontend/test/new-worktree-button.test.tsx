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
vi.mock('#lib/createWorktree', () => ({
  createWorktree: vi.fn(),
}))
vi.mock('#lib/projectApi', () => ({
  getProjectBranches: vi.fn(),
  setProjectReferenceBranch: vi.fn(),
  projectBranchesKey: (slug: string) => ['project-branches', slug],
}))
vi.mock('#lib/useProvisionWorktree', () => ({
  useProvisionWorktree: () => provision,
}))
// The snapshot arrives over the events socket; there is no queryFn, so a
// component that mounts before the first frame sees `undefined` — which is
// the case the permission-mode default has to survive.
const snapshot = vi.hoisted(() => vi.fn())
vi.mock('#lib/useSnapshot', () => ({ useSnapshot: snapshot }))

import { NewWorktreeButton } from '#components/NewWorktreeButton'
import { createWorktree } from '#lib/createWorktree'
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
  snapshot.mockReturnValue(undefined)
  vi.mocked(getAuthList).mockResolvedValue(CLAUDE_ONLY)
  vi.mocked(getProjectBranches).mockResolvedValue(BRANCHES)
  vi.mocked(setProjectReferenceBranch).mockImplementation((_slug, branch) => Promise.resolve(branch))
})

afterEach(cleanup)

/** Render the button and open its popover, waiting for the auth list. */
async function openMenu(): Promise<void> {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <NewWorktreeButton projectSlug="proj" />
    </QueryClientProvider>,
  )
  fireEvent.click(screen.getByRole('button', { name: 'New worktree' }))
  await waitFor(() => expect(screen.getByText('Claude')).toBeTruthy())
}

const branchInput = (): HTMLInputElement =>
  screen.getByLabelText<HTMLInputElement>('Reference branch')

describe('NewWorktreeButton', () => {
  it('creates a worktree for a tool with credentials', async () => {
    await openMenu()

    await waitFor(() => expect(screen.queryAllByText('Sign in').length).toBe(3))
    fireEvent.click(screen.getByText('Claude'))

    expect(provision).toHaveBeenCalledTimes(1)
    expect(provision.mock.calls[0][0]).toBe('proj')
    expect(provision.mock.calls[0][1]).toBe('claude')
    expect(useUiStore.getState().settingsOpen).toBe(false)
  })

  it('routes a credential-less tool to settings → credentials instead of creating', async () => {
    await openMenu()

    await waitFor(() => expect(screen.queryAllByText('Sign in').length).toBe(3))
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
        <NewWorktreeButton projectSlug="proj" variant="cta" />
      </QueryClientProvider>,
    )
    // The icon variant's trigger is icon-only; the CTA carries a visible label.
    expect(screen.getByRole('button', { name: /New worktree/ }).textContent).toContain('New worktree')
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
    expect(vi.mocked(createWorktree)).toHaveBeenCalledWith(
      // undefined, not a posture: the user has never touched the dropdown,
      // so the create omits the field and the SERVER resolves it. Sending one
      // here would both make that fallback unreachable and overwrite the
      // project's remembered choice with a default nobody picked.
      'proj', 'claude', expect.any(Function), expect.any(String), undefined, 'tui', undefined,
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
    expect(vi.mocked(createWorktree)).toHaveBeenCalledWith(
      'proj', 'claude', expect.any(Function), expect.any(String), 'release/2.x', 'tui', undefined,
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

  // The bargain the containerless mode is documented on: no sandbox, so the
  // agent edits its worktree freely but still asks before anything wider.
  it('shows the driver default, and never reads a missing snapshot as sandboxed', async () => {
    snapshot.mockReturnValue(undefined)
    await openMenu()
    // An initializer that captured the undefined snapshot here would show the
    // sandboxed default for the component's life; the value is derived at
    // render instead, so the containerless answer lands as soon as it does.
    snapshot.mockReturnValue({ driver: 'containerless', projects: [] })
    cleanup()
    await openMenu()
    expect(screen.getByRole('combobox')).toHaveProperty('value', 'accept-edits')

    snapshot.mockReturnValue({ driver: 'k8s', projects: [] })
    cleanup()
    await openMenu()
    expect(screen.getByRole('combobox')).toHaveProperty('value', 'bypass')
  })

  // The remembered choice is the server's, not this browser's, so the form
  // opens on what a create would actually resolve to for this project.
  it('prefers the project\'s remembered posture over the driver default', async () => {
    snapshot.mockReturnValue({
      driver: 'k8s',
      projects: [{ slug: 'proj', lastPermissionMode: 'plan' }],
    })
    await openMenu()
    expect(screen.getByRole('combobox')).toHaveProperty('value', 'plan')
  })

  it('sends an explicit choice, and omits it while untouched', async () => {
    snapshot.mockReturnValue({ driver: 'containerless', projects: [] })
    provision.mockImplementation(
      (_slug, _tool, _kind, sid: string, op: (sid: string, p: () => void) => unknown) => {
        void op(sid, () => {})
      })
    await openMenu()
    fireEvent.click(screen.getByText('Claude'))
    // Untouched: the field is omitted so the server resolves it — and so a
    // defaulted create never overwrites what the user last picked.
    expect(vi.mocked(createWorktree)).toHaveBeenLastCalledWith(
      'proj', 'claude', expect.any(Function), expect.any(String), undefined, 'tui', undefined,
    )

    cleanup()
    await openMenu()
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'manual' } })
    fireEvent.click(screen.getByText('Claude'))
    expect(vi.mocked(createWorktree)).toHaveBeenLastCalledWith(
      'proj', 'claude', expect.any(Function), expect.any(String), undefined, 'tui', 'manual',
    )
  })

  // pi has no permission system at all, so it cannot honor a posture the user
  // has already picked — the row says so rather than silently launching
  // unrestrained.
  it('disables a tool that has no such posture', async () => {
    vi.mocked(getAuthList).mockResolvedValue({
      gitCredentials: [],
      toolAuth: [
        { tool: 'claude', kind: 'oauth', keyPreview: '***h', savedAt: '2026-01-01T00:00:00.000Z' },
        { tool: 'pi', kind: 'api-key', keyPreview: '***k', savedAt: '2026-01-01T00:00:00.000Z' },
      ],
    })
    snapshot.mockReturnValue({ driver: 'k8s', projects: [] })
    await openMenu()
    // Under bypass — pi's only posture — it is clickable like any other.
    expect(screen.getByText('Pi').closest('button')).toHaveProperty('disabled', false)

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'plan' } })
    expect(screen.getByText('Pi').closest('button')).toHaveProperty('disabled', true)
    expect(screen.getByText('Claude').closest('button')).toHaveProperty('disabled', false)
  })
})
