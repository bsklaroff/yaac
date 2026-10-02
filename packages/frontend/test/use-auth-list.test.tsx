// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import type { JSX, ReactNode } from 'react'
import type { AuthListResult } from '@yaac/shared/types'

import { configuredTools, useAuthList } from '#lib/useAuthList'
import { mockFetch, testQueryClient } from './harness'

const LIST: AuthListResult = {
  gitCredentials: [],
  toolAuth: [
    { tool: 'claude', kind: 'oauth', keyPreview: '***host', savedAt: '2026-01-01T00:00:00.000Z', models: [], defaultModel: 'claude-opus-5-5' },
    {
      tool: 'opencode', kind: 'api-key', keyPreview: '***okey', savedAt: '2026-01-01T00:00:00.000Z', opencodeProvider: 'openrouter',
      models: [], defaultModel: 'openrouter/moonshotai/kimi-k2.6',
    },
  ],
}

afterEach(() => vi.unstubAllGlobals())

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
    const server = mockFetch({ 'GET /api/auth/list': LIST })
    const client = testQueryClient()
    const wrapper = ({ children }: { children: ReactNode }): JSX.Element => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    )

    const { result } = renderHook(() => useAuthList(), { wrapper })

    expect(result.current).toBeUndefined()
    await waitFor(() => expect(result.current).toEqual(LIST))
    expect(server.called('GET /api/auth/list')).toHaveLength(1)
  })
})
