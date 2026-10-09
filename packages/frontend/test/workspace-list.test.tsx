// @vitest-environment jsdom
import type { JSX } from 'react'
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react'
import type {
  DraftWorkspaceEntry,
  HeldWorkspaceEntry,
  ProvisioningWorkspaceEntry,
  ProjectSummary,
  QueuedWorkspaceEntry,
  StoppedWorkspaceEntry,
  StoppedWorkspacePage,
  WorkspaceGroupSummary,
  WorkspaceListEntry,
} from '@yaac/shared/types'

vi.mock('#lib/createWorkspace', () => ({
  createWorkspace: vi.fn(() => Promise.resolve({ workspaceId: 'w-new' })),
  dismissProvisioning: vi.fn(),
  restartWorkspace: vi.fn(),
  renameWorkspace: vi.fn(() => Promise.resolve()),
}))
vi.mock('#lib/stopWorkspaceFlow', () => ({ stopWorkspaceOptimistic: vi.fn() }))
const provision = vi.hoisted(() => vi.fn())
vi.mock('#lib/useProvisionWorkspace', () => ({ useProvisionWorkspace: () => provision }))
// The stop dialog lists what is queued, off the snapshot.
const snapshot = vi.hoisted(() => vi.fn())
vi.mock('#lib/useSnapshot', () => ({ useSnapshot: snapshot }))

import { WorkspaceList } from '#components/WorkspaceList'
import { createWorkspace, renameWorkspace } from '#lib/createWorkspace'
import { useUiStore } from '#lib/store'
import { mockFetch, testQueryClient, type FetchCall, type FetchMock } from './harness'

/** The elements the Stopped lists' load-more markers are watching. */
const watched = new Set<{ fire: () => void }>()

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  // jsdom has no layout, so a test says when a marker scrolls into view.
  globalThis.IntersectionObserver = class {
    private readonly entry: { fire: () => void }
    constructor(callback: (entries: { isIntersecting: boolean }[]) => void) {
      this.entry = { fire: () => callback([{ isIntersecting: true }]) }
    }
    observe(): void { watched.add(this.entry) }
    disconnect(): void { watched.delete(this.entry) }
  } as unknown as typeof IntersectionObserver
})

/** Scroll every load-more marker into view. */
function scrollToEnd(): void {
  act(() => { for (const w of [...watched]) w.fire() })
}

const initial = useUiStore.getState()

const SET_GROUP = 'POST /api/workspace/set-group'
const GROUP_CREATE = 'POST /api/workspace/group/create'
const GROUP_RENAME = 'POST /api/workspace/group/rename'
const GROUP_PIN = 'POST /api/workspace/group/set-pinned'
const GROUP_DELETE = 'POST /api/workspace/group/delete'
const QUEUE_RUN = 'POST /api/workspace/queue/run'
const QUEUE_DISCARD = 'POST /api/workspace/queue/discard'
const DRAFT_DISCARD = 'POST /api/workspace/draft/discard'

/** The project's stopped workspaces, as the server lists them. */
const stoppedRows: StoppedWorkspaceEntry[] = []

/** `GET /workspace/list-stopped` over `stoppedRows`, honoring the filters
 *  the sidebar sends. The cursor is a row index. */
function listStopped(c: FetchCall): StoppedWorkspacePage {
  const q = c.query.get('q')?.toLowerCase()
  const group = c.query.get('group')
  const exclude = c.query.get('excludeGroups')?.split(',') ?? []
  const excludeIds = c.query.get('exclude')?.split(',') ?? []
  const rows = stoppedRows.filter((r) => (group ? r.groupId === group : !exclude.includes(r.groupId ?? ''))
    && !excludeIds.includes(r.workspaceId)
    && (!q || `${r.title ?? ''} ${r.prompt ?? ''}`.toLowerCase().includes(q)))
  const start = Number(c.query.get('cursor') || 0)
  const end = start + Number(c.query.get('limit') || rows.length)
  return { entries: rows.slice(start, end), total: rows.length, ...(end < rows.length ? { nextCursor: String(end) } : {}) }
}

/** A stopped workspace in the project. */
const stoppedEntry = (workspaceId: string, over: Partial<StoppedWorkspaceEntry> = {}): StoppedWorkspaceEntry => ({
  workspaceId,
  projectId: 'proj',
  tool: 'claude',
  createdAt: '2026-08-10 00:00:00',
  stoppedAt: '2026-08-10 01:00:00',
  title: `Stopped ${workspaceId}`,
  seen: true,
  agentSessions: [],
  ...over,
})

/** The stopped-list requests so far, as their query strings. */
const stoppedQueries = (): string[] =>
  server.called('GET /api/workspace/list-stopped').map((c) => c.query.toString())
let server: FetchMock
/** The JSON bodies posted to a route so far. */
const posted = (route: string): unknown[] => server.called(route).map((c) => c.body)
/** A set-group body filing `workspaceId` under `groupId` (null: ungrouped). */
const filed = (workspaceId: string, groupId: string | null): unknown => ({ projectId: 'proj', workspaceId, groupId })

beforeEach(() => {
  localStorage.clear()
  stoppedRows.length = 0
  watched.clear()
  snapshot.mockReturnValue(undefined)
  useUiStore.setState(initial, true)
  server = mockFetch({
    'GET /api/workspace/list-stopped': listStopped,
    [SET_GROUP]: undefined,
    [GROUP_CREATE]: { groupId: 'g-new', name: 'Release' },
    [GROUP_RENAME]: undefined,
    [GROUP_PIN]: undefined,
    [GROUP_DELETE]: undefined,
    [QUEUE_RUN]: { workspaceId: 'w-run' },
    [QUEUE_DISCARD]: undefined,
    [DRAFT_DISCARD]: undefined,
  })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

const entry = (over: Partial<WorkspaceListEntry> = {}): WorkspaceListEntry => ({
  workspaceId: 's1',
  projectId: 'proj',
  tool: 'claude',
  status: 'running',
  createdAt: '2026-08-10 00:00:00',
  agentSessions: [],
  blockedHosts: [],
  forwardedPorts: [],
  unforwardedPorts: [],
  ...over,
})

const group = (over: Partial<WorkspaceGroupSummary> = {}): WorkspaceGroupSummary => ({
  groupId: 'g1',
  projectId: 'proj',
  name: 'Release',
  pinned: false,
  createdAt: '2026-08-10 00:00:00',
  stoppedCount: 0,
  unseenDeaths: 0,
  ...over,
})

const provisioning = (over: Partial<ProvisioningWorkspaceEntry> = {}): ProvisioningWorkspaceEntry => ({
  workspaceId: 'p1',
  projectId: 'proj',
  tool: 'claude',
  kind: 'restart',
  message: 'Starting…',
  createdAt: '2026-08-10 00:00:00',
  ...over,
})

const queuedEntry = (id: string, over: Partial<QueuedWorkspaceEntry> = {}): QueuedWorkspaceEntry => ({
  id,
  projectId: 'proj',
  parentWorkspaceId: 'a',
  prompt: `Step ${id}\nmore detail`,
  tool: 'claude',
  model: 'claude-sonnet-5',
  modelName: 'Sonnet 5',
  mode: 'tui',
  permissionMode: 'bypass',
  branch: 'main',
  createdAt: '2026-08-10 00:00:00',
  ...over,
})

interface ListOpts {
  /** The project's stopped counts, from the snapshot. */
  project?: Pick<ProjectSummary, 'stoppedCount' | 'unseenDeaths'>
  groups?: WorkspaceGroupSummary[]
  projectId?: string | null
  provisioning?: ProvisioningWorkspaceEntry[]
  queued?: QueuedWorkspaceEntry[]
  held?: HeldWorkspaceEntry[]
  drafts?: DraftWorkspaceEntry[]
}

/** Render the list; the returned function re-renders the same instance with
 *  new props, as a fresh snapshot would. */
function renderList(
  workspaces: WorkspaceListEntry[],
  opts: ListOpts = {},
): (workspaces: WorkspaceListEntry[], opts?: ListOpts) => void {
  const client = testQueryClient()
  const element = (w: WorkspaceListEntry[], o: ListOpts): JSX.Element => (
    <QueryClientProvider client={client}>
      <WorkspaceList
        projectId={o.projectId === undefined ? 'proj' : o.projectId}
        project={o.project}
        workspaces={w}
        groups={o.groups ?? []}
        provisioning={o.provisioning ?? []}
        queued={o.queued ?? []}
        held={o.held ?? []}
        drafts={o.drafts ?? []}
      />
    </QueryClientProvider>
  )
  const { rerender } = render(element(workspaces, opts))
  return (w, o = {}) => rerender(element(w, o))
}

/** Pick an item from a row's `…` menu; the item runs once the menu closes. */
async function pickAction(item: string, menu = 'Workspace actions', index = 0): Promise<void> {
  fireEvent.click(screen.getAllByRole('button', { name: menu })[index])
  fireEvent.click(await screen.findByRole('menuitem', { name: item }))
}

/**
 * The list body shared by the desktop sidebar and the mobile workspaces
 * screen. Ordering and group-visibility rules are unit-tested in
 * sidebar.test.ts; these tests check the rendered body agrees with them and
 * that row and group actions work without hover (as on a phone).
 */
describe('WorkspaceList', () => {
  it('renders one flat list, with each group as its own section below it', () => {
    renderList([
      entry({ workspaceId: 'a', title: 'Loose one', status: 'waiting' }),
      entry({ workspaceId: 'b', title: 'Filed one', groupId: 'g1' }),
      entry({ workspaceId: 'c', title: 'Dying one', stopping: true }),
    ], { groups: [group()] })

    // No status headers; each row's own markers show its state.
    expect(screen.queryByText('Waiting')).toBeNull()
    expect(screen.queryByText('Running')).toBeNull()
    expect(screen.getByText('Loose one')).toBeTruthy()
    expect(screen.getByRole('group', { name: 'Release' })).toBeTruthy()
    expect(screen.getByText('Filed one')).toBeTruthy()
    // A workspace on its way out is a placeholder, not a selectable row.
    expect(screen.getByText('stopping…')).toBeTruthy()
  })

  it('marks each row by its status: asking, running, background work, or unread', () => {
    renderList([
      entry({ workspaceId: 'a', title: 'Working', status: 'running' }),
      entry({ workspaceId: 'b', title: 'Watching', status: 'background' }),
      entry({ workspaceId: 'c', title: 'Done', status: 'waiting', waitingSinceMs: 1 }),
      entry({ workspaceId: 'd', title: 'Blocked', status: 'waiting', asking: true, waitingSinceMs: 1 }),
    ])

    const marker = (title: string, selector: string): Element | null =>
      screen.getByText(title).closest('button')!.querySelector(selector)
    expect(marker('Working', '.braille-spinner:not(.braille-breathe)')).toBeTruthy()
    expect(marker('Watching', '.braille-breathe')).toBeTruthy()
    expect(marker('Watching', '.bg-amber-500')).toBeNull()
    expect(marker('Done', '.braille-spinner')).toBeNull()
    expect(marker('Done', '.bg-amber-500')).toBeTruthy()
    expect(marker('Done', '[aria-label="Waiting for your answer"]')).toBeNull()
    expect(marker('Blocked', '[aria-label="Waiting for your answer"]')).toBeTruthy()
    expect(marker('Blocked', '.bg-amber-500, .braille-spinner')).toBeNull()
  })

  it('names each row\'s tool and the model it is answering as', () => {
    // The model comes from the live conversation, not the launch settings. A
    // workspace whose agent has not replied yet, and every opencode one (no
    // readable transcript), shows just the tool name.
    renderList([
      entry({
        workspaceId: 'a',
        title: 'Answered once',
        agentSessions: [{ agentSessionId: 'c1', tool: 'claude', ordinal: 0, active: true, model: 'claude-opus-5' }],
      }),
      entry({ workspaceId: 'b', title: 'Not yet', tool: 'opencode' }),
    ])

    expect(screen.getByText('Claude · Opus 5')).toBeTruthy()
    expect(screen.getByText('OpenCode')).toBeTruthy()
  })

  it('counts a group\'s stopped members in its header, and shows them only when asked', async () => {
    stoppedRows.push(stoppedEntry('gone', { title: 'Stopped one', groupId: 'g1' }),
      stoppedEntry('gone2', { title: 'Stopped two', groupId: 'g1' }))
    renderList([entry({ workspaceId: 'b', title: 'Filed one', groupId: 'g1' })], {
      groups: [group({ stoppedCount: 2 })],
      project: { stoppedCount: 2, unseenDeaths: 0 },
    })

    // Counted from the snapshot, with nothing fetched for a hidden list.
    const section = screen.getByRole('group', { name: group().name })
    expect(section.textContent).toContain('(1/3)')
    expect(screen.queryByText('Stopped one')).toBeNull()
    expect(stoppedQueries()).toEqual([])

    // Shown at the foot of the section, after the live rows.
    await pickAction('Show stopped workspaces', 'Group actions')
    await within(section).findByText('Stopped one')
    expect(section.textContent?.indexOf('Stopped one'))
      .toBeGreaterThan(section.textContent?.indexOf('Filed one') ?? Infinity)
    const row = screen.getByText('Stopped one').closest<HTMLElement>('.group')
    fireEvent.click(within(row ?? document.body).getByLabelText('Remove from group'))
    await waitFor(() => expect(posted(SET_GROUP)).toEqual([filed('gone', null)]))

    // Hiding them leaves the live rows where they were.
    await pickAction('Hide stopped workspaces', 'Group actions')
    expect(within(section).queryByText('Stopped two')).toBeNull()
    expect(screen.getByText('Filed one')).toBeTruthy()
  })

  it('makes the caret the show/hide toggle for a group with only stopped members', async () => {
    stoppedRows.push(stoppedEntry('gone', { title: 'Stopped one', groupId: 'g1' }))
    renderList([], { groups: [group({ pinned: true, stoppedCount: 1 })] })

    const caret = await screen.findByRole('button', { name: /Release.*\(0\/1\)/ })
    expect(caret.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(caret)
    expect(await screen.findByText('Stopped one')).toBeTruthy()

    // The menu sees the same state the caret set, and closes the caret too.
    await pickAction('Hide stopped workspaces', 'Group actions')
    expect(screen.queryByText('Stopped one')).toBeNull()
    expect(caret.getAttribute('aria-expanded')).toBe('false')
    await pickAction('Show stopped workspaces', 'Group actions')
    expect(await screen.findByText('Stopped one')).toBeTruthy()
    expect(caret.getAttribute('aria-expanded')).toBe('true')
  })

  it('keeps an all-stopped group the caret opened open once a member restarts', async () => {
    // Collapsed while it still has a live member...
    const rerender = renderList([entry({ workspaceId: 'gone', title: 'Live one', groupId: 'g1' })],
      { groups: [group({ pinned: true })] })
    fireEvent.click(screen.getByRole('button', { name: /Release.*\(1\/1\)/ }))
    expect(screen.queryByText('Live one')).toBeNull()

    // ...then it stops, leaving only stopped members, and the caret opens it.
    stoppedRows.push(stoppedEntry('gone', { title: 'Stopped one', groupId: 'g1' }))
    const opts = { groups: [group({ pinned: true, stoppedCount: 1 })] }
    rerender([], opts)
    const caret = await screen.findByRole('button', { name: /Release.*\(0\/1\)/ })
    expect(caret.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(caret)
    expect(await screen.findByText('Stopped one')).toBeTruthy()

    // A restart makes it live again. It must not revert to its old collapsed
    // state and hide the row the user just asked for.
    rerender([], { ...opts, provisioning: [provisioning({ workspaceId: 'gone', groupId: 'g1' })] })
    expect(screen.getByRole('button', { name: /Release.*\(1\/1\)/ }).getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText('Restarting workspace')).toBeTruthy()
  })

  it('keeps a held member on screen as its queue comes and goes', async () => {
    const live = [entry({ workspaceId: 'b', title: 'Filed one', groupId: 'g1' })]
    const held = [{ workspaceId: 's', projectId: 'proj', tool: 'claude' as const, title: 'Stopped s', groupId: 'g1',
      stoppedAt: '2026-08-10 01:00:00' }]
    stoppedRows.push(stoppedEntry('s', { groupId: 'g1' }))
    const rerender = renderList(live, {
      groups: [group({ stoppedCount: 1 })], queued: [queuedEntry('q1', { parentWorkspaceId: 's' })], held,
    })

    // Held: its row stays out, with what waits on it.
    expect(screen.getByText('Stopped s')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '1 queued workspace' }))
    expect(screen.getByText('Step q1')).toBeTruthy()

    // Its queue drains: hidden with the other stopped members.
    rerender(live, { groups: [group({ stoppedCount: 1 })] })
    expect(screen.queryByText('Stopped s')).toBeNull()

    // Once shown, they stay shown as another member stops. An unread death
    // shows on the header, since hidden rows would hide it.
    await pickAction('Show stopped workspaces', 'Group actions')
    stoppedRows.push(stoppedEntry('t', { groupId: 'g1', deathReason: 'oom', seen: false }))
    const more = [...live, entry({ workspaceId: 'c', title: 'Other' })]
    const grown = [group({ stoppedCount: 2, unseenDeaths: 1 })]
    rerender(more, { groups: grown })
    expect(await screen.findByRole('button', { name: /Release.*\(1\/3\).*1 died/ })).toBeTruthy()
    expect(await screen.findByText('Stopped t')).toBeTruthy()
    expect(screen.getByText('Stopped s')).toBeTruthy()

    // It gains a queued child: on screen again whatever the toggle says.
    await pickAction('Hide stopped workspaces', 'Group actions')
    rerender(more, { groups: grown, queued: [queuedEntry('q2', { parentWorkspaceId: 's' })], held })
    expect(screen.getByText('Stopped s')).toBeTruthy()
    expect(screen.queryByText('Stopped t')).toBeNull()
  })

  it('opens a stopped workspace in the pane by selecting it', async () => {
    stoppedRows.push(stoppedEntry('gone', { title: 'Stopped one', groupId: 'g1' }))
    renderList([entry({ workspaceId: 'b', title: 'Filed one', groupId: 'g1' })], {
      groups: [group({ stoppedCount: 1 })],
    })

    await pickAction('Show stopped workspaces', 'Group actions')
    fireEvent.click(await screen.findByText('Stopped one'))
    expect(useUiStore.getState().selectedWorkspaceId).toBe('gone')
  })

  describe('the Stopped section', () => {
    const many = (n: number): StoppedWorkspaceEntry[] =>
      Array.from({ length: n }, (_, i) => stoppedEntry(`s${String(i).padStart(3, '0')}`))

    it('shows the real count collapsed, then pages in more rows as the list scrolls to its end', async () => {
      stoppedRows.push(...many(120))
      renderList([entry({ workspaceId: 'a', title: 'Live one' })], { project: { stoppedCount: 120, unseenDeaths: 0 } })

      const header = screen.getByRole('button', { name: /Stopped\s*120/ })
      expect(header.getAttribute('aria-expanded')).toBe('false')
      expect(stoppedQueries()).toEqual([])

      fireEvent.click(header)
      expect(await screen.findByText('Stopped s049')).toBeTruthy()
      expect(screen.queryByText('Stopped s050')).toBeNull()
      scrollToEnd()
      expect(await screen.findByText('Stopped s099')).toBeTruthy()
      scrollToEnd()
      expect(await screen.findByText('Stopped s119')).toBeTruthy()
      expect(stoppedQueries()).toHaveLength(3)
      expect(screen.getByRole('button', { name: /Stopped\s*120/ })).toBeTruthy()
      // The choice is saved.
      expect(useUiStore.getState().stoppedExpanded).toBe(true)
    })

    it('lists a grouped workspace only while its group is not showing it', async () => {
      stoppedRows.push(stoppedEntry('mine', { title: 'Grouped stop', groupId: 'g1' }), stoppedEntry('loose'))
      useUiStore.setState({ stoppedExpanded: true })
      renderList([entry({ workspaceId: 'b', title: 'Filed one', groupId: 'g1' })], {
        groups: [group({ stoppedCount: 1 })],
        project: { stoppedCount: 2, unseenDeaths: 0 },
      })
      const stoppedSection = screen.getByRole('group', { name: 'Stopped workspaces' })
      const groupSection = screen.getByRole('group', { name: 'Release' })
      expect(await within(stoppedSection).findByText('Grouped stop')).toBeTruthy()
      expect(stoppedSection.textContent).toMatch(/Stopped\s*2/)

      // Shown in the group: gone from the section, and from its count.
      await pickAction('Show stopped workspaces', 'Group actions')
      expect(await within(groupSection).findByText('Grouped stop')).toBeTruthy()
      await waitFor(() => expect(within(stoppedSection).queryByText('Grouped stop')).toBeNull())
      expect(stoppedSection.textContent).toMatch(/Stopped\s*1/)
      expect(stoppedQueries().at(-1)).toContain('excludeGroups=g1')

      // Collapsing the group sends it back to the section.
      fireEvent.click(screen.getByRole('button', { name: /Release/ }))
      expect(await within(stoppedSection).findByText('Grouped stop')).toBeTruthy()
      expect(within(groupSection).queryByText('Grouped stop')).toBeNull()
      expect(stoppedSection.textContent).toMatch(/Stopped\s*2/)

      // Expanding it again takes it back.
      fireEvent.click(screen.getByRole('button', { name: /Release/ }))
      expect(await within(groupSection).findByText('Grouped stop')).toBeTruthy()
      await waitFor(() => expect(within(stoppedSection).queryByText('Grouped stop')).toBeNull())
    })

    it('leaves out held workspaces and restarts, which have rows of their own, from its rows and its count', async () => {
      stoppedRows.push(stoppedEntry('held'), stoppedEntry('back'), stoppedEntry('plain'), stoppedEntry('failed'))
      useUiStore.setState({ stoppedExpanded: true })
      renderList([], {
        project: { stoppedCount: 4, unseenDeaths: 0 },
        held: [{ workspaceId: 'held', projectId: 'proj', tool: 'claude', title: 'Stopped held', stoppedAt: '2026-08-10 01:00:00' }],
        queued: [queuedEntry('q1', { parentWorkspaceId: 'held' })],
        // A create stopped mid-provision keeps its failed row, and is listed
        // as stopped too.
        provisioning: [provisioning({ workspaceId: 'back' }),
          provisioning({ workspaceId: 'failed', kind: 'create', error: 'stopped' })],
      })
      const stoppedSection = screen.getByRole('group', { name: 'Stopped workspaces' })
      expect(await within(stoppedSection).findByText('Stopped plain')).toBeTruthy()
      expect(within(stoppedSection).getByText('Stopped failed')).toBeTruthy()
      expect(within(stoppedSection).queryByText('Stopped held')).toBeNull()
      expect(within(stoppedSection).queryByText('Stopped back')).toBeNull()
      expect(stoppedSection.textContent).toMatch(/Stopped\s*2/)

      // A search's count is the server's, which leaves them out as well.
      fireEvent.change(screen.getByRole('textbox', { name: 'Search workspaces' }), { target: { value: 'Stopped' } })
      await waitFor(() => expect(stoppedQueries().at(-1)).toContain('q=Stopped'))
      expect(stoppedQueries().at(-1)).toContain(`exclude=${encodeURIComponent('back,held')}`)
      await waitFor(() => expect(stoppedSection.textContent).toMatch(/Stopped\s*2/))
    })

    it('marks every death seen from its menu', async () => {
      stoppedRows.push(stoppedEntry('dead', { deathReason: 'oom', seen: false }))
      server.route('POST /api/workspace/mark-all-deaths-seen', undefined)
      renderList([], { project: { stoppedCount: 1, unseenDeaths: 1 } })
      await pickAction('Mark all as read', 'Stopped workspaces actions')
      await waitFor(() => expect(posted('POST /api/workspace/mark-all-deaths-seen')).toEqual([{ projectId: 'proj' }]))
    })
  })

  describe('search', () => {
    it('filters the rows and groups, searches the stopped list on the server, and keeps the selection', async () => {
      stoppedRows.push(stoppedEntry('old', { title: 'Parser rewrite, take one' }), stoppedEntry('other'))
      useUiStore.setState({ selectedWorkspaceId: 'b' })
      renderList([
        entry({ workspaceId: 'a', title: 'Fix the parser' }),
        entry({ workspaceId: 'b', title: 'Write docs' }),
        entry({ workspaceId: 'c', title: 'Parser tests', groupId: 'g1' }),
        entry({ workspaceId: 'd', title: 'Unrelated', groupId: 'g2' }),
      ], {
        groups: [group(), group({ groupId: 'g2', name: 'Pinned', pinned: true })],
        project: { stoppedCount: 2, unseenDeaths: 0 },
      })

      fireEvent.change(screen.getByRole('textbox', { name: 'Search workspaces' }), { target: { value: 'PARSER' } })
      expect(screen.getByText('Fix the parser')).toBeTruthy()
      expect(screen.queryByText('Write docs')).toBeNull()
      expect(screen.getByText('Parser tests')).toBeTruthy()
      // A group with no match goes, pinned or not.
      expect(screen.queryByRole('group', { name: 'Pinned' })).toBeNull()
      // The stopped section opens on the server's matches.
      expect(await screen.findByText('Parser rewrite, take one')).toBeTruthy()
      expect(screen.queryByText('Stopped other')).toBeNull()
      expect(stoppedQueries().at(-1)).toContain('q=PARSER')
      expect(useUiStore.getState().selectedWorkspaceId).toBe('b')

      fireEvent.change(screen.getByRole('textbox', { name: 'Search workspaces' }), { target: { value: 'zzz' } })
      expect(await screen.findByText('No matches')).toBeTruthy()

      fireEvent.click(screen.getByRole('button', { name: 'Clear search' }))
      expect(screen.getByText('Write docs')).toBeTruthy()
      expect(screen.getByRole('group', { name: 'Pinned' })).toBeTruthy()
    })
  })

  describe('status filter', () => {
    /** Check or uncheck a status in the filter menu, which stays open
     *  across picks. */
    const pick = async (status: string): Promise<void> => {
      if (!screen.queryByRole('menu')) fireEvent.click(screen.getByRole('button', { name: 'Filter by status' }))
      fireEvent.click(await screen.findByRole('menuitemcheckbox', { name: status }))
    }

    it('narrows the rows and groups to the checked statuses, opening or hiding the Stopped section', async () => {
      stoppedRows.push(stoppedEntry('old'))
      renderList([
        entry({ workspaceId: 'a', title: 'Needs me', status: 'waiting' }),
        entry({ workspaceId: 'b', title: 'Busy' }),
        entry({ workspaceId: 'c', title: 'Watching', status: 'background', groupId: 'g1' }),
      ], {
        groups: [group(), group({ groupId: 'g2', name: 'Pinned', pinned: true })],
        project: { stoppedCount: 1, unseenDeaths: 0 },
        queued: [queuedEntry('q1', { parentWorkspaceId: 'a' }), queuedEntry('q2', { parentWorkspaceId: 'b' })],
      })

      await pick('Waiting')
      expect(screen.getByText('Needs me')).toBeTruthy()
      expect(screen.queryByText('Busy')).toBeNull()
      expect(screen.queryByRole('group', { name: 'Release' })).toBeNull()
      expect(screen.queryByRole('group', { name: 'Pinned' })).toBeNull()
      expect(screen.queryByRole('group', { name: 'Stopped workspaces' })).toBeNull()
      // A queued workspace stays under its shown parent, and goes with a hidden one.
      expect(screen.getAllByText(/1 queued workspace/)).toHaveLength(1)
      expect(screen.getByRole('button', { name: 'Filter by status' }).textContent).toBe('1')

      await pick('Monitoring')
      expect(within(screen.getByRole('group', { name: 'Release' })).getByText('Watching')).toBeTruthy()

      await pick('Stopped')
      const stoppedSection = screen.getByRole('group', { name: 'Stopped workspaces' })
      expect(await within(stoppedSection).findByText('Stopped old')).toBeTruthy()
      expect(useUiStore.getState().sidebarStatuses).toEqual(['waiting', 'background', 'stopped'])

      fireEvent.click(await screen.findByRole('menuitem', { name: 'Show all' }))
      expect(screen.getByText('Busy')).toBeTruthy()
      expect(screen.getByRole('group', { name: 'Pinned' })).toBeTruthy()
      expect(useUiStore.getState().sidebarStatuses).toEqual([])
    })

    it('says so when nothing has a checked status', async () => {
      renderList([entry({ workspaceId: 'a', title: 'Busy' })], { project: { stoppedCount: 3, unseenDeaths: 0 } })
      await pick('Waiting')
      expect(screen.getByText('No matches')).toBeTruthy()
    })
  })

  // A restarting workspace is missing from the snapshot until it is back, so
  // its placeholder row must sit in its group, not at the top of the list.
  it('draws a restarting workspace inside its group', () => {
    renderList([entry({ workspaceId: 'b', title: 'Filed one', groupId: 'g1' })], {
      groups: [group()],
      provisioning: [
        provisioning({ workspaceId: 'r', groupId: 'g1' }),
        provisioning({ workspaceId: 'loose', kind: 'create' }),
        provisioning({ workspaceId: 'named', kind: 'create', title: 'Fix the parser' }),
        provisioning({ workspaceId: 'f', groupId: 'g1', error: 'boom' }),
      ],
    })

    const section = screen.getByRole('group', { name: 'Release' })
    for (const row of screen.getAllByText('Restarting workspace')) expect(section.contains(row)).toBe(true)
    // The ungrouped provisioning row stays outside the group.
    expect(section.contains(screen.getByText('New workspace'))).toBe(false)
    // A create given a title, or made from a titled draft or queued entry,
    // is headed by it.
    expect(screen.getByText('Fix the parser')).toBeTruthy()
    // Counted as active alongside the live row; a failed one is shown but has
    // nothing running.
    expect(screen.getByText('(2/3)')).toBeTruthy()
  })

  it('keeps a group on screen while its last workspace restarts', () => {
    // Nothing live is left in it, so an unpinned group would otherwise vanish
    // and take the restarting row with it.
    renderList([], { groups: [group()], provisioning: [provisioning({ groupId: 'g1' })] })
    expect(screen.getByRole('group', { name: 'Release' })).toBeTruthy()
    expect(screen.getByText('Restarting workspace')).toBeTruthy()
  })

  it('selects a workspace on tap, which is what advances the mobile pane screen', () => {
    renderList([entry({ workspaceId: 'a', title: 'Fix parser' })])
    fireEvent.click(screen.getByText('Fix parser'))
    expect(useUiStore.getState().selectedWorkspaceId).toBe('a')
    expect(useUiStore.getState().mobileScreen).toBe('pane')
  })

  it('gathers a row\'s actions into one menu — reachable without a hover', async () => {
    renderList([entry({ workspaceId: 'a', title: 'Fix parser' })])
    fireEvent.click(screen.getByRole('button', { name: 'Workspace actions' }))
    const items = (await screen.findAllByRole('menuitem')).map((i) => i.textContent)
    expect(items).toEqual(['Rename', 'Move to group…', 'Queue workspace after this…', 'Stop…'])
    fireEvent.click(screen.getByRole('menuitem', { name: 'Move to group…' }))
    expect(await screen.findByText('Add to group')).toBeTruthy()
  })

  it('confirms a stop, naming what it will start', async () => {
    snapshot.mockReturnValue({ queuedWorkspaces: [queuedEntry('q1'), queuedEntry('q2', {
      parentWorkspaceId: undefined, parentQueuedId: 'q1',
    })] })
    renderList([entry({ workspaceId: 'a', title: 'Fix parser' })])
    await pickAction('Stop…')
    expect(await screen.findByText('Stop “Fix parser”?')).toBeTruthy()
    // Only the direct child starts with this stop; the chain below it waits.
    expect(screen.getByRole('button', { name: 'Stop and start 1 queued' })).toBeTruthy()
    expect(screen.getByText(/waits for its parent/)).toBeTruthy()

    fireEvent.click(screen.getAllByRole('button', { name: 'Discard' })[0])
    await waitFor(() => expect(posted(QUEUE_DISCARD)).toEqual([{ id: 'q1' }]))
    fireEvent.click(screen.getAllByRole('button', { name: 'Edit' })[1])
    expect(useUiStore.getState().createWorkspaceDialog).toEqual({ projectId: 'proj', editId: 'q2' })
  })

  it('opens the create dialog queued after a row', async () => {
    renderList([entry({ workspaceId: 'a', title: 'Fix parser' })])
    await pickAction('Queue workspace after this…')
    await waitFor(() => expect(useUiStore.getState().createWorkspaceDialog)
      .toEqual({ projectId: 'proj', parent: 'a', focus: 'prompt' }))
  })

  describe('queued workspaces', () => {
    it('nests each under the row it waits on, a chain one step deeper per link', () => {
      renderList([entry({ workspaceId: 'a', title: 'Parent' }), entry({ workspaceId: 'b', title: 'Other' })], {
        queued: [
          queuedEntry('q1'),
          queuedEntry('q2', { parentWorkspaceId: undefined, parentQueuedId: 'q1', launchError: 'branch gone' }),
        ],
      })
      fireEvent.click(screen.getByRole('button', { name: /2 queued workspaces/ }))
      const text = screen.getByRole('group', { name: 'Ungrouped workspaces' }).textContent ?? ''
      // The chain follows the row it waits on, whatever else is listed.
      expect(text.indexOf('Parent')).toBeLessThan(text.indexOf('Step q1'))
      expect(text.indexOf('Step q1')).toBeLessThan(text.indexOf('Step q2'))
      expect(screen.getByText('Claude · Sonnet 5 · queued')).toBeTruthy()
      // A failed launch says why in place of its settings.
      expect(screen.getByText('branch gone')).toBeTruthy()
    })

    it('collapses a workspace\'s whole queued set behind one count, open wherever the workspace moves', () => {
      const queued = [
        queuedEntry('q1'),
        queuedEntry('q2', { parentWorkspaceId: undefined, parentQueuedId: 'q1' }),
        queuedEntry('q3'),
      ]
      const rerender = renderList([entry({ workspaceId: 'a', title: 'Parent' })], { queued })
      // Collapsed on load. The count reaches through the chain, and only the
      // top-level set has an expander — not q1, which has a chain of its own.
      expect(screen.getAllByRole('button', { name: /queued workspace/ })).toHaveLength(1)
      expect(screen.queryByText('Step q1')).toBeNull()
      expect(screen.queryByText('Step q2')).toBeNull()
      fireEvent.click(screen.getByRole('button', { name: '3 queued workspaces' }))
      expect(screen.getByText('Step q2')).toBeTruthy()

      // Filed into a group, then stopped (held): still open.
      rerender([entry({ workspaceId: 'a', title: 'Parent', groupId: 'g1' })], {
        queued,
        groups: [group()],
      })
      expect(screen.getByRole('group', { name: group().name }).textContent).toContain('Step q1')
      const held = [{ workspaceId: 'a', projectId: 'proj', tool: 'claude' as const, title: 'Parent',
        stoppedAt: '2026-08-10 00:00:00' }]
      rerender([], { queued, held })
      expect(screen.getByText('Parent')).toBeTruthy()
      expect(screen.getByText('Step q1')).toBeTruthy()

      // A failed launch shows on the expander, since its row can be hidden.
      fireEvent.click(screen.getByRole('button', { name: '3 queued workspaces' }))
      rerender([], { queued: [{ ...queued[0], launchError: 'branch gone' }, ...queued.slice(1)], held })
      expect(screen.getByRole('button', { name: /3 queued workspaces.*1 failed/ })).toBeTruthy()
      expect(screen.queryByText('branch gone')).toBeNull()

      fireEvent.click(screen.getByRole('button', { name: /3 queued workspaces/ }))
      expect(screen.getByText('branch gone')).toBeTruthy()
      expect(screen.getByText('Step q2')).toBeTruthy()
    })

    it('opens only the set the user just queued or moved into, once the entry lands there', async () => {
      const workspaces = [entry({ workspaceId: 'a', title: 'Parent' }), entry({ workspaceId: 'b', title: 'Other' })]
      const other = queuedEntry('q9', { parentWorkspaceId: 'b' })
      const rerender = renderList(workspaces, { queued: [queuedEntry('q1'), other] })
      // Queued at the end of a's chain; the snapshot hasn't caught up yet.
      act(() => useUiStore.getState().setRevealQueued({ id: 'q2', parent: 'q1' }))
      expect(screen.queryByText('Step q1')).toBeNull()

      const chained = queuedEntry('q2', { parentWorkspaceId: undefined, parentQueuedId: 'q1' })
      rerender(workspaces, { queued: [queuedEntry('q1'), chained, other] })
      await waitFor(() => expect(screen.getByText('Step q2')).toBeTruthy())
      expect(screen.getByText('Step q1')).toBeTruthy()
      expect(screen.queryByText('Step q9')).toBeNull()
      expect(useUiStore.getState().revealQueued).toBeNull()

      // Moved to b: the snapshot still shows it under q1 when the save
      // resolves, which must not count — only its arrival under b does.
      fireEvent.click(screen.getByRole('button', { name: '2 queued workspaces' }))
      act(() => useUiStore.getState().setRevealQueued({ id: 'q2', parent: 'b' }))
      expect(screen.queryByText('Step q1')).toBeNull()
      expect(useUiStore.getState().revealQueued).not.toBeNull()
      rerender(workspaces, { queued: [queuedEntry('q1'), { ...chained, parentQueuedId: undefined, parentWorkspaceId: 'b' },
        other] })
      await waitFor(() => expect(screen.getByText('Step q9')).toBeTruthy())
      expect(screen.getByText('Step q2')).toBeTruthy()
      expect(screen.queryByText('Step q1')).toBeNull()
    })

    it('keeps a held parent in its place with why it died, and puts an orphan on top', () => {
      renderList([], {
        queued: [
          queuedEntry('q1', { parentWorkspaceId: 'dead' }),
          queuedEntry('q9', { parentWorkspaceId: 'never', orphaned: true }),
        ],
        held: [{
          workspaceId: 'dead', projectId: 'proj', tool: 'claude', title: 'Crashed one',
          stoppedAt: '2026-08-10 00:00:00', deathReason: 'oom',
        }],
      })
      expect(screen.getByText('Crashed one')).toBeTruthy()
      expect(screen.getByText(/died .* — /)).toBeTruthy()
      expect(screen.getByText('parent gone')).toBeTruthy()
      expect(screen.queryByText('No workspaces yet')).toBeNull()
    })

    it('keeps a group on screen for a held member', () => {
      renderList([], {
        groups: [group()],
        queued: [queuedEntry('q1', { parentWorkspaceId: 'dead' })],
        held: [{ workspaceId: 'dead', projectId: 'proj', tool: 'claude', groupId: 'g1', stoppedAt: '' }],
      })
      fireEvent.click(screen.getByRole('button', { name: '1 queued workspace' }))
      expect(screen.getByRole('group', { name: 'Release' }).textContent).toContain('Step q1')
    })

    it('edits on click, and runs, re-queues after, or discards from its menu', async () => {
      renderList([entry({ workspaceId: 'a', title: 'Parent' })], {
        queued: [queuedEntry('q1'), queuedEntry('q2', { parentWorkspaceId: undefined, parentQueuedId: 'q1' })],
      })
      fireEvent.click(screen.getByRole('button', { name: '2 queued workspaces' }))
      fireEvent.click(screen.getByText('Step q1'))
      expect(useUiStore.getState().createWorkspaceDialog).toEqual({ projectId: 'proj', editId: 'q1' })

      await pickAction('Run now', 'Queued workspace actions')
      await waitFor(() => expect(posted(QUEUE_RUN)).toEqual([{ id: 'q1' }]))

      await pickAction('Queue workspace after this…', 'Queued workspace actions')
      await waitFor(() => expect(useUiStore.getState().createWorkspaceDialog)
        .toEqual({ projectId: 'proj', parent: 'q1', focus: 'prompt' }))

      await pickAction('Discard…', 'Queued workspace actions')
      // The confirmation says where its chain goes, and that it still runs.
      expect(await screen.findByText(
        '“Step q1” will not run. The workspace queued after it will start when “Parent” stops instead.',
      )).toBeTruthy()
      fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
      await waitFor(() => expect(posted(QUEUE_DISCARD)).toEqual([{ id: 'q1' }]))
    })
  })

  describe('draft workspaces', () => {
    const draft = (id: string, over: Partial<DraftWorkspaceEntry> = {}): DraftWorkspaceEntry => ({
      id, projectId: 'proj', prompt: `Idea ${id}\nmore detail`, tool: 'codex', mode: 'tui',
      permissionMode: 'manual', createdAt: '2026-08-10 00:00:00', updatedAt: '2026-08-10 00:00:00', ...over,
    })

    it('shows no section without drafts, and a collapsible one above everything with them', () => {
      renderList([entry({ title: 'Live' })])
      expect(screen.queryByRole('group', { name: 'Drafts' })).toBeNull()

      cleanup()
      renderList([entry({ title: 'Live' })], {
        drafts: [
          draft('d1'),
          draft('d2', { generatedTitle: 'Generated title' }),
          draft('d3', { title: 'Mine', generatedTitle: 'Not shown' }),
        ],
      })
      const section = screen.getByRole('group', { name: 'Drafts' })
      // Newest first; the user's title, else a generated one, wins over the
      // prompt's first line.
      expect(section.textContent).toMatch(/Mine.*Generated title.*Idea d1/)
      expect(section.textContent).not.toMatch(/Not shown/)
      const all = document.body.textContent ?? ''
      expect(all.indexOf('Idea d1')).toBeLessThan(all.indexOf('Live'))

      fireEvent.click(screen.getByRole('button', { name: /Drafts/ }))
      expect(screen.queryByText('Idea d1')).toBeNull()
      // Nothing is shown, but the list is not empty either.
      expect(screen.queryByText('No workspaces yet')).toBeNull()
    })

    it('reopens the create dialog on click, and discards from its menu', async () => {
      renderList([], { drafts: [draft('d1')] })
      expect(screen.queryByText('No workspaces yet')).toBeNull()
      fireEvent.click(screen.getByText('Idea d1'))
      expect(useUiStore.getState().createWorkspaceDialog)
        .toEqual({ projectId: 'proj', draftId: 'd1', focus: 'prompt' })

      await pickAction('Discard…', 'Draft actions')
      fireEvent.click(await screen.findByRole('button', { name: 'Discard' }))
      await waitFor(() => expect(posted(DRAFT_DISCARD)).toEqual([{ id: 'd1' }]))
    })

    // Its Start is ignored, and the row is headed by the generated title
    // until the server reports it.
    it('runs a draft now from its menu', async () => {
      renderList([], {
        drafts: [draft('d1', { generatedTitle: 'Idea one', branch: 'dev', startAfter: 's1', groupId: 'g1' })],
      })
      await pickAction('Run now', 'Draft actions')
      expect(provision).toHaveBeenCalledWith(
        'proj', 'codex', 'create', expect.any(String), expect.any(Function), 'g1',
        { title: 'Idea one', prompt: 'Idea d1\nmore detail' })
      const op = provision.mock.calls[0][4] as (id: string, onProgress: () => void) => Promise<unknown>
      await op('w-new', () => {})
      expect(createWorkspace).toHaveBeenCalledWith('proj', 'codex', expect.any(Function), 'w-new', {
        branch: 'dev', permissionMode: 'manual', mode: 'tui', prompt: 'Idea d1\nmore detail', group: 'g1', draftId: 'd1',
      })
    })
  })

  it('says what to do when there is nothing to show', () => {
    renderList([])
    expect(screen.getByText('No workspaces yet')).toBeTruthy()

    // Only stopped workspaces: the Stopped section is something to show.
    cleanup()
    renderList([], { project: { stoppedCount: 3, unseenDeaths: 0 } })
    expect(screen.queryByText('No workspaces yet')).toBeNull()
    expect(screen.getByRole('button', { name: /Stopped\s*3/ })).toBeTruthy()

    cleanup()
    renderList([], { projectId: null })
    expect(screen.getByText('No project selected')).toBeTruthy()
    // jsdom's matchMedia stub reports desktop, so the copy points at the rail.
    expect(screen.getByText('Pick a project from the rail on the left.')).toBeTruthy()
  })

  describe('the group dialog', () => {
    it('creates a group around the row it was opened from', async () => {
      renderList([entry({ workspaceId: 'a', title: 'Fix parser' })])
      await pickAction('Move to group…')
      fireEvent.change(await screen.findByPlaceholderText('New group name'), {
        target: { value: 'Release' },
      })
      fireEvent.click(screen.getByRole('button', { name: 'Create group' }))

      await waitFor(() => expect(posted(GROUP_CREATE)).toEqual([{ projectId: 'proj', workspaceId: 'a', name: 'Release' }]))
    })

    it('offers only the groups the sidebar is showing', async () => {
      // A hidden group's workspaces have all stopped. Moving a live workspace
      // into it would make it reappear unexpectedly, and a drag can't target
      // it.
      renderList([entry({ workspaceId: 'a', title: 'Fix parser' })], {
        groups: [group({ pinned: true }), group({ groupId: 'g2', name: 'Hidden' })],
      })
      await pickAction('Move to group…')

      expect(await screen.findByRole('button', { name: 'Release' })).toBeTruthy()
      expect(screen.queryByRole('button', { name: 'Hidden' })).toBeNull()
    })

    // The keyboard/touch equivalent of dragging with a mouse.
    it('moves the row into an existing group, and back out of one', async () => {
      renderList([entry({ workspaceId: 'a', title: 'Fix parser' })], {
        groups: [group({ pinned: true })],
      })
      await pickAction('Move to group…')
      fireEvent.click(await screen.findByRole('button', { name: 'Release' }))
      await waitFor(() => expect(posted(SET_GROUP)).toEqual([filed('a', 'g1')]))

      cleanup()
      renderList([entry({ workspaceId: 'a', title: 'Fix parser', groupId: 'g1' })], { groups: [group()] })
      await pickAction('Move to group…')
      fireEvent.click(await screen.findByRole('button', { name: 'Remove from group' }))
      await waitFor(() => expect(posted(SET_GROUP)).toEqual([filed('a', 'g1'), filed('a', null)]))
    })
  })

  describe('group header actions', () => {
    const renderGrouped = (): void => {
      renderList([entry({ workspaceId: 'b', title: 'Filed one', groupId: 'g1' })], { groups: [group()] })
    }

    it('pins, deletes, and renames the group inline', async () => {
      renderGrouped()
      await pickAction('Pin', 'Group actions')
      await waitFor(() => expect(posted(GROUP_PIN)).toEqual([{ projectId: 'proj', groupId: 'g1', pinned: true }]))

      await pickAction('Rename', 'Group actions')
      const input = await screen.findByRole<HTMLInputElement>('textbox', { name: 'Group name' })
      expect(input.value).toBe('Release')
      fireEvent.change(input, { target: { value: 'Shipping' } })
      fireEvent.keyDown(input, { key: 'Enter' })
      await waitFor(() => expect(posted(GROUP_RENAME)).toEqual([{ projectId: 'proj', groupId: 'g1', name: 'Shipping' }]))

      await pickAction('Delete group', 'Group actions')
      await waitFor(() => expect(posted(GROUP_DELETE)).toEqual([{ projectId: 'proj', groupId: 'g1' }]))
    })
  })

  describe('drag between the list and a group', () => {
    /** jsdom lays nothing out, so the drop zones get the geometry the test
     *  needs: the ungrouped list on top, the group's section below it. */
    function stubZones(): void {
      const rect = (top: number, bottom: number): DOMRect =>
        ({ top, bottom, left: 0, right: 200, x: 0, y: top, width: 200, height: bottom - top,
          toJSON: () => ({}) })
      screen.getByRole('group', { name: 'Ungrouped workspaces' }).getBoundingClientRect =
        () => rect(0, 100)
      screen.getByRole('group', { name: 'Release' }).getBoundingClientRect = () => rect(100, 200)
    }

    const press = (label: string, clientY: number): void => {
      fireEvent.pointerDown(screen.getByText(label), { pointerType: 'mouse', clientX: 10, clientY })
    }
    const dropAt = (clientY: number): void => {
      fireEvent.pointerMove(window, { clientX: 10, clientY })
      fireEvent.pointerUp(window, { clientX: 10, clientY })
    }

    it('files a workspace into the group it is dropped on, and back out again', async () => {
      renderList([
        entry({ workspaceId: 'a', title: 'Loose one' }),
        entry({ workspaceId: 'b', title: 'Filed one', groupId: 'g1' }),
      ], { groups: [group()] })
      stubZones()

      press('Loose one', 10)
      dropAt(150)
      await waitFor(() => expect(posted(SET_GROUP)).toEqual([filed('a', 'g1')]))

      press('Filed one', 150)
      dropAt(10)
      await waitFor(() => expect(posted(SET_GROUP)).toEqual([filed('a', 'g1'), filed('b', null)]))
    })

    it('leaves a press that never travels as a plain selection', () => {
      // Pinned, so the section is on screen with nothing live in it.
      renderList([entry({ workspaceId: 'a', title: 'Loose one' })], {
        groups: [group({ pinned: true })],
      })
      stubZones()

      press('Loose one', 10)
      dropAt(12) // inside the threshold
      expect(posted(SET_GROUP)).toEqual([])
      expect(useUiStore.getState().selectedWorkspaceId).toBe('a')
    })

    it('drops the drag when the pointer is cancelled, and stays dropped', () => {
      renderList([
        entry({ workspaceId: 'a', title: 'Loose one' }),
        entry({ workspaceId: 'b', title: 'Filed one', groupId: 'g1' }),
      ], { groups: [group()] })
      stubZones()

      press('Loose one', 10)
      fireEvent.pointerMove(window, { clientX: 10, clientY: 150 })
      fireEvent.pointerCancel(window, { clientX: 10, clientY: 150 })
      expect(posted(SET_GROUP)).toEqual([])

      // The listeners were removed, so a later unrelated pointerup can't
      // replay the move.
      fireEvent.pointerUp(window, { clientX: 10, clientY: 150 })
      expect(posted(SET_GROUP)).toEqual([])
    })

    it('ignores a drop back where the workspace started', () => {
      renderList([entry({ workspaceId: 'b', title: 'Filed one', groupId: 'g1' })], { groups: [group()] })
      stubZones()

      press('Filed one', 150)
      dropAt(190)
      expect(posted(SET_GROUP)).toEqual([])
    })
  })

  describe('row rename', () => {
    /** Pick Rename from a row's menu to open its inline editor and return the field. */
    async function openEditor(): Promise<HTMLInputElement> {
      await pickAction('Rename')
      return await screen.findByRole<HTMLInputElement>('textbox', { name: 'Workspace row title' })
    }

    it('seeds the editor from the title, falling back to the prompt', async () => {
      renderList([entry({ workspaceId: 'a', title: 'My workspace', prompt: 'do a thing' })])
      expect((await openEditor()).value).toBe('My workspace')
      cleanup()

      renderList([entry({ workspaceId: 'a', title: '', prompt: 'do a thing' })])
      expect((await openEditor()).value).toBe('do a thing')
    })

    it('commits a rename on Enter and closes the editor', async () => {
      renderList([entry({ workspaceId: 'a', title: 'Old' })])
      const input = await openEditor()
      fireEvent.change(input, { target: { value: 'New name' } })
      fireEvent.keyDown(input, { key: 'Enter' })

      expect(renameWorkspace).toHaveBeenCalledWith('a', 'New name')
      expect(screen.queryByRole('textbox', { name: 'Workspace row title' })).toBeNull()
    })

    it('commits a rename on blur', async () => {
      renderList([entry({ workspaceId: 'a', title: 'Old' })])
      const input = await openEditor()
      fireEvent.change(input, { target: { value: 'Renamed' } })
      fireEvent.blur(input)

      expect(renameWorkspace).toHaveBeenCalledWith('a', 'Renamed')
    })

    it('reverts on Escape without renaming', async () => {
      renderList([entry({ workspaceId: 'a', title: 'Old' })])
      const input = await openEditor()
      fireEvent.change(input, { target: { value: 'discard me' } })
      fireEvent.keyDown(input, { key: 'Escape' })

      expect(renameWorkspace).not.toHaveBeenCalled()
      expect(screen.queryByRole('textbox', { name: 'Workspace row title' })).toBeNull()
    })

    it('does not rename when the value is unchanged', async () => {
      renderList([entry({ workspaceId: 'a', title: 'Same' })])
      const input = await openEditor()
      fireEvent.keyDown(input, { key: 'Enter' })

      expect(renameWorkspace).not.toHaveBeenCalled()
    })

    it('does not select the workspace when renaming it', async () => {
      renderList([entry({ workspaceId: 'a', title: 'Old' })])
      await openEditor()

      expect(useUiStore.getState().selectedWorkspaceId).toBeNull()
    })
  })

  it('lays out a teammate\'s list as theirs, with every control off and rows still opening', async () => {
    // Viewing another user (#lib/viewer): the caller is TEST_USER_ID.
    useUiStore.setState({ viewedUserId: 'u-ada' })
    stoppedRows.push({
      workspaceId: 'ghost', projectId: 'proj', tool: 'claude', createdAt: '2026-08-09 00:00:00',
      stoppedAt: '2026-08-09 01:00:00', title: 'Old run', seen: true, agentSessions: [], groupId: 'g1',
    })
    renderList([entry({ workspaceId: 'a', title: 'Their run' }), entry({ workspaceId: 'b', title: 'Filed', groupId: 'g1' })], {
      groups: [group({ stoppedCount: 1 })],
      provisioning: [provisioning({ kind: 'create', title: 'Booting' })],
      queued: [queuedEntry('q1')],
      drafts: [{
        id: 'd1', projectId: 'proj', prompt: 'An idea', tool: 'codex', mode: 'tui',
        permissionMode: 'manual', createdAt: '2026-08-10 00:00:00', updatedAt: '2026-08-10 00:00:00',
      }],
    })

    expect(screen.getByText(/workspaces, read-only/)).toBeTruthy()
    for (const menu of ['Workspace actions', 'Queued workspace actions', 'Draft actions']) {
      expect(screen.queryByRole('button', { name: menu })).toBeNull()
    }
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull()
    // Queued entries and drafts open the create form, which writes.
    expect(screen.getByRole<HTMLButtonElement>('button', { name: /An idea/ }).disabled).toBe(true)

    // The group menu keeps only what changes this client's view.
    await pickAction('Show stopped workspaces', 'Group actions')
    await screen.findByText('Old run')
    expect(screen.queryByRole('button', { name: 'Restart workspace' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Remove from group' })).toBeNull()

    fireEvent.click(screen.getByText('Their run'))
    expect(useUiStore.getState().selectedWorkspaceId).toBe('a')
    expect(server.calls.filter((c) => c.method !== 'GET')).toEqual([])
  })
})
