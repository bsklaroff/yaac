import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import type { ProjectSummary, WorkspaceListEntry } from '@yaac/shared/types'

vi.mock('#lib/createWorkspace', () => ({ restartWorkspace: vi.fn(() => Promise.resolve({ workspaceId: 'ws-1' })) }))
const provision = vi.hoisted(() => vi.fn())
vi.mock('#lib/useProvisionWorkspace', () => ({ useProvisionWorkspace: () => provision }))

import { TrackedScratchDirsBadge } from '#components/TrackedScratchDirsBadge'
import { restartWorkspace } from '#lib/createWorkspace'
import {
  mockFetch, renderWithClient as render, serverError, serverSnapshot, testQueryClient, TEST_USER_ID, type FetchMock,
} from './harness'

const PUT = 'PUT /api/project/p-1/scratch-dirs'
const KEEP = 'POST /api/workspace/ws-1/keep-scratch-dirs'

/** A project with the default scratch dirs, warning about none but `ignoredTracked`. */
const project = (ignoredTracked: string[] = []): ProjectSummary => ({
  id: 'p-1', name: 'demo', remoteUrl: '', addedAt: '', owner: TEST_USER_ID, workspaceCount: 1, stoppedCount: 0,
  deaths: 0, deathsSeenBy: {}, createDefaults: {}, gitCredential: null, hosted: false, guardDefaultBranch: true,
  scratchDirs: { dirs: [{ path: 'node_modules', sizeGiB: 8 }, { path: 'target', sizeGiB: 32 }], ignoredTracked },
})

const workspace = {
  workspaceId: 'ws-1', projectId: 'p-1', groupId: 'g-1', trackedScratchDirs: ['target'],
  sessions: [{ sessionId: 'se-1', tool: 'claude', mode: 'tui', window: 'claude-se1', permissionMode: 'bypass', ordinal: 0 }],
} as unknown as WorkspaceListEntry

let server: FetchMock
beforeEach(() => {
  server = mockFetch({ [PUT]: { dirs: [], ignoredTracked: [] }, [KEEP]: undefined })
  provision.mockReset()
})

afterEach(() => {
  cleanup()
})

describe('TrackedScratchDirsBadge', () => {
  it('shows nothing once every tracked path is ignored in the project', () => {
    const { container } = render(
      <TrackedScratchDirsBadge workspace={workspace} project={project(['target'])} />,
    )
    expect(container.textContent).toBe('')
  })

  it('keeps the paths in the workspace\'s checkout, then restarts it in place', async () => {
    render(<TrackedScratchDirsBadge workspace={workspace} project={project()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Scratch directories tracked in git' }))
    expect(screen.getByText('target/')).toBeTruthy()
    expect(screen.getByText(/a stop deletes them, committed files/)).toBeTruthy()
    // Under k8s its volume hides what git tracks there.
    expect(screen.getByText(/its volume hides the committed files/)).toBeTruthy()
    fireEvent.click(screen.getByText('Keep in the checkout and restart'))

    await waitFor(() => expect(provision).toHaveBeenCalledTimes(1))
    expect(server.called(KEEP).map((c) => c.body)).toEqual([{ paths: ['target'] }])
    expect(server.called(PUT)).toEqual([])
    const [row, op] = provision.mock.calls[0] as [unknown, (p: (m: string) => void) => Promise<unknown>]
    expect(row).toEqual({ workspaceId: 'ws-1', projectId: 'p-1', tool: 'claude', kind: 'restart', groupId: 'g-1' })
    await op(() => {})
    expect(restartWorkspace).toHaveBeenCalledWith('ws-1', expect.any(Function))
  })

  it('adds the paths to the project\'s ignored list on "don\'t show again", restarting nothing', async () => {
    render(<TrackedScratchDirsBadge workspace={workspace} project={project(['vendor'])} />)
    fireEvent.click(screen.getByRole('button', { name: 'Scratch directories tracked in git' }))
    fireEvent.click(screen.getByLabelText('Don\'t show again for this project'))

    await waitFor(() => {
      expect(server.called(PUT).map((c) => c.body)).toEqual([{ ignoredTracked: ['vendor', 'target'] }])
    })
    expect(provision).not.toHaveBeenCalled()
  })

  it('says nothing under containerless of a volume, which it has none of', () => {
    render(
      <TrackedScratchDirsBadge workspace={workspace} project={project()} />,
      testQueryClient(undefined, serverSnapshot({ driver: 'containerless' })),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Scratch directories tracked in git' }))
    expect(screen.getByText(/a stop deletes them, committed files/)).toBeTruthy()
    expect(screen.queryByText(/its volume hides/)).toBeNull()
  })

  it('restarts nothing when the project refuses the change, and says why', async () => {
    server.route(KEEP, serverError('FORBIDDEN', 'only the owner of this project may do that', 403))
    render(<TrackedScratchDirsBadge workspace={workspace} project={project()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Scratch directories tracked in git' }))
    fireEvent.click(screen.getByText('Keep in the checkout and restart'))

    expect(await screen.findByText('only the owner of this project may do that')).toBeTruthy()
    expect(provision).not.toHaveBeenCalled()
  })
})
