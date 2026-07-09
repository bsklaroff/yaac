import { describe, it, expect, vi, afterEach } from 'vitest'
import { api } from '@/frontend/lib/apiClient'
import { allowBlockedHost } from '@/frontend/lib/blockedHostsApi'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('allowBlockedHost', () => {
  it('POSTs the allow-host endpoint with the host and persist:true', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValue(undefined)
    await allowBlockedHost('abc-123', 'evil.example.com', { persist: true })
    expect(post).toHaveBeenCalledWith(
      '/session/abc-123/allow-host',
      { host: 'evil.example.com', persist: true },
    )
  })

  it('sends persist:false for a session-only allow', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValue(undefined)
    await allowBlockedHost('abc-123', 'x.com', { persist: false })
    expect(post).toHaveBeenCalledWith('/session/abc-123/allow-host', { host: 'x.com', persist: false })
  })
})
