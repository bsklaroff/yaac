import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, fireEvent } from '@testing-library/react'
import type { ServerSnapshot, StoppedWorkspaceEntry } from '@yaac/shared/types'

vi.mock('#components/WorkspaceTerminal', () => ({ WorkspaceTerminal: () => <textarea data-testid="terminal" /> }))

import { ReadOnlyWorkspace } from '#components/ReadOnlyWorkspace'
import { WorkspaceView } from '#components/WorkspaceView'
import { useUiStore } from '#lib/store'
import { mockFetch, renderWithClient, serverSnapshot, testQueryClient, workspaceEntry } from './harness'

/**
 * The containerless badge in both workspace headers: the live pane's and the
 * read-only one a stopped or teammate's workspace opens in. It follows the
 * server's driver, so a k8s server draws none.
 */


const workspace = workspaceEntry({ terminals: [] })

const stopped: StoppedWorkspaceEntry = {
  workspaceId: 's2',
  projectId: 'proj',
  tool: 'claude',
  createdAt: '2026-08-10 00:00:00',
  stoppedAt: '2026-08-10 01:00:00',
  title: 'Stopped run',
  deathSeenBy: [],
  agentSessions: [],
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
  it('draws nothing under k8s', () => {
    renderPanes('k8s')
    expect(screen.getByText('Stopped run')).toBeTruthy()
    expect(screen.queryByRole('button', BADGE)).toBeNull()
  })

  it('flags the live and read-only headers under containerless, and explains on click', async () => {
    renderPanes('containerless')
    const badges = screen.getAllByRole('button', BADGE)
    expect(badges).toHaveLength(2)

    fireEvent.click(badges[1])
    expect(await screen.findByText('Not sandboxed')).toBeTruthy()
    expect(screen.getByText(/drive the yaac server itself/)).toBeTruthy()
    expect(screen.getByText('yaac cluster install')).toBeTruthy()
  })
})
