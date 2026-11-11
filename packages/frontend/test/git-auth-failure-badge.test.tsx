import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { GitAuthFailureBadge } from '#components/GitAuthFailureBadge'
import { useUiStore } from '#lib/store'
import type { ProjectSummary } from '@yaac/shared/types'
import { projectRepo, serverSnapshot } from './harness'



const FAILURES = [{ host: 'github.com', status: 401, atMs: 1751700000000 }]

describe('GitAuthFailureBadge', () => {
  it('renders a labeled trigger', () => {
    render(<GitAuthFailureBadge projectId="proj" failures={FAILURES} iconSize={12} />)

    const trigger = screen.getByRole('button', { name: 'Git authentication failed' })
    expect(trigger.textContent).toBe('git auth')
  })

  it('explains the failure, and its button opens settings on the project\'s repo on that host', () => {
    useUiStore.getState().receiveSnapshot(serverSnapshot({
      projects: [{ id: 'proj', repos: [projectRepo({ id: 'repo-gh' })] } as ProjectSummary],
    }))
    render(<GitAuthFailureBadge projectId="proj" failures={FAILURES} iconSize={12} />)

    expect(screen.queryByText('github.com — HTTP 401')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Git authentication failed' }))

    expect(screen.getByText('Git authentication failed')).toBeTruthy()
    expect(screen.getByText('github.com — HTTP 401')).toBeTruthy()
    expect(screen.getByText(/Assign\s+the repo a new credential in Settings/)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Change git credential…' }))
    const state = useUiStore.getState()
    expect(state.settingsOpen).toBe(true)
    expect(state.settingsSection).toBe('repos')
    expect(state.settingsFocusRepo).toBe('repo-gh')
  })
})
