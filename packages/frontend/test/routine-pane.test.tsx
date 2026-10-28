import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { act, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import type { RoutineEntry, RoutineRunPage, ServerSnapshot } from '@yaac/shared/types'

// No xterm, no PTY: the terminal pane is a stub.
vi.mock('#components/WorkspaceTerminal', () => ({ WorkspaceTerminal: () => <textarea data-testid="terminal" /> }))

import { WorkspaceView } from '#components/WorkspaceView'
import { useUiStore } from '#lib/store'
import { mockFetch, renderWithClient, serverSnapshot, workspaceEntry, type FetchMock } from './harness'

/*
 * A routine's pane in the main view, and the workspace header's ties to
 * routines and timeouts: the "from" link back to the routine a run came
 * from, and the chip that moves or clears its deadline. The sidebar's
 * routine rows are workspace-list.test.tsx's; the form is
 * new-workspace-pane.test.tsx's.
 */

const initial = useUiStore.getState()
let server: FetchMock
const posted = (route: string): unknown[] => server.called(route).map((c) => c.body)
const inMinutes = (m: number): string => new Date(Date.now() + m * 60_000).toISOString()

const ROUTINE: RoutineEntry = {
  id: 'r1', projectId: 'proj', name: 'Nightly triage', cron: '0 9 * * 1-5', timeZone: 'Europe/Paris',
  prompt: 'Triage new issues.\nLabel each.\nClose duplicates.\nPing owners.\nSummarize.', tool: 'claude',
  model: 'claude-opus-5-5', modelName: 'Opus 5.5', mode: 'acp', permissionMode: 'accept-edits', branch: 'main',
  groupId: 'g1', timeoutMinutes: 90, paused: false,
  nextRuns: ['2026-10-26T08:00:00.000Z', '2026-10-27T08:00:00.000Z', '2026-10-28T08:00:00.000Z'],
  createdAt: '2026-10-01 00:00:00',
}

const PAGE_ONE: RoutineRunPage = {
  runs: [
    { id: 'e5', startAt: '2026-10-23T07:00:00.000Z', title: 'Nightly triage · Fri Oct 23 09:00', state: 'running',
      workspaceId: 'w5', deadline: inMinutes(38) },
    { id: 'e4', startAt: '2026-10-22T07:00:00.000Z', state: 'failed', launchError: 'no credential' },
    { id: 'e3', startAt: '2026-10-21T07:00:00.000Z', state: 'timed-out', workspaceId: 'w3' },
    { id: 'e3b', startAt: '2026-10-21T06:00:00.000Z', state: 'ended', workspaceId: 'w3b' },
  ],
  nextCursor: 'c1',
}
const PAGE_TWO: RoutineRunPage = {
  runs: [{ id: 'e2', startAt: '2026-10-20T07:00:00.000Z', state: 'died', workspaceId: 'w2', deathReason: 'oom' }],
}

function show(snapshot: ServerSnapshot): void {
  useUiStore.setState({ snapshot })
  renderWithClient(<WorkspaceView snapshot={snapshot} provisioning={[]} />)
}

beforeEach(() => {
  server = mockFetch({
    'GET /api/config/time-zone': { timeZone: 'America/New_York', pinned: true },
    'GET /api/routine/runs': ({ query }: { query: URLSearchParams }) => (query.get('cursor') === 'c1' ? PAGE_TWO : PAGE_ONE),
    'POST /api/routine/pause': ROUTINE,
    'POST /api/routine/run': { workspaceId: 'w6' },
    'POST /api/workspace/timeout': { workspaceId: 'w5', deadline: null },
  })
})
afterEach(() => {
  cleanup()
  useUiStore.setState(initial, true)
})

describe('the routine pane', () => {
  it('shows the schedule, settings and runs, acts on the routine, and opens a run', async () => {
    useUiStore.setState({ activeProjectId: 'proj' })
    act(() => useUiStore.getState().openRoutine('proj', 'r1'))
    show(serverSnapshot({
      routines: [ROUTINE],
      workspaceGroups: [{
        groupId: 'g1', projectId: 'proj', name: 'Triage runs', pinned: false, createdAt: '', stoppedCount: 0,
        deaths: 0, deathsSeenBy: {},
      }],
    }))
    expect(screen.getByRole('heading', { name: 'Nightly triage' })).toBeTruthy()
    // The schedule and its next runs read in the routine's own zone.
    expect(screen.getByText('At 09:00, Monday through Friday')).toBeTruthy()
    expect(screen.getByText('Next: Mon Oct 26 09:00 · Tue Oct 27 09:00 · Wed Oct 28 09:00')).toBeTruthy()
    for (const fact of ['Claude · Opus 5.5', 'Chat', 'Accept edits', 'Triage runs', 'after 1h 30m']) {
      expect(screen.getByText(fact)).toBeTruthy()
    }
    expect(screen.getByRole('button', { name: 'Show all' })).toBeTruthy()

    // Runs, newest first, with their start in the user's zone.
    await screen.findByText('stops in 38m')
    expect(screen.getByText('Fri Oct 23 03:00')).toBeTruthy()
    expect(screen.getByText('failed: no credential')).toBeTruthy()
    expect(screen.getByText('timed out')).toBeTruthy()
    expect(screen.getByText('ended at next run')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Show older runs' }))
    expect(await screen.findByText(/^died: /)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Pause' }))
    fireEvent.click(screen.getByRole('button', { name: 'Run now' }))
    await waitFor(() => expect(posted('POST /api/routine/pause')).toEqual([{ id: 'r1' }]))
    await waitFor(() => expect(posted('POST /api/routine/run')).toEqual([{ id: 'r1' }]))

    fireEvent.click(screen.getByText('timed out'))
    expect(useUiStore.getState()).toMatchObject({ selectedWorkspaceId: 'w3', selectedRoutineId: null })
  })

  it('falls back to a new workspace once its routine is gone', () => {
    useUiStore.setState({ activeProjectId: 'proj', selectedRoutineId: 'r-gone' })
    show(serverSnapshot({ routines: [ROUTINE] }))
    expect(screen.getByRole('heading').textContent).toBe('New workspace')
  })
})

describe('a workspace header', () => {
  it('links a run back to its routine, and moves, sets or clears its timeout', async () => {
    useUiStore.setState({ activeProjectId: 'proj', selectedWorkspaceId: 'w5' })
    const run = workspaceEntry({ workspaceId: 'w5', projectId: 'proj', title: 'A run', routineId: 'r1', deadline: inMinutes(42) })
    show(serverSnapshot({ routines: [ROUTINE], workspaces: [run] }))

    fireEvent.click(screen.getByRole('button', { name: 'Stops in 42m' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: '+30m' }))
    await waitFor(() => expect(posted('POST /api/workspace/timeout')).toEqual([{ workspaceId: 'w5', timeout: 72 }]))
    fireEvent.click(screen.getByRole('button', { name: 'Stops in 42m' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'No timeout' }))
    fireEvent.click(screen.getByRole('button', { name: 'Stops in 42m' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Stop after…' }))
    const box = await screen.findByLabelText('Stop after')
    fireEvent.change(box, { target: { value: '2h' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    await waitFor(() => expect(posted('POST /api/workspace/timeout').slice(1)).toEqual([
      { workspaceId: 'w5', timeout: null },
      { workspaceId: 'w5', timeout: 120 },
    ]))

    fireEvent.click(screen.getByRole('button', { name: 'from Nightly triage' }))
    expect(useUiStore.getState()).toMatchObject({ selectedWorkspaceId: null, selectedRoutineId: 'r1' })
  })
})
