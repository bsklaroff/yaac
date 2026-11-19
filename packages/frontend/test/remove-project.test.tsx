import { describe, it, expect, beforeEach } from 'vitest'
import type { JSX } from 'react'
import { act, screen, fireEvent, waitFor } from '@testing-library/react'
import { RemoveProject } from '#components/settings/RemoveProject'
import { ProjectOpPane } from '#components/ProjectOpPane'
import { useUiStore } from '#lib/store'
import { mockFetch, projectRepo, renderWithClient, serverError, type FetchMock } from './harness'
import type { ProjectSummary, ServerSnapshot } from '@yaac/shared/types'


const REMOTE = 'https://github.com/acme/widgets.git'

const ID = 'f3b1c2d4-0000-4000-8000-000000000001'
const PROJECT = { id: ID, name: 'widgets', repos: [projectRepo({ remoteUrl: REMOTE })] } as ProjectSummary
const REMOVE = `DELETE /api/project/${ID}`
/** What the confirmation says goes, and that the repo stays. */
const REMOVES = 'Removes "widgets" and all its workspaces, with their uncommitted and unpushed work. '
  + 'Its repo stays in Settings → Repos, to link again or delete. '
let server: FetchMock

beforeEach(() => {
  // Settings is open on another project's page than the active one.
  useUiStore.setState({ activeProjectId: null, projectOps: [], settingsOpen: true, settingsProjectId: ID })
  server = mockFetch({ [REMOVE]: undefined })
})


/** The settings row, plus the main area's progress pane while the active
 *  project's op runs, as the shell shows it. */
function Harness(): JSX.Element {
  const op = useUiStore((s) => s.projectOps.find((o) => o.id === s.activeProjectId))
  return op ? <ProjectOpPane op={op} /> : <RemoveProject project={PROJECT} />
}

/** Render the row and click through to the remove-confirm dialog. */
async function openConfirm(): Promise<void> {
  useUiStore.setState({ snapshot: { projects: [PROJECT] } as ServerSnapshot })
  renderWithClient(<Harness />)
  fireEvent.click(screen.getByRole('button', { name: 'Remove project' }))
  await screen.findByText(`${REMOVES}This can't be undone.`)
}

describe('RemoveProject', () => {
  it('requires typing the project\'s name, then closes settings and removes in the background', async () => {
    let finishRemove = (): void => {}
    server.route(REMOVE, () => new Promise((resolve) => { finishRemove = () => resolve(undefined) }))
    await openConfirm()

    const remove = screen.getByRole<HTMLButtonElement>('button', { name: 'Remove' })
    expect(remove.disabled).toBe(true)
    fireEvent.click(remove)
    expect(server.called(REMOVE)).toHaveLength(0)

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'widgets' } })
    expect(remove.disabled).toBe(false)
    fireEvent.click(remove)

    await waitFor(() => expect(server.called(REMOVE)).toHaveLength(1))
    // The dialog and settings close at once, and the project is selected so
    // its progress shows until the snapshot drops the project.
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(useUiStore.getState()).toMatchObject({ settingsOpen: false, activeProjectId: ID })
    expect(screen.getByText('Removing widgets')).toBeTruthy()
    act(() => finishRemove())
    await waitFor(() => expect(useUiStore.getState().projectOps[0]?.done).toBe(true))
    act(() => useUiStore.getState().settleProjectOps([ID]))
    expect(useUiStore.getState().activeProjectId).toBe(ID)
    act(() => useUiStore.getState().settleProjectOps([]))
    expect(useUiStore.getState().activeProjectId).toBeNull()
    expect(useUiStore.getState().projectOps).toEqual([])
  })

  it('shows a failed removal until dismissed', async () => {
    server.route(REMOVE, serverError('RUNTIME_UNAVAILABLE', 'cluster unreachable', 503))
    await openConfirm()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'widgets' } })
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))

    expect(await screen.findByText('cluster unreachable')).toBeTruthy()
    expect(screen.getByText("Couldn't remove widgets")).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(useUiStore.getState().projectOps).toEqual([])
    expect(useUiStore.getState().activeProjectId).toBe(ID)
  })

  it('does not remove on a wrong name', async () => {
    await openConfirm()

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'other' } })
    const remove = screen.getByRole<HTMLButtonElement>('button', { name: 'Remove' })
    expect(remove.disabled).toBe(true)
    fireEvent.click(remove)

    expect(server.called(REMOVE)).toHaveLength(0)
    expect(useUiStore.getState()).toMatchObject({ settingsOpen: true, activeProjectId: null })
  })

  it('names the volumes whose data goes with the project, on a cluster', async () => {
    server.route('GET /api/volume/list', () => [
      { name: 'queue', size: '1Gi', createdAt: '', stoppedWorkspaces: [] },
      { name: 'db', size: '5Gi', createdAt: '', stoppedWorkspaces: [] },
    ])
    useUiStore.setState({ snapshot: { driver: 'k8s', projects: [PROJECT] } as ServerSnapshot })
    renderWithClient(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: 'Remove project' }))
    expect(await screen.findByText(
      `${REMOVES}Its 2 volumes (queue, db) and all their data go too. This can't be undone.`,
    )).toBeTruthy()
  })

  it('keeps Remove disabled on a cluster until the volume list is read', async () => {
    server.route('GET /api/volume/list', serverError('RUNTIME_UNAVAILABLE', 'cluster unreachable', 503))
    useUiStore.setState({ snapshot: { driver: 'k8s', projects: [PROJECT] } as ServerSnapshot })
    renderWithClient(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: 'Remove project' }))
    await waitFor(() => expect(server.called('GET /api/volume/list').length).toBeGreaterThan(0))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'widgets' } })
    expect(screen.getByText(`${REMOVES}Checking its volumes… This can't be undone.`)).toBeTruthy()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Remove' }).disabled).toBe(true)
  })
})
