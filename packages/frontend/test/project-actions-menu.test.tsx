// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import type { JSX } from 'react'
import { act, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import { ProjectActionsMenu } from '#components/ProjectActionsMenu'
import { ProjectOpPane } from '#components/ProjectOpPane'
import { useUiStore } from '#lib/store'
import { SNAPSHOT_KEY } from '#lib/useEvents'
import { mockFetch, renderWithClient, serverError, testQueryClient, type FetchMock } from './harness'

// jsdom has no ResizeObserver; Base UI's positioner needs one to exist.
beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
})

const REMOTE = 'https://github.com/acme/widgets.git'

const ID = 'f3b1c2d4-0000-4000-8000-000000000001'
const REMOVE = `DELETE /api/project/${ID}`
let server: FetchMock

beforeEach(() => {
  useUiStore.setState({ activeProjectId: ID, projectOps: [] })
  server = mockFetch({ [REMOVE]: undefined })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

/** The menu, plus the main area's progress pane while the project's op
 *  runs, as the shell shows it. */
function Harness(): JSX.Element {
  const op = useUiStore((s) => s.projectOps.find((o) => o.id === s.activeProjectId))
  return op ? <ProjectOpPane op={op} /> : <ProjectActionsMenu projectId={ID} remoteUrl={REMOTE} />
}

/** Render the menu, labeled with the project's name, and click through to
 *  the remove-confirm dialog. */
async function openConfirm(): Promise<void> {
  const client = testQueryClient()
  client.setQueryData(SNAPSHOT_KEY, { projects: [{ id: ID, name: 'widgets' }] })
  renderWithClient(<Harness />, client)
  fireEvent.click(screen.getByRole('button', { name: 'widgets' }))
  fireEvent.click(await screen.findByText('Remove project'))
  await screen.findByText('Removes "widgets" and all its workspaces. This can\'t be undone.')
}

describe('ProjectActionsMenu', () => {
  it('requires typing the git URL, then removes in the background', async () => {
    let finishRemove = (): void => {}
    server.route(REMOVE, () => new Promise((resolve) => { finishRemove = () => resolve(undefined) }))
    await openConfirm()

    const remove = screen.getByRole<HTMLButtonElement>('button', { name: 'Remove' })
    expect(remove.disabled).toBe(true)
    fireEvent.click(remove)
    expect(server.called(REMOVE)).toHaveLength(0)

    fireEvent.change(screen.getByRole('textbox'), { target: { value: REMOTE } })
    expect(remove.disabled).toBe(false)
    fireEvent.click(remove)

    await waitFor(() => expect(server.called(REMOVE)).toHaveLength(1))
    // The dialog closes at once; progress shows until the snapshot drops the
    // project.
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.getByText('Removing widgets')).toBeTruthy()
    act(() => finishRemove())
    await waitFor(() => expect(useUiStore.getState().projectOps[0]?.doneId).toBe(ID))
    act(() => useUiStore.getState().settleProjectOps([ID]))
    expect(useUiStore.getState().activeProjectId).toBe(ID)
    act(() => useUiStore.getState().settleProjectOps([]))
    expect(useUiStore.getState().activeProjectId).toBeNull()
    expect(useUiStore.getState().projectOps).toEqual([])
  })

  it('shows a failed removal until dismissed', async () => {
    server.route(REMOVE, serverError('RUNTIME_UNAVAILABLE', 'cluster unreachable', 503))
    await openConfirm()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: REMOTE } })
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))

    expect(await screen.findByText('cluster unreachable')).toBeTruthy()
    expect(screen.getByText("Couldn't remove widgets")).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(useUiStore.getState().projectOps).toEqual([])
    expect(useUiStore.getState().activeProjectId).toBe(ID)
  })

  it('does not remove on a wrong URL', async () => {
    await openConfirm()

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'https://github.com/acme/other.git' } })
    const remove = screen.getByRole<HTMLButtonElement>('button', { name: 'Remove' })
    expect(remove.disabled).toBe(true)
    fireEvent.click(remove)

    expect(server.called(REMOVE)).toHaveLength(0)
    expect(useUiStore.getState().activeProjectId).toBe(ID)
  })
})
