// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import { ProjectActionsMenu } from '#components/ProjectActionsMenu'
import { useUiStore } from '#lib/store'
import { SNAPSHOT_KEY } from '#lib/useEvents'
import { mockFetch, renderWithClient, testQueryClient, type FetchMock } from './harness'

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
  useUiStore.setState({ activeProjectId: ID })
  server = mockFetch({ [REMOVE]: undefined })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

/** Render the menu, labeled with the project's name, and click through to
 *  the remove-confirm dialog. */
async function openConfirm(): Promise<void> {
  const client = testQueryClient()
  client.setQueryData(SNAPSHOT_KEY, { projects: [{ id: ID, name: 'widgets' }] })
  renderWithClient(<ProjectActionsMenu projectId={ID} remoteUrl={REMOTE} />, client)
  fireEvent.click(screen.getByRole('button', { name: 'widgets' }))
  fireEvent.click(await screen.findByText('Remove project'))
  await screen.findByText('Removes "widgets" and all its workspaces. This can\'t be undone.')
}

describe('ProjectActionsMenu', () => {
  it('requires typing the git URL before removal', async () => {
    await openConfirm()

    const remove = screen.getByRole<HTMLButtonElement>('button', { name: 'Remove' })
    expect(remove.disabled).toBe(true)
    fireEvent.click(remove)
    expect(server.called(REMOVE)).toHaveLength(0)

    fireEvent.change(screen.getByRole('textbox'), { target: { value: REMOTE } })
    expect(remove.disabled).toBe(false)
    fireEvent.click(remove)

    await waitFor(() => expect(server.called(REMOVE)).toHaveLength(1))
    await waitFor(() => expect(useUiStore.getState().activeProjectId).toBeNull())
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
