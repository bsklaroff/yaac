import { describe, it, expect } from 'vitest'
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import App from '#App'
import { useUiStore } from '#lib/store'
import { mockFetch, renderWithClient, serverError, serverSnapshot, testQueryClient, TEST_USER_ID, TEST_WHOAMI } from './harness'


describe('App', () => {
  it('shows the server\'s reason when it will not identify this device', async () => {
    // The bootstrap is GET /whoami; a 401 carries the server's own account
    // of why (a tagged device, Funnel, or a name reached without serve).
    const message = 'tailscale serve sent no user identity: this device is a tagged device'
    const server = mockFetch({ 'GET /api/whoami': serverError('UNAUTHENTICATED', message, 401) })
    renderWithClient(<App />, testQueryClient(null))
    expect(screen.getByText('Loading…')).toBeTruthy()
    await waitFor(() => expect(screen.getByText(message)).toBeTruthy())
    expect(server.calls[0].path).toBe('/api/whoami')
  })

  it('clears a project id the snapshot cannot resolve when there are no projects', async () => {
    // A link to a removed project, or a failed first add dismissed on a
    // phone: the workspaces screen would open on a project that is not there.
    mockFetch()
    useUiStore.setState({ activeProjectId: 'gone', selectedWorkspaceId: 'w-gone', mobileScreen: 'workspaces' })
    renderWithClient(<App />, testQueryClient(TEST_WHOAMI, serverSnapshot()))
    await waitFor(() => expect(useUiStore.getState().activeProjectId).toBeNull())
    expect(useUiStore.getState()).toMatchObject({ selectedWorkspaceId: null, mobileScreen: 'projects' })
    expect(screen.getByText('Welcome to yaac')).toBeTruthy()
  })

  it('shows the adds the server lists, as after a reload, with their clone progress', async () => {
    // This tab started neither, so it holds no op of its own: the rail and
    // the pane come from the snapshot alone.
    const server = mockFetch()
    const ADDING = '0b6c5d4e-3f2a-4b1c-8d9e-0f1a2b3c4d5e'
    const FAILED = '1c7d6e5f-4a3b-4c2d-9e0f-1a2b3c4d5e6f'
    useUiStore.setState({ activeProjectId: ADDING, selectedWorkspaceId: null, projectOps: [] })
    renderWithClient(<App />, testQueryClient(TEST_WHOAMI, serverSnapshot({
      projectAdds: [
        {
          id: ADDING, owner: TEST_USER_ID, name: 'widgets', remoteUrl: 'https://github.com/acme/widgets.git', hosted: false,
          progress: { phase: 'Receiving objects', percent: 45, detail: '1.20 MiB | 2.00 MiB/s' },
        },
        { id: FAILED, owner: TEST_USER_ID, name: 'gadgets', remoteUrl: 'https://github.com/acme/gadgets.git', hosted: false, error: 'Failed to clone: fatal: repository not found' },
        // Another user's add is theirs to show.
        { id: 'theirs', owner: 'u-ada', name: 'theirs', remoteUrl: 'https://github.com/ada/theirs.git', hosted: false },
      ],
    })))

    expect(await screen.findByText('Adding widgets')).toBeTruthy()
    expect(screen.getByRole('progressbar', { name: 'Receiving objects' }).getAttribute('aria-valuenow')).toBe('45')
    expect(screen.getByText('1.20 MiB | 2.00 MiB/s')).toBeTruthy()
    // The selection stays on the pending add rather than falling back.
    expect(useUiStore.getState().activeProjectId).toBe(ADDING)
    expect(screen.getAllByLabelText('Adding project')).toHaveLength(1)
    expect(screen.getAllByLabelText('Failed')).toHaveLength(1)

    act(() => useUiStore.getState().setActiveProject(FAILED))
    expect(await screen.findByText('Failed to clone: fatal: repository not found')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    await waitFor(() => expect(server.calls.filter((c) => c.method === 'POST' && c.path === `/api/project/add/${FAILED}/dismiss`))
      .toHaveLength(1))
  })
})
