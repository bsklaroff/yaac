// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import type { AuthListResult, DraftWorktreeEntry, QueuedWorktreeEntry, WorktreeListEntry } from '@yaac/shared/types'
import type { ProjectBranches } from '#lib/projectApi'
import { ServerError } from '@yaac/shared/errors'

const provision = vi.hoisted(() => vi.fn())

vi.mock('#lib/settingsApi', () => ({
  getAuthList: vi.fn(),
}))
vi.mock('#lib/createWorktree', () => ({
  createWorktree: vi.fn(),
}))
vi.mock('#lib/queueApi', () => ({
  queueWorktree: vi.fn(),
  updateQueuedWorktree: vi.fn(),
  runQueuedWorktree: vi.fn(),
  discardQueuedWorktree: vi.fn(),
}))
vi.mock('#lib/draftApi', () => ({
  saveDraftWorktree: vi.fn(),
  discardDraftWorktree: vi.fn(),
}))
vi.mock('#lib/projectApi', () => ({
  getProjectBranches: vi.fn(),
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

import { CreateWorktreeDialog } from '#components/CreateWorktreeDialog'
import { NewWorktreeButton } from '#components/NewWorktreeButton'
import { createWorktree } from '#lib/createWorktree'
import { discardDraftWorktree, saveDraftWorktree } from '#lib/draftApi'
import { queueWorktree, runQueuedWorktree, updateQueuedWorktree } from '#lib/queueApi'
import { getProjectBranches } from '#lib/projectApi'
import { getAuthList } from '#lib/settingsApi'
import { useUiStore } from '#lib/store'

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
}

/** A snapshot for project `proj` with the given create memory. */
function project(memory: Record<string, unknown> = {}, driver = 'k8s', extra: Record<string, unknown> = {}): unknown {
  return {
    driver,
    projects: [{ slug: 'proj', createDefaults: {}, gitCredential: { id: 'c1', name: 'github.com token' }, ...memory }],
    worktrees: [],
    queuedWorktrees: [],
    heldWorktrees: [],
    draftWorktrees: [],
    provisioning: [],
    ...extra,
  }
}

/** A live worktree to queue after: codex on gpt-5.5, forked from dev. */
const PARENT: WorktreeListEntry = {
  worktreeId: 'w-parent',
  projectSlug: 'proj',
  tool: 'codex',
  status: 'running',
  createdAt: '2026-01-01 00:00:01',
  title: 'Parent work',
  agentSessions: [{
    agentSessionId: 'a1', tool: 'codex', mode: 'tui', ordinal: 0, active: true, model: 'gpt-5.5',
  }],
  blockedHosts: [],
  forwardedPorts: [],
  unforwardedPorts: [],
  baseBranch: 'dev',
  permissionMode: 'accept-edits',
}

const GROUPS = [
  { groupId: 'g-review', projectSlug: 'proj', name: 'Review', pinned: false, createdAt: '2026-01-01 00:00:00' },
  { groupId: 'g-other', projectSlug: 'proj', name: 'Other', pinned: true, createdAt: '2026-01-02 00:00:00' },
  { groupId: 'g-theirs', projectSlug: 'else', name: 'Theirs', pinned: true, createdAt: '2026-01-02 00:00:00' },
]

const entry = (id: string, extra: Partial<QueuedWorktreeEntry> = {}): QueuedWorktreeEntry => ({
  id,
  projectSlug: 'proj',
  parentWorktreeId: 'w-parent',
  prompt: `step ${id}`,
  tool: 'claude',
  model: 'claude-sonnet-5',
  mode: 'tui',
  permissionMode: 'manual',
  branch: 'release/2.x',
  createdAt: '2026-01-01 00:00:02',
  ...extra,
})

beforeEach(() => {
  useUiStore.setState({
    settingsOpen: false, settingsSection: 'general', settingsFocusTool: null, settingsFocusProject: null,
    createWorktreeDialog: null, revealQueued: null,
  })
  vi.clearAllMocks()
  snapshot.mockReturnValue(project())
  vi.mocked(getAuthList).mockResolvedValue(CLAUDE_ONLY)
  vi.mocked(getProjectBranches).mockResolvedValue(BRANCHES)
  // Run the op the button hands the provisioning flow, so what it sends is
  // what `createWorktree` is called with.
  provision.mockImplementation(
    (_slug, _tool, _kind, sid: string, op: (sid: string, p: () => void) => unknown) => {
      void op(sid, () => {})
    })
  vi.mocked(queueWorktree).mockImplementation((_p, parent, settings) =>
    Promise.resolve({ id: 'q-new', projectSlug: 'proj', parentWorktreeId: parent, createdAt: '', ...settings }))
  vi.mocked(updateQueuedWorktree).mockImplementation((id) => Promise.resolve(entry(id)))
  vi.mocked(runQueuedWorktree).mockResolvedValue({ worktreeId: 'w-run' })
  vi.mocked(saveDraftWorktree).mockImplementation((projectSlug, settings, id) =>
    Promise.resolve({ id: id ?? 'd-new', projectSlug, createdAt: '', updatedAt: '', ...settings }))
  vi.mocked(discardDraftWorktree).mockResolvedValue(undefined)
})

afterEach(cleanup)

/** Mount the trigger beside the one dialog it opens, as App does. */
function mount(): void {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <NewWorktreeButton projectSlug="proj" />
      <CreateWorktreeDialog />
    </QueryClientProvider>,
  )
}

/** Render the button and open its dialog. */
async function openMenu(): Promise<void> {
  mount()
  fireEvent.click(screen.getByRole('button', { name: 'New worktree' }))
  await waitFor(() => expect(screen.getByLabelText('Agent')).toBeTruthy())
}

/** Open the dialog the way a row menu or queued row does. */
async function openWith(opts: { parent?: string; editId?: string; draftId?: string }): Promise<void> {
  mount()
  act(() => useUiStore.getState().openCreateWorktree({ projectSlug: 'proj', ...opts }))
  await waitFor(() => expect(screen.getByLabelText('Agent')).toBeTruthy())
  await waitFor(() => expect(submitButton().title).not.toBe('Loading…'))
}

/** Open, and wait until the credential list has landed. */
async function openReady(): Promise<void> {
  await openMenu()
  await waitFor(() => expect(createButton().disabled).toBe(false))
}

const promptInput = (): HTMLTextAreaElement => screen.getByLabelText<HTMLTextAreaElement>('Prompt')
const submitButton = (): HTMLButtonElement => screen.getByRole<HTMLButtonElement>('button', { name: /^(Queue|Save)$/ })
const branchInput = (): HTMLInputElement => screen.getByLabelText<HTMLInputElement>('Base branch')
const modelInput = (): HTMLInputElement => screen.getByLabelText<HTMLInputElement>('Model')
const select = (label: string): HTMLSelectElement => screen.getByLabelText<HTMLSelectElement>(label)
const createButton = (): HTMLButtonElement => screen.getByRole<HTMLButtonElement>('button', { name: /^Create$|^Sign in to|^Add git/ })
const option = (label: string, text: string): HTMLOptionElement =>
  [...select(label).options].find((o) => o.textContent?.startsWith(text))!
const heading = (): string => screen.getByRole('heading').textContent ?? ''

/** Rename through the heading's pencil, as every other rename is done. */
function retitle(text: string): void {
  fireEvent.click(screen.getByRole('button', { name: 'Rename worktree' }))
  const input = screen.getByLabelText<HTMLInputElement>('Worktree title')
  fireEvent.change(input, { target: { value: text } })
  fireEvent.keyDown(input, { key: 'Enter' })
}

describe('CreateWorktreeDialog', () => {
  it('opens on the project\'s last agent with what it last used, and creates with all of it', async () => {
    vi.mocked(getAuthList).mockResolvedValue(SIGNED_IN)
    snapshot.mockReturnValue(project({
      lastTool: 'codex',
      lastBranch: 'dev',
      createDefaults: { codex: { model: 'gpt-5.5', permissionMode: 'read-only' } },
    }))
    await openReady()

    expect(select('Agent').value).toBe('codex')
    expect(branchInput().value).toBe('dev')
    // Shown by name, sent by id.
    expect(modelInput().value).toBe('GPT-5.5')
    expect(select('Permissions').value).toBe('read-only')
    expect(select('UI').value).toBe('tui')

    fireEvent.click(createButton())
    // Every field is sent, so every field becomes the next default.
    expect(vi.mocked(createWorktree)).toHaveBeenCalledWith('proj', 'codex', expect.any(Function), expect.any(String), {
      branch: 'dev', model: 'gpt-5.5', permissionMode: 'read-only', mode: 'tui',
    })
    // The provisioning row names the model from its first frame.
    expect(provision.mock.calls[0][6]).toEqual({ model: 'gpt-5.5', modelName: 'GPT-5.5' })
    await waitFor(() => expect(screen.queryByLabelText('Agent')).toBeNull()) // closed
  })

  // A missing snapshot would read a containerless server as sandboxed and
  // offer bypass, so nothing may create until it lands.
  it('falls back per field, and offers no create before the snapshot lands', async () => {
    snapshot.mockReturnValue(undefined)
    await openMenu()
    await waitFor(() => expect(modelInput().value).toBe('Opus 5.5'))
    expect(createButton().disabled).toBe(true)

    cleanup()
    act(() => useUiStore.getState().closeCreateWorktree())
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
    expect(option('Permissions', 'Read-only').disabled).toBe(true)
    expect(option('Permissions', 'Accept').disabled).toBe(false)
    // Not codex postures in either UI, so not offered at all.
    expect(option('Permissions', 'Manual')).toBeUndefined()
    expect(option('Permissions', 'Plan')).toBeUndefined()

    fireEvent.change(select('UI'), { target: { value: 'tui' } })
    fireEvent.change(select('Permissions'), { target: { value: 'read-only' } })
    expect(option('UI', 'Chat').disabled).toBe(true)
    expect(select('Permissions').value).toBe('read-only')
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

  it('closes a suggestion list on Escape, keeping the dialog and its prompt', async () => {
    await openReady()
    fireEvent.change(promptInput(), { target: { value: 'keep me' } })

    fireEvent.change(modelInput(), { target: { value: 'sonnet' } })
    expect(screen.getByText('Sonnet 5')).toBeTruthy()
    fireEvent.keyDown(modelInput(), { key: 'Escape' })
    expect(screen.queryByText('Sonnet 5')).toBeNull()

    fireEvent.change(branchInput(), { target: { value: 're' } })
    expect(screen.getByText('release/2.x')).toBeTruthy()
    fireEvent.keyDown(branchInput(), { key: 'Escape' })
    expect(screen.queryByText('release/2.x')).toBeNull()

    expect(useUiStore.getState().createWorktreeDialog).not.toBeNull()
    expect(promptInput().value).toBe('keep me')
    // With no list open, Escape is the dialog's again — which, with a prompt
    // typed, asks before letting it go.
    fireEvent.keyDown(modelInput(), { key: 'Escape' })
    fireEvent.click(await screen.findByRole('button', { name: 'Discard' }))
    await waitFor(() => expect(useUiStore.getState().createWorktreeDialog).toBeNull())
    expect(saveDraftWorktree).not.toHaveBeenCalled()
  })

  it('takes only models and branches the lists have', async () => {
    await openReady()
    await waitFor(() => expect(branchInput().value).toBe('main'))

    for (const [input, typed, shown] of [
      [modelInput, 'claude-next', 'Opus 5.5'],
      [branchInput, 'no-such-branch', 'main'],
    ] as const) {
      fireEvent.change(input(), { target: { value: typed } })
      expect(screen.getByText('No matches')).toBeTruthy()
      // Enter has nothing to pick, and the unpicked text cannot create.
      fireEvent.keyDown(input(), { key: 'Enter' })
      expect(createButton().disabled).toBe(true)
      expect(createWorktree).not.toHaveBeenCalled()
      // Escape abandons it for what was chosen — not the dialog.
      fireEvent.keyDown(input(), { key: 'Escape' })
      expect(input().value).toBe(shown)
      expect(useUiStore.getState().createWorktreeDialog).not.toBeNull()
    }
  })

  it('creates on Enter straight after opening, but not from a button', async () => {
    await openReady()
    await waitFor(() => expect(branchInput().value).toBe('main'))
    // As in the model field, typed text is a search: Enter picks the top
    // match rather than creating.
    fireEvent.change(branchInput(), { target: { value: 'de' } })
    expect(createButton().disabled).toBe(true)
    fireEvent.keyDown(branchInput(), { key: 'Enter' })
    expect(branchInput().value).toBe('dev')
    fireEvent.keyDown(createButton(), { key: 'Enter' })
    expect(createWorktree).not.toHaveBeenCalled()

    fireEvent.keyDown(promptInput(), { key: 'Enter' })
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

  it('routes a project without a git credential to its row in settings instead of creating', async () => {
    snapshot.mockReturnValue(project({ gitCredential: null }))
    await openReady()

    expect(screen.getByText('This project has no git credential')).toBeTruthy()
    // Enter takes the same route as the button.
    fireEvent.keyDown(promptInput(), { key: 'Enter' })

    expect(provision).not.toHaveBeenCalled()
    const state = useUiStore.getState()
    expect(state.settingsOpen).toBe(true)
    expect(state.settingsSection).toBe('credentials')
    expect(state.settingsFocusProject).toBe('proj')
    await waitFor(() => expect(screen.queryByLabelText('Agent')).toBeNull()) // closed
  })

  it('renders a labeled trigger in the cta variant', () => {
    render(<NewWorktreeButton projectSlug="proj" variant="cta" />)
    // The icon variant's trigger is icon-only; the CTA carries a visible label.
    expect(screen.getByRole('button', { name: /New worktree/ }).textContent).toContain('New worktree')
  })

  // Alt+N and the + button both open here, so "open, type, Enter" is a
  // create with an opening prompt, and Shift+Enter a second line of it.
  it('focuses the prompt as it opens, before the dialog\'s own focus handling gets there', () => {
    // Alt+N then typing straight away is the flow; a key pressed before the
    // focus lands would go nowhere.
    mount()
    act(() => useUiStore.getState().openCreateWorktree({ projectSlug: 'proj', focus: 'prompt' }))
    expect(document.activeElement).toBe(promptInput())
  })

  // Handing focus back would park a focus ring on the + after a keyboard
  // close; jsdom has no :focus-visible, so this pins where focus lands.
  it('leaves focus off the + once its dialog closes, dismissed or created', async () => {
    mount()
    const plus = screen.getByRole('button', { name: 'New worktree' })
    for (const close of [
      () => fireEvent.click(screen.getByRole('button', { name: 'Close' })),
      () => fireEvent.keyDown(promptInput(), { key: 'Enter' }),
    ]) {
      plus.focus()
      fireEvent.click(plus)
      await waitFor(() => expect(createButton().disabled).toBe(false))
      close()
      await waitFor(() => expect(screen.queryByLabelText('Agent')).toBeNull())
      await new Promise((r) => setTimeout(r, 0))
      expect(document.activeElement).toBe(document.body)
    }
    expect(createWorktree).toHaveBeenCalledTimes(1)
  })

  it('focuses the prompt, and a typed prompt rides the create', async () => {
    await openReady()
    await waitFor(() => expect(document.activeElement).toBe(promptInput()))

    fireEvent.change(promptInput(), { target: { value: 'fix the flaky test' } })
    fireEvent.keyDown(promptInput(), { key: 'Enter', shiftKey: true })
    expect(createWorktree).not.toHaveBeenCalled()

    fireEvent.keyDown(promptInput(), { key: 'Enter' })
    expect(vi.mocked(createWorktree)).toHaveBeenCalledWith('proj', 'claude', expect.any(Function), expect.any(String),
      expect.objectContaining({ prompt: 'fix the flaky test' }))
  })

  it('names and files a create: a title off the heading and a picked or new group ride it', async () => {
    snapshot.mockReturnValue(project({}, 'k8s', { worktreeGroups: GROUPS }))
    await openReady()
    // Now has no parent to take a group from. Only this project's groups the
    // sidebar shows are offered: Review is unpinned with nothing in it.
    expect(select('Group').value).toBe('')
    expect([...select('Group').options].map((o) => o.textContent)).toEqual(['None', 'Other', '+ New group'])
    fireEvent.change(select('Group'), { target: { value: 'g-other' } })
    expect(heading()).toBe('New worktree')
    retitle('  Fix   the build ')
    // Enter finishes the title, not the dialog.
    expect(createWorktree).not.toHaveBeenCalled()
    expect(heading()).toBe('Fix the build')
    // The Enter that confirms an IME candidate leaves the editor open.
    fireEvent.click(screen.getByRole('button', { name: 'Rename worktree' }))
    fireEvent.keyDown(screen.getByLabelText('Worktree title'), { key: 'Enter', isComposing: true })
    fireEvent.keyDown(screen.getByLabelText('Worktree title'), { key: 'Escape' })
    expect(heading()).toBe('Fix the build')
    fireEvent.click(createButton())
    expect(vi.mocked(createWorktree)).toHaveBeenCalledWith('proj', 'claude', expect.any(Function), expect.any(String),
      expect.objectContaining({ title: 'Fix the build', group: 'g-other' }))
    // The optimistic row is filed in the group from its first frame.
    expect(provision.mock.calls[0][5]).toBe('g-other')

    // A group with a live member is offered; "+ New group" is a name box, and
    // Escape in it goes back to the dropdown rather than closing the dialog.
    cleanup()
    useUiStore.setState({ createWorktreeDialog: null })
    snapshot.mockReturnValue(project({}, 'k8s', {
      worktrees: [{ ...PARENT, groupId: 'g-review' }], worktreeGroups: GROUPS,
    }))
    await openReady()
    expect([...select('Group').options].map((o) => o.textContent))
      .toEqual(['None', 'Review', 'Other', '+ New group'])
    fireEvent.change(select('Group'), { target: { value: option('Group', '+ New group').value } })
    fireEvent.keyDown(screen.getByLabelText('New group name'), { key: 'Escape' })
    expect(select('Group').value).toBe('')
    fireEvent.change(select('Group'), { target: { value: option('Group', '+ New group').value } })
    const name = screen.getByLabelText<HTMLInputElement>('New group name')
    expect(document.activeElement).toBe(name)
    // A blank name is refused, not filed as None.
    fireEvent.change(name, { target: { value: '  ' } })
    expect(createButton().disabled).toBe(true)
    expect(createButton().title).toBe('Name the new group')
    fireEvent.change(name, { target: { value: ' Release  prep ' } })
    fireEvent.click(createButton())
    // Sent by name for the server to create; no id yet to file the row under.
    expect(vi.mocked(createWorktree)).toHaveBeenLastCalledWith('proj', 'claude', expect.any(Function),
      expect.any(String), expect.objectContaining({ group: 'Release prep' }))
    expect(provision.mock.calls[1][5]).toBeUndefined()
  })

  // The branch last created from is remembered (see the first test) — but
  // one origin no longer has falls back to origin's default.
  it('opens on origin\'s default when origin lost the branch last created from', async () => {
    vi.mocked(getProjectBranches).mockResolvedValue({ ...BRANCHES, defaultBranch: 'dev' })
    snapshot.mockReturnValue(project({ lastBranch: 'deleted' }))
    await openMenu()
    await waitFor(() => expect(branchInput().value).toBe('dev'))
  })

  // Whether origin still has it is only known once the list lands.
  it('sends a remembered branch only once the list confirms it', async () => {
    let land: (b: ProjectBranches) => void = () => {}
    vi.mocked(getProjectBranches).mockReturnValue(new Promise((r) => { land = r }))
    snapshot.mockReturnValue(project({ lastBranch: 'dev' }))
    await openMenu()
    await waitFor(() => expect(createButton().title).toBe('Loading branches…'))
    expect(branchInput().value).toBe('dev')
    expect(createButton().disabled).toBe(true)

    act(() => land(BRANCHES))
    await waitFor(() => expect(createButton().disabled).toBe(false))
    fireEvent.click(createButton())
    expect(vi.mocked(createWorktree)).toHaveBeenCalledWith('proj', 'claude', expect.any(Function), expect.any(String),
      expect.objectContaining({ branch: 'dev' }))
  })

  it('leaves the branch to the server when the list fails to load', async () => {
    vi.mocked(getProjectBranches).mockRejectedValue(new Error('boom'))
    snapshot.mockReturnValue(project({ lastBranch: 'dev' }))
    await openMenu()
    await waitFor(() => expect(createButton().disabled).toBe(false))
    expect(branchInput().value).toBe('')

    fireEvent.click(createButton())
    expect(vi.mocked(createWorktree).mock.calls[0][4]).not.toHaveProperty('branch')
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

  describe('queueing', () => {
    // A parent's settings are what a child defaults to: its first
    // conversation's agent and current model, its posture, and the branch it
    // forked from — every one sent concrete.
    it('seeds from the parent worktree and queues with every setting concrete', async () => {
      vi.mocked(getAuthList).mockResolvedValue(SIGNED_IN)
      snapshot.mockReturnValue(project({}, 'k8s', {
        worktrees: [{ ...PARENT, groupId: 'g-review' }], worktreeGroups: GROUPS,
      }))
      await openWith({ parent: 'w-parent' })

      expect(select('Start').value).toBe('w-parent')
      expect(select('Group').value).toBe('g-review')
      expect(select('Agent').value).toBe('codex')
      expect(modelInput().value).toBe('GPT-5.5')
      expect(select('Permissions').value).toBe('accept-edits')
      await waitFor(() => expect(branchInput().value).toBe('dev'))
      expect(screen.getByText('latest from origin when it starts')).toBeTruthy()

      // A queued worktree runs unattended, so it needs something to do.
      expect(submitButton().disabled).toBe(true)
      fireEvent.change(promptInput(), { target: { value: 'follow up' } })
      retitle('Follow-up')
      fireEvent.click(submitButton())

      await waitFor(() => expect(vi.mocked(queueWorktree)).toHaveBeenCalledWith('proj', 'w-parent', {
        prompt: 'follow up', tool: 'codex', model: 'gpt-5.5', mode: 'tui', permissionMode: 'accept-edits', branch: 'dev',
        title: 'Follow-up', group: 'g-review',
      }, undefined))
      expect(createWorktree).not.toHaveBeenCalled()
      await waitFor(() => expect(screen.queryByLabelText('Agent')).toBeNull())
      // The sidebar opens the set it landed in.
      expect(useUiStore.getState().revealQueued).toEqual({ id: 'q-new', parent: 'w-parent' })
    })

    it('re-seeds only untouched fields when Start changes', async () => {
      vi.mocked(getAuthList).mockResolvedValue(SIGNED_IN)
      snapshot.mockReturnValue(project({}, 'k8s', {
        worktrees: [{ ...PARENT, groupId: 'g-review' }], worktreeGroups: GROUPS,
      }))
      await openReady()
      expect(select('Agent').value).toBe('claude')
      expect(select('Group').value).toBe('')
      expect(screen.getByRole('button', { name: 'Create' })).toBeTruthy()

      fireEvent.change(select('Permissions'), { target: { value: 'plan' } })
      fireEvent.change(select('Start'), { target: { value: 'w-parent' } })
      // The group follows the parent until it is picked.
      expect(select('Group').value).toBe('g-review')
      // The agent was untouched, so it follows the parent — and a new agent
      // brings its own memory, so the posture pick goes with the old one.
      expect(select('Agent').value).toBe('codex')
      expect(select('Permissions').value).toBe('accept-edits')
      expect(screen.getByRole('button', { name: 'Queue' })).toBeTruthy()

      fireEvent.change(select('Agent'), { target: { value: 'claude' } })
      fireEvent.change(select('Group'), { target: { value: 'g-other' } })
      fireEvent.change(select('Start'), { target: { value: '' } })
      // Picked here, so a different Start leaves it alone.
      expect(select('Agent').value).toBe('claude')
      expect(select('Group').value).toBe('g-other')
    })

    it('refuses a blank new group rather than moving an entry out of its own', async () => {
      vi.mocked(getAuthList).mockResolvedValue(SIGNED_IN)
      snapshot.mockReturnValue(project({}, 'k8s', {
        worktrees: [PARENT],
        queuedWorktrees: [entry('q1', { groupId: 'g-review' })],
        worktreeGroups: GROUPS,
      }))
      await openWith({ editId: 'q1' })
      expect(select('Group').value).toBe('g-review')
      fireEvent.change(select('Group'), { target: { value: option('Group', '+ New group').value } })
      const name = screen.getByLabelText('New group name')
      fireEvent.change(name, { target: { value: '   ' } })
      expect(submitButton().disabled).toBe(true)
      expect(submitButton().title).toBe('Name the new group')
      fireEvent.keyDown(name, { key: 'Enter' })
      expect(updateQueuedWorktree).not.toHaveBeenCalled()

      // × puts its own group back. Review holds only a queued entry, which
      // the sidebar nests under its parent — still offered after moving off it.
      fireEvent.click(screen.getByRole('button', { name: 'Pick an existing group' }))
      expect(select('Group').value).toBe('g-review')
      fireEvent.change(select('Group'), { target: { value: '' } })
      expect([...select('Group').options].map((o) => o.textContent))
        .toEqual(['None', 'Review', 'Other', '+ New group'])
    })

    it('surfaces a refused queue and stays open', async () => {
      vi.mocked(getAuthList).mockResolvedValue(SIGNED_IN)
      snapshot.mockReturnValue(project({}, 'k8s', { worktrees: [PARENT] }))
      vi.mocked(queueWorktree).mockRejectedValue(new Error('no model is known for that tool'))
      await openWith({ parent: 'w-parent' })
      fireEvent.change(promptInput(), { target: { value: 'x' } })
      fireEvent.click(submitButton())
      await waitFor(() => expect(screen.getByText('no model is known for that tool')).toBeTruthy())
      expect(screen.getByLabelText('Agent')).toBeTruthy()
    })
  })

  describe('editing a queued worktree', () => {
    const chain = [
      entry('q1'),
      entry('q2', { parentWorktreeId: undefined, parentQueuedId: 'q1', title: 'Second', groupId: 'g-review' }),
      entry('q3', { parentWorktreeId: undefined, parentQueuedId: 'q2' }),
      entry('q4', { prompt: 'sibling' }),
    ]

    it('opens on the entry\'s own settings and never offers a cycle', async () => {
      vi.mocked(getAuthList).mockResolvedValue(SIGNED_IN)
      snapshot.mockReturnValue(project({}, 'k8s', {
        worktrees: [PARENT], queuedWorktrees: chain, worktreeGroups: GROUPS,
      }))
      await openWith({ editId: 'q2' })

      expect(promptInput().value).toBe('step q2')
      expect(heading()).toBe('Second')
      expect(select('Group').value).toBe('g-review')
      expect(select('Start').value).toBe('q1')
      expect(modelInput().value).toBe('Sonnet 5')
      expect(select('Permissions').value).toBe('manual')
      expect(branchInput().value).toBe('release/2.x')
      // Itself and what hangs under it would be a chain that never starts.
      const offered = [...select('Start').options].map((o) => o.value)
      expect(offered).toEqual(['', 'w-parent', 'q1', 'q4'])
      expect(submitButton().textContent).toBe('Save')

      vi.mocked(updateQueuedWorktree)
        .mockResolvedValueOnce(entry('q2', { parentWorktreeId: undefined, parentQueuedId: 'q4' }))
      fireEvent.change(select('Start'), { target: { value: 'q4' } })
      // Its own group, not the new parent's; a cleared title goes back to auto.
      expect(select('Group').value).toBe('g-review')
      retitle('')
      fireEvent.change(select('Group'), { target: { value: '' } })
      fireEvent.click(submitButton())
      await waitFor(() => expect(vi.mocked(updateQueuedWorktree)).toHaveBeenCalledWith('q2', {
        prompt: 'step q2', tool: 'claude', model: 'claude-sonnet-5', mode: 'tui', permissionMode: 'manual',
        branch: 'release/2.x', title: '', group: null, parent: 'q4',
      }))
      expect(runQueuedWorktree).not.toHaveBeenCalled()
      // The sidebar opens the set the server says it landed in.
      await waitFor(() => expect(useUiStore.getState().revealQueued).toEqual({ id: 'q2', parent: 'q4' }))
    })

    it('offers a held parent it already waits on, and "Now" saves then runs', async () => {
      snapshot.mockReturnValue(project({}, 'k8s', {
        queuedWorktrees: [entry('q1', { parentWorktreeId: 'w-held' })],
        heldWorktrees: [{ worktreeId: 'w-held', projectSlug: 'proj', tool: 'claude', title: 'Died', stoppedAt: '' }],
      }))
      await openWith({ editId: 'q1' })
      expect(option('Start', 'After “Died” stops')).toBeTruthy()

      fireEvent.change(select('Start'), { target: { value: '' } })
      fireEvent.click(submitButton())
      await waitFor(() => expect(vi.mocked(runQueuedWorktree)).toHaveBeenCalledWith('q1'))
      // Saved as it stands, without a parent: running it is what "Now" means.
      expect(vi.mocked(updateQueuedWorktree).mock.calls[0][1]).not.toHaveProperty('parent')
      expect(useUiStore.getState().revealQueued).toBeNull()
    })

    it('says so when the entry has already started', async () => {
      mount()
      act(() => useUiStore.getState().openCreateWorktree({ projectSlug: 'proj', editId: 'gone' }))
      await waitFor(() => expect(screen.getByText('Queued worktree gone')).toBeTruthy())
    })
  })

  describe('drafts', () => {
    const closeX = (): void => { fireEvent.click(screen.getByRole('button', { name: 'Close' })) }
    const draft = (extra: Partial<DraftWorktreeEntry> = {}): DraftWorktreeEntry => ({
      id: 'd1', projectSlug: 'proj', prompt: 'half an idea', tool: 'codex', mode: 'tui',
      permissionMode: 'read-only', model: 'gpt-5.5', branch: 'dev', createdAt: '', updatedAt: '', ...extra,
    })

    it('closes without asking when nothing was typed', async () => {
      await openReady()
      closeX()
      await waitFor(() => expect(useUiStore.getState().createWorktreeDialog).toBeNull())
      expect(screen.queryByText('Save as a draft?')).toBeNull()
    })

    it('asks on dismissal with a prompt, and saves every setting as shown', async () => {
      vi.mocked(getAuthList).mockResolvedValue(SIGNED_IN)
      snapshot.mockReturnValue(project({}, 'k8s', {
        worktrees: [{ ...PARENT, groupId: 'g-review' }], worktreeGroups: GROUPS,
      }))
      await openReady()
      fireEvent.change(promptInput(), { target: { value: '  later, maybe  ' } })
      retitle('Someday')
      fireEvent.change(select('Permissions'), { target: { value: 'plan' } })

      // Keep editing goes back to the form, prompt and all.
      // A reload would lose it as surely as a close.
      const unload = new Event('beforeunload', { cancelable: true })
      window.dispatchEvent(unload)
      expect(unload.defaultPrevented).toBe(true)

      closeX()
      fireEvent.click(await screen.findByRole('button', { name: 'Keep editing' }))
      await waitFor(() => expect(screen.queryByText('Save as a draft?')).toBeNull())
      expect(useUiStore.getState().createWorktreeDialog).not.toBeNull()
      fireEvent.change(select('Start'), { target: { value: 'w-parent' } })

      closeX()
      fireEvent.click(await screen.findByRole('button', { name: 'Save draft' }))
      await waitFor(() => expect(useUiStore.getState().createWorktreeDialog).toBeNull())
      expect(saveDraftWorktree).toHaveBeenCalledWith('proj', {
        prompt: 'later, maybe', tool: 'codex', model: 'gpt-5.5', mode: 'tui', permissionMode: 'accept-edits',
        branch: 'dev', startAfter: 'w-parent', title: 'Someday', groupId: 'g-review',
      }, undefined)
      expect(createWorktree).not.toHaveBeenCalled()
      expect(queueWorktree).not.toHaveBeenCalled()
      const after = new Event('beforeunload', { cancelable: true })
      window.dispatchEvent(after)
      expect(after.defaultPrevented).toBe(false)
    })

    it('keeps a typed prompt as a draft on the way to missing credentials', async () => {
      // Codex was last used, but only Claude is signed in.
      snapshot.mockReturnValue(project({ lastTool: 'codex' }))
      await openMenu()
      const signIn = await screen.findByRole('button', { name: 'Sign in to Codex…' })
      fireEvent.change(promptInput(), { target: { value: 'first thing' } })
      fireEvent.click(signIn)
      await waitFor(() => expect(useUiStore.getState().settingsOpen).toBe(true))
      expect(saveDraftWorktree).toHaveBeenCalledWith('proj', expect.objectContaining({
        prompt: 'first thing', tool: 'codex',
      }), undefined)
      expect(useUiStore.getState().createWorktreeDialog).toBeNull()
    })

    it('reopens a draft on its fields, asks only once it changes, and a create consumes it', async () => {
      vi.mocked(getAuthList).mockResolvedValue(SIGNED_IN)
      // Its Start parent has gone since it was saved: it starts now instead.
      snapshot.mockReturnValue(project({}, 'k8s', { draftWorktrees: [draft({ startAfter: 'w-gone' })] }))
      mount()
      act(() => useUiStore.getState().openCreateWorktree({ projectSlug: 'proj', draftId: 'd1' }))
      await waitFor(() => expect(createButton().disabled).toBe(false))
      expect(promptInput().value).toBe('half an idea')
      expect(select('Start').value).toBe('')
      expect(select('Agent').value).toBe('codex')
      expect(modelInput().value).toBe('GPT-5.5')
      expect(select('Permissions').value).toBe('read-only')
      await waitFor(() => expect(branchInput().value).toBe('dev'))

      fireEvent.change(promptInput(), { target: { value: 'a whole idea' } })
      closeX()
      fireEvent.click(await screen.findByRole('button', { name: 'Save changes' }))
      await waitFor(() => expect(useUiStore.getState().createWorktreeDialog).toBeNull())
      expect(saveDraftWorktree).toHaveBeenLastCalledWith('proj', expect.objectContaining({ prompt: 'a whole idea' }), 'd1')

      // Gone meanwhile (another tab created from it): the edit is saved anew.
      cleanup()
      vi.mocked(saveDraftWorktree).mockClear()
        .mockRejectedValueOnce(new ServerError('NOT_FOUND', 'project proj has no draft worktree d1'))
      mount()
      act(() => useUiStore.getState().openCreateWorktree({ projectSlug: 'proj', draftId: 'd1' }))
      await waitFor(() => expect(createButton().disabled).toBe(false))
      fireEvent.change(promptInput(), { target: { value: 'kept anyway' } })
      closeX()
      fireEvent.click(await screen.findByRole('button', { name: 'Save changes' }))
      await waitFor(() => expect(useUiStore.getState().createWorktreeDialog).toBeNull())
      expect(vi.mocked(saveDraftWorktree).mock.calls.map((c) => c[2])).toEqual(['d1', undefined])
      expect(vi.mocked(saveDraftWorktree).mock.calls[1][1]).toMatchObject({ prompt: 'kept anyway' })

      // Reopened exactly as saved, a dismissal has nothing to lose.
      cleanup()
      snapshot.mockReturnValue(project({}, 'k8s', { draftWorktrees: [draft()] }))
      mount()
      act(() => useUiStore.getState().openCreateWorktree({ projectSlug: 'proj', draftId: 'd1' }))
      await waitFor(() => expect(createButton().disabled).toBe(false))
      closeX()
      await waitFor(() => expect(useUiStore.getState().createWorktreeDialog).toBeNull())
      expect(screen.queryByText('Save changes to this draft?')).toBeNull()

      // A title and group of its own ride the create.
      cleanup()
      snapshot.mockReturnValue(project({}, 'k8s', {
        draftWorktrees: [draft({ title: 'Named', groupId: 'g-other' })], worktreeGroups: GROUPS,
      }))
      mount()
      act(() => useUiStore.getState().openCreateWorktree({ projectSlug: 'proj', draftId: 'd1' }))
      await waitFor(() => expect(createButton().disabled).toBe(false))
      expect(heading()).toBe('Named')
      expect(select('Group').value).toBe('g-other')
      fireEvent.click(createButton())
      // The server drops the draft once the create succeeds, so a failed one keeps it.
      expect(vi.mocked(createWorktree)).toHaveBeenCalledWith('proj', 'codex', expect.any(Function), expect.any(String), {
        branch: 'dev', model: 'gpt-5.5', permissionMode: 'read-only', mode: 'tui', prompt: 'half an idea',
        title: 'Named', group: 'g-other', draftId: 'd1',
      })
      expect(discardDraftWorktree).not.toHaveBeenCalled()
    })

    it('keeps an untouched draft group following Start, and a picked one where it was', async () => {
      const other = { ...PARENT, worktreeId: 'w-other', title: 'Other work', groupId: 'g-other' }
      const open = async (d: DraftWorktreeEntry): Promise<void> => {
        cleanup()
        useUiStore.setState({ createWorktreeDialog: null })
        snapshot.mockReturnValue(project({}, 'k8s', {
          worktrees: [{ ...PARENT, groupId: 'g-review' }, other], worktreeGroups: GROUPS, draftWorktrees: [d],
        }))
        mount()
        act(() => useUiStore.getState().openCreateWorktree({ projectSlug: 'proj', draftId: 'd1' }))
        await waitFor(() => expect(screen.getByLabelText('Group')).toBeTruthy())
      }
      // Saved following its Start's group: it still follows.
      await open(draft({ startAfter: 'w-parent', groupId: 'g-review' }))
      expect(select('Group').value).toBe('g-review')
      fireEvent.change(select('Start'), { target: { value: 'w-other' } })
      expect(select('Group').value).toBe('g-other')
      // Saved on Now with no group: so does this one.
      await open(draft())
      fireEvent.change(select('Start'), { target: { value: 'w-parent' } })
      expect(select('Group').value).toBe('g-review')
      // Saved with a group its Start would not give: picked, so it stays.
      await open(draft({ startAfter: 'w-parent', groupId: 'g-other' }))
      fireEvent.change(select('Start'), { target: { value: '' } })
      expect(select('Group').value).toBe('g-other')
    })

    it('keeps the prior group on a draft closed while a new one is being named', async () => {
      snapshot.mockReturnValue(project({}, 'k8s', {
        draftWorktrees: [draft({ groupId: 'g-other' })], worktreeGroups: GROUPS,
      }))
      mount()
      act(() => useUiStore.getState().openCreateWorktree({ projectSlug: 'proj', draftId: 'd1' }))
      await waitFor(() => expect(screen.getByLabelText('Group')).toBeTruthy())
      fireEvent.change(select('Group'), { target: { value: option('Group', '+ New group').value } })
      fireEvent.change(screen.getByLabelText('New group name'), { target: { value: 'Not yet made' } })
      fireEvent.change(promptInput(), { target: { value: 'half an idea, and more' } })
      closeX()
      fireEvent.click(await screen.findByRole('button', { name: 'Save changes' }))
      await waitFor(() => expect(useUiStore.getState().createWorktreeDialog).toBeNull())
      expect(vi.mocked(saveDraftWorktree).mock.calls[0][1]).toMatchObject({ groupId: 'g-other' })
    })

    it('queueing from a draft names it, for the server to drop once queued', async () => {
      vi.mocked(getAuthList).mockResolvedValue(SIGNED_IN)
      snapshot.mockReturnValue(project({}, 'k8s', {
        worktrees: [PARENT], draftWorktrees: [draft({ startAfter: 'w-parent' })],
      }))
      await openWith({ draftId: 'd1' })
      expect(select('Start').value).toBe('w-parent')
      fireEvent.click(submitButton())
      await waitFor(() => expect(queueWorktree).toHaveBeenCalledWith('proj', 'w-parent', expect.objectContaining({
        prompt: 'half an idea', permissionMode: 'read-only',
      }), 'd1'))
      expect(discardDraftWorktree).not.toHaveBeenCalled()
    })
  })
})
