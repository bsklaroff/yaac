import { useState, type JSX } from 'react'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { act, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import type {
  AuthListResult, DraftWorkspaceEntry, QueuedWorkspaceEntry, ServerSnapshot, WorkspaceListEntry,
} from '@yaac/shared/types'
import { LeaveNewWorkspaceDialog, NewWorkspacePane } from '#components/NewWorkspacePane'
import { NewWorkspaceButton } from '#components/NewWorkspaceButton'
import { flushTypedText, loadPersisted, useUiStore } from '#lib/store'
import type { NewWorkspaceOpts } from '#lib/newWorkspace'
import type { ProjectBranches } from '#lib/useProjectBranches'
import { mockFetch, renderWithClient, serverError, typeInto, type FetchMock } from './harness'

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
function project(memory: Record<string, unknown> = {}, driver = 'k8s', extra: Record<string, unknown> = {}): ServerSnapshot {
  return {
    driver,
    projects: [{ id: 'proj', name: 'proj', createDefaults: {}, gitCredential: { id: 'c1', name: 'github.com token' }, ...memory }],
    workspaces: [],
    queuedWorkspaces: [],
    heldWorkspaces: [],
    draftWorkspaces: [],
    provisioning: [],
    ...extra,
  } as unknown as ServerSnapshot
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
const PROMPT = 'GET /api/workspace/prompt'

type Body = Record<string, unknown>
let server: FetchMock
/** The bodies sent to one route, in order. */
const sent = (route: string): Body[] => server.called(route).map((c) => c.body as Body)
/** Forget the requests so far, between phases of one test. */
const forget = (): void => { server.calls.length = 0 }
const setSnapshot = (snapshot: ServerSnapshot | undefined): void => useUiStore.setState({ snapshot })

const initial = useUiStore.getState()
beforeEach(() => {
  useUiStore.setState(initial, true)
  useUiStore.setState({ activeProjectId: 'proj', selectedWorkspaceId: null })
  setSnapshot(project())
  server = mockFetch({
    [AUTH_LIST]: CLAUDE_ONLY,
    [BRANCH_LIST]: BRANCHES,
    // A queued entry's or draft's whole prompt, here the snapshot's own.
    [PROMPT]: ({ query }: { query: URLSearchParams }) => {
      const snapshot = useUiStore.getState().snapshot
      const row = [...snapshot?.queuedWorkspaces ?? [], ...snapshot?.draftWorkspaces ?? []]
        .find((r) => r.id === query.get('id'))
      return row !== undefined ? { prompt: row.prompt } : serverError('NOT_FOUND', 'gone', 404)
    },
    // The create's NDJSON stream, cut to its terminal event: a cold create,
    // listed under the id it was given.
    [CREATE]: ({ body }: { body: Body }) => (
      { type: 'result', result: { workspaceId: body.workspaceId, jobName: 'job', tool: body.tool } }),
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
  })
})

afterEach(() => {
  cleanup()
  flushTypedText()
  localStorage.clear()
})

/** The pane under the header bar WorkspaceView gives it. */
function PaneWithBar(): JSX.Element {
  const [bar, setBar] = useState<HTMLElement | null>(null)
  return (
    <>
      <header ref={setBar} />
      <NewWorkspacePane projectId="proj" bar={bar} />
    </>
  )
}

/** Mount the pane as WorkspaceView does with nothing selected, beside the
 *  sidebar's + and App's leave dialog. */
function mount(): void {
  renderWithClient(
    <>
      <NewWorkspaceButton projectId="proj" />
      <PaneWithBar />
      <LeaveNewWorkspaceDialog />
    </>,
  )
}

/** Open the pane the way a row menu or a sidebar row does. */
async function openWith(opts: Omit<NewWorkspaceOpts, 'projectId'>): Promise<void> {
  act(() => useUiStore.getState().openNewWorkspace({ projectId: 'proj', ...opts }))
  mount()
  await waitFor(() => expect(sendButton().title).not.toBe('Loading…'))
}

/** Mount, and wait until the credential list has landed. Until then
 *  creating is blocked. */
async function openReady(): Promise<void> {
  mount()
  await waitFor(() => expect(sendButton().title).not.toMatch(/^Loading|first$/))
}

const promptInput = (): HTMLTextAreaElement => screen.getByLabelText<HTMLTextAreaElement>('Prompt')
const typePrompt = (text: string): void => { fireEvent.change(promptInput(), { target: { value: text } }) }
const sendButton = (): HTMLButtonElement => screen.getByRole<HTMLButtonElement>('button', { name: /^(Create|Queue|Save)$/ })
const emptyButton = (): HTMLButtonElement =>
  screen.getByRole<HTMLButtonElement>('button', { name: 'Start without a prompt' })
const barButton = (name: 'New Shell' | 'Browse files' | 'Show changes'): HTMLButtonElement =>
  screen.getByRole<HTMLButtonElement>('button', { name })
const branchInput = (): HTMLInputElement => screen.getByLabelText<HTMLInputElement>('Base branch')
const modelInput = (): HTMLInputElement => screen.getByLabelText<HTMLInputElement>('Model')
const select = (label: string): HTMLSelectElement => screen.getByLabelText<HTMLSelectElement>(label)
const option = (label: string, text: string): HTMLOptionElement =>
  [...select(label).options].find((o) => o.textContent?.startsWith(text))!
const heading = (): string => screen.getByRole('heading').textContent ?? ''
const posture = (): string => screen.getByRole('button', { name: 'Permission mode' }).textContent ?? ''
const effortShown = (): string => screen.getByRole('button', { name: 'Effort' }).textContent ?? ''

/** The items of the composer's posture or effort menu, by name, closing it. */
async function menuItems(menu: 'Permission mode' | 'Effort'): Promise<string[]> {
  fireEvent.click(screen.getByRole('button', { name: menu }))
  const items = await screen.findAllByRole('menuitemradio')
  const names = items.map((i) => i.querySelector('.text-text')?.textContent ?? '')
  fireEvent.click(items.find((i) => i.getAttribute('aria-checked') === 'true') ?? items[0])
  await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
  return names
}

/** Pick from the composer's posture or effort menu. */
async function pick(menu: 'Permission mode' | 'Effort', name: string): Promise<void> {
  fireEvent.click(screen.getByRole('button', { name: menu }))
  const items = await screen.findAllByRole('menuitemradio')
  fireEvent.click(items.find((i) => i.querySelector('.text-text')?.textContent === name)!)
  await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
}

function pickModel(text: string): void {
  typeInto(modelInput(), text)
  fireEvent.keyDown(modelInput(), { key: 'Enter' })
}

/** Rename through the heading's pencil, as every other rename is done. */
function retitle(text: string): void {
  fireEvent.click(screen.getByRole('button', { name: 'Rename workspace' }))
  const input = screen.getByLabelText<HTMLInputElement>('Workspace title')
  fireEvent.change(input, { target: { value: text } })
  fireEvent.keyDown(input, { key: 'Enter' })
}

/** Navigate away, as clicking another workspace does. */
const leave = (): void => act(() => useUiStore.getState().selectWorkspace('w-elsewhere'))

describe('NewWorkspacePane', () => {
  it('opens on the project\'s last agent with what it last used, and creates with all of it', async () => {
    server.route(AUTH_LIST, SIGNED_IN)
    setSnapshot(project({
      lastTool: 'codex',
      lastBranch: 'dev',
      createDefaults: { codex: { model: 'gpt-5.5', permissionMode: 'read-only' } },
    }))
    await openReady()

    expect(select('Agent').value).toBe('codex')
    expect(branchInput().value).toBe('dev')
    // Shown by name, sent by id.
    expect(modelInput().value).toBe('GPT-5.5')
    expect(posture()).toBe('Read-only')
    expect(select('UI').value).toBe('acp')
    // A chat starts from a prompt.
    expect(sendButton().disabled).toBe(true)
    expect(sendButton().title).toBe('Type a prompt')

    typePrompt('  tidy the parser ')
    fireEvent.click(sendButton())
    // Every field is sent, so every field becomes the next default.
    expect(sent(CREATE)).toEqual([{
      project: 'proj', tool: 'codex', workspaceId: expect.any(String) as string, prompt: 'tidy the parser',
      branch: 'dev', model: 'gpt-5.5', permissionMode: 'read-only', mode: 'acp', draftOnFailure: true,
    }])
    // The create opens at once, its row naming the model and prompt.
    const state = useUiStore.getState()
    const row = state.optimisticProvisioning[0]
    expect(row).toMatchObject({
      projectId: 'proj', tool: 'codex', kind: 'create', model: 'gpt-5.5', modelName: 'GPT-5.5',
      prompt: 'tidy the parser',
    })
    expect(state.selectedWorkspaceId).toBe(row.workspaceId)
    // Its chat pane shows the prompt until the agent echoes it; the form is spent.
    expect(state.launches).toEqual({ [row.workspaceId]: { prompt: 'tidy the parser' } })
    expect(state.newWorkspace).toBeNull()
    await waitFor(() => expect(useUiStore.getState().inFlightProvisions).toEqual([]))
  })

  // Without the snapshot a containerless server would look sandboxed and get
  // bypass, so creating waits for it.
  it('falls back per field, and offers no create before the snapshot lands', async () => {
    setSnapshot(undefined)
    mount()
    await waitFor(() => expect(modelInput().value).toBe('Opus 5.5'))
    typePrompt('x')
    expect(sendButton().disabled).toBe(true)
    expect(sendButton().title).toBe('Loading…')

    act(() => setSnapshot(project({}, 'containerless')))
    await waitFor(() => expect(sendButton().disabled).toBe(false))
    expect(select('Agent').value).toBe('claude')
    expect(modelInput().value).toBe('Opus 5.5')
    expect(posture()).toBe('Accept edits')
    expect(select('UI').value).toBe('acp')
    // Bypass can still be picked there, with a warning.
    fireEvent.click(screen.getByRole('button', { name: 'Permission mode' }))
    expect(await screen.findByText('No sandbox — acts as you.')).toBeTruthy()
  })

  it('reloads an agent\'s own memory and options when the agent changes', async () => {
    server.route(AUTH_LIST, SIGNED_IN)
    setSnapshot(project({
      createDefaults: {
        claude: { model: 'claude-sonnet-5', permissionMode: 'manual', mode: 'acp' },
        codex: { model: 'gpt-5.5' },
      },
    }))
    await openReady()
    expect(modelInput().value).toBe('Sonnet 5')
    expect(posture()).toBe('Manual permissions')

    fireEvent.change(select('Agent'), { target: { value: 'codex' } })
    expect(modelInput().value).toBe('GPT-5.5')
    expect(posture()).toBe('Bypass permissions')
    expect(select('UI').value).toBe('acp')

    // pi has no permission system, so bypass is all it offers.
    fireEvent.change(select('Agent'), { target: { value: 'pi' } })
    expect(await menuItems('Permission mode')).toEqual(['Bypass permissions'])
    expect(modelInput().value).toBe('Claude Opus 4.8')
  })

  // docs/effort-levels.md. Levels are the model's own; a pick or the
  // remembered level stands where the model has it, else its default.
  it("offers the model's own effort levels, keeps a level the next model has, and sends it", async () => {
    const efforts = {
      ...CLAUDE,
      models: [
        { id: 'claude-opus-5-5', name: 'Opus 5.5', efforts: { levels: ['low', 'medium', 'high', 'max'], default: 'medium' } },
        { id: 'claude-sonnet-5', name: 'Sonnet 5', efforts: { levels: ['low', 'high'], default: 'high' } },
        { id: 'claude-haiku-4-5', name: 'Haiku 4.5' },
      ],
    }
    server.route(AUTH_LIST, { gitCredentials: [], toolAuth: [efforts] })
    setSnapshot(project({ createDefaults: { claude: { effort: 'max' } } }))
    await openReady()
    expect(effortShown()).toBe('Max effort')
    expect(await menuItems('Effort')).toEqual(['Low', 'Medium', 'High', 'Max'])

    // Sonnet has no max: its default instead. A pick it has then stays.
    pickModel('claude-sonnet')
    expect(effortShown()).toBe('High effort')
    await pick('Effort', 'Low')
    pickModel('claude-opus')
    expect(effortShown()).toBe('Low effort')
    typePrompt('go')
    fireEvent.click(sendButton())
    expect(sent(CREATE).at(-1)).toMatchObject({ model: 'claude-opus-5-5', effort: 'low' })

    // A model with no levels has no effort to send.
    forget()
    pickModel('claude-haiku')
    expect(screen.queryByRole('button', { name: 'Effort' })).toBeNull()
    typePrompt('go')
    fireEvent.click(sendButton())
    expect(sent(CREATE).at(-1)).not.toHaveProperty('effort')
  })

  it('searches models by name or id, and Enter picks before it creates', async () => {
    await openReady()
    typePrompt('go')

    typeInto(modelInput(), 'sonnet')
    expect(screen.getByText('Sonnet 5')).toBeTruthy()
    expect(screen.queryByText('Opus 5.5')).toBeNull()
    // Mid-edit text is a search, not a pick.
    expect(sendButton().disabled).toBe(true)
    expect(sendButton().title).toBe('Pick a model from the list')

    typeInto(modelInput(), 'claude-sonnet')
    fireEvent.keyDown(modelInput(), { key: 'Enter' })
    expect(modelInput().value).toBe('Sonnet 5')
    expect(sent(CREATE)).toHaveLength(0)

    fireEvent.keyDown(modelInput(), { key: 'Enter' })
    expect(sent(CREATE).at(-1)).toMatchObject({ project: 'proj', tool: 'claude', model: 'claude-sonnet-5' })
  })

  it('closes a suggestion list on Escape, keeping the form and its prompt', async () => {
    await openReady()
    typePrompt('keep me')

    typeInto(modelInput(), 'sonnet')
    expect(screen.getByText('Sonnet 5')).toBeTruthy()
    fireEvent.keyDown(modelInput(), { key: 'Escape' })
    expect(screen.queryByText('Sonnet 5')).toBeNull()

    typeInto(branchInput(), 're')
    expect(screen.getByText('release/2.x')).toBeTruthy()
    fireEvent.keyDown(branchInput(), { key: 'Escape' })
    expect(screen.queryByText('release/2.x')).toBeNull()

    // With no list open, Escape has nothing to close: the pane is no dialog.
    fireEvent.keyDown(modelInput(), { key: 'Escape' })
    expect(promptInput().value).toBe('keep me')
    expect(useUiStore.getState().newWorkspace).toMatchObject({ prompt: 'keep me' })
    expect(screen.queryByText('Save as a draft?')).toBeNull()
  })

  it('takes only models and branches the lists have', async () => {
    await openReady()
    await waitFor(() => expect(branchInput().value).toBe('main'))
    typePrompt('go')

    for (const [input, typed, shown] of [
      [modelInput, 'claude-next', 'Opus 5.5'],
      [branchInput, 'no-such-branch', 'main'],
    ] as const) {
      typeInto(input(), typed)
      expect(screen.getByText('No matches')).toBeTruthy()
      // Enter has nothing to pick, and the unpicked text cannot create.
      fireEvent.keyDown(input(), { key: 'Enter' })
      expect(sendButton().disabled).toBe(true)
      expect(sent(CREATE)).toHaveLength(0)
      // Escape reverts to the chosen value.
      fireEvent.keyDown(input(), { key: 'Escape' })
      expect(input().value).toBe(shown)
    }
  })

  it('creates on Enter in the prompt, a newline on Shift+Enter, and nothing from a button or without a prompt', async () => {
    await openReady()
    await waitFor(() => expect(branchInput().value).toBe('main'))
    // As in the model field, Enter picks the top match rather than creating.
    typeInto(branchInput(), 'de')
    fireEvent.keyDown(branchInput(), { key: 'Enter' })
    expect(branchInput().value).toBe('dev')
    fireEvent.keyDown(promptInput(), { key: 'Enter' })
    expect(sent(CREATE)).toHaveLength(0)

    typePrompt('fix the flaky test')
    fireEvent.keyDown(sendButton(), { key: 'Enter' })
    fireEvent.keyDown(promptInput(), { key: 'Enter', shiftKey: true })
    expect(sent(CREATE)).toHaveLength(0)

    fireEvent.keyDown(promptInput(), { key: 'Enter' })
    expect(sent(CREATE).at(-1)).toMatchObject({
      project: 'proj', tool: 'claude', branch: 'dev', model: 'claude-opus-5-5', permissionMode: 'bypass', mode: 'acp',
      prompt: 'fix the flaky test',
    })
  })

  // A chat needs a prompt; a terminal can start bare, to see the agent's UI.
  // Send needs a prompt; a workspace starts without one only from a button
  // pressed for that, in whichever UI is picked.
  it('starts a chat or a terminal without a prompt while none is typed', async () => {
    await openReady()
    expect(select('UI').value).toBe('acp')
    typePrompt('something')
    expect(emptyButton().disabled).toBe(true)
    typePrompt('')
    fireEvent.click(emptyButton())
    expect(sent(CREATE)).toEqual([expect.objectContaining({ project: 'proj', tool: 'claude', mode: 'acp' })])
    expect(sent(CREATE)[0]).not.toHaveProperty('prompt')
    const row = useUiStore.getState().optimisticProvisioning[0]
    expect(useUiStore.getState().selectedWorkspaceId).toBe(row.workspaceId)
    expect(useUiStore.getState().launches).toEqual({})

    forget()
    fireEvent.change(select('UI'), { target: { value: 'tui' } })
    fireEvent.click(emptyButton())
    expect(sent(CREATE)).toEqual([expect.objectContaining({ mode: 'tui' })])
    expect(sent(CREATE)[0]).not.toHaveProperty('prompt')

    // A terminal with a prompt has it typed in once it is up; only a chat
    // holds it for its pane.
    forget()
    fireEvent.change(select('UI'), { target: { value: 'tui' } })
    typePrompt('in the terminal')
    fireEvent.click(sendButton())
    expect(sent(CREATE)).toEqual([expect.objectContaining({ mode: 'tui', prompt: 'in the terminal' })])
    expect(useUiStore.getState().launches).toEqual({})
  })

  // The bar matches a workspace's, and its pane buttons start the workspace
  // now, then open that pane once it is up.
  it('starts the workspace from the bar, with or without a prompt, and holds the pane to open', async () => {
    await openReady()
    expect(screen.getByRole('button', { name: /Tile view|Tab view/ })).toBeTruthy()
    expect(barButton('Browse files').title).toBe('Start the workspace and browse its files')
    fireEvent.click(barButton('Browse files'))
    expect(sent(CREATE)).toEqual([expect.objectContaining({ mode: 'acp' })])
    expect(sent(CREATE)[0]).not.toHaveProperty('prompt')
    const first = useUiStore.getState().optimisticProvisioning[0].workspaceId
    expect(useUiStore.getState().launches).toEqual({ [first]: { pane: 'files' } })

    // A typed prompt rides along, and the chat holds it as well.
    forget()
    typePrompt('look around')
    fireEvent.click(barButton('New Shell'))
    expect(sent(CREATE)).toEqual([expect.objectContaining({ mode: 'acp', prompt: 'look around' })])
    const second = useUiStore.getState().optimisticProvisioning[1].workspaceId
    expect(useUiStore.getState().launches[second]).toEqual({ prompt: 'look around', pane: 'shell' })

    // What blocks a create blocks them too.
    forget()
    typeInto(modelInput(), 'sonn')
    expect(barButton('Show changes').disabled).toBe(true)
    expect(barButton('Show changes').title).toBe('Pick a model from the list')
  })

  it('sends a credential-less agent to settings → credentials, keeping the prompt', async () => {
    await openReady()
    typePrompt('first thing')
    fireEvent.change(select('Agent'), { target: { value: 'codex' } })

    expect(screen.getByText('Codex has no credentials')).toBeTruthy()
    expect(screen.queryByLabelText('Model')).toBeNull()
    expect(sendButton().disabled).toBe(true)
    expect(sendButton().title).toBe('Sign in to Codex first')
    fireEvent.keyDown(promptInput(), { key: 'Enter' })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in to Codex…' }))

    const state = useUiStore.getState()
    expect(state.settingsOpen).toBe(true)
    expect(state.settingsSection).toBe('credentials')
    expect(state.settingsFocusTool).toBe('codex')
    // The form waits here, so nothing needs saving as a draft.
    expect(state.newWorkspace).toMatchObject({ prompt: 'first thing', tool: 'codex' })
    expect(server.calls.filter((c) => c.method === 'POST')).toEqual([])
  })

  it('sends a project without a git credential to its row in settings', async () => {
    setSnapshot(project({ gitCredential: null }))
    mount()
    await waitFor(() => expect(sendButton().title).toBe('Add git authentication first'))
    expect(screen.getByText('This project has no git credential')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Add git authentication…' }))
    const state = useUiStore.getState()
    expect(state.settingsOpen).toBe(true)
    expect(state.settingsSection).toBe('credentials')
    expect(state.settingsFocusProject).toBe('proj')
  })

  // Opening from the + or Alt+N must leave keys typed next in the prompt,
  // and no focus ring on the +.
  it('focuses the prompt whenever it is opened', async () => {
    mount()
    await waitFor(() => expect(document.activeElement).toBe(promptInput()))
    const plus = screen.getByRole('button', { name: 'New workspace' })
    plus.focus()
    fireEvent.click(plus)
    expect(document.activeElement).toBe(promptInput())
  })

  it('names and files a create: a title off the heading and a picked or new group ride it', async () => {
    setSnapshot(project({}, 'k8s', { workspaceGroups: GROUPS }))
    await openReady()
    // "Now" has no parent to take a group from. Only groups the sidebar
    // shows are offered; Review is unpinned and empty.
    expect(select('Group').value).toBe('')
    expect([...select('Group').options].map((o) => o.textContent)).toEqual(['None', 'Other', '+ New group'])
    fireEvent.change(select('Group'), { target: { value: 'g-other' } })
    expect(heading()).toBe('New workspace')
    typePrompt('build it')
    retitle('  Fix   the build ')
    // Enter finishes the title, not the form.
    expect(sent(CREATE)).toHaveLength(0)
    expect(heading()).toBe('Fix the build')
    // The Enter that confirms an IME candidate leaves the editor open.
    fireEvent.click(screen.getByRole('button', { name: 'Rename workspace' }))
    fireEvent.keyDown(screen.getByLabelText('Workspace title'), { key: 'Enter', isComposing: true })
    fireEvent.keyDown(screen.getByLabelText('Workspace title'), { key: 'Escape' })
    expect(heading()).toBe('Fix the build')
    fireEvent.click(sendButton())
    expect(sent(CREATE).at(-1)).toMatchObject({
      project: 'proj', tool: 'claude', title: 'Fix the build', group: 'g-other',
    })
    // The optimistic row is in the group from the start.
    expect(useUiStore.getState().optimisticProvisioning[0]).toMatchObject({ groupId: 'g-other', title: 'Fix the build' })

    // A group with a live member is offered. "+ New group" shows a name box,
    // where Escape returns to the dropdown.
    act(() => setSnapshot(project({}, 'k8s', {
      workspaces: [{ ...PARENT, groupId: 'g-review' }], workspaceGroups: GROUPS,
    })))
    expect([...select('Group').options].map((o) => o.textContent))
      .toEqual(['None', 'Review', 'Other', '+ New group'])
    fireEvent.change(select('Group'), { target: { value: option('Group', '+ New group').value } })
    fireEvent.keyDown(screen.getByLabelText('New group name'), { key: 'Escape' })
    expect(select('Group').value).toBe('')
    fireEvent.change(select('Group'), { target: { value: option('Group', '+ New group').value } })
    const name = screen.getByLabelText<HTMLInputElement>('New group name')
    expect(document.activeElement).toBe(name)
    typePrompt('and release it')
    // A blank name is refused, not filed as None.
    fireEvent.change(name, { target: { value: '  ' } })
    expect(sendButton().disabled).toBe(true)
    expect(sendButton().title).toBe('Name the new group')
    fireEvent.change(name, { target: { value: ' Release  prep ' } })
    fireEvent.click(sendButton())
    // Sent by name for the server to create; there is no id yet.
    expect(sent(CREATE).at(-1)).toMatchObject({ project: 'proj', tool: 'claude', group: 'Release prep' })
    expect(useUiStore.getState().optimisticProvisioning[1]).not.toHaveProperty('groupId')
  })

  // The remembered branch (see the first test) falls back to origin's
  // default when origin no longer has it.
  it('opens on origin\'s default when origin lost the branch last created from', async () => {
    server.route(BRANCH_LIST, { ...BRANCHES, defaultBranch: 'dev' })
    setSnapshot(project({ lastBranch: 'deleted' }))
    mount()
    await waitFor(() => expect(branchInput().value).toBe('dev'))
  })

  // Whether origin still has it is only known once the list lands.
  it('sends a remembered branch only once the list confirms it', async () => {
    let land: (b: ProjectBranches) => void = () => {}
    const landed = new Promise<ProjectBranches>((r) => { land = r })
    server.route(BRANCH_LIST, () => landed)
    setSnapshot(project({ lastBranch: 'dev' }))
    mount()
    typePrompt('go')
    await waitFor(() => expect(sendButton().title).toBe('Loading branches…'))
    expect(branchInput().value).toBe('dev')
    expect(sendButton().disabled).toBe(true)

    act(() => land(BRANCHES))
    await waitFor(() => expect(sendButton().disabled).toBe(false))
    fireEvent.click(sendButton())
    expect(sent(CREATE).at(-1)).toMatchObject({ project: 'proj', tool: 'claude', branch: 'dev' })
  })

  it('leaves the branch to the server when the list fails to load', async () => {
    server.route(BRANCH_LIST, serverError('INTERNAL', 'boom'))
    setSnapshot(project({ lastBranch: 'dev' }))
    mount()
    typePrompt('go')
    await waitFor(() => expect(sendButton().disabled).toBe(false))
    expect(branchInput().value).toBe('')

    fireEvent.click(sendButton())
    expect(sent(CREATE)[0]).not.toHaveProperty('branch')
  })

  it('typeahead filters the branch list and a picked branch rides the create', async () => {
    await openReady()
    await waitFor(() => expect(branchInput().value).toBe('main'))

    typeInto(branchInput(), 're')
    // 'release/2.x' matches; 'dev' does not.
    expect(screen.getByText('release/2.x')).toBeTruthy()
    expect(screen.queryByText('dev')).toBeNull()

    fireEvent.click(screen.getByText('release/2.x'))
    expect(branchInput().value).toBe('release/2.x')

    typePrompt('go')
    fireEvent.click(sendButton())
    expect(sent(CREATE).at(-1)).toMatchObject({ project: 'proj', tool: 'claude', branch: 'release/2.x' })
  })

  // A reload brings the form back; leaving drops it.
  it('keeps the form across a reload until it is left', async () => {
    await openReady()
    typePrompt('half typed')
    await pick('Permission mode', 'Plan mode')
    flushTypedText()
    const saved = loadPersisted().newWorkspace
    expect(saved).toMatchObject({ projectId: 'proj', prompt: 'half typed', picked: { picks: { permissionMode: 'plan' } } })

    cleanup()
    useUiStore.setState({ newWorkspace: null })
    useUiStore.setState({ newWorkspace: saved })
    mount()
    expect(promptInput().value).toBe('half typed')
    await waitFor(() => expect(posture()).toBe('Plan mode'))

    // Nothing to warn about while localStorage keeps it; a prompt too long
    // to keep holds the leave-page prompt instead.
    const unload = (): boolean => {
      const e = new Event('beforeunload', { cancelable: true })
      window.dispatchEvent(e)
      return e.defaultPrevented
    }
    expect(unload()).toBe(false)
    typePrompt('x'.repeat(64 * 1024 + 1))
    flushTypedText()
    expect(loadPersisted().newWorkspace).toBeUndefined()
    expect(unload()).toBe(true)

    leave()
    fireEvent.click(await screen.findByRole('button', { name: 'Discard' }))
    await waitFor(() => expect(useUiStore.getState().selectedWorkspaceId).toBe('w-elsewhere'))
    flushTypedText()
    expect(loadPersisted().newWorkspace).toBeUndefined()
    expect(sent(SAVE_DRAFT)).toHaveLength(0)
  })

  describe('queueing', () => {
    // A child defaults to its parent's settings: the first conversation's
    // agent and model, the permission mode, and the fork branch. All are sent
    // as concrete values.
    it('seeds from the parent workspace and queues with every setting concrete', async () => {
      server.route(AUTH_LIST, SIGNED_IN)
      setSnapshot(project({}, 'k8s', {
        workspaces: [{ ...PARENT, groupId: 'g-review' }], workspaceGroups: GROUPS,
      }))
      await openWith({ parent: 'w-parent' })

      expect(select('Start').value).toBe('w-parent')
      expect(select('Group').value).toBe('g-review')
      expect(select('Agent').value).toBe('codex')
      expect(modelInput().value).toBe('GPT-5.5')
      expect(posture()).toBe('Accept edits')
      await waitFor(() => expect(branchInput().value).toBe('dev'))
      expect(screen.getByText('latest from origin when it starts')).toBeTruthy()
      // A bare terminal can only start now.
      expect(screen.queryByRole('button', { name: 'Start without a prompt' })).toBeNull()
      // Nor can the bar's pane buttons, which start one now.
      expect(barButton('Browse files').disabled).toBe(true)
      expect(barButton('Browse files').title).toBe('Set Start to Now to start it here')

      // A queued workspace runs unattended, so it needs something to do.
      expect(sendButton().disabled).toBe(true)
      typePrompt('follow up')
      retitle('Follow-up')
      fireEvent.click(sendButton())

      await waitFor(() => expect(sent(QUEUE)).toEqual([{
        project: 'proj', parent: 'w-parent',
        prompt: 'follow up', tool: 'codex', model: 'gpt-5.5', mode: 'tui', permissionMode: 'accept-edits', branch: 'dev',
        title: 'Follow-up', group: 'g-review',
      }]))
      expect(sent(CREATE)).toHaveLength(0)
      // The form is spent, and the sidebar opens the set it landed in.
      await waitFor(() => expect(useUiStore.getState().newWorkspace).toBeNull())
      expect(promptInput().value).toBe('')
      expect(useUiStore.getState().revealQueued).toEqual({ id: 'q-new', parent: 'w-parent' })
    })

    it('re-seeds only untouched fields when Start changes', async () => {
      server.route(AUTH_LIST, SIGNED_IN)
      setSnapshot(project({}, 'k8s', {
        workspaces: [{ ...PARENT, groupId: 'g-review' }], workspaceGroups: GROUPS,
      }))
      await openReady()
      expect(select('Agent').value).toBe('claude')
      expect(select('Group').value).toBe('')
      expect(sendButton().getAttribute('aria-label')).toBe('Create')

      await pick('Permission mode', 'Plan mode')
      fireEvent.change(select('Start'), { target: { value: 'w-parent' } })
      // The group follows the parent until it is picked.
      expect(select('Group').value).toBe('g-review')
      // The agent was untouched, so it follows the parent, and the new agent
      // brings its own remembered permission mode.
      expect(select('Agent').value).toBe('codex')
      expect(posture()).toBe('Accept edits')
      expect(sendButton().getAttribute('aria-label')).toBe('Queue')

      fireEvent.change(select('Agent'), { target: { value: 'claude' } })
      fireEvent.change(select('Group'), { target: { value: 'g-other' } })
      fireEvent.change(select('Start'), { target: { value: '' } })
      // Picked here, so a different Start leaves it alone.
      expect(select('Agent').value).toBe('claude')
      expect(select('Group').value).toBe('g-other')
    })

    it('refuses a blank new group rather than moving an entry out of its own', async () => {
      server.route(AUTH_LIST, SIGNED_IN)
      setSnapshot(project({}, 'k8s', {
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
      expect(sendButton().disabled).toBe(true)
      expect(sendButton().title).toBe('Name the new group')
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

    it('surfaces a refused queue and keeps the form', async () => {
      server.route(AUTH_LIST, SIGNED_IN)
      setSnapshot(project({}, 'k8s', { workspaces: [PARENT] }))
      server.route(QUEUE, serverError('VALIDATION', 'no model is known for that tool', 400))
      await openWith({ parent: 'w-parent' })
      typePrompt('x')
      fireEvent.click(sendButton())
      await waitFor(() => expect(screen.getByText('no model is known for that tool')).toBeTruthy())
      expect(promptInput().value).toBe('x')
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
      setSnapshot(project({}, 'k8s', {
        workspaces: [PARENT], queuedWorkspaces: chain, workspaceGroups: GROUPS,
      }))
      await openWith({ editId: 'q2' })

      expect(promptInput().value).toBe('step q2')
      expect(heading()).toBe('Second')
      expect(select('Group').value).toBe('g-review')
      expect(select('Start').value).toBe('q1')
      expect(modelInput().value).toBe('Sonnet 5')
      expect(posture()).toBe('Manual permissions')
      expect(branchInput().value).toBe('release/2.x')
      // Itself and its descendants would form a chain that never starts.
      const offered = [...select('Start').options].map((o) => o.value)
      expect(offered).toEqual(['', 'w-parent', 'q1', 'q4'])
      expect(sendButton().getAttribute('aria-label')).toBe('Save')
      expect(screen.queryByRole('button', { name: 'Save draft' })).toBeNull()

      server.route(UPDATE, entry('q2', { parentWorkspaceId: undefined, parentQueuedId: 'q4' }))
      fireEvent.change(select('Start'), { target: { value: 'q4' } })
      // Its own group, not the new parent's; a cleared title goes back to auto.
      expect(select('Group').value).toBe('g-review')
      retitle('')
      fireEvent.change(select('Group'), { target: { value: '' } })
      fireEvent.click(sendButton())
      await waitFor(() => expect(sent(UPDATE)).toEqual([{
        id: 'q2', prompt: 'step q2', tool: 'claude', model: 'claude-sonnet-5', mode: 'tui', permissionMode: 'manual',
        branch: 'release/2.x', title: '', group: null, parent: 'q4',
      }]))
      expect(sent(RUN)).toHaveLength(0)
      // The sidebar opens the set the server says it landed in.
      await waitFor(() => expect(useUiStore.getState().revealQueued).toEqual({ id: 'q2', parent: 'q4' }))
      expect(useUiStore.getState().newWorkspace).toBeNull()
    })

    it('edits the whole prompt, of which the snapshot holds only a preview', async () => {
      const full = `${'a long brief '.repeat(40)}the end`
      setSnapshot(project({}, 'k8s', { workspaces: [PARENT], queuedWorkspaces: [entry('q1', { prompt: full.slice(0, 300) })] }))
      let answer = (_reply: unknown): void => {}
      server.route(PROMPT, () => new Promise((resolve) => { answer = resolve }))
      act(() => useUiStore.getState().openNewWorkspace({ projectId: 'proj', editId: 'q1' }))
      mount()
      // Nothing can be typed over the preview or saved until it is whole.
      await waitFor(() => expect(server.called(PROMPT)).toHaveLength(1))
      expect(promptInput().readOnly).toBe(true)
      expect(sendButton().title).toBe('Loading…')

      act(() => answer({ prompt: full }))
      await waitFor(() => expect(promptInput().value).toBe(full))
      expect(promptInput().readOnly).toBe(false)
      server.route(UPDATE, entry('q1', { prompt: full }))
      fireEvent.click(sendButton())
      await waitFor(() => expect(sent(UPDATE)).toMatchObject([{ id: 'q1', prompt: full }]))
    })

    it('offers a held parent it already waits on, and "Now" saves then runs', async () => {
      setSnapshot(project({}, 'k8s', {
        queuedWorkspaces: [entry('q1', { parentWorkspaceId: 'w-held' })],
        heldWorkspaces: [{ workspaceId: 'w-held', projectId: 'proj', tool: 'claude', title: 'Died', stoppedAt: '' }],
      }))
      await openWith({ editId: 'q1' })
      expect(option('Start', 'After “Died” stops')).toBeTruthy()

      fireEvent.change(select('Start'), { target: { value: '' } })
      fireEvent.click(sendButton())
      await waitFor(() => expect(sent(RUN)).toEqual([{ id: 'q1' }]))
      // Saved as it stands, without a parent: running it is what "Now" means.
      expect(sent(UPDATE)[0]).not.toHaveProperty('parent')
      expect(useUiStore.getState().revealQueued).toBeNull()
    })

    // The + is a blank create: it keeps a plain form being typed, but not an
    // edit, which has no close of its own.
    it('leaves an edit for a blank create on the +, without asking', async () => {
      setSnapshot(project({}, 'k8s', { workspaces: [PARENT], queuedWorkspaces: chain }))
      await openWith({ editId: 'q2' })
      typePrompt('step q2, revised')
      fireEvent.click(screen.getByRole('button', { name: 'New workspace' }))
      expect(screen.queryByText('Save as a draft?')).toBeNull()
      expect(promptInput().value).toBe('')
      expect(sendButton().getAttribute('aria-label')).toBe('Create')
      expect(sent(UPDATE)).toHaveLength(0)

      typePrompt('a fresh one')
      fireEvent.click(screen.getByRole('button', { name: 'New workspace' }))
      expect(promptInput().value).toBe('a fresh one')
    })

    it('says so when the entry has already started, and leaves without asking', async () => {
      act(() => useUiStore.getState().openNewWorkspace({ projectId: 'proj', editId: 'gone' }))
      mount()
      await waitFor(() => expect(screen.getByText('Queued workspace gone')).toBeTruthy())
      fireEvent.click(screen.getByRole('button', { name: 'Start a new workspace' }))
      expect(promptInput().value).toBe('')
      expect(useUiStore.getState().newWorkspace).toBeNull()
    })
  })

  describe('drafts', () => {
    const draft = (extra: Partial<DraftWorkspaceEntry> = {}): DraftWorkspaceEntry => ({
      id: 'd1', projectId: 'proj', prompt: 'half an idea', tool: 'codex', mode: 'tui',
      permissionMode: 'read-only', model: 'gpt-5.5', branch: 'dev', createdAt: '', updatedAt: '', ...extra,
    })

    it('leaves without asking when no prompt is typed, dropping the form', async () => {
      await openReady()
      fireEvent.change(select('UI'), { target: { value: 'tui' } })
      expect(useUiStore.getState().newWorkspace).not.toBeNull()
      leave()
      expect(useUiStore.getState().selectedWorkspaceId).toBe('w-elsewhere')
      expect(useUiStore.getState().newWorkspace).toBeNull()
      expect(screen.queryByText('Save as a draft?')).toBeNull()
    })

    it('asks before leaving with a prompt, and saves every setting as shown', async () => {
      server.route(AUTH_LIST, SIGNED_IN)
      setSnapshot(project({}, 'k8s', {
        workspaces: [{ ...PARENT, groupId: 'g-review' }], workspaceGroups: GROUPS,
      }))
      await openReady()
      typePrompt('  later, maybe  ')
      retitle('Someday')
      await pick('Permission mode', 'Plan mode')

      // Another workspace, or another project: either asks first.
      leave()
      fireEvent.click(await screen.findByRole('button', { name: 'Keep editing' }))
      await waitFor(() => expect(screen.queryByText('Save as a draft?')).toBeNull())
      expect(useUiStore.getState().selectedWorkspaceId).toBeNull()
      fireEvent.change(select('Start'), { target: { value: 'w-parent' } })

      act(() => useUiStore.getState().setActiveProject('other'))
      expect(useUiStore.getState().activeProjectId).toBe('proj')
      fireEvent.click(await screen.findByRole('button', { name: 'Save draft' }))
      await waitFor(() => expect(useUiStore.getState().activeProjectId).toBe('other'))
      expect(sent(SAVE_DRAFT)).toEqual([{
        project: 'proj', prompt: 'later, maybe', tool: 'codex', model: 'gpt-5.5', mode: 'tui', permissionMode: 'accept-edits',
        branch: 'dev', startAfter: 'w-parent', title: 'Someday', groupId: 'g-review',
      }])
      expect(useUiStore.getState().newWorkspace).toBeNull()
      expect(sent(CREATE)).toHaveLength(0)
      expect(sent(QUEUE)).toHaveLength(0)
    })

    it('saves a draft from its own button once a prompt is typed, without asking', async () => {
      await openReady()
      const save = screen.getByRole<HTMLButtonElement>('button', { name: 'Save draft' })
      expect(save.disabled).toBe(true)
      typePrompt('for later')
      expect(save.disabled).toBe(false)
      fireEvent.click(save)
      expect(save.disabled).toBe(true)
      await waitFor(() => expect(promptInput().value).toBe(''))
      expect(sent(SAVE_DRAFT)).toHaveLength(1)
      expect(sent(SAVE_DRAFT)[0]).toMatchObject({ project: 'proj', prompt: 'for later' })
      expect(sent(SAVE_DRAFT)[0]).not.toHaveProperty('id')
      expect(screen.queryByText('Save as a draft?')).toBeNull()
      expect(sent(CREATE)).toHaveLength(0)
    })

    it('reopens a draft on its fields, asks only once it changes, and a create consumes it', async () => {
      server.route(AUTH_LIST, SIGNED_IN)
      // Its Start parent has gone since it was saved: it starts now instead.
      setSnapshot(project({}, 'k8s', { draftWorkspaces: [draft({ startAfter: 'w-gone' })] }))
      await openWith({ draftId: 'd1' })
      expect(promptInput().value).toBe('half an idea')
      expect(heading()).toBe('New workspace')
      expect(select('Start').value).toBe('')
      expect(select('Agent').value).toBe('codex')
      expect(modelInput().value).toBe('GPT-5.5')
      expect(posture()).toBe('Read-only')
      await waitFor(() => expect(branchInput().value).toBe('dev'))
      // Its prompt is its own, so no bare terminal.
      expect(emptyButton().disabled).toBe(true)

      // A generated title landing while open heads the form; whitespace is
      // not an edit, but a real edit drops it until reverted.
      act(() => setSnapshot(project({}, 'k8s', {
        draftWorkspaces: [draft({ startAfter: 'w-gone', generatedTitle: 'Half an idea' })],
      })))
      typePrompt('half an idea \n')
      expect(heading()).toBe('Half an idea')
      typePrompt('a whole idea')
      expect(heading()).toBe('New workspace')
      typePrompt('half an idea')
      expect(heading()).toBe('Half an idea')

      // Opening another draft over it is leaving it too.
      typePrompt('a whole idea')
      act(() => useUiStore.getState().openNewWorkspace({ projectId: 'proj', draftId: 'd1' }))
      fireEvent.click(await screen.findByRole('button', { name: 'Save changes' }))
      await waitFor(() => expect(promptInput().value).toBe('half an idea'))
      expect(sent(SAVE_DRAFT).at(-1)).toMatchObject({ project: 'proj', prompt: 'a whole idea', id: 'd1' })

      // Deleted meanwhile (another tab created from it): saved as a new draft.
      forget()
      let saves = 0
      server.route(SAVE_DRAFT, ({ body }: { body: Body }) => (saves++ === 0
        ? serverError('NOT_FOUND', 'project proj has no draft workspace d1', 404)
        : { ...draft(), ...body, id: 'd-new' }))
      typePrompt('kept anyway')
      leave()
      fireEvent.click(await screen.findByRole('button', { name: 'Save changes' }))
      await waitFor(() => expect(useUiStore.getState().selectedWorkspaceId).toBe('w-elsewhere'))
      expect(sent(SAVE_DRAFT).map((b) => b.id)).toEqual(['d1', undefined])
      expect(sent(SAVE_DRAFT)[1]).toMatchObject({ prompt: 'kept anyway' })

      // Reopened exactly as saved, leaving has nothing to lose.
      cleanup()
      setSnapshot(project({}, 'k8s', { draftWorkspaces: [draft()] }))
      await openWith({ draftId: 'd1' })
      const save = screen.getByRole<HTMLButtonElement>('button', { name: 'Save draft' })
      expect(save.disabled).toBe(true)
      expect(save.title).toBe('No changes to save')
      leave()
      expect(useUiStore.getState().selectedWorkspaceId).toBe('w-elsewhere')
      expect(screen.queryByText('Save changes to this draft?')).toBeNull()

      // Once changed, Save draft updates it in place.
      cleanup()
      forget()
      server.route(SAVE_DRAFT, ({ body }: { body: Body }) => ({ ...draft(), ...body }))
      await openWith({ draftId: 'd1' })
      await pick('Permission mode', 'Bypass permissions')
      fireEvent.click(screen.getByRole('button', { name: 'Save draft' }))
      await waitFor(() => expect(useUiStore.getState().newWorkspace).toBeNull())
      expect(sent(SAVE_DRAFT)).toEqual([expect.objectContaining({ project: 'proj', permissionMode: 'bypass', id: 'd1' })])

      // A title and group of its own ride the create.
      cleanup()
      setSnapshot(project({}, 'k8s', {
        draftWorkspaces: [draft({ title: 'Named', groupId: 'g-other' })], workspaceGroups: GROUPS,
      }))
      await openWith({ draftId: 'd1' })
      expect(heading()).toBe('Named')
      expect(select('Group').value).toBe('g-other')
      fireEvent.click(sendButton())
      // The server deletes the draft only once the create succeeds.
      expect(sent(CREATE)).toEqual([{
        project: 'proj', tool: 'codex', workspaceId: expect.any(String) as string,
        branch: 'dev', model: 'gpt-5.5', permissionMode: 'read-only', mode: 'tui', prompt: 'half an idea',
        title: 'Named', group: 'g-other', draftId: 'd1', draftOnFailure: true,
      }])
    })

    it('leaves a reopened draft for a blank create on the +, asking first once it changed', async () => {
      setSnapshot(project({}, 'k8s', { draftWorkspaces: [draft()] }))
      await openWith({ draftId: 'd1' })
      fireEvent.click(screen.getByRole('button', { name: 'New workspace' }))
      expect(promptInput().value).toBe('')

      act(() => useUiStore.getState().openNewWorkspace({ projectId: 'proj', draftId: 'd1' }))
      await waitFor(() => expect(promptInput().value).toBe('half an idea'))
      typePrompt('half an idea, grown')
      fireEvent.click(screen.getByRole('button', { name: 'New workspace' }))
      fireEvent.click(await screen.findByRole('button', { name: 'Discard changes' }))
      await waitFor(() => expect(promptInput().value).toBe(''))
      expect(sendButton().getAttribute('aria-label')).toBe('Create')
      expect(sent(SAVE_DRAFT)).toHaveLength(0)
      expect(sent(CREATE)).toHaveLength(0)
    })

    it('keeps an untouched draft group following Start, and a picked one where it was', async () => {
      const other = { ...PARENT, workspaceId: 'w-other', title: 'Other work', groupId: 'g-other' }
      const open = async (d: DraftWorkspaceEntry): Promise<void> => {
        cleanup()
        useUiStore.setState({ newWorkspace: null, selectedWorkspaceId: null })
        setSnapshot(project({}, 'k8s', {
          workspaces: [{ ...PARENT, groupId: 'g-review' }, other], workspaceGroups: GROUPS, draftWorkspaces: [d],
        }))
        await openWith({ draftId: 'd1' })
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

    it('keeps the prior group on a draft left while a new one is being named', async () => {
      setSnapshot(project({}, 'k8s', {
        draftWorkspaces: [draft({ groupId: 'g-other' })], workspaceGroups: GROUPS,
      }))
      await openWith({ draftId: 'd1' })
      fireEvent.change(select('Group'), { target: { value: option('Group', '+ New group').value } })
      fireEvent.change(screen.getByLabelText('New group name'), { target: { value: 'Not yet made' } })
      typePrompt('half an idea, and more')
      leave()
      fireEvent.click(await screen.findByRole('button', { name: 'Save changes' }))
      await waitFor(() => expect(useUiStore.getState().selectedWorkspaceId).toBe('w-elsewhere'))
      expect(sent(SAVE_DRAFT)[0]).toMatchObject({ groupId: 'g-other' })
    })

    it('queueing from a draft names it, for the server to drop once queued', async () => {
      server.route(AUTH_LIST, SIGNED_IN)
      setSnapshot(project({}, 'k8s', {
        workspaces: [PARENT], draftWorkspaces: [draft({ startAfter: 'w-parent' })],
      }))
      await openWith({ draftId: 'd1' })
      expect(select('Start').value).toBe('w-parent')
      fireEvent.click(sendButton())
      await waitFor(() => expect(sent(QUEUE)).toEqual([expect.objectContaining({
        project: 'proj', parent: 'w-parent', prompt: 'half an idea', permissionMode: 'read-only', draftId: 'd1',
      })]))
    })
  })
})
