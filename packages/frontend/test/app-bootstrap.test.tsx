// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import App from '#App'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('App', () => {
  it('shows the server\'s reason when it will not identify this device', async () => {
    // The bootstrap is GET /whoami; a 401 carries the server's own account
    // of why (a tagged device, Funnel, or a name reached without serve).
    const message = 'tailscale serve sent no user identity: this device is a tagged device'
    const fetchMock = vi.fn(() => Promise.resolve(new Response(
      JSON.stringify({ error: { code: 'UNAUTHENTICATED', message } }),
      { status: 401, headers: { 'content-type': 'application/json' } },
    )))
    vi.stubGlobal('fetch', fetchMock)
    render(<QueryClientProvider client={new QueryClient()}><App /></QueryClientProvider>)
    expect(screen.getByText('Loading…')).toBeTruthy()
    await waitFor(() => expect(screen.getByText(message)).toBeTruthy())
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toContain('/api/whoami')
  })
})
