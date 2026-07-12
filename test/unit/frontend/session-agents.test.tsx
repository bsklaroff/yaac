// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { SessionAgents as SessionAgentsData } from '@/shared/types'

vi.mock('@/frontend/lib/agentsApi', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, getSessionAgents: vi.fn() }
})
import { getSessionAgents } from '@/frontend/lib/agentsApi'
import { SessionAgents } from '@/frontend/components/SessionAgents'

const mock = vi.mocked(getSessionAgents)

const PAYLOAD: SessionAgentsData = {
  agents: [
    { id: 'a1', type: 'Explore', task: 'Map networking', status: 'done', result: 'the full map', spawnedAt: 1000, completedAt: 4400 },
    { id: 'a2', type: 'general-purpose', task: 'Synthesize', status: 'running', spawnedAt: 2000 },
  ],
}

function renderPane(): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <SessionAgents sessionId="s1" />
    </QueryClientProvider>,
  )
}

afterEach(() => { cleanup(); mock.mockReset() })

describe('SessionAgents', () => {
  it('lists sub-agents with status + duration', async () => {
    mock.mockResolvedValue(PAYLOAD)
    renderPane()
    await waitFor(() => expect(screen.getByText('2 sub-agents')).toBeTruthy())
    expect(screen.getByText('1 running')).toBeTruthy()
    expect(screen.getByText('Map networking')).toBeTruthy()
    expect(screen.getByText('Synthesize')).toBeTruthy()
    expect(screen.getByText('3.4s')).toBeTruthy() // done duration
    expect(screen.getByText('running…')).toBeTruthy()
  })

  it('expands a sub-agent to show its result', async () => {
    mock.mockResolvedValue(PAYLOAD)
    renderPane()
    await waitFor(() => expect(screen.getByText('Map networking')).toBeTruthy())
    expect(screen.queryByText('the full map')).toBeNull() // collapsed
    fireEvent.click(screen.getByRole('button', { name: /Map networking/ }))
    expect(screen.getByText('the full map')).toBeTruthy()
  })

  it('shows an empty state when nothing fanned out', async () => {
    mock.mockResolvedValue({ agents: [] })
    renderPane()
    await waitFor(() => expect(screen.getByText('No sub-agents yet')).toBeTruthy())
  })
})
