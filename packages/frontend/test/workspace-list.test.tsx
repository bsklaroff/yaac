// @vitest-environment jsdom
import type { JSX } from 'react'
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react'
import type {
  DraftWorkspaceEntry,
  HeldWorkspaceEntry,
  ProvisioningWorkspaceEntry,
  QueuedWorkspaceEntry,
  StoppedWorkspaceEntry,
  WorkspaceGroupSummary,
  WorkspaceListEntry,
} from '@yaac/shared/types'

const stoppedRows: StoppedWorkspaceEntry[] = []
vi.mock('#lib/stoppedApi', () => ({ getStoppedWorkspaces: vi.fn(() => Promise.resolve(stoppedRows)) }))
vi.mock('#lib/createWorkspace', () => ({
  dismissProvisioning: vi.fn(),
  restartWorkspace: vi.fn(),
  renameWorkspace: vi.fn(() => Promise.resolve()),
}))
vi.mock('#lib/groupApi', () => ({
  createWorkspaceGroup: vi.fn(() => Promise.resolve({ groupId: 'g-new' })),
  renameWorkspaceGroup: vi.fn(() => Promise.resolve()),
  setWorkspaceGroupPinned: vi.fn(() => Promise.resolve()),
  deleteWorkspaceGroup: vi.fn(() => Promise.resolve()),
  setWorkspaceGroup: vi.fn(() => Promise.resolve()),
}))
vi.mock('#lib/stopWorkspaceFlow', () => ({ stopWorkspaceOptimistic: vi.fn() }))
vi.mock('#lib/useProvisionWorkspace', () => ({ useProvisionWorkspace: () => vi.fn() }))
vi.mock('#lib/queueApi', () => ({
  runQueuedWorkspace: vi.fn(() => Promise.resolve({ workspaceId: 'w-run' })),
  discardQueuedWorkspace: vi.fn(() => Promise.resolve()),
}))
vi.mock('#lib/draftApi', () => ({ discardDraftWorkspace: vi.fn(() => Promise.resolve()) }))
// The stop dialog lists what is queued, off the snapshot.
const snapshot = vi.hoisted(() => vi.fn())
vi.mock('#lib/useSnapshot', () => ({ useSnapshot: snapshot }))

import { WorkspaceList } from '#components/WorkspaceList'
import { renameWorkspace } from '#lib/createWorkspace'
import { discardDraftWorkspace } from '#lib/draftApi'
import { discardQueuedWorkspace, runQueuedWorkspace } from '#lib/queueApi'
import {
  createWorkspaceGroup,
  deleteWorkspaceGroup,
  renameWorkspaceGroup,
  setWorkspaceGroup,
  setWorkspaceGroupPinned,
} from '#lib/groupApi'
import { useUiStore } from '#lib/store'

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
})

const initial = useUiStore.getState()

beforeEach(() => {
  localStorage.clear()
  stoppedRows.length = 0
  snapshot.mockReturnValue(undefined)
  useUiStore.setState(initial, true)
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const entry = (over: Partial<WorkspaceListEntry> = {}): WorkspaceListEntry => ({
  workspaceId: 's1',
  projectSlug: 'proj',
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
  projectSlug: 'proj',
  name: 'Release',
  pinned: false,
  createdAt: '2026-08-10 00:00:00',
  ...over,
})

const provisioning = (over: Partial<ProvisioningWorkspaceEntry> = {}): ProvisioningWorkspaceEntry => ({
  workspaceId: 'p1',
  projectSlug: 'proj',
  tool: 'claude',
  kind: 'restart',
  message: 'Starting…',
  createdAt: '2026-08-10 00:00:00',
  ...over,
})

const queuedEntry = (id: string, over: Partial<QueuedWorkspaceEntry> = {}): QueuedWorkspaceEntry => ({
  id,
  projectSlug: 'proj',
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
  groups?: WorkspaceGroupSummary[]
  projectSlug?: string | null
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
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const element = (w: WorkspaceListEntry[], o: ListOpts): JSX.Element => (
    <QueryClientProvider client={client}>
      <WorkspaceList
        projectSlug={o.projectSlug === undefined ? 'proj' : o.projectSlug}
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
 * The list body the desktop sidebar and the mobile workspaces screen share.
 * Its ordering and group-visibility rules are covered as pure functions in
 * sidebar.test.ts; what matters here is that the rendered body agrees with
 * them and that its row and group actions work without a hover, which is the
 * only kind of interaction a phone has.
 */
describe('WorkspaceList', () => {
  it('renders one flat list, with each group as its own section below it', () => {
    renderList([
      entry({ workspaceId: 'a', title: 'Loose one', status: 'waiting' }),
      entry({ workspaceId: 'b', title: 'Filed one', groupId: 'g1' }),
      entry({ workspaceId: 'c', title: 'Dying one', stopping: true }),
    ], { groups: [group()] })

    // No status headers survive — a row's own markers say what state it is in.
    expect(screen.queryByText('Waiting')).toBeNull()
    expect(screen.queryByText('Running')).toBeNull()
    expect(screen.getByText('Loose one')).toBeTruthy()
    expect(screen.getByRole('group', { name: 'Release' })).toBeTruthy()
    expect(screen.getByText('Filed one')).toBeTruthy()
    // A workspace on its way out is a placeholder, not a selectable row.
    expect(screen.getByText('stopping…')).toBeTruthy()
  })

  it('names each row\'s tool and the model it is answering as', () => {
    // The model comes off the live conversation, so a row says what it is
    // running rather than what it was launched with. A workspace whose agent
    // has not replied yet — and every opencode one, which leaves no
    // transcript to read — keeps the bare tool name.
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
    const stoppedMember = (workspaceId: string, title: string): StoppedWorkspaceEntry => ({
      workspaceId,
      projectSlug: 'proj',
      tool: 'claude',
      createdAt: '2026-08-10 00:00:00',
      stoppedAt: '2026-08-10 01:00:00',
      title,
      seen: false,
      agentSessions: [],
      groupId: 'g1',
    })
    stoppedRows.push(stoppedMember('gone', 'Stopped one'), stoppedMember('gone2', 'Stopped two'))
    renderList([entry({ workspaceId: 'b', title: 'Filed one', groupId: 'g1' })], { groups: [group()] })

    const section = screen.getByRole('group', { name: group().name })
    await waitFor(() => expect(section.textContent).toContain('(1/3)'))
    expect(screen.queryByText('Stopped one')).toBeNull()

    // Shown at the foot of the section, after the live rows.
    await pickAction('Show stopped workspaces', 'Group actions')
    expect(section.textContent?.indexOf('Stopped one'))
      .toBeGreaterThan(section.textContent?.indexOf('Filed one') ?? Infinity)
    const row = screen.getByText('Stopped one').closest<HTMLElement>('.group')
    fireEvent.click(within(row ?? document.body).getByLabelText('Remove from group'))
    await waitFor(() => expect(setWorkspaceGroup).toHaveBeenCalledWith('proj', 'gone', null))

    // Hiding them leaves the live rows where they were.
    await pickAction('Hide stopped workspaces', 'Group actions')
    expect(screen.queryByText('Stopped one')).toBeNull()
    expect(screen.getByText('Filed one')).toBeTruthy()
  })

  it('makes the caret the show/hide toggle for a group with only stopped members', async () => {
    stoppedRows.push({
      workspaceId: 'gone',
      projectSlug: 'proj',
      tool: 'claude',
      createdAt: '2026-08-10 00:00:00',
      stoppedAt: '2026-08-10 01:00:00',
      title: 'Stopped one',
      seen: true,
      agentSessions: [],
      groupId: 'g1',
    })
    renderList([], { groups: [group({ pinned: true })] })

    const caret = await screen.findByRole('button', { name: /Release.*\(0\/1\)/ })
    expect(caret.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(caret)
    expect(screen.getByText('Stopped one')).toBeTruthy()

    // The menu sees the same state the caret set, and closes the caret too.
    await pickAction('Hide stopped workspaces', 'Group actions')
    expect(screen.queryByText('Stopped one')).toBeNull()
    expect(caret.getAttribute('aria-expanded')).toBe('false')
    await pickAction('Show stopped workspaces', 'Group actions')
    expect(screen.getByText('Stopped one')).toBeTruthy()
    expect(caret.getAttribute('aria-expanded')).toBe('true')
  })

  it('keeps an all-stopped group the caret opened open once a member restarts', async () => {
    // Collapsed while it still has a live member...
    const opts = { groups: [group({ pinned: true })] }
    const rerender = renderList([entry({ workspaceId: 'gone', title: 'Live one', groupId: 'g1' })], opts)
    fireEvent.click(screen.getByRole('button', { name: /Release.*\(1\/1\)/ }))
    expect(screen.queryByText('Live one')).toBeNull()

    // ...then it stops, leaving only stopped members, and the caret opens it.
    stoppedRows.push({
      workspaceId: 'gone',
      projectSlug: 'proj',
      tool: 'claude',
      createdAt: '2026-08-10 00:00:00',
      stoppedAt: '2026-08-10 01:00:00',
      title: 'Stopped one',
      seen: true,
      agentSessions: [],
      groupId: 'g1',
    })
    rerender([], opts)
    const caret = await screen.findByRole('button', { name: /Release.*\(0\/1\)/ })
    expect(caret.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(caret)
    expect(screen.getByText('Stopped one')).toBeTruthy()

    // A restart makes it live again: it must not snap back to how it was left
    // while it last had a live member, hiding the row the user just asked for.
    rerender([], { ...opts, provisioning: [provisioning({ workspaceId: 'gone', groupId: 'g1' })] })
    expect(screen.getByRole('button', { name: /Release.*\(1\/1\)/ }).getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText('Restarting workspace')).toBeTruthy()
  })

  it('keeps a held member on screen as its queue comes and goes', async () => {
    const stoppedMember = (workspaceId: string, over: Partial<StoppedWorkspaceEntry> = {}): StoppedWorkspaceEntry => ({
      workspaceId,
      projectSlug: 'proj',
      tool: 'claude',
      createdAt: '2026-08-10 00:00:00',
      stoppedAt: '2026-08-10 01:00:00',
      title: `Stopped ${workspaceId}`,
      seen: true,
      agentSessions: [],
      groupId: 'g1',
      ...over,
    })
    const live = [entry({ workspaceId: 'b', title: 'Filed one', groupId: 'g1' })]
    const held = [{ workspaceId: 's', projectSlug: 'proj', tool: 'claude' as const, groupId: 'g1',
      stoppedAt: '2026-08-10 01:00:00' }]
    stoppedRows.push(stoppedMember('s'))
    const rerender = renderList(live, { groups: [group()], queued: [queuedEntry('q1', { parentWorkspaceId: 's' })], held })

    // Held: its row stays out, with what waits on it.
    expect(await screen.findByText('Stopped s')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '1 queued workspace' }))
    expect(screen.getByText('Step q1')).toBeTruthy()

    // Its queue drains: hidden with the other stopped members.
    rerender(live, { groups: [group()] })
    expect(screen.queryByText('Stopped s')).toBeNull()

    // Shown, they stay shown as another member stops — and an unread death
    // shows on the header, since hidden rows would hide it.
    await pickAction('Show stopped workspaces', 'Group actions')
    // The stopped list is refetched when the live set changes.
    stoppedRows.push(stoppedMember('t', { deathReason: 'oom', seen: false }))
    const more = [...live, entry({ workspaceId: 'c', title: 'Other' })]
    rerender(more, { groups: [group()] })
    expect(await screen.findByRole('button', { name: /Release.*\(1\/3\).*1 died/ })).toBeTruthy()
    expect(screen.getByText('Stopped t')).toBeTruthy()
    expect(screen.getByText('Stopped s')).toBeTruthy()

    // It gains a queued child: on screen again whatever the toggle says.
    await pickAction('Hide stopped workspaces', 'Group actions')
    rerender(more, { groups: [group()], queued: [queuedEntry('q2', { parentWorkspaceId: 's' })], held })
    expect(screen.getByText('Stopped s')).toBeTruthy()
    expect(screen.queryByText('Stopped t')).toBeNull()
  })

  it('opens a stopped member\'s conversation, without selecting a workspace', async () => {
    // A ghost row has no pane to open — but it does have a conversation, and
    // the stopped overlay is where that is readable. Selection must stay put:
    // there is nothing to show in the pane until it is restarted, and on a
    // phone selecting would navigate away from the list entirely.
    stoppedRows.push({
      workspaceId: 'gone',
      projectSlug: 'proj',
      tool: 'claude',
      createdAt: '2026-08-10 00:00:00',
      stoppedAt: '2026-08-10 01:00:00',
      title: 'Stopped one',
      seen: false,
      agentSessions: [],
      groupId: 'g1',
    })
    renderList([entry({ workspaceId: 'b', title: 'Filed one', groupId: 'g1' })], { groups: [group()] })

    await screen.findByRole('button', { name: /Release.*\(1\/2\)/ })
    await pickAction('Show stopped workspaces', 'Group actions')
    fireEvent.click(screen.getByText('Stopped one'))

    expect(useUiStore.getState().stoppedOverlayOpen).toBe(true)
    expect(useUiStore.getState().stoppedOverlayFocus).toBe('gone')
    expect(useUiStore.getState().selectedWorkspaceId).not.toBe('gone')
  })

  // A workspace being restarted is out of the snapshot until its container is
  // back, so this placeholder is the only thing holding its place — it has to
  // hold it where the workspace lives, not at the top of the list.
  it('draws a restarting workspace inside its group', () => {
    renderList([entry({ workspaceId: 'b', title: 'Filed one', groupId: 'g1' })], {
      groups: [group()],
      provisioning: [
        provisioning({ workspaceId: 'r', groupId: 'g1' }),
        provisioning({ workspaceId: 'loose', kind: 'create' }),
        provisioning({ workspaceId: 'f', groupId: 'g1', error: 'boom' }),
      ],
    })

    const section = screen.getByRole('group', { name: 'Release' })
    for (const row of screen.getAllByText('Restarting workspace')) expect(section.contains(row)).toBe(true)
    // The ungrouped one stays where every provisioning row used to go.
    expect(section.contains(screen.getByText('New workspace'))).toBe(false)
    // Counted in the section's active count alongside the live row — a failed
    // one is on screen but has nothing running behind it.
    expect(screen.getByText('(2/3)')).toBeTruthy()
  })

  it('keeps a group on screen while its last workspace restarts', () => {
    // Nothing live is left in it — an unpinned group would vanish, taking the
    // restarting row with it.
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
    expect(discardQueuedWorkspace).toHaveBeenCalledWith('q1')
    fireEvent.click(screen.getAllByRole('button', { name: 'Edit' })[1])
    expect(useUiStore.getState().createWorkspaceDialog).toEqual({ projectSlug: 'proj', editId: 'q2' })
  })

  it('opens the create dialog queued after a row', async () => {
    renderList([entry({ workspaceId: 'a', title: 'Fix parser' })])
    await pickAction('Queue workspace after this…')
    await waitFor(() => expect(useUiStore.getState().createWorkspaceDialog)
      .toEqual({ projectSlug: 'proj', parent: 'a', focus: 'prompt' }))
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
      const held = [{ workspaceId: 'a', projectSlug: 'proj', tool: 'claude' as const, title: 'Parent',
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
          workspaceId: 'dead', projectSlug: 'proj', tool: 'claude', title: 'Crashed one',
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
        held: [{ workspaceId: 'dead', projectSlug: 'proj', tool: 'claude', groupId: 'g1', stoppedAt: '' }],
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
      expect(useUiStore.getState().createWorkspaceDialog).toEqual({ projectSlug: 'proj', editId: 'q1' })

      await pickAction('Run now', 'Queued workspace actions')
      await waitFor(() => expect(runQueuedWorkspace).toHaveBeenCalledWith('q1'))

      await pickAction('Queue workspace after this…', 'Queued workspace actions')
      await waitFor(() => expect(useUiStore.getState().createWorkspaceDialog)
        .toEqual({ projectSlug: 'proj', parent: 'q1', focus: 'prompt' }))

      await pickAction('Discard…', 'Queued workspace actions')
      // The confirmation says where its chain goes, and that it still runs.
      expect(await screen.findByText(
        '“Step q1” will not run. The workspace queued after it will start when “Parent” stops instead.',
      )).toBeTruthy()
      fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
      await waitFor(() => expect(discardQueuedWorkspace).toHaveBeenCalledWith('q1'))
    })
  })

  describe('draft workspaces', () => {
    const draft = (id: string, over: Partial<DraftWorkspaceEntry> = {}): DraftWorkspaceEntry => ({
      id, projectSlug: 'proj', prompt: `Idea ${id}\nmore detail`, tool: 'codex', mode: 'tui',
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
        .toEqual({ projectSlug: 'proj', draftId: 'd1', focus: 'prompt' })

      await pickAction('Discard…', 'Draft actions')
      fireEvent.click(await screen.findByRole('button', { name: 'Discard' }))
      await waitFor(() => expect(discardDraftWorkspace).toHaveBeenCalledWith('d1'))
    })
  })

  it('says what to do when there is nothing to show', () => {
    renderList([])
    expect(screen.getByText('No workspaces yet')).toBeTruthy()

    cleanup()
    renderList([], { projectSlug: null })
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

      await waitFor(() => expect(createWorkspaceGroup).toHaveBeenCalledWith('proj', 'a', 'Release'))
    })

    it('offers only the groups the sidebar is showing', async () => {
      // A hidden group is one whose workspaces have all stopped; moving a live
      // workspace into it would make it reappear somewhere unannounced, and a
      // drag has no way to aim at it either.
      renderList([entry({ workspaceId: 'a', title: 'Fix parser' })], {
        groups: [group({ pinned: true }), group({ groupId: 'g2', name: 'Hidden' })],
      })
      await pickAction('Move to group…')

      expect(await screen.findByRole('button', { name: 'Release' })).toBeTruthy()
      expect(screen.queryByRole('button', { name: 'Hidden' })).toBeNull()
    })

    // The keyboard/touch path to what dragging does with a mouse.
    it('moves the row into an existing group, and back out of one', async () => {
      renderList([entry({ workspaceId: 'a', title: 'Fix parser' })], {
        groups: [group({ pinned: true })],
      })
      await pickAction('Move to group…')
      fireEvent.click(await screen.findByRole('button', { name: 'Release' }))
      await waitFor(() => expect(setWorkspaceGroup).toHaveBeenCalledWith('proj', 'a', 'g1'))

      cleanup()
      renderList([entry({ workspaceId: 'a', title: 'Fix parser', groupId: 'g1' })], { groups: [group()] })
      await pickAction('Move to group…')
      fireEvent.click(await screen.findByRole('button', { name: 'Remove from group' }))
      await waitFor(() => expect(setWorkspaceGroup).toHaveBeenCalledWith('proj', 'a', null))
    })
  })

  describe('group header actions', () => {
    const renderGrouped = (): void => {
      renderList([entry({ workspaceId: 'b', title: 'Filed one', groupId: 'g1' })], { groups: [group()] })
    }

    it('pins, deletes, and renames the group inline', async () => {
      renderGrouped()
      await pickAction('Pin', 'Group actions')
      await waitFor(() => expect(setWorkspaceGroupPinned).toHaveBeenCalledWith('proj', 'g1', true))

      await pickAction('Rename', 'Group actions')
      const input = await screen.findByRole<HTMLInputElement>('textbox', { name: 'Group name' })
      expect(input.value).toBe('Release')
      fireEvent.change(input, { target: { value: 'Shipping' } })
      fireEvent.keyDown(input, { key: 'Enter' })
      await waitFor(() => expect(renameWorkspaceGroup).toHaveBeenCalledWith('proj', 'g1', 'Shipping'))

      await pickAction('Delete group', 'Group actions')
      await waitFor(() => expect(deleteWorkspaceGroup).toHaveBeenCalledWith('proj', 'g1'))
    })
  })

  describe('drag between the list and a group', () => {
    /** jsdom lays nothing out, so the drop zones get the geometry the test
     *  needs: the ungrouped list on top, the group's section below it. */
    function stubZones(): void {
      const rect = (top: number, bottom: number): DOMRect =>
        ({ top, bottom, left: 0, right: 200, x: 0, y: top, width: 200, height: bottom - top,
          toJSON: () => ({}) }) as DOMRect
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
      await waitFor(() => expect(setWorkspaceGroup).toHaveBeenCalledWith('proj', 'a', 'g1'))

      vi.mocked(setWorkspaceGroup).mockClear()
      press('Filed one', 150)
      dropAt(10)
      await waitFor(() => expect(setWorkspaceGroup).toHaveBeenCalledWith('proj', 'b', null))
    })

    it('leaves a press that never travels as a plain selection', () => {
      // Pinned, so the section is on screen with nothing live in it.
      renderList([entry({ workspaceId: 'a', title: 'Loose one' })], {
        groups: [group({ pinned: true })],
      })
      stubZones()

      press('Loose one', 10)
      dropAt(12) // inside the threshold
      expect(setWorkspaceGroup).not.toHaveBeenCalled()
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
      expect(setWorkspaceGroup).not.toHaveBeenCalled()

      // The listeners came down with it, so a later unrelated pointerup can't
      // replay the move against wherever the pointer has since wandered.
      fireEvent.pointerUp(window, { clientX: 10, clientY: 150 })
      expect(setWorkspaceGroup).not.toHaveBeenCalled()
    })

    it('ignores a drop back where the workspace started', () => {
      renderList([entry({ workspaceId: 'b', title: 'Filed one', groupId: 'g1' })], { groups: [group()] })
      stubZones()

      press('Filed one', 150)
      dropAt(190)
      expect(setWorkspaceGroup).not.toHaveBeenCalled()
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
      expect(screen.queryByRole('textbox')).toBeNull()
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
      expect(screen.queryByRole('textbox')).toBeNull()
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
})
