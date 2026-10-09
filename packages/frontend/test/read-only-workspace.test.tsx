// @vitest-environment jsdom
import type { JSX } from 'react'
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { QueryClientProvider } from '@tanstack/react-query'
import { screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import type { StoppedWorkspaceEntry, WorkspaceListEntry } from '@yaac/shared/types'

const provision = vi.hoisted(() => vi.fn())
vi.mock('#lib/useProvisionWorkspace', () => ({ useProvisionWorkspace: () => provision }))

import { ReadOnlyWorkspace, type ReadOnlySubject } from '#components/ReadOnlyWorkspace'
import { useStoppedEntry } from '#lib/useStoppedWorkspaces'
import { useUiStore } from '#lib/store'
import { mockFetch, renderWithClient, serverError, testQueryClient, type FetchCall, type FetchMock } from './harness'

/**
 * The pane for a workspace the user reads but does not drive: a stopped one
 * (theirs or a teammate's), or a teammate's running one. The server is
 * answered at `fetch`; the restart goes through the provisioning hook.
 */

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
})

const MARK = 'POST /api/workspace/mark-death-seen'
const initial = useUiStore.getState()

const stopped = (over: Partial<StoppedWorkspaceEntry> = {}): StoppedWorkspaceEntry => ({
  workspaceId: 's1',
  projectId: 'proj',
  tool: 'claude',
  createdAt: '2026-07-13 00:00:00',
  stoppedAt: '2026-07-13 01:00:00',
  title: 'OOMed run',
  prompt: 'fix the parser',
  seen: true,
  agentSessions: [],
  ...over,
})

let server: FetchMock
beforeEach(() => {
  useUiStore.setState(initial, true)
  server = mockFetch({ [MARK]: undefined })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

/** The selected stopped workspace as App resolves it, in the pane. */
function Selected({ projectId, workspaceId }: { projectId: string; workspaceId: string }): JSX.Element {
  const { entry, pending } = useStoppedEntry(projectId, workspaceId, { enabled: true, version: '1' })
  if (pending) return <p>looking up</p>
  if (!entry) return <p>not found</p>
  return (
    <>
      <p>{entry.seen ? 'seen' : 'unseen'}</p>
      <ReadOnlyWorkspace subject={{ kind: 'stopped', entry }} />
    </>
  )
}

/** `list-stopped` over `rows`, honoring the project and workspace filters. */
const listing = (rows: StoppedWorkspaceEntry[]) => (c: FetchCall) => {
  const entries = rows.filter((r) => r.projectId === c.query.get('project')
    && r.workspaceId === c.query.get('workspace'))
  return { entries, total: entries.length }
}

const renderPane = (subject: ReadOnlySubject): ReturnType<typeof renderWithClient> =>
  renderWithClient(<ReadOnlyWorkspace subject={subject} />)

describe('ReadOnlyWorkspace', () => {
  it('shows a stopped workspace\'s facts and conversation, and restarts it in place', async () => {
    const entry = stopped({ deathReason: 'oom', deathDetail: 'exit code 137' })
    renderPane({ kind: 'stopped', entry })

    expect(screen.getByText('OOMed run')).toBeTruthy()
    expect(screen.getByText('Died')).toBeTruthy()
    expect(screen.getByText('Cause').nextElementSibling?.textContent).toContain('exit code 137')
    // No conversation recorded: the founding prompt stands in.
    expect(screen.getByText('fix the parser')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Restart' }))
    // The confirm dialog's button.
    fireEvent.click((await screen.findAllByRole('button', { name: 'Restart' })).at(-1)!)
    await waitFor(() => expect(provision).toHaveBeenCalledTimes(1))
    expect(provision.mock.calls[0]?.slice(0, 4)).toEqual(['proj', 'claude', 'restart', 's1'])
  })

  it('marks an unseen death seen once, and never in a teammate\'s view', async () => {
    const entry = stopped({ deathReason: 'oom', seen: false })
    const client = testQueryClient()
    const view = renderWithClient(<ReadOnlyWorkspace subject={{ kind: 'stopped', entry }} />, client)
    await waitFor(() => expect(server.called(MARK).map((c) => c.body)).toEqual([{ projectId: 'proj', workspaceId: 's1' }]))
    // A fresh copy of the same, still unseen entry is not marked again.
    view.rerender(
      <QueryClientProvider client={client}>
        <ReadOnlyWorkspace subject={{ kind: 'stopped', entry: { ...entry } }} />
      </QueryClientProvider>,
    )
    await new Promise((r) => setTimeout(r, 0))
    expect(server.called(MARK)).toHaveLength(1)
    cleanup()

    useUiStore.setState({ viewedUserId: 'u-ada' })
    renderPane({ kind: 'stopped', entry: stopped({ workspaceId: 's2', deathReason: 'oom', seen: false }) })
    await new Promise((r) => setTimeout(r, 0))
    expect(server.called(MARK)).toHaveLength(1)
    expect(screen.queryByRole('button', { name: 'Restart' })).toBeNull()
  })

  it('looks a selection up in the active project only', async () => {
    server.route('GET /api/workspace/list-stopped', listing([stopped(), stopped({ workspaceId: 'theirs', projectId: 'other' })]))
    renderWithClient(<Selected projectId="proj" workspaceId="s1" />)
    expect(await screen.findByText('OOMed run')).toBeTruthy()
    cleanup()

    // Another project's id (a link to a teammate's workspace) finds nothing,
    // so it never opens with this view's controls.
    renderWithClient(<Selected projectId="proj" workspaceId="theirs" />)
    expect(await screen.findByText('not found')).toBeTruthy()
    expect(server.called('GET /api/workspace/list-stopped').at(-1)?.query.get('project')).toBe('proj')
  })

  it('puts a refused mark-seen back from a refetch, and does not retry it', async () => {
    server.route('GET /api/workspace/list-stopped', listing([stopped({ deathReason: 'oom', seen: false })]))
    server.route(MARK, serverError('FORBIDDEN', 'not yours', 403))
    renderWithClient(<Selected projectId="proj" workspaceId="s1" />)
    await waitFor(() => expect(server.called(MARK)).toHaveLength(1))
    await waitFor(() => expect(server.called('GET /api/workspace/list-stopped')).toHaveLength(2))
    expect(await screen.findByText('unseen')).toBeTruthy()
    expect(server.called(MARK)).toHaveLength(1)
  })

  it('shows a teammate\'s running workspace with its status and no actions', () => {
    const live: WorkspaceListEntry = {
      workspaceId: 'w1', projectId: 'proj', tool: 'codex', status: 'running', createdAt: '2026-07-13 00:00:00',
      title: 'Their run', agentSessions: [], blockedHosts: [], forwardedPorts: [], unforwardedPorts: [],
    }
    useUiStore.setState({ viewedUserId: 'u-ada' })
    renderPane({ kind: 'live', entry: live })
    expect(screen.getByText('Their run')).toBeTruthy()
    expect(screen.getByText('Status').nextElementSibling?.textContent).toBe('running')
    expect(screen.queryByRole('button', { name: 'Restart' })).toBeNull()
  })
})
