import { describe, it, expect, vi, afterEach } from 'vitest'
import { api } from '#lib/apiClient'
import { requestUsageRefresh } from '#lib/usageApi'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('requestUsageRefresh', () => {
  it('POSTs the usage-refresh nudge endpoint', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValue(undefined)
    await requestUsageRefresh()
    expect(post).toHaveBeenCalledWith('/auth/claude/usage/refresh')
  })
})
