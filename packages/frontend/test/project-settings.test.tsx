// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import type { ProjectSummary } from '@yaac/shared/types'

vi.mock('#lib/projectApi', () => ({
  getProjectConfig: vi.fn().mockResolvedValue(null),
  saveProjectConfig: vi.fn(),
  getProjectDockerfile: vi.fn().mockResolvedValue(''),
  saveProjectDockerfile: vi.fn(),
  getProjectEnv: vi.fn().mockResolvedValue([]),
  setProjectEnvVar: vi.fn(),
  deleteProjectEnvVar: vi.fn(),
}))
const snapshot = vi.hoisted(() => vi.fn())
vi.mock('#lib/useSnapshot', () => ({ useSnapshot: snapshot }))

import { ProjectSettings } from '#components/settings/ProjectSettings'
import { useUiStore } from '#store'

afterEach(cleanup)

const project = (slug: string, remoteUrl: string): ProjectSummary =>
  ({ slug, remoteUrl, addedAt: '', worktreeCount: 0, createDefaults: {}, gitCredential: null })

describe('ProjectSettings', () => {
  it('shows the picked project\'s remote, with its scheme, above the environment', () => {
    useUiStore.setState({ activeProjectSlug: 'alpha' })
    snapshot.mockReturnValue({
      driver: 'containerless',
      projects: [project('alpha', 'https://github.com/o/alpha.git'), project('beta', 'git@gitlab.com:o/beta.git')],
    })
    render(<ProjectSettings />)

    const remote = screen.getByText('https://github.com/o/alpha.git')
    expect(remote.previousElementSibling?.textContent).toBe('HTTPS')
    // Directly under the project picker, ahead of the environment section.
    expect(remote.closest('div')?.querySelector('select')).toBeTruthy()

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'beta' } })
    expect(screen.getByText('git@gitlab.com:o/beta.git').previousElementSibling?.textContent).toBe('SSH')
  })
})
