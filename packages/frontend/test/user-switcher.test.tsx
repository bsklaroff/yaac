// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import type { ProjectSummary, ServerSnapshot, Whoami } from '@yaac/shared/types'

const snapshot = vi.hoisted(() => vi.fn())
vi.mock('#lib/useSnapshot', () => ({ useSnapshot: snapshot }))

import { UserSwitcher } from '#components/UserSwitcher'
import { useUiStore } from '#lib/store'
import { ownedBy } from '#lib/viewer'
import { mockFetch, renderWithClient, testQueryClient, TEST_WHOAMI } from './harness'

const initial = useUiStore.getState()
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  useUiStore.setState(initial, true)
})

const project = (id: string, owner: string): ProjectSummary =>
  ({ id, name: id, remoteUrl: '', addedAt: '', owner, workspaceCount: 0, stoppedCount: 0, unseenDeaths: 0, createDefaults: {}, gitCredential: null })

const ME: Whoami = {
  kind: 'tailnet', userId: 'u-me', login: 'me@x.com', name: 'Me',
  users: [{ id: 'u-ada', login: 'ada@x.com', name: 'Ada' }, { id: 'u-me', login: 'me@x.com', name: 'Me' }],
}

function renderSwitcher(driver: ServerSnapshot['driver'], whoami: Whoami = ME): void {
  // Ada has two live workspaces across her projects, one restarting, one
  // stopping and one that failed to start: three count.
  const workspaces = [
    { workspaceId: 'w1', projectId: 'ada-1' }, { workspaceId: 'w2', projectId: 'ada-2' },
    { workspaceId: 'w3', projectId: 'ada-2', stopping: true },
  ]
  const provisioning = [
    { workspaceId: 'w4', projectId: 'ada-1' },
    { workspaceId: 'w5', projectId: 'ada-1', error: 'image build failed' },
  ]
  snapshot.mockReturnValue({ driver, workspaces, provisioning, projects: [project('mine', 'u-me'), project('ada-1', 'u-ada'), project('ada-2', 'u-ada')] })
  // Opening the menu refetches the users, so a teammate seen since load shows.
  mockFetch({ 'GET /api/whoami': whoami })
  renderWithClient(<UserSwitcher />, testQueryClient(whoami))
}

describe('ownedBy', () => {
  it('keeps one user\'s projects and the rows in them, and passes install-wide fields through', () => {
    const row = (projectId: string): { projectId: string; workspaceId: string } => ({ projectId, workspaceId: `w-${projectId}` })
    const all = {
      driver: 'k8s', imageBuilds: [{ id: 'b' }],
      projects: [project('mine', 'u-me'), project('hers', 'u-ada')],
      workspaces: [row('mine'), row('hers')], workspaceGroups: [row('hers')], stale: [row('mine')],
      provisioning: [row('hers')], queuedWorkspaces: [row('hers')], heldWorkspaces: [row('mine')],
      draftWorkspaces: [row('hers')],
    } as unknown as ServerSnapshot
    const hers = ownedBy(all, 'u-ada')
    expect(hers.projects.map((p) => p.id)).toEqual(['hers'])
    for (const key of ['workspaces', 'workspaceGroups', 'provisioning', 'queuedWorkspaces', 'draftWorkspaces'] as const) {
      expect(hers[key].map((r) => r.projectId)).toEqual(['hers'])
    }
    expect(hers.stale).toEqual([])
    expect(hers.heldWorkspaces).toEqual([])
    expect(hers.imageBuilds).toBe(all.imageBuilds)
  })
})

describe('UserSwitcher', () => {
  it('is absent on a local install, which has one user', () => {
    renderSwitcher('k8s', TEST_WHOAMI)
    expect(screen.queryByRole('button', { name: /Switch user/ })).toBeNull()
  })

  it('lists the caller first with each user\'s active workspace count, opens a teammate on their first project, and switches back', async () => {
    useUiStore.setState({ activeProjectId: 'mine', selectedWorkspaceId: 'w1' })
    renderSwitcher('k8s')
    fireEvent.click(screen.getByRole('button', { name: 'Switch user (Your projects)' }))
    const items = await screen.findAllByRole('menuitem')
    expect(items.map((i) => i.textContent)).toEqual(['MMe (you)me@x.comidle', 'AAdaada@x.com3 active'])
    expect(screen.queryByText(/does not separate users/)).toBeNull()

    fireEvent.click(items[1])
    expect(useUiStore.getState()).toMatchObject({ viewedUserId: 'u-ada', activeProjectId: 'ada-1', selectedWorkspaceId: null })
    await waitFor(() => expect(screen.getByRole('button', { name: "Switch user (Ada's projects)" })).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: "Switch user (Ada's projects)" }))
    fireEvent.click(await screen.findByRole('menuitem', { name: /Me \(you\)/ }))
    expect(useUiStore.getState()).toMatchObject({ viewedUserId: null, activeProjectId: 'mine' })
  })

  it('says plainly that a containerless server does not separate users', async () => {
    renderSwitcher('containerless')
    fireEvent.click(screen.getByRole('button', { name: /Switch user/ }))
    expect(await screen.findByText(/does not separate users/)).toBeTruthy()
  })
})
