import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, fireEvent, waitFor } from '@testing-library/react'
import type { ServerSnapshot, StoppedWorkspaceEntry } from '@yaac/shared/types'

vi.mock('#components/WorkspaceTerminal', () => ({ WorkspaceTerminal: () => <textarea data-testid="terminal" /> }))

import { ReadOnlyWorkspace } from '#components/ReadOnlyWorkspace'
import { WorkspaceView } from '#components/WorkspaceView'
import { useUiStore } from '#lib/store'
import { mockFetch, renderWithClient, serverSnapshot, testQueryClient, workspaceEntry } from './harness'

/**
 * The containerless badge: in a live workspace's Details pane, and in the
 * header of the read-only pane a stopped or teammate's workspace opens in.
 * It follows the server's driver, so a k8s server draws none.
 */


const workspace = workspaceEntry({ terminals: [] })

const stopped: StoppedWorkspaceEntry = {
  workspaceId: 's2',
  projectId: 'proj',
  createdAt: '2026-08-10 00:00:00',
  sessions: [],
  stoppedAt: '2026-08-10 01:00:00',
  title: 'Stopped run',
  deathSeenBy: [],
  conversations: [],
}

const BADGE = { name: /Containerless workspace/ }

const initial = useUiStore.getState()
beforeEach(() => {
  useUiStore.setState({ ...initial, selectedWorkspaceId: 's1', layouts: {}, activeTabs: {} })
  mockFetch()
})

function renderPanes(driver: ServerSnapshot['driver']): void {
  const snapshot = serverSnapshot({ driver, workspaces: [workspace] })
  renderWithClient(
    <>
      <WorkspaceView snapshot={snapshot} provisioning={[]} />
      <ReadOnlyWorkspace subject={{ kind: 'stopped', entry: stopped }} />
    </>,
    testQueryClient(undefined, snapshot),
  )
}

describe('ContainerlessBadge', () => {
  it('draws nothing under k8s', async () => {
    renderPanes('k8s')
    expect(screen.getByText('Stopped run')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Details' }))
    expect(await screen.findByText('in the cluster')).toBeTruthy()
    expect(screen.queryByRole('button', BADGE)).toBeNull()
  })

  it('flags the read-only header and the live Details pane under containerless, and explains on click', async () => {
    renderPanes('containerless')
    // The live header carries none; its badge waits in the Details pane.
    expect(screen.getAllByRole('button', BADGE)).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Details' }))
    await waitFor(() => expect(screen.getAllByRole('button', BADGE)).toHaveLength(2))
    const badges = screen.getAllByRole('button', BADGE)

    fireEvent.click(badges[1])
    expect(await screen.findByText('Not sandboxed')).toBeTruthy()
    expect(screen.getByText(/drive the yaac server itself/)).toBeTruthy()
    expect(screen.getByText('yaac cluster install')).toBeTruthy()
  })
})
