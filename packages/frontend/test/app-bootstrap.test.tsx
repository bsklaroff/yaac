import { describe, it, expect } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import App from '#App'
import { useUiStore } from '#lib/store'
import { mockFetch, renderWithClient, serverError, serverSnapshot, testQueryClient, TEST_WHOAMI } from './harness'


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
})
