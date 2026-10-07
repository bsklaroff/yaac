// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { screen, cleanup, waitFor } from '@testing-library/react'
import App from '#App'
import { mockFetch, renderWithClient, serverError, testQueryClient } from './harness'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

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
})
