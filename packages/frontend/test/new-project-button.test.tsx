// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { JSX } from 'react'
import { act, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import type { AuthListResult, GitCredentialSummary } from '@yaac/shared/types'
import { AddProjectDialog, NewProjectButton } from '#components/NewProjectButton'
import { ProjectOpPane } from '#components/ProjectOpPane'
import { useUiStore } from '#lib/store'
import { mockFetch, renderWithClient, serverError, type FetchMock } from './harness'

const TOKEN: GitCredentialSummary = {
  id: 'c-token', name: 'repo-token', kind: 'https', preview: '***abcd', projects: ['alpha'],
}
const list = (...gitCredentials: GitCredentialSummary[]): AuthListResult => ({ gitCredentials, toolAuth: [] })

const AUTH_LIST = 'GET /api/auth/list'
const ADD = 'POST /api/project/add'
const NEW_TOKEN = 'POST /api/auth/git/credentials'
const NEW_KEY = 'POST /api/auth/git/ssh-keys'

let server: FetchMock

beforeEach(() => {
  useUiStore.setState({ activeProjectId: null, projectOps: [], addProjectForm: null, trustedHostKeys: [] })
  server = mockFetch({ [AUTH_LIST]: list(TOKEN) })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

/** The button and dialog, plus the main area's progress pane for the
 *  selected op, as the shell shows it. */
function Harness(): JSX.Element {
  const op = useUiStore((s) => s.projectOps.find((o) => o.id === s.activeProjectId))
  return (
    <>
      <NewProjectButton />
      <AddProjectDialog />
      {op && <ProjectOpPane op={op} />}
    </>
  )
}

/** The snapshot lists these projects, as the shell reports each frame. */
function snapshotLists(...projectIds: string[]): void {
  act(() => useUiStore.getState().settleProjectOps(projectIds))
}

/** Render, open the dialog, type the remote, and wait for credentials. */
async function openWith(url: string): Promise<void> {
  renderWithClient(<Harness />)
  fireEvent.click(screen.getByRole('button', { name: 'New project' }))
  fireEvent.change(screen.getByLabelText('Repository URL'), { target: { value: url } })
  await waitFor(() => expect(server.called(AUTH_LIST).length).toBeGreaterThan(0))
}

const addButton = (): HTMLButtonElement => screen.getByRole<HTMLButtonElement>('button', { name: 'Add' })

describe('NewProjectButton', () => {
  it('generates a new SSH key and shows its public half before the clone that needs it', async () => {
    server.route(NEW_KEY, { id: 'c-key', publicKey: 'ssh-ed25519 AAAAkey yaac repo-key' })
    let finishClone = (): void => {}
    server.route(ADD, () => new Promise((resolve) => {
      finishClone = () => resolve({ project: { id: 'id-repo', name: 'repo' }, knownHostsEntry: 'github.com ssh-ed25519 HOSTKEY' })
    }))
    await openWith('git@github.com:o/repo.git')

    // No SSH key exists (the token is the wrong kind), so the picker offers
    // a new one, named for the project.
    await waitFor(() => expect(screen.getByLabelText<HTMLInputElement>('Credential name').value).toBe('repo-key'))
    expect(screen.queryByRole('option', { name: 'repo-token' })).toBeNull()
    expect(addButton().disabled).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: 'Generate key' }))
    expect(await screen.findByText('ssh-ed25519 AAAAkey yaac repo-key')).toBeTruthy()
    expect(server.called(NEW_KEY).map((c) => c.body)).toEqual([{ name: 'repo-key' }])
    expect(server.called(ADD)).toHaveLength(0)

    fireEvent.click(addButton())
    await waitFor(() => expect(server.called(ADD).map((c) => c.body)).toEqual([
      { remoteUrl: 'git@github.com:o/repo.git', gitCredentialId: 'c-key' },
    ]))
    // The dialog closes while the clone runs, and its pending entry is
    // selected, showing progress.
    expect(screen.queryByLabelText('Repository URL')).toBeNull()
    expect(screen.getByText('Adding repo')).toBeTruthy()
    const pending = useUiStore.getState().activeProjectId
    expect(useUiStore.getState().projectOps.map((o) => o.id)).toEqual([pending])

    // The user starts a second add before the first finishes. Its host key
    // waits for the form to close rather than replacing it.
    fireEvent.click(screen.getByRole('button', { name: 'New project' }))
    fireEvent.change(screen.getByLabelText('Repository URL'), { target: { value: 'git@github.com:o/two.git' } })
    act(() => finishClone())
    await waitFor(() => expect(useUiStore.getState().trustedHostKeys).toHaveLength(1))
    expect(screen.getByLabelText<HTMLInputElement>('Repository URL').value).toBe('git@github.com:o/two.git')
    expect(screen.queryByText('github.com ssh-ed25519 HOSTKEY')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(await screen.findByText('github.com ssh-ed25519 HOSTKEY')).toBeTruthy()
    expect(screen.getByText('Added repo.')).toBeTruthy()
    // The pending entry stays selected until the snapshot lists the
    // project, so the shell never shows an unknown one.
    snapshotLists('alpha')
    expect(useUiStore.getState().activeProjectId).toBe(pending)
    snapshotLists('alpha', 'id-repo')
    expect(useUiStore.getState().activeProjectId).toBe('id-repo')
    expect(useUiStore.getState().projectOps).toEqual([])
  })

  it('stores a new HTTPS token first, and a failed clone retries from the progress pane', async () => {
    server.route(NEW_TOKEN, { id: 'c-new' })
    let adds = 0
    server.route(ADD, () => (adds++ === 0
      ? serverError('VALIDATION', 'git authentication failed for github.com', 400)
      : { project: { id: 'id-repo', name: 'repo' }, knownHostsEntry: null }))
    await openWith('https://github.com/o/Repo.git/')

    // A matching token exists, so nothing is preselected.
    await waitFor(() => expect(screen.getByRole('option', { name: 'repo-token' })).toBeTruthy())
    expect(addButton().disabled).toBe(true)
    // Named for the project name the server derives (last URL segment,
    // lowercased), avoiding the taken name.
    fireEvent.change(screen.getByLabelText('Git credential'), { target: { value: 'new' } })
    expect(screen.getByLabelText<HTMLInputElement>('Credential name').value).toBe('repo-token-2')
    fireEvent.change(screen.getByLabelText('Token'), { target: { value: 'ghp_x' } })

    server.route(AUTH_LIST, list(TOKEN, {
      id: 'c-new', name: 'repo-token-2', kind: 'https', preview: '***_x', projects: [],
    }))
    fireEvent.click(addButton())
    expect(await screen.findByText('git authentication failed for github.com')).toBeTruthy()
    expect(screen.getByText("Couldn't add repo")).toBeTruthy()
    expect(server.called(NEW_TOKEN).map((c) => c.body)).toEqual([{ name: 'repo-token-2', token: 'ghp_x' }])

    // Try again reopens the dialog on the same remote, where the stored
    // token is now an existing credential.
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(screen.getByLabelText<HTMLInputElement>('Repository URL').value).toBe('https://github.com/o/Repo.git/')
    expect(useUiStore.getState().projectOps).toEqual([])
    fireEvent.change(await screen.findByLabelText('Git credential'), { target: { value: 'c-new' } })
    fireEvent.click(addButton())
    await waitFor(() => expect(server.called(ADD)).toHaveLength(2))
    await waitFor(() => expect(useUiStore.getState().projectOps[0]?.doneId).toBe('id-repo'))
    snapshotLists('id-repo')
    expect(useUiStore.getState().activeProjectId).toBe('id-repo')
    expect(server.called(NEW_TOKEN)).toHaveLength(1)
    const retried = { remoteUrl: 'https://github.com/o/Repo.git/', gitCredentialId: 'c-new' }
    expect(server.called(ADD).map((c) => c.body)).toEqual([retried, retried])
    // No host key to show: the dialog stays closed.
    expect(screen.queryByLabelText('Repository URL')).toBeNull()
  })
})
