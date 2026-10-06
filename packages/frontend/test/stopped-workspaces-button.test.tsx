// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { QueryClientProvider } from '@tanstack/react-query'
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react'
import type { JSX } from 'react'
import type { StoppedWorkspaceEntry } from '@yaac/shared/types'

const provision = vi.hoisted(() => vi.fn())

vi.mock('#lib/createWorkspace', () => ({ restartWorkspace: vi.fn() }))
vi.mock('#lib/useProvisionWorkspace', () => ({ useProvisionWorkspace: () => provision }))

import { StoppedWorkspacesButton } from '#components/StoppedWorkspacesButton'
import { useStoppedWorkspaces } from '#lib/useStoppedWorkspaces'
import { useUiStore } from '#lib/store'
import { mockFetch, renderWithClient, serverError, testQueryClient, type FetchMock } from './harness'

// jsdom has no ResizeObserver; Base UI needs one to exist.
beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
})

const entry = (over: Partial<StoppedWorkspaceEntry> = {}): StoppedWorkspaceEntry => ({
  workspaceId: 's1',
  projectId: 'proj',
  tool: 'claude',
  createdAt: '2026-07-13 00:00:00',
  stoppedAt: '2026-07-13 01:00:00',
  seen: false,
  agentSessions: [],
  ...over,
})

/** The sidebar entry point's accessible name carries its count ("Stopped
 *  workspaces 2"), so match on the prefix. */
const STOPPED_ENTRY = { name: /^Stopped workspaces/ }

const TWO = [
  entry({ workspaceId: 's1', title: 'Fix parser', prompt: 'fix the parser bug' }),
  entry({ workspaceId: 's2', title: 'Add tests', tool: 'codex' }),
]

const LIST = 'GET /api/workspace/list-stopped'
const MARK = 'POST /api/workspace/mark-death-seen'
const MARK_ALL = 'POST /api/workspace/mark-all-deaths-seen'

let server: FetchMock
beforeEach(() => {
  useUiStore.setState({ stoppedOverlayOpen: false, optimisticStopped: [] })
  vi.clearAllMocks()
  server = mockFetch({ [LIST]: TWO, [MARK]: undefined, [MARK_ALL]: undefined })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

/** Answer the stopped list with these rows. */
const listing = (rows: StoppedWorkspaceEntry[]): void => server.route(LIST, rows)

/** The button as WorkspaceList mounts it: fed by the hook, given the live ids. */
function Harness({ live = [], provisioning = [] }: { live?: string[]; provisioning?: string[] }): JSX.Element {
  const ids = (list: string[]): { workspaceId: string }[] => list.map((workspaceId) => ({ workspaceId }))
  const stopped = useStoppedWorkspaces('proj', ids(live), ids(provisioning))
  return <StoppedWorkspacesButton projectId="proj" stopped={stopped} />
}

function renderButton(): void {
  renderWithClient(<Harness />)
}

/** Render, wait for the (data-gated) sidebar entry point, and open the overlay. */
async function open(): Promise<void> {
  renderButton()
  fireEvent.click(await screen.findByRole('button', STOPPED_ENTRY))
}

describe('StoppedWorkspacesButton', () => {
  it('fetches on mount so the sidebar entry point can hide when empty', async () => {
    renderButton()
    // Fetched without user interaction: the list decides visibility.
    await waitFor(() => expect(server.called(LIST)).toHaveLength(1))
    expect(Object.fromEntries(server.called(LIST)[0].query)).toEqual({ project: 'proj', limit: '100' })
  })

  it('hides the entry point when nothing is deleted', async () => {
    listing([])
    renderButton()
    await waitFor(() => expect(server.called(LIST)).toHaveLength(1))
    expect(screen.queryByRole('button', STOPPED_ENTRY)).toBeNull()
  })

  it('shows the entry point once deleted workspaces exist', async () => {
    renderButton()
    expect(await screen.findByRole('button', STOPPED_ENTRY)).toBeTruthy()
  })

  it('lists deleted workspaces and shows the selected one in the detail pane', async () => {
    await open()
    // The first row is auto-selected, so its prompt (detail-only) is visible.
    await waitFor(() => expect(screen.getByText('fix the parser bug')).toBeTruthy())
    // The title appears in both the list row and the detail header.
    expect(screen.getAllByText('Fix parser').length).toBeGreaterThan(0)
    // Switching selection removes the first row's prompt from the detail pane.
    fireEvent.click(screen.getAllByText('Add tests')[0])
    await waitFor(() => expect(screen.queryByText('fix the parser bug')).toBeNull())
  })

  it('filters the list by the search box', async () => {
    await open()
    await waitFor(() => expect(screen.getByText('fix the parser bug')).toBeTruthy())
    fireEvent.change(screen.getByPlaceholderText('Search…'), { target: { value: 'tests' } })
    // 'Fix parser' leaves both the filtered list and the detail pane.
    expect(screen.queryByText('Fix parser')).toBeNull()
    expect(screen.getAllByText('Add tests').length).toBeGreaterThan(0)
  })

  it('names the agent with its model in the row, the detail, and the search', async () => {
    listing([
      ...TWO,
      entry({
        workspaceId: 's3', title: 'Tune cache', tool: 'opencode',
        agentSessions: [{
          agentSessionId: 'c3', tool: 'opencode', mode: 'tui', ordinal: 0, active: true,
          model: 'anthropic/claude-opus-4-8',
        }],
      }),
    ])
    await open()
    fireEvent.click(await screen.findByText('Tune cache'))
    // Same label as a live row; a workspace that never reported a model shows
    // just the tool name.
    await waitFor(() => expect(screen.getAllByText('OpenCode · Opus 4.8')).toHaveLength(2))
    expect(screen.getByText('Codex')).toBeTruthy()
    fireEvent.change(screen.getByPlaceholderText('Search…'), { target: { value: 'opus' } })
    expect(screen.queryByText('Fix parser')).toBeNull()
    expect(screen.getAllByText('Tune cache').length).toBeGreaterThan(0)
  })

  it('renders a died row with its cause in the list and detail, and its title in the restart dialog', async () => {
    listing([
      entry({
        workspaceId: 's3',
        title: 'OOMed run',
        deathReason: 'oom',
        deathDetail: 'exit code 137',
      }),
    ])
    await open()
    // Row subtitle carries the short description (no detail).
    await waitFor(() => expect(
      screen.getByText(/died .* — out of memory \(hit the workspace memory limit\)/)).toBeTruthy())
    // Detail pane: the timestamp row is labeled Died, and Cause carries the detail.
    expect(screen.getByText('Died')).toBeTruthy()
    expect(screen.getByText('Cause')).toBeTruthy()
    expect(screen.getByText(/out of memory \(hit the workspace memory limit\) — exit code 137/)).toBeTruthy()
    // The restart dialog names the workspace by title only; the cause is
    // already on screen behind it.
    fireEvent.click(screen.getByRole('button', { name: /Restart/ }))
    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByText('OOMed run')).toBeTruthy()
    expect(within(dialog).queryByText(/died/)).toBeNull()
  })

  it('flags an unseen abnormal death with a notification dot on the entry point', async () => {
    listing([
      entry({ workspaceId: 's3', title: 'OOMed run', deathReason: 'oom' }),
    ])
    renderButton()
    // The dot shows without opening the overlay (its title is the tooltip).
    expect(await screen.findByTitle('1 workspace died unexpectedly')).toBeTruthy()
  })

  it('shows no notification dot when every deletion was user-initiated', async () => {
    renderButton() // TWO are plain deletes (no deathReason)
    await screen.findByRole('button', STOPPED_ENTRY)
    expect(screen.queryByTitle(/died unexpectedly/)).toBeNull()
  })

  it('marks the death seen server-side and clears the dot once its row is clicked', async () => {
    listing([
      entry({ workspaceId: 's3', title: 'OOMed run', deathReason: 'oom' }),
    ])
    await open()
    // The only row fills the detail pane automatically, but that is not a
    // read: the acknowledgement is durable and cross-client, so it waits for a
    // click.
    await waitFor(() => expect(screen.getByText('Cause')).toBeTruthy())
    expect(server.called(MARK)).toEqual([])

    fireEvent.click(screen.getAllByText('OOMed run')[0])
    // Persisted via the server; the cached list is patched optimistically so
    // the dot clears without a refetch.
    await waitFor(() => expect(server.called(MARK).map((c) => c.body)).toEqual([{ projectId: 'proj', workspaceId: 's3' }]))
    await waitFor(() => expect(screen.queryByTitle(/died unexpectedly/)).toBeNull())
  })

  it('does not acknowledge deaths the search box walks the stand-in through', async () => {
    // Each keystroke re-filters the list, changing the top row that fills the
    // desktop detail pane. Acknowledging it would mark every death whose title
    // matches a prefix of the query.
    listing([
      entry({ workspaceId: 's3', title: 'Oomed parser', deathReason: 'oom' }),
      entry({ workspaceId: 's4', title: 'Oomed indexer', deathReason: 'oom' }),
      entry({ workspaceId: 's5', title: 'Evicted run', deathReason: 'evicted' }),
    ])
    await open()
    const search = screen.getByPlaceholderText('Search…')
    for (const q of ['e', 'ev', 'evi']) fireEvent.change(search, { target: { value: q } })
    await waitFor(() => expect(screen.getAllByText('Evicted run').length).toBeGreaterThan(0))
    expect(server.called(MARK)).toEqual([])
    expect(await screen.findByTitle('3 workspaces died unexpectedly')).toBeTruthy()
  })

  it('keeps the dot until each died row is individually viewed', async () => {
    listing([
      entry({ workspaceId: 's1', title: 'Plain delete' }),
      entry({ workspaceId: 's3', title: 'OOMed run', deathReason: 'oom' }),
    ])
    await open() // nothing clicked yet → the died row stays unseen
    expect(await screen.findByTitle('1 workspace died unexpectedly')).toBeTruthy()
    expect(server.called(MARK)).toEqual([]) // the plain delete isn't a death
    fireEvent.click(screen.getAllByText('OOMed run')[0]) // view it → marked seen
    await waitFor(() => expect(server.called(MARK).map((c) => c.body)).toEqual([{ projectId: 'proj', workspaceId: 's3' }]))
    await waitFor(() => expect(screen.queryByTitle(/died unexpectedly/)).toBeNull())
  })

  it('clears every death at once from the overlay header', async () => {
    listing([
      entry({ workspaceId: 's1', title: 'Plain delete' }),
      entry({ workspaceId: 's3', title: 'OOMed run', deathReason: 'oom' }),
      entry({ workspaceId: 's4', title: 'Evicted run', deathReason: 'evicted' }),
    ])
    await open() // top row is the plain delete → both deaths stay unseen
    expect(await screen.findByTitle('2 workspaces died unexpectedly')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Mark all as read' }))
    await waitFor(() => expect(server.called(MARK_ALL).map((c) => c.body)).toEqual([{ projectId: 'proj' }]))
    // Optimistic patch: the dot clears without a refetch, and with nothing left
    // unread the button itself goes away.
    await waitFor(() => expect(screen.queryByTitle(/died unexpectedly/)).toBeNull())
    expect(screen.queryByRole('button', { name: 'Mark all as read' })).toBeNull()
    // Selecting a row that is already marked doesn't re-post a per-row ack.
    fireEvent.click(screen.getAllByText('OOMed run')[0])
    await waitFor(() => expect(screen.getByText('Cause')).toBeTruthy())
    expect(server.called(MARK)).toEqual([])
  })

  it('shows a failed mark-seen in the header and puts the dot back from a refetch', async () => {
    listing([
      entry({ workspaceId: 's1', title: 'Plain delete' }),
      entry({ workspaceId: 's3', title: 'OOMed run', deathReason: 'oom' }),
    ])
    server.route(MARK_ALL, serverError('INTERNAL', 'database is locked'))
    await open()
    expect(await screen.findByTitle('1 workspace died unexpectedly')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Mark all as read' }))
    expect(await screen.findByText('database is locked')).toBeTruthy()
    // The optimistic patch is undone by refetching the server's list, which
    // still has the death unseen.
    await waitFor(() => expect(server.called(LIST)).toHaveLength(2))
    expect(await screen.findByTitle('1 workspace died unexpectedly')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Mark all as read' })).toBeTruthy()
  })

  it('offers no mark-all when every deletion was user-initiated', async () => {
    await open() // TWO are plain deletes (no deathReason)
    await waitFor(() => expect(screen.getByText('fix the parser bug')).toBeTruthy())
    expect(screen.queryByRole('button', { name: 'Mark all as read' })).toBeNull()
  })

  it('labels a plain delete as Stopped with no Cause row', async () => {
    await open()
    await waitFor(() => expect(screen.getByText('fix the parser bug')).toBeTruthy())
    expect(screen.getByText('Stopped')).toBeTruthy()
    expect(screen.queryByText('Cause')).toBeNull()
  })

  it('restarts a workspace and closes the overlay', async () => {
    await open()
    await waitFor(() => expect(screen.getByText('fix the parser bug')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /Restart/ }))
    const dialog = await screen.findByRole('alertdialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Restart' }))

    expect(provision).toHaveBeenCalledTimes(1)
    expect(provision.mock.calls[0][0]).toBe('proj')
    expect(provision.mock.calls[0][1]).toBe('claude')
    expect(provision.mock.calls[0][2]).toBe('restart')
    expect(provision.mock.calls[0][3]).toBe('s1')
    expect(useUiStore.getState().stoppedOverlayOpen).toBe(false)
  })

  it('hides live and provisioning entries, and never blinks out while refetching', async () => {
    // Each change to the live set is a fresh fetch. The last list is kept
    // until it lands, or the entry point and every ghost row would blink out.
    const client = testQueryClient()
    const mount = (live: string[], provisioning: string[] = []): JSX.Element => (
      <QueryClientProvider client={client}><Harness live={live} provisioning={provisioning} /></QueryClientProvider>
    )
    const { rerender } = render(mount([]))
    expect(await screen.findByRole('button', { name: /^Stopped workspaces\s*2/ })).toBeTruthy()

    // A restart's provisioning row takes its entry off the list, and a failed
    // restart dismissed puts it straight back. Neither is a refetch: the
    // provisioning set isn't part of the key.
    rerender(mount([], ['s1']))
    expect(screen.getByRole('button', { name: /^Stopped workspaces\s*1/ })).toBeTruthy()
    rerender(mount([]))
    expect(screen.getByRole('button', { name: /^Stopped workspaces\s*2/ })).toBeTruthy()
    expect(server.called(LIST)).toHaveLength(1)

    let land: (rows: StoppedWorkspaceEntry[]) => void = () => {}
    const pending = new Promise<StoppedWorkspaceEntry[]>((r) => { land = r })
    server.route(LIST, () => pending)
    rerender(mount(['w1']))
    await waitFor(() => expect(server.called(LIST)).toHaveLength(2))
    expect(screen.getByRole('button', { name: /^Stopped workspaces\s*2/ })).toBeTruthy()

    // A restart landing: s1 is live again, so it leaves the list at once, and
    // stays gone once the refetch agrees.
    rerender(mount(['w1', 's1']))
    expect(screen.getByRole('button', { name: /^Stopped workspaces\s*1/ })).toBeTruthy()
    land([TWO[1]])
    await waitFor(() => expect(server.called(LIST)).toHaveLength(3))
    expect(screen.getByRole('button', { name: /^Stopped workspaces\s*1/ })).toBeTruthy()
  })
})
