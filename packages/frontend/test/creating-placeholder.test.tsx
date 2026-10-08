// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { screen, cleanup } from '@testing-library/react'
import { CreatingPlaceholder } from '#components/CreatingPlaceholder'
import { SNAPSHOT_KEY } from '#lib/useEvents'
import { renderWithClient, testQueryClient } from './harness'
import type { ProvisioningWorkspaceEntry } from '@yaac/shared/types'

afterEach(() => {
  cleanup()
})

const failed = (over: Partial<ProvisioningWorkspaceEntry> = {}): ProvisioningWorkspaceEntry => ({
  workspaceId: 'w1',
  projectId: 'demo',
  tool: 'claude',
  kind: 'create',
  message: '',
  createdAt: '2026-01-01 00:00:00',
  error: 'a tool is missing',
  ...over,
})

describe('CreatingPlaceholder', () => {
  it('shows a failure, with the prompt it was given, and a way to clear it', () => {
    renderWithClient(<CreatingPlaceholder creating={failed({ prompt: 'fix the parser bug' })} />)
    expect(screen.getByText('a tool is missing')).toBeTruthy()
    expect(screen.getByText('fix the parser bug')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeTruthy()
  })

  it('shows progress, naming the project, rather than a dismiss while it is still working', () => {
    const client = testQueryClient()
    client.setQueryData(SNAPSHOT_KEY, { projects: [{ id: 'demo', name: 'widgets' }] })
    renderWithClient(<CreatingPlaceholder creating={{
      ...failed(), error: undefined, message: 'Pulling image…',
    }} />, client)
    expect(screen.getByText('Pulling image…')).toBeTruthy()
    expect(screen.getByText(/in widgets/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull()
  })
})
