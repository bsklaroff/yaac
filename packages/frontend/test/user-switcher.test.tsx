import { describe, it, expect, afterEach } from 'vitest'
import { screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import type { ProjectSummary, ServerSnapshot, Whoami } from '@yaac/shared/types'


import { UserSwitcher } from '#components/UserSwitcher'
import { useUiStore } from '#lib/store'
import { ownedBy } from '#lib/viewer'
import {
  mockFetch, provisioningEntry, renderWithClient, serverSnapshot, testQueryClient, TEST_WHOAMI, workspaceEntry,
} from './harness'

const initial = useUiStore.getState()
afterEach(() => {
  cleanup()
  useUiStore.setState(initial, true)
})

const project = (id: string, owner: string): ProjectSummary =>
  ({ id, name: id, remoteUrl: '', addedAt: '', owner, workspaceCount: 0, stoppedCount: 0, deaths: 0, deathsSeenBy: {}, createDefaults: {}, gitCredential: null, hosted: false, guardDefaultBranch: true, scratchDirs: { dirs: [], ignoredTracked: [] } })

const ME: Whoami = {
  kind: 'tailnet', userId: 'u-me', login: 'me@x.com', name: 'Me',
  users: [{ id: 'u-ada', login: 'ada@x.com', name: 'Ada' }, { id: 'u-me', login: 'me@x.com', name: 'Me' }],
}

function renderSwitcher(driver: ServerSnapshot['driver'], whoami: Whoami = ME): void {
  // Ada has two live workspaces across her projects, one restarting, one
  // stopping and one that failed to start: three count.
  const workspaces = [
    workspaceEntry({ workspaceId: 'w1', projectId: 'ada-1' }), workspaceEntry({ workspaceId: 'w2', projectId: 'ada-2' }),
    workspaceEntry({ workspaceId: 'w3', projectId: 'ada-2', stopping: true }),
  ]
  const provisioning = [
    provisioningEntry({ workspaceId: 'w4', projectId: 'ada-1' }),
    provisioningEntry({ workspaceId: 'w5', projectId: 'ada-1', error: 'image build failed' }),
  ]
  const projects = [project('mine', 'u-me'), project('ada-1', 'u-ada'), project('ada-2', 'u-ada')]
  // Opening the menu refetches the users, so a teammate seen since load shows.
  mockFetch({ 'GET /api/whoami': whoami })
  renderWithClient(<UserSwitcher />, testQueryClient(whoami, serverSnapshot({ driver, workspaces, provisioning, projects })))
}

describe('ownedBy', () => {
  it('keeps one user\'s projects and the rows in them, and passes install-wide fields through', () => {
    const row = (projectId: string): { projectId: string; workspaceId: string } => ({ projectId, workspaceId: `w-${projectId}` })
    const all = {
      driver: 'k8s', imageBuilds: [{ id: 'b' }],
      projects: [project('mine', 'u-me'), project('hers', 'u-ada')],
      workspaces: [row('mine'), row('hers')], workspaceGroups: [row('hers')], stale: [row('mine')],
      provisioning: [row('hers')], queuedWorkspaces: [row('hers')], heldWorkspaces: [row('mine')],
      draftWorkspaces: [row('hers')], routines: [row('mine'), row('hers')],
    } as unknown as ServerSnapshot
    const hers = ownedBy(all, 'u-ada')
    expect(hers.projects.map((p) => p.id)).toEqual(['hers'])
    for (const key of ['workspaces', 'workspaceGroups', 'provisioning', 'queuedWorkspaces', 'draftWorkspaces', 'routines'] as const) {
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

  it('lists the caller first with each user\'s active workspace count, opens a teammate on their first project, and switches back to each user\'s last', async () => {
    useUiStore.setState({ activeProjectId: 'mine', selectedWorkspaceId: 'w1' })
    renderSwitcher('k8s')
    fireEvent.click(screen.getByRole('button', { name: 'Switch user (Your projects)' }))
    const items = await screen.findAllByRole('menuitem')
    expect(items.map((i) => i.textContent)).toEqual(['MMe (you)me@x.comidle', 'AAdaada@x.com3 active'])
    expect(screen.queryByText(/does not separate users/)).toBeNull()

    fireEvent.click(items[1])
    expect(useUiStore.getState()).toMatchObject({ viewedUserId: 'u-ada', activeProjectId: 'ada-1', selectedWorkspaceId: null })
    await waitFor(() => expect(screen.getByRole('button', { name: "Switch user (Ada's projects)" })).toBeTruthy())

    // Each user reopens on the project of theirs last open.
    useUiStore.getState().setActiveProject('ada-2')
    fireEvent.click(screen.getByRole('button', { name: "Switch user (Ada's projects)" }))
    fireEvent.click(await screen.findByRole('menuitem', { name: /Me \(you\)/ }))
    expect(useUiStore.getState()).toMatchObject({ viewedUserId: null, activeProjectId: 'mine' })
    fireEvent.click(screen.getByRole('button', { name: 'Switch user (Your projects)' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: /Ada/ }))
    expect(useUiStore.getState()).toMatchObject({ viewedUserId: 'u-ada', activeProjectId: 'ada-2' })
  })

  it('says plainly that a containerless server does not separate users', async () => {
    renderSwitcher('containerless')
    fireEvent.click(screen.getByRole('button', { name: /Switch user/ }))
    expect(await screen.findByText(/does not separate users/)).toBeTruthy()
  })
})
