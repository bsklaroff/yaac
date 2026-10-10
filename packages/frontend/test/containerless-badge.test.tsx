// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeAll, beforeEach } from 'vitest'
import { screen, cleanup, fireEvent } from '@testing-library/react'
import type { ServerSnapshot, StoppedWorkspaceEntry, WorkspaceListEntry } from '@yaac/shared/types'

const useSnapshot = vi.hoisted(() => vi.fn())
vi.mock('#lib/useSnapshot', () => ({ useSnapshot }))
vi.mock('#components/WorkspaceTerminal', () => ({ WorkspaceTerminal: () => <textarea data-testid="terminal" /> }))

import { ReadOnlyWorkspace } from '#components/ReadOnlyWorkspace'
import { WorkspaceView } from '#components/WorkspaceView'
import { useUiStore } from '#lib/store'
import { mockFetch, renderWithClient } from './harness'

/**
 * The containerless badge in both workspace headers: the live pane's and the
 * read-only one a stopped or teammate's workspace opens in. It follows the
 * server's driver, so a k8s server draws none.
 */

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
})

const workspace: WorkspaceListEntry = {
  workspaceId: 's1',
  projectId: 'proj',
  tool: 'claude',
  status: 'running',
  createdAt: '2026-08-10 00:00:00',
  agentSessions: [],
  blockedHosts: [],
  forwardedPorts: [],
  unforwardedPorts: [],
  terminals: [],
}

const stopped: StoppedWorkspaceEntry = {
  workspaceId: 's2',
  projectId: 'proj',
  tool: 'claude',
  createdAt: '2026-08-10 00:00:00',
  stoppedAt: '2026-08-10 01:00:00',
  title: 'Stopped run',
  seen: true,
  agentSessions: [],
}

const BADGE = { name: /Containerless workspace/ }

const initial = useUiStore.getState()
beforeEach(() => {
  useUiStore.setState({ ...initial, selectedWorkspaceId: 's1', layouts: {}, activeTabs: {} })
  mockFetch()
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function renderPanes(driver: ServerSnapshot['driver']): void {
  const snapshot = { driver, workspaces: [workspace] } as unknown as ServerSnapshot
  useSnapshot.mockReturnValue(snapshot)
  renderWithClient(
    <>
      <WorkspaceView snapshot={snapshot} provisioning={[]} />
      <ReadOnlyWorkspace subject={{ kind: 'stopped', entry: stopped }} />
    </>,
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
