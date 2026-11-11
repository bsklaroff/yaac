import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { screen, cleanup, waitFor, fireEvent, within } from '@testing-library/react'
import type { WorkspaceListEntry } from '@yaac/shared/types'
import type { WorkspaceStep } from '@yaac/shared/steps'

// No xterm, no sockets: the live window and the log are stubs naming what
// they were given.
vi.mock('#components/WorkspaceTerminal', () => ({
  WorkspaceTerminal: ({ target }: { target: string }) => <div data-testid="terminal">{target}</div>,
}))
vi.mock('#components/StepLog', () => ({
  StepLog: ({ life, file, follow }: { life: string; file: string; follow: boolean }) => (
    <div data-testid="log">{`${life}/${file}${follow ? ' following' : ''}`}</div>
  ),
}))

import { WorkspaceView } from '#components/WorkspaceView'
import { useUiStore } from '#lib/store'
import { mockFetch, renderWithClient, serverSnapshot, workspaceEntry, type FetchMock } from './harness'

/*
 * A workspace's steps in its bar and panes (docs/workspace-steps.md): the
 * ones still running or that failed listed, the finished ones folded, a
 * step's pane only when picked, live while it runs and its log after, and
 * a non-interactive workspace, or a site's release, offering nothing that
 * would change it.
 */

const LIFE = '2026-11-03T01:00:00.000Z'
const step = (name: string, state: WorkspaceStep['state'], over: Partial<WorkspaceStep & { target: string }> = {}) => ({
  name: `ci.${name}`, workflow: 'ci', origin: 'start' as const, spec: { run: [`echo ${name}`] }, state, life: LIFE, ...over,
})
const STEPS = [
  step('install', 'succeeded', { exitCode: 0 }),
  step('build', 'failed', { exitCode: 2 }),
  step('docs', 'skipped'),
  step('server', 'running', { target: 'window:@4' }),
]

const initial = useUiStore.getState()
let server: FetchMock
beforeEach(() => {
  useUiStore.setState({ ...initial, selectedWorkspaceId: 's1', layouts: {}, activeTabs: {}, viewMode: 'tabs' })
  server = mockFetch({
    'GET /api/workspace/s1/changes': {
      base: 'abc', baseResolved: true, files: [], diff: '', truncated: false, branch: 'main', comparison: null,
      listing: { version: 'v1', paths: [], symlinks: {}, ignored: [], emptyDirs: [], conflicted: [], truncated: false },
    },
    'POST /api/workspace/s1/steps/ci.build/rerun': step('build', 'pending'),
    'POST /api/workspace/s1/steps/ci.server/cancel': undefined,
  })
})
afterEach(() => {
  cleanup()
})

function show(over: Partial<WorkspaceListEntry>): void {
  const snapshot = serverSnapshot({ workspaces: [workspaceEntry({ terminals: [], ...over })] })
  useUiStore.setState({ snapshot })
  renderWithClient(<WorkspaceView snapshot={snapshot} provisioning={[]} />)
}

describe('WorkspaceView steps', () => {
  it('lists running and failed steps, folds finished ones, and opens a step\'s pane only when picked', async () => {
    show({ steps: STEPS })
    const bar = screen.getByLabelText('Steps')
    // Grouped under their workflow, each by its name in it.
    expect(within(bar).getByRole('group', { name: 'Workflow ci' }).textContent?.startsWith('ci')).toBe(true)
    expect(within(bar).getAllByRole('button').map((b) => b.textContent)).toEqual(['build2', 'server', '2 done'])
    // No pane opens by itself.
    expect(screen.queryByTestId('terminal')).toBeNull()
    expect(screen.queryByTestId('log')).toBeNull()

    fireEvent.click(within(bar).getByRole('button', { name: '2 done' }))
    expect(within(bar).getAllByRole('button').map((b) => b.textContent))
      .toEqual(['build2', 'server', '2 done', 'install', 'docs'])

    // A running step shows its live window; one that finished, its log.
    fireEvent.click(within(bar).getByRole('button', { name: 'server' }))
    expect((await screen.findByTestId('terminal')).textContent).toBe('window:@4')
    fireEvent.click(within(bar).getByRole('button', { name: /^build/ }))
    expect((await screen.findByTestId('log')).textContent).toBe('2026-11-03T01-00-00.000Z/ci.build.log')
    expect(screen.getByText('failed (exit 2)')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Rerun' }))
    await waitFor(() => expect(server.called('POST /api/workspace/s1/steps/ci.build/rerun')).toHaveLength(1))
  })

  it('offers no shell, session or step action in a non-interactive workspace, and follows a running step\'s log', async () => {
    show({ steps: STEPS, nonInteractive: true })
    expect(screen.queryByRole('button', { name: /New Shell/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /New Session/ })).toBeNull()
    expect(screen.getByText('This workspace runs its steps untouched')).toBeTruthy()

    fireEvent.click(within(screen.getByLabelText('Steps')).getByRole('button', { name: 'server' }))
    expect((await screen.findByTestId('log')).textContent).toBe('2026-11-03T01-00-00.000Z/ci.server.log following')
    expect(screen.queryByTestId('terminal')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull()
  })

  it('labels a site\'s release, which offers nothing its site does not manage, and opens the site from the label', async () => {
    show({ steps: STEPS, site: 'web' })
    expect(screen.queryByRole('button', { name: /New Shell/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /New Session/ })).toBeNull()
    expect(screen.getByText('This workspace serves the site “web”')).toBeTruthy()

    fireEvent.click(within(screen.getByLabelText('Steps')).getByRole('button', { name: 'server' }))
    expect((await screen.findByTestId('log')).textContent).toBe('2026-11-03T01-00-00.000Z/ci.server.log following')
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'release of web' }))
    expect(useUiStore.getState()).toMatchObject({ settingsOpen: true, settingsSection: 'project' })
  })
})
