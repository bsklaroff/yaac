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
// the case the form's fallbacks have to survive.
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

const CLAUDE = {
  tool: 'claude' as const, kind: 'oauth' as const, keyPreview: '***h', savedAt: '2026-01-01T00:00:00.000Z',
  models: [
    { id: 'claude-opus-5-5', name: 'Opus 5.5' },
    { id: 'claude-sonnet-5', name: 'Sonnet 5' },
  ],
  defaultModel: 'claude-opus-5-5',
}
const CODEX = {
  tool: 'codex' as const, kind: 'oauth' as const, keyPreview: '***x', savedAt: '2026-01-01T00:00:00.000Z',
  models: [{ id: 'gpt-6-sol', name: 'GPT-6 Sol' }, { id: 'gpt-5.5', name: 'GPT-5.5' }],
  defaultModel: 'gpt-6-sol',
}
const PI = {
  tool: 'pi' as const, kind: 'api-key' as const, keyPreview: '***k', savedAt: '2026-01-01T00:00:00.000Z',
  models: [{ id: 'anthropic/claude-opus-4-8', name: 'Claude Opus 4.8' }],
  defaultModel: 'anthropic/claude-opus-4-8',
}
const CLAUDE_ONLY: AuthListResult = { gitCredentials: [], toolAuth: [CLAUDE] }
const SIGNED_IN: AuthListResult = { gitCredentials: [], toolAuth: [CLAUDE, CODEX, PI] }

const BRANCHES: ProjectBranches = {
  branches: ['main', 'dev', 'release/2.x'],
  defaultBranch: 'main',
  referenceBranch: null,
}

/** A snapshot for project `proj` with the given create memory. */
function project(memory: Record<string, unknown> = {}, driver = 'k8s'): unknown {
  return { driver, projects: [{ slug: 'proj', createDefaults: {}, ...memory }] }
}

beforeEach(() => {
  useUiStore.setState({ settingsOpen: false, settingsSection: 'general', settingsFocusTool: null })
  vi.clearAllMocks()
  snapshot.mockReturnValue(project())
  vi.mocked(getAuthList).mockResolvedValue(CLAUDE_ONLY)
  vi.mocked(getProjectBranches).mockResolvedValue(BRANCHES)
  vi.mocked(setProjectReferenceBranch).mockImplementation((_slug, branch) => Promise.resolve(branch))
  // Run the op the button hands the provisioning flow, so what it sends is
  // what `createWorktree` is called with.
  provision.mockImplementation(
    (_slug, _tool, _kind, sid: string, op: (sid: string, p: () => void) => unknown) => {
      void op(sid, () => {})
    })
})

afterEach(cleanup)

/** Render the button and open its popover. */
async function openMenu(): Promise<void> {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <NewWorktreeButton projectSlug="proj" />
    </QueryClientProvider>,
  )
  fireEvent.click(screen.getByRole('button', { name: 'New worktree' }))
  await waitFor(() => expect(screen.getByLabelText('Agent')).toBeTruthy())
}

/** Open, and wait until the credential list has landed. */
async function openReady(): Promise<void> {
  await openMenu()
  await waitFor(() => expect(createButton().disabled).toBe(false))
}

const branchInput = (): HTMLInputElement => screen.getByLabelText<HTMLInputElement>('Reference branch')
const modelInput = (): HTMLInputElement => screen.getByLabelText<HTMLInputElement>('Model')
const select = (label: string): HTMLSelectElement => screen.getByLabelText<HTMLSelectElement>(label)
const createButton = (): HTMLButtonElement => screen.getByRole<HTMLButtonElement>('button', { name: /^Create$|^Sign in to/ })
const option = (label: string, text: string): HTMLOptionElement =>
  [...select(label).options].find((o) => o.textContent?.startsWith(text))!

describe('NewWorktreeButton', () => {
  it('opens on the project\'s last agent with what it last used, and creates with all of it', async () => {
    vi.mocked(getAuthList).mockResolvedValue(SIGNED_IN)
    snapshot.mockReturnValue(project({
      lastTool: 'codex',
      createDefaults: { codex: { model: 'gpt-5.5', permissionMode: 'plan' } },
    }))
    await openReady()

    expect(select('Agent').value).toBe('codex')
    // Shown by name, sent by id.
    expect(modelInput().value).toBe('GPT-5.5')
    expect(select('Permissions').value).toBe('plan')
    expect(select('UI').value).toBe('tui')

    fireEvent.click(createButton())
    // Every field is sent, so every field becomes the next default. The
    // branch is omitted: the picker is on the project's default.
    expect(vi.mocked(createWorktree)).toHaveBeenCalledWith('proj', 'codex', expect.any(Function), expect.any(String), {
      model: 'gpt-5.5', permissionMode: 'plan', mode: 'tui',
    })
    // The provisioning row names the model from its first frame.
    expect(provision.mock.calls[0][6]).toEqual({ model: 'gpt-5.5', modelName: 'GPT-5.5' })
    expect(screen.queryByLabelText('Agent')).toBeNull() // closed
  })

  // A missing snapshot would read a containerless server as sandboxed and
  // offer bypass, so nothing may create until it lands.
  it('falls back per field, and offers no create before the snapshot lands', async () => {
    snapshot.mockReturnValue(undefined)
    await openMenu()
    await waitFor(() => expect(modelInput().value).toBe('Opus 5.5'))
    expect(createButton().disabled).toBe(true)

    cleanup()
    snapshot.mockReturnValue(project({}, 'containerless'))
    await openReady()
    expect(select('Agent').value).toBe('claude')
    expect(modelInput().value).toBe('Opus 5.5')
    expect(select('Permissions').value).toBe('accept-edits')
    expect(select('UI').value).toBe('tui')
    // Picking bypass there is allowed, and said out loud.
    fireEvent.change(select('Permissions'), { target: { value: 'bypass' } })
    expect(screen.getByText('no sandbox — acts as you')).toBeTruthy()
  })

  it('reloads an agent\'s own memory and options when the agent changes', async () => {
    vi.mocked(getAuthList).mockResolvedValue(SIGNED_IN)
    snapshot.mockReturnValue(project({
      createDefaults: {
        claude: { model: 'claude-sonnet-5', permissionMode: 'manual', mode: 'acp' },
        codex: { model: 'gpt-5.5' },
      },
    }))
    await openReady()
    expect(modelInput().value).toBe('Sonnet 5')
    expect(select('UI').value).toBe('acp')

    fireEvent.change(select('Agent'), { target: { value: 'codex' } })
    expect(modelInput().value).toBe('GPT-5.5')
    expect(select('Permissions').value).toBe('bypass')
    expect(select('UI').value).toBe('tui')

    // pi has no permission system, so bypass is all it offers.
    fireEvent.change(select('Agent'), { target: { value: 'pi' } })
    expect([...select('Permissions').options].map((o) => o.value)).toEqual(['bypass'])
    expect(modelInput().value).toBe('Claude Opus 4.8')
  })

  // codex's chat adapter has no plan or manual mode, and neither field
  // quietly moves the other: each disables what the other rules out.
  it('disables the postures and UIs that rule each other out', async () => {
    vi.mocked(getAuthList).mockResolvedValue(SIGNED_IN)
    await openReady()
    fireEvent.change(select('Agent'), { target: { value: 'codex' } })

    fireEvent.change(select('UI'), { target: { value: 'acp' } })
    expect(option('Permissions', 'Plan').disabled).toBe(true)
    expect(option('Permissions', 'Manual').disabled).toBe(true)
    expect(option('Permissions', 'Accept').disabled).toBe(false)

    fireEvent.change(select('UI'), { target: { value: 'tui' } })
    fireEvent.change(select('Permissions'), { target: { value: 'plan' } })
    expect(option('UI', 'Chat').disabled).toBe(true)
    expect(select('Permissions').value).toBe('plan')
  })

  it('searches models by name or id, and Enter picks before it creates', async () => {
    await openReady()

    fireEvent.change(modelInput(), { target: { value: 'sonnet' } })
    expect(screen.getByText('Sonnet 5')).toBeTruthy()
    expect(screen.queryByText('Opus 5.5')).toBeNull()
    // Mid-edit text is a search, not a pick.
    expect(createButton().disabled).toBe(true)

    fireEvent.change(modelInput(), { target: { value: 'claude-sonnet' } })
    fireEvent.keyDown(modelInput(), { key: 'Enter' })
    expect(modelInput().value).toBe('Sonnet 5')
    expect(createWorktree).not.toHaveBeenCalled()

    fireEvent.keyDown(modelInput(), { key: 'Enter' })
    expect(vi.mocked(createWorktree)).toHaveBeenCalledWith('proj', 'claude', expect.any(Function), expect.any(String),
      expect.objectContaining({ model: 'claude-sonnet-5' }))
  })

  it('takes a model id the catalog does not list', async () => {
    await openReady()
    fireEvent.change(modelInput(), { target: { value: 'claude-next' } })
    fireEvent.click(screen.getByText('Use "claude-next" as a model id'))
    expect(modelInput().value).toBe('claude-next')

    fireEvent.click(createButton())
    expect(vi.mocked(createWorktree)).toHaveBeenCalledWith('proj', 'claude', expect.any(Function), expect.any(String),
      expect.objectContaining({ model: 'claude-next' }))
  })

  it('creates on Enter straight after opening, but not from a button', async () => {
    await openReady()
    await waitFor(() => expect(branchInput().value).toBe('main'))
    fireEvent.change(branchInput(), { target: { value: 'dev' } })
    fireEvent.keyDown(screen.getByRole('button', { name: 'Set as default branch' }), { key: 'Enter' })
    expect(createWorktree).not.toHaveBeenCalled()

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Enter' })
    expect(vi.mocked(createWorktree)).toHaveBeenCalledWith('proj', 'claude', expect.any(Function), expect.any(String),
      expect.objectContaining({ branch: 'dev', model: 'claude-opus-5-5', permissionMode: 'bypass', mode: 'tui' }))
  })

  it('routes a credential-less agent to settings → credentials instead of creating', async () => {
    await openReady()
    fireEvent.change(select('Agent'), { target: { value: 'codex' } })

    expect(screen.getByText('Codex has no credentials')).toBeTruthy()
    expect(screen.queryByLabelText('Model')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Sign in to Codex…' }))

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

  it('typeahead filters the branch list and a picked branch rides the create', async () => {
    await openReady()
    await waitFor(() => expect(branchInput().value).toBe('main'))

    fireEvent.change(branchInput(), { target: { value: 're' } })
    // 'release/2.x' matches; 'dev' does not.
    expect(screen.getByText('release/2.x')).toBeTruthy()
    expect(screen.queryByText('dev')).toBeNull()

    fireEvent.click(screen.getByText('release/2.x'))
    expect(branchInput().value).toBe('release/2.x')

    fireEvent.click(createButton())
    expect(vi.mocked(createWorktree)).toHaveBeenCalledWith('proj', 'claude', expect.any(Function), expect.any(String),
      expect.objectContaining({ branch: 'release/2.x' }))
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
