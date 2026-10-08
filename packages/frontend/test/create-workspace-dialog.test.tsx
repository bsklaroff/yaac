// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { act, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import type {
  AuthListResult, DraftWorkspaceEntry, QueuedWorkspaceEntry, WorkspaceListEntry,
} from '@yaac/shared/types'

const provision = vi.hoisted(() => vi.fn())

vi.mock('#lib/useProvisionWorkspace', () => ({
  useProvisionWorkspace: () => provision,
}))
// The snapshot is pushed over the events socket, so it is mocked directly.
// Before the first frame it is `undefined`, which the form must handle.
const snapshot = vi.hoisted(() => vi.fn())
vi.mock('#lib/useSnapshot', () => ({ useSnapshot: snapshot }))

import { CreateWorkspaceDialog } from '#components/CreateWorkspaceDialog'
import { NewWorkspaceButton } from '#components/NewWorkspaceButton'
import { useUiStore } from '#lib/store'
import type { ProjectBranches } from '#lib/useProjectBranches'
import { mockFetch, renderWithClient, serverError, type FetchMock } from './harness'

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
    projects: [{ id: 'proj', name: 'proj', createDefaults: {}, gitCredential: { id: 'c1', name: 'github.com token' }, ...memory }],
    workspaces: [],
    queuedWorkspaces: [],
    heldWorkspaces: [],
    draftWorkspaces: [],
    provisioning: [],
    ...extra,
  }
}

/** A live workspace to queue after: codex on gpt-5.5, forked from dev. */
const PARENT: WorkspaceListEntry = {
  workspaceId: 'w-parent',
  projectId: 'proj',
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
  { groupId: 'g-review', projectId: 'proj', name: 'Review', pinned: false, createdAt: '2026-01-01 00:00:00' },
  { groupId: 'g-other', projectId: 'proj', name: 'Other', pinned: true, createdAt: '2026-01-02 00:00:00' },
  { groupId: 'g-theirs', projectId: 'else', name: 'Theirs', pinned: true, createdAt: '2026-01-02 00:00:00' },
]

const entry = (id: string, extra: Partial<QueuedWorkspaceEntry> = {}): QueuedWorkspaceEntry => ({
  id,
  projectId: 'proj',
  parentWorkspaceId: 'w-parent',
  prompt: `step ${id}`,
  tool: 'claude',
  model: 'claude-sonnet-5',
  mode: 'tui',
  permissionMode: 'manual',
  branch: 'release/2.x',
  createdAt: '2026-01-01 00:00:02',
  ...extra,
})

const AUTH_LIST = 'GET /api/auth/list'
const BRANCH_LIST = 'GET /api/project/proj/branches'
const CREATE = 'POST /api/workspace/create'
const QUEUE = 'POST /api/workspace/queue/create'
const UPDATE = 'POST /api/workspace/queue/update'
const RUN = 'POST /api/workspace/queue/run'
const SAVE_DRAFT = 'POST /api/workspace/draft/save'
const DISCARD_DRAFT = 'POST /api/workspace/draft/discard'

type Body = Record<string, unknown>
let server: FetchMock
/** The bodies sent to one route, in order. */
const sent = (route: string): Body[] => server.called(route).map((c) => c.body as Body)
/** Forget the requests so far, between phases of one test. */
const forget = (): void => { server.calls.length = 0 }

beforeEach(() => {
  useUiStore.setState({
    settingsOpen: false, settingsSection: 'general', settingsFocusTool: null, settingsFocusProject: null,
    createWorkspaceDialog: null, revealQueued: null,
  })
  vi.clearAllMocks()
  snapshot.mockReturnValue(project())
  // Run the op passed to the provisioning flow, so the test can check what
  // the create sends.
  provision.mockImplementation(
    (_projectId, _tool, _kind, sid: string, op: (sid: string, p: () => void) => unknown) => {
      void op(sid, () => {})
    })
  server = mockFetch({
    [AUTH_LIST]: CLAUDE_ONLY,
    [BRANCH_LIST]: BRANCHES,
    // The create's NDJSON stream, cut to its terminal event.
    [CREATE]: { type: 'result', result: { workspaceId: 'w-new', jobName: 'job', tool: 'claude' } },
    [QUEUE]: ({ body }: { body: Body }) => {
      const { project: projectId, parent, draftId: _draftId, ...settings } = body
      return { id: 'q-new', projectId, parentWorkspaceId: parent, createdAt: '', ...settings }
    },
    [UPDATE]: ({ body }: { body: Body }) => entry(body.id as string),
    [RUN]: { workspaceId: 'w-run' },
    [SAVE_DRAFT]: ({ body }: { body: Body }) => {
      const { project: projectId, id, ...settings } = body
      return { id: id ?? 'd-new', projectId, createdAt: '', updatedAt: '', ...settings }
    },
    [DISCARD_DRAFT]: undefined,
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

/** Mount the trigger beside the one dialog it opens, as App does. */
function mount(): void {
  renderWithClient(
    <>
      <NewWorkspaceButton projectId="proj" />
      <CreateWorkspaceDialog />
    </>,
  )
}

/** Render the button and open its dialog. */
async function openMenu(): Promise<void> {
  mount()
  fireEvent.click(screen.getByRole('button', { name: 'New workspace' }))
  await waitFor(() => expect(screen.getByLabelText('Agent')).toBeTruthy())
}

/** Open the dialog the way a row menu or queued row does. */
async function openWith(opts: { parent?: string; editId?: string; draftId?: string }): Promise<void> {
  mount()
  act(() => useUiStore.getState().openCreateWorkspace({ projectId: 'proj', ...opts }))
  await waitFor(() => expect(screen.getByLabelText('Agent')).toBeTruthy())
  await waitFor(() => expect(submitButton().title).not.toBe('Loading…'))
}

/** Wait until the credential list has landed and the agent can create.
 *  Until then an agent reads as signed out, offering its sign-in button. */
async function createReady(): Promise<void> {
  await waitFor(() => expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Create' }).disabled).toBe(false))
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
  fireEvent.click(screen.getByRole('button', { name: 'Rename workspace' }))
  const input = screen.getByLabelText<HTMLInputElement>('Workspace title')
  fireEvent.change(input, { target: { value: text } })
  fireEvent.keyDown(input, { key: 'Enter' })
}

describe('CreateWorkspaceDialog', () => {
  it('opens on the project\'s last agent with what it last used, and creates with all of it', async () => {
    server.route(AUTH_LIST, SIGNED_IN)
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
    expect(select('UI').value).toBe('acp')

    fireEvent.click(createButton())
    // Every field is sent, so every field becomes the next default.
    expect(sent(CREATE)).toEqual([{
      project: 'proj', tool: 'codex', workspaceId: expect.any(String) as string,
      branch: 'dev', model: 'gpt-5.5', permissionMode: 'read-only', mode: 'acp', draftOnFailure: true,
    }])
    // The provisioning row names the model from its first frame.
    expect(provision.mock.calls[0][6]).toEqual({ model: 'gpt-5.5', modelName: 'GPT-5.5' })
    await waitFor(() => expect(screen.queryByLabelText('Agent')).toBeNull()) // closed
  })

  // Without the snapshot a containerless server would look sandboxed and get
  // bypass, so creating waits for it.
  it('falls back per field, and offers no create before the snapshot lands', async () => {
    snapshot.mockReturnValue(undefined)
    await openMenu()
    await waitFor(() => expect(modelInput().value).toBe('Opus 5.5'))
    expect(createButton().disabled).toBe(true)

    cleanup()
    act(() => useUiStore.getState().closeCreateWorkspace())
    snapshot.mockReturnValue(project({}, 'containerless'))
    await openReady()
    expect(select('Agent').value).toBe('claude')
    expect(modelInput().value).toBe('Opus 5.5')
    expect(select('Permissions').value).toBe('accept-edits')
    expect(select('UI').value).toBe('acp')
    // Bypass can still be picked there, with a warning.
    fireEvent.change(select('Permissions'), { target: { value: 'bypass' } })
    expect(screen.getByText('no sandbox — acts as you')).toBeTruthy()
  })

  it('reloads an agent\'s own memory and options when the agent changes', async () => {
    server.route(AUTH_LIST, SIGNED_IN)
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
    expect(select('UI').value).toBe('acp')

    // pi has no permission system, so bypass is all it offers.
    fireEvent.change(select('Agent'), { target: { value: 'pi' } })
    expect([...select('Permissions').options].map((o) => o.value)).toEqual(['bypass'])
    expect(modelInput().value).toBe('Claude Opus 4.8')
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
    expect(sent(CREATE)).toHaveLength(0)

    fireEvent.keyDown(modelInput(), { key: 'Enter' })
    expect(sent(CREATE).at(-1)).toMatchObject({ project: 'proj', tool: 'claude', model: 'claude-sonnet-5' })
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

    expect(useUiStore.getState().createWorkspaceDialog).not.toBeNull()
    expect(promptInput().value).toBe('keep me')
    // With no list open, Escape goes to the dialog, which asks before
    // discarding a typed prompt.
    fireEvent.keyDown(modelInput(), { key: 'Escape' })
    fireEvent.click(await screen.findByRole('button', { name: 'Discard' }))
    await waitFor(() => expect(useUiStore.getState().createWorkspaceDialog).toBeNull())
    expect(sent(SAVE_DRAFT)).toHaveLength(0)
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
      expect(sent(CREATE)).toHaveLength(0)
      // Escape reverts to the chosen value without closing the dialog.
      fireEvent.keyDown(input(), { key: 'Escape' })
      expect(input().value).toBe(shown)
      expect(useUiStore.getState().createWorkspaceDialog).not.toBeNull()
    }
  })

  it('creates on Enter straight after opening, but not from a button', async () => {
    await openReady()
    await waitFor(() => expect(branchInput().value).toBe('main'))
    // As in the model field, Enter picks the top match rather than creating.
    fireEvent.change(branchInput(), { target: { value: 'de' } })
    expect(createButton().disabled).toBe(true)
    fireEvent.keyDown(branchInput(), { key: 'Enter' })
    expect(branchInput().value).toBe('dev')
    fireEvent.keyDown(createButton(), { key: 'Enter' })
    expect(sent(CREATE)).toHaveLength(0)

    fireEvent.keyDown(promptInput(), { key: 'Enter' })
    expect(sent(CREATE).at(-1)).toMatchObject({
      project: 'proj', tool: 'claude', branch: 'dev', model: 'claude-opus-5-5', permissionMode: 'bypass', mode: 'acp',
    })
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
    renderWithClient(<NewWorkspaceButton projectId="proj" variant="cta" />)
    // The icon variant's trigger is icon-only; the CTA carries a visible label.
    expect(screen.getByRole('button', { name: /New workspace/ }).textContent).toContain('New workspace')
  })

  // The dialog opens with the prompt focused, so "open, type, Enter" creates
  // with a prompt; Shift+Enter adds a line.
  it('focuses the prompt as it opens, before the dialog\'s own focus handling gets there', () => {
    // Keys typed right after opening must reach the prompt.
    mount()
    act(() => useUiStore.getState().openCreateWorkspace({ projectId: 'proj', focus: 'prompt' }))
    expect(document.activeElement).toBe(promptInput())
  })

  // Returning focus to the + would show a focus ring after a keyboard close.
  // jsdom has no :focus-visible, so the test checks where focus lands.
  it('leaves focus off the + once its dialog closes, dismissed or created', async () => {
    mount()
    const plus = screen.getByRole('button', { name: 'New workspace' })
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
    expect(sent(CREATE)).toHaveLength(1)
  })

  it('focuses the prompt, and a typed prompt rides the create', async () => {
    await openReady()
    await waitFor(() => expect(document.activeElement).toBe(promptInput()))

    fireEvent.change(promptInput(), { target: { value: 'fix the flaky test' } })
    fireEvent.keyDown(promptInput(), { key: 'Enter', shiftKey: true })
    expect(sent(CREATE)).toHaveLength(0)

    fireEvent.keyDown(promptInput(), { key: 'Enter' })
    expect(sent(CREATE).at(-1)).toMatchObject({ project: 'proj', tool: 'claude', prompt: 'fix the flaky test' })
  })

  it('names and files a create: a title off the heading and a picked or new group ride it', async () => {
    snapshot.mockReturnValue(project({}, 'k8s', { workspaceGroups: GROUPS }))
    await openReady()
    // "Now" has no parent to take a group from. Only groups the sidebar
    // shows are offered; Review is unpinned and empty.
    expect(select('Group').value).toBe('')
    expect([...select('Group').options].map((o) => o.textContent)).toEqual(['None', 'Other', '+ New group'])
    fireEvent.change(select('Group'), { target: { value: 'g-other' } })
    expect(heading()).toBe('New workspace')
    retitle('  Fix   the build ')
    // Enter finishes the title, not the dialog.
    expect(sent(CREATE)).toHaveLength(0)
    expect(heading()).toBe('Fix the build')
    // The Enter that confirms an IME candidate leaves the editor open.
    fireEvent.click(screen.getByRole('button', { name: 'Rename workspace' }))
    fireEvent.keyDown(screen.getByLabelText('Workspace title'), { key: 'Enter', isComposing: true })
    fireEvent.keyDown(screen.getByLabelText('Workspace title'), { key: 'Escape' })
    expect(heading()).toBe('Fix the build')
    fireEvent.click(createButton())
    expect(sent(CREATE).at(-1)).toMatchObject({
      project: 'proj', tool: 'claude', title: 'Fix the build', group: 'g-other',
    })
    // The optimistic row is in the group from the start.
    expect(provision.mock.calls[0][5]).toBe('g-other')

    // A group with a live member is offered. "+ New group" shows a name box,
    // where Escape returns to the dropdown instead of closing the dialog.
    cleanup()
    useUiStore.setState({ createWorkspaceDialog: null })
    snapshot.mockReturnValue(project({}, 'k8s', {
      workspaces: [{ ...PARENT, groupId: 'g-review' }], workspaceGroups: GROUPS,
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
    // Sent by name for the server to create; there is no id yet.
    expect(sent(CREATE).at(-1)).toMatchObject({ project: 'proj', tool: 'claude', group: 'Release prep' })
    expect(provision.mock.calls[1][5]).toBeUndefined()
  })

  // The remembered branch (see the first test) falls back to origin's
  // default when origin no longer has it.
  it('opens on origin\'s default when origin lost the branch last created from', async () => {
    server.route(BRANCH_LIST, { ...BRANCHES, defaultBranch: 'dev' })
    snapshot.mockReturnValue(project({ lastBranch: 'deleted' }))
    await openMenu()
    await waitFor(() => expect(branchInput().value).toBe('dev'))
  })

  // Whether origin still has it is only known once the list lands.
  it('sends a remembered branch only once the list confirms it', async () => {
    let land: (b: ProjectBranches) => void = () => {}
    const landed = new Promise<ProjectBranches>((r) => { land = r })
    server.route(BRANCH_LIST, () => landed)
    snapshot.mockReturnValue(project({ lastBranch: 'dev' }))
    await openMenu()
    await waitFor(() => expect(createButton().title).toBe('Loading branches…'))
    expect(branchInput().value).toBe('dev')
    expect(createButton().disabled).toBe(true)

    act(() => land(BRANCHES))
    await waitFor(() => expect(createButton().disabled).toBe(false))
    fireEvent.click(createButton())
    expect(sent(CREATE).at(-1)).toMatchObject({ project: 'proj', tool: 'claude', branch: 'dev' })
  })

  it('leaves the branch to the server when the list fails to load', async () => {
    server.route(BRANCH_LIST, serverError('INTERNAL', 'boom'))
    snapshot.mockReturnValue(project({ lastBranch: 'dev' }))
    await openMenu()
    await waitFor(() => expect(createButton().disabled).toBe(false))
    expect(branchInput().value).toBe('')

    fireEvent.click(createButton())
    expect(sent(CREATE)[0]).not.toHaveProperty('branch')
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
    expect(sent(CREATE).at(-1)).toMatchObject({ project: 'proj', tool: 'claude', branch: 'release/2.x' })
  })

  describe('queueing', () => {
    // A child defaults to its parent's settings: the first conversation's
    // agent and model, the permission mode, and the fork branch. All are sent
    // as concrete values.
    it('seeds from the parent workspace and queues with every setting concrete', async () => {
      server.route(AUTH_LIST, SIGNED_IN)
      snapshot.mockReturnValue(project({}, 'k8s', {
        workspaces: [{ ...PARENT, groupId: 'g-review' }], workspaceGroups: GROUPS,
      }))
      await openWith({ parent: 'w-parent' })

      expect(select('Start').value).toBe('w-parent')
      expect(select('Group').value).toBe('g-review')
      expect(select('Agent').value).toBe('codex')
      expect(modelInput().value).toBe('GPT-5.5')
      expect(select('Permissions').value).toBe('accept-edits')
      await waitFor(() => expect(branchInput().value).toBe('dev'))
      expect(screen.getByText('latest from origin when it starts')).toBeTruthy()

      // A queued workspace runs unattended, so it needs something to do.
      expect(submitButton().disabled).toBe(true)
      fireEvent.change(promptInput(), { target: { value: 'follow up' } })
      retitle('Follow-up')
      fireEvent.click(submitButton())

      await waitFor(() => expect(sent(QUEUE)).toEqual([{
        project: 'proj', parent: 'w-parent',
        prompt: 'follow up', tool: 'codex', model: 'gpt-5.5', mode: 'tui', permissionMode: 'accept-edits', branch: 'dev',
        title: 'Follow-up', group: 'g-review',
      }]))
      expect(sent(CREATE)).toHaveLength(0)
      await waitFor(() => expect(screen.queryByLabelText('Agent')).toBeNull())
      // The sidebar opens the set it landed in.
      expect(useUiStore.getState().revealQueued).toEqual({ id: 'q-new', parent: 'w-parent' })
    })

    it('re-seeds only untouched fields when Start changes', async () => {
      server.route(AUTH_LIST, SIGNED_IN)
      snapshot.mockReturnValue(project({}, 'k8s', {
        workspaces: [{ ...PARENT, groupId: 'g-review' }], workspaceGroups: GROUPS,
      }))
      await openReady()
      expect(select('Agent').value).toBe('claude')
      expect(select('Group').value).toBe('')
      expect(screen.getByRole('button', { name: 'Create' })).toBeTruthy()

      fireEvent.change(select('Permissions'), { target: { value: 'plan' } })
      fireEvent.change(select('Start'), { target: { value: 'w-parent' } })
      // The group follows the parent until it is picked.
      expect(select('Group').value).toBe('g-review')
      // The agent was untouched, so it follows the parent, and the new agent
      // brings its own remembered permission mode.
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
      server.route(AUTH_LIST, SIGNED_IN)
      snapshot.mockReturnValue(project({}, 'k8s', {
        workspaces: [PARENT],
        queuedWorkspaces: [entry('q1', { groupId: 'g-review', generatedTitle: 'Generated' })],
        workspaceGroups: GROUPS,
      }))
      await openWith({ editId: 'q1' })
      // An untitled entry's edit is headed by its generated title.
      expect(heading()).toBe('Generated')
      expect(select('Group').value).toBe('g-review')
      fireEvent.change(select('Group'), { target: { value: option('Group', '+ New group').value } })
      const name = screen.getByLabelText('New group name')
      fireEvent.change(name, { target: { value: '   ' } })
      expect(submitButton().disabled).toBe(true)
      expect(submitButton().title).toBe('Name the new group')
      fireEvent.keyDown(name, { key: 'Enter' })
      expect(sent(UPDATE)).toHaveLength(0)

      // × restores its own group. Review holds only a queued entry, and is
      // still offered after the entry moves off its parent.
      fireEvent.click(screen.getByRole('button', { name: 'Pick an existing group' }))
      expect(select('Group').value).toBe('g-review')
      fireEvent.change(select('Group'), { target: { value: '' } })
      expect([...select('Group').options].map((o) => o.textContent))
        .toEqual(['None', 'Review', 'Other', '+ New group'])
    })

    it('surfaces a refused queue and stays open', async () => {
      server.route(AUTH_LIST, SIGNED_IN)
      snapshot.mockReturnValue(project({}, 'k8s', { workspaces: [PARENT] }))
      server.route(QUEUE, serverError('VALIDATION', 'no model is known for that tool', 400))
      await openWith({ parent: 'w-parent' })
      fireEvent.change(promptInput(), { target: { value: 'x' } })
      fireEvent.click(submitButton())
      await waitFor(() => expect(screen.getByText('no model is known for that tool')).toBeTruthy())
      expect(screen.getByLabelText('Agent')).toBeTruthy()
    })
  })

  describe('editing a queued workspace', () => {
    const chain = [
      entry('q1'),
      entry('q2', { parentWorkspaceId: undefined, parentQueuedId: 'q1', title: 'Second', groupId: 'g-review' }),
      entry('q3', { parentWorkspaceId: undefined, parentQueuedId: 'q2' }),
      entry('q4', { prompt: 'sibling' }),
    ]

    it('opens on the entry\'s own settings and never offers a cycle', async () => {
      server.route(AUTH_LIST, SIGNED_IN)
      snapshot.mockReturnValue(project({}, 'k8s', {
        workspaces: [PARENT], queuedWorkspaces: chain, workspaceGroups: GROUPS,
      }))
      await openWith({ editId: 'q2' })

      expect(promptInput().value).toBe('step q2')
      expect(heading()).toBe('Second')
      expect(select('Group').value).toBe('g-review')
      expect(select('Start').value).toBe('q1')
      expect(modelInput().value).toBe('Sonnet 5')
      expect(select('Permissions').value).toBe('manual')
      expect(branchInput().value).toBe('release/2.x')
      // Itself and its descendants would form a chain that never starts.
      const offered = [...select('Start').options].map((o) => o.value)
      expect(offered).toEqual(['', 'w-parent', 'q1', 'q4'])
      expect(submitButton().textContent).toBe('Save')
      expect(screen.queryByRole('button', { name: 'Save draft' })).toBeNull()

      server.route(UPDATE, entry('q2', { parentWorkspaceId: undefined, parentQueuedId: 'q4' }))
      fireEvent.change(select('Start'), { target: { value: 'q4' } })
      // Its own group, not the new parent's; a cleared title goes back to auto.
      expect(select('Group').value).toBe('g-review')
      retitle('')
      fireEvent.change(select('Group'), { target: { value: '' } })
      fireEvent.click(submitButton())
      await waitFor(() => expect(sent(UPDATE)).toEqual([{
        id: 'q2', prompt: 'step q2', tool: 'claude', model: 'claude-sonnet-5', mode: 'tui', permissionMode: 'manual',
        branch: 'release/2.x', title: '', group: null, parent: 'q4',
      }]))
      expect(sent(RUN)).toHaveLength(0)
      // The sidebar opens the set the server says it landed in.
      await waitFor(() => expect(useUiStore.getState().revealQueued).toEqual({ id: 'q2', parent: 'q4' }))
    })

    it('offers a held parent it already waits on, and "Now" saves then runs', async () => {
      snapshot.mockReturnValue(project({}, 'k8s', {
        queuedWorkspaces: [entry('q1', { parentWorkspaceId: 'w-held' })],
        heldWorkspaces: [{ workspaceId: 'w-held', projectId: 'proj', tool: 'claude', title: 'Died', stoppedAt: '' }],
      }))
      await openWith({ editId: 'q1' })
      expect(option('Start', 'After “Died” stops')).toBeTruthy()

      fireEvent.change(select('Start'), { target: { value: '' } })
      fireEvent.click(submitButton())
      await waitFor(() => expect(sent(RUN)).toEqual([{ id: 'q1' }]))
      // Saved as it stands, without a parent: running it is what "Now" means.
      expect(sent(UPDATE)[0]).not.toHaveProperty('parent')
      expect(useUiStore.getState().revealQueued).toBeNull()
    })

    it('says so when the entry has already started', async () => {
      mount()
      act(() => useUiStore.getState().openCreateWorkspace({ projectId: 'proj', editId: 'gone' }))
      await waitFor(() => expect(screen.getByText('Queued workspace gone')).toBeTruthy())
    })
  })

  describe('drafts', () => {
    const closeX = (): void => { fireEvent.click(screen.getByRole('button', { name: 'Close' })) }
    const draft = (extra: Partial<DraftWorkspaceEntry> = {}): DraftWorkspaceEntry => ({
      id: 'd1', projectId: 'proj', prompt: 'half an idea', tool: 'codex', mode: 'tui',
      permissionMode: 'read-only', model: 'gpt-5.5', branch: 'dev', createdAt: '', updatedAt: '', ...extra,
    })

    it('closes without asking when nothing was typed', async () => {
      await openReady()
      closeX()
      await waitFor(() => expect(useUiStore.getState().createWorkspaceDialog).toBeNull())
      expect(screen.queryByText('Save as a draft?')).toBeNull()
    })

    it('asks on dismissal with a prompt, and saves every setting as shown', async () => {
      server.route(AUTH_LIST, SIGNED_IN)
      snapshot.mockReturnValue(project({}, 'k8s', {
        workspaces: [{ ...PARENT, groupId: 'g-review' }], workspaceGroups: GROUPS,
      }))
      await openReady()
      fireEvent.change(promptInput(), { target: { value: '  later, maybe  ' } })
      retitle('Someday')
      fireEvent.change(select('Permissions'), { target: { value: 'plan' } })

      // A reload is guarded like a close.
      const unload = new Event('beforeunload', { cancelable: true })
      window.dispatchEvent(unload)
      expect(unload.defaultPrevented).toBe(true)

      closeX()
      fireEvent.click(await screen.findByRole('button', { name: 'Keep editing' }))
      await waitFor(() => expect(screen.queryByText('Save as a draft?')).toBeNull())
      expect(useUiStore.getState().createWorkspaceDialog).not.toBeNull()
      fireEvent.change(select('Start'), { target: { value: 'w-parent' } })

      closeX()
      fireEvent.click(await screen.findByRole('button', { name: 'Save draft' }))
      await waitFor(() => expect(useUiStore.getState().createWorkspaceDialog).toBeNull())
      expect(sent(SAVE_DRAFT)).toEqual([{
        project: 'proj', prompt: 'later, maybe', tool: 'codex', model: 'gpt-5.5', mode: 'tui', permissionMode: 'accept-edits',
        branch: 'dev', startAfter: 'w-parent', title: 'Someday', groupId: 'g-review',
      }])
      expect(sent(CREATE)).toHaveLength(0)
      expect(sent(QUEUE)).toHaveLength(0)
      const after = new Event('beforeunload', { cancelable: true })
      window.dispatchEvent(after)
      expect(after.defaultPrevented).toBe(false)
    })

    it('saves a draft from its own button once a prompt is typed, without asking', async () => {
      await openReady()
      const save = screen.getByRole<HTMLButtonElement>('button', { name: 'Save draft' })
      expect(save.disabled).toBe(true)
      fireEvent.change(promptInput(), { target: { value: 'for later' } })
      expect(save.disabled).toBe(false)
      // A browser keeps the form clickable through the close animation;
      // jsdom has none, so hold the close back to reach that window.
      const realClose = useUiStore.getState().closeCreateWorkspace
      const close = vi.fn()
      act(() => useUiStore.setState({ closeCreateWorkspace: close }))
      try {
        fireEvent.click(save)
        expect(save.textContent).toBe('Saving…')
        expect(createButton().textContent).toBe('Create')
        await waitFor(() => expect(close).toHaveBeenCalled())
        // Clicks after the save resolves repeat nothing.
        await waitFor(() => expect(save.textContent).toBe('Save draft'))
        expect(save.disabled).toBe(true)
        expect(createButton().disabled).toBe(true)
        fireEvent.click(save)
        fireEvent.click(createButton())
      } finally {
        useUiStore.setState({ closeCreateWorkspace: realClose })
      }
      expect(sent(SAVE_DRAFT)).toHaveLength(1)
      expect(sent(SAVE_DRAFT)[0]).toMatchObject({ project: 'proj', prompt: 'for later' })
      expect(sent(SAVE_DRAFT)[0]).not.toHaveProperty('id')
      expect(screen.queryByText('Save as a draft?')).toBeNull()
      expect(sent(CREATE)).toHaveLength(0)
    })

    it('keeps a typed prompt as a draft on the way to missing credentials', async () => {
      // Codex was last used, but only Claude is signed in.
      snapshot.mockReturnValue(project({ lastTool: 'codex' }))
      await openMenu()
      const signIn = await screen.findByRole('button', { name: 'Sign in to Codex…' })
      fireEvent.change(promptInput(), { target: { value: 'first thing' } })
      fireEvent.click(signIn)
      await waitFor(() => expect(useUiStore.getState().settingsOpen).toBe(true))
      expect(sent(SAVE_DRAFT)).toEqual([expect.objectContaining({ project: 'proj', prompt: 'first thing', tool: 'codex' })])
      expect(sent(SAVE_DRAFT)[0]).not.toHaveProperty('id')
      expect(useUiStore.getState().createWorkspaceDialog).toBeNull()
    })

    it('reopens a draft on its fields, asks only once it changes, and a create consumes it', async () => {
      server.route(AUTH_LIST, SIGNED_IN)
      // Its Start parent has gone since it was saved: it starts now instead.
      snapshot.mockReturnValue(project({}, 'k8s', { draftWorkspaces: [draft({ startAfter: 'w-gone' })] }))
      mount()
      act(() => useUiStore.getState().openCreateWorkspace({ projectId: 'proj', draftId: 'd1' }))
      await createReady()
      expect(promptInput().value).toBe('half an idea')
      expect(heading()).toBe('New workspace')
      expect(select('Start').value).toBe('')
      expect(select('Agent').value).toBe('codex')
      expect(modelInput().value).toBe('GPT-5.5')
      expect(select('Permissions').value).toBe('read-only')
      await waitFor(() => expect(branchInput().value).toBe('dev'))

      // A generated title landing while open heads the dialog; whitespace is
      // not an edit, but a real edit drops it until reverted.
      snapshot.mockReturnValue(project({}, 'k8s', {
        draftWorkspaces: [draft({ startAfter: 'w-gone', generatedTitle: 'Half an idea' })],
      }))
      fireEvent.change(promptInput(), { target: { value: 'half an idea \n' } })
      expect(heading()).toBe('Half an idea')
      fireEvent.change(promptInput(), { target: { value: 'a whole idea' } })
      expect(heading()).toBe('New workspace')
      fireEvent.change(promptInput(), { target: { value: 'half an idea' } })
      expect(heading()).toBe('Half an idea')

      fireEvent.change(promptInput(), { target: { value: 'a whole idea' } })
      closeX()
      fireEvent.click(await screen.findByRole('button', { name: 'Save changes' }))
      await waitFor(() => expect(useUiStore.getState().createWorkspaceDialog).toBeNull())
      expect(sent(SAVE_DRAFT).at(-1)).toMatchObject({ project: 'proj', prompt: 'a whole idea', id: 'd1' })

      // Deleted meanwhile (another tab created from it): saved as a new draft.
      cleanup()
      forget()
      let saves = 0
      server.route(SAVE_DRAFT, ({ body }: { body: Body }) => (saves++ === 0
        ? serverError('NOT_FOUND', 'project proj has no draft workspace d1', 404)
        : { ...draft(), ...body, id: 'd-new' }))
      mount()
      act(() => useUiStore.getState().openCreateWorkspace({ projectId: 'proj', draftId: 'd1' }))
      await createReady()
      fireEvent.change(promptInput(), { target: { value: 'kept anyway' } })
      closeX()
      fireEvent.click(await screen.findByRole('button', { name: 'Save changes' }))
      await waitFor(() => expect(useUiStore.getState().createWorkspaceDialog).toBeNull())
      expect(sent(SAVE_DRAFT).map((b) => b.id)).toEqual(['d1', undefined])
      expect(sent(SAVE_DRAFT)[1]).toMatchObject({ prompt: 'kept anyway' })

      // Reopened exactly as saved, a dismissal has nothing to lose.
      cleanup()
      snapshot.mockReturnValue(project({}, 'k8s', { draftWorkspaces: [draft()] }))
      mount()
      act(() => useUiStore.getState().openCreateWorkspace({ projectId: 'proj', draftId: 'd1' }))
      await createReady()
      const save = screen.getByRole<HTMLButtonElement>('button', { name: 'Save draft' })
      expect(save.disabled).toBe(true)
      expect(save.title).toBe('No changes to save')
      closeX()
      await waitFor(() => expect(useUiStore.getState().createWorkspaceDialog).toBeNull())
      expect(screen.queryByText('Save changes to this draft?')).toBeNull()

      // Once changed, Save draft updates it in place.
      cleanup()
      forget()
      mount()
      act(() => useUiStore.getState().openCreateWorkspace({ projectId: 'proj', draftId: 'd1' }))
      await createReady()
      fireEvent.change(select('Permissions'), { target: { value: 'bypass' } })
      fireEvent.click(screen.getByRole('button', { name: 'Save draft' }))
      await waitFor(() => expect(useUiStore.getState().createWorkspaceDialog).toBeNull())
      expect(sent(SAVE_DRAFT)).toEqual([expect.objectContaining({ project: 'proj', permissionMode: 'bypass', id: 'd1' })])

      // A title and group of its own ride the create.
      cleanup()
      snapshot.mockReturnValue(project({}, 'k8s', {
        draftWorkspaces: [draft({ title: 'Named', groupId: 'g-other' })], workspaceGroups: GROUPS,
      }))
      mount()
      act(() => useUiStore.getState().openCreateWorkspace({ projectId: 'proj', draftId: 'd1' }))
      await createReady()
      expect(heading()).toBe('Named')
      expect(select('Group').value).toBe('g-other')
      fireEvent.click(createButton())
      // The server deletes the draft only once the create succeeds.
      expect(sent(CREATE)).toEqual([{
      project: 'proj', tool: 'codex', workspaceId: expect.any(String) as string,
        branch: 'dev', model: 'gpt-5.5', permissionMode: 'read-only', mode: 'tui', prompt: 'half an idea',
        title: 'Named', group: 'g-other', draftId: 'd1', draftOnFailure: true,
      }])
      expect(sent(DISCARD_DRAFT)).toHaveLength(0)
    })

    it('keeps an untouched draft group following Start, and a picked one where it was', async () => {
      const other = { ...PARENT, workspaceId: 'w-other', title: 'Other work', groupId: 'g-other' }
      const open = async (d: DraftWorkspaceEntry): Promise<void> => {
        cleanup()
        useUiStore.setState({ createWorkspaceDialog: null })
        snapshot.mockReturnValue(project({}, 'k8s', {
          workspaces: [{ ...PARENT, groupId: 'g-review' }, other], workspaceGroups: GROUPS, draftWorkspaces: [d],
        }))
        mount()
        act(() => useUiStore.getState().openCreateWorkspace({ projectId: 'proj', draftId: 'd1' }))
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
        draftWorkspaces: [draft({ groupId: 'g-other' })], workspaceGroups: GROUPS,
      }))
      mount()
      act(() => useUiStore.getState().openCreateWorkspace({ projectId: 'proj', draftId: 'd1' }))
      await waitFor(() => expect(screen.getByLabelText('Group')).toBeTruthy())
      fireEvent.change(select('Group'), { target: { value: option('Group', '+ New group').value } })
      fireEvent.change(screen.getByLabelText('New group name'), { target: { value: 'Not yet made' } })
      fireEvent.change(promptInput(), { target: { value: 'half an idea, and more' } })
      closeX()
      fireEvent.click(await screen.findByRole('button', { name: 'Save changes' }))
      await waitFor(() => expect(useUiStore.getState().createWorkspaceDialog).toBeNull())
      expect(sent(SAVE_DRAFT)[0]).toMatchObject({ groupId: 'g-other' })
    })

    it('queueing from a draft names it, for the server to drop once queued', async () => {
      server.route(AUTH_LIST, SIGNED_IN)
      snapshot.mockReturnValue(project({}, 'k8s', {
        workspaces: [PARENT], draftWorkspaces: [draft({ startAfter: 'w-parent' })],
      }))
      await openWith({ draftId: 'd1' })
      expect(select('Start').value).toBe('w-parent')
      fireEvent.click(submitButton())
      await waitFor(() => expect(sent(QUEUE)).toEqual([expect.objectContaining({
        project: 'proj', parent: 'w-parent', prompt: 'half an idea', permissionMode: 'read-only', draftId: 'd1',
      })]))
      expect(sent(DISCARD_DRAFT)).toHaveLength(0)
    })
  })
})
