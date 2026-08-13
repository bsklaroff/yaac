// @vitest-environment jsdom
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'

vi.mock('#lib/useSnapshot', () => ({ useSnapshot: vi.fn() }))
vi.mock('#lib/imageBuildsApi', () => ({
  getImageBuildLog: vi.fn().mockResolvedValue({ log: '' }),
  dismissImageBuild: vi.fn().mockResolvedValue(undefined),
  retryImageBuild: vi.fn().mockResolvedValue(undefined),
}))

import { ImageBuildIndicator } from '#components/ImageBuildIndicator'
import { useSnapshot } from '#lib/useSnapshot'
import type { ServerSnapshot, ImageBuildEntry } from '@yaac/shared/types'

// jsdom has no ResizeObserver; Base UI needs one to exist.
beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
})

afterEach(cleanup)

function build(overrides: Partial<ImageBuildEntry> = {}): ImageBuildEntry {
  return {
    id: 'build-1',
    tag: 'yaac-base:abc123',
    layer: 'base',
    action: 'build',
    projectSlugs: ['proj'],
    reason: 'prewarm',
    status: 'running',
    startedAt: '2026-07-06 00:00:00',
    ...overrides,
  }
}

function stubSnapshot(imageBuilds: ImageBuildEntry[]): void {
  vi.mocked(useSnapshot).mockReturnValue({
    worktrees: [], worktreeGroups: [], stale: [], projects: [], provisioning: [], gitAuthFailures: {},
    imageBuilds,
    planUsage: null,
    codexPlanUsage: null,
    forwardBindHost: '127.0.0.1',
  } as ServerSnapshot)
}

describe('ImageBuildIndicator', () => {
  it('shows a muted history pill when only finished builds remain in scope', () => {
    // Finished rows persist until dismissed, so the pill stays as an entry
    // point to review/clear them — otherwise the persisted history is unreachable.
    stubSnapshot([build({ status: 'succeeded' })])
    render(<ImageBuildIndicator projectSlug="proj" />)
    const pill = screen.getByRole('button', { name: 'Show image build history' })
    expect(pill.textContent).toBe('builds')
  })

  it('renders nothing when there are no builds in scope', () => {
    stubSnapshot([])
    render(<ImageBuildIndicator projectSlug="proj" />)
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('renders nothing when the snapshot has not arrived yet', () => {
    vi.mocked(useSnapshot).mockReturnValue(undefined)
    render(<ImageBuildIndicator projectSlug="proj" />)
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('shows a building pill while a build runs', () => {
    stubSnapshot([build()])
    render(<ImageBuildIndicator projectSlug="proj" />)
    const pill = screen.getByRole('button', { name: 'Show image build progress' })
    expect(pill.textContent).toBe('building')
  })

  it('counts multiple concurrent builds', () => {
    stubSnapshot([build(), build({ id: 'build-2', tag: 'yaac-tools:def' })])
    render(<ImageBuildIndicator projectSlug="proj" />)
    const pill = screen.getByRole('button', { name: 'Show image build progress' })
    expect(pill.textContent).toBe('building 2')
  })

  it('shows a failure pill when nothing runs but a build failed', () => {
    stubSnapshot([build({ status: 'failed', error: 'boom' })])
    render(<ImageBuildIndicator projectSlug="proj" />)
    const pill = screen.getByRole('button', { name: 'Show failed image builds' })
    expect(pill.textContent).toBe('build failed')
  })

  it('prefers the building pill over the failure pill', () => {
    stubSnapshot([build(), build({ id: 'build-2', status: 'failed' })])
    render(<ImageBuildIndicator projectSlug="proj" />)
    expect(screen.getByRole('button', { name: 'Show image build progress' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Show failed image builds' })).toBeNull()
  })

  it('opens the builds overlay on click', () => {
    stubSnapshot([build()])
    render(<ImageBuildIndicator projectSlug="proj" />)
    expect(screen.queryByText('Image builds')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Show image build progress' }))
    expect(screen.getByText('Image builds')).toBeTruthy()
  })

  it('hides a build that belongs to a different project', () => {
    stubSnapshot([build({ projectSlugs: ['other'] })])
    render(<ImageBuildIndicator projectSlug="proj" />)
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('always shows a project-less infra build (the proxy sidecar)', () => {
    stubSnapshot([build({ layer: 'proxy', projectSlugs: [] })])
    render(<ImageBuildIndicator projectSlug="proj" />)
    expect(screen.getByRole('button', { name: 'Show image build progress' })).toBeTruthy()
  })

  it('with no active project, shows only project-less infra builds', () => {
    stubSnapshot([build(), build({ id: 'build-2', layer: 'proxy', projectSlugs: [] })])
    render(<ImageBuildIndicator projectSlug={null} />)
    // The 'proj' build is hidden; the proxy build keeps the pill visible.
    expect(screen.getByRole('button', { name: 'Show image build progress' }).textContent).toBe('building')
  })
})
