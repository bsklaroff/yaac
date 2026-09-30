// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { CreatingPlaceholder } from '#components/CreatingPlaceholder'
import type { ProvisioningWorkspaceEntry } from '@yaac/shared/types'

afterEach(() => {
  cleanup()
})

const failed = (over: Partial<ProvisioningWorkspaceEntry> = {}): ProvisioningWorkspaceEntry => ({
  workspaceId: 'w1',
  projectSlug: 'demo',
  tool: 'claude',
  kind: 'create',
  message: '',
  createdAt: '2026-01-01 00:00:00',
  error: 'a tool is missing',
  ...over,
})

describe('CreatingPlaceholder', () => {
  it('shows a failure with a way to clear it', () => {
    render(<CreatingPlaceholder creating={failed()} />)
    expect(screen.getByText('a tool is missing')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeTruthy()
  })

  it('shows progress rather than a dismiss while it is still working', () => {
    render(<CreatingPlaceholder creating={{
      ...failed(), error: undefined, message: 'Pulling image…',
    }} />)
    expect(screen.getByText('Pulling image…')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull()
  })
})
