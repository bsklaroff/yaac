// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import type { JSX, ReactNode } from 'react'
import type { AuthListResult } from '@yaac/shared/types'

vi.mock('#lib/settingsApi', () => ({
  getAuthList: vi.fn(),
}))

import { getAuthList } from '#lib/settingsApi'
import { configuredTools, useAuthList } from '#lib/useAuthList'

const LIST: AuthListResult = {
  gitCredentials: [],
  toolAuth: [
    { tool: 'claude', kind: 'oauth', keyPreview: '***host', savedAt: '2026-01-01T00:00:00.000Z' },
    { tool: 'opencode', kind: 'api-key', keyPreview: '***okey', savedAt: '2026-01-01T00:00:00.000Z', opencodeProvider: 'openrouter' },
  ],
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('configuredTools', () => {
  it('is empty while the list is still loading', () => {
    expect(configuredTools(undefined).size).toBe(0)
  })

  it('collects the tools that have a stored credential', () => {
    const tools = configuredTools(LIST)
    expect(tools.has('claude')).toBe(true)
    expect(tools.has('opencode')).toBe(true)
    expect(tools.has('codex')).toBe(false)
  })
})

describe('useAuthList', () => {
  it('fetches and exposes the masked credential list', async () => {
    vi.mocked(getAuthList).mockResolvedValue(LIST)
    const wrapper = ({ children }: { children: ReactNode }): JSX.Element => (
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        {children}
      </QueryClientProvider>
    )

    const { result } = renderHook(() => useAuthList(), { wrapper })

    expect(result.current).toBeUndefined()
    await waitFor(() => expect(result.current).toEqual(LIST))
    expect(getAuthList).toHaveBeenCalledTimes(1)
  })
})
