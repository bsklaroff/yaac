// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { screen, fireEvent, cleanup } from '@testing-library/react'

vi.mock('#lib/useSnapshot', () => ({ useSnapshot: vi.fn() }))

import { ImageBuildIndicator } from '#components/ImageBuildIndicator'
import { useSnapshot } from '#lib/useSnapshot'
import type { ServerSnapshot, ImageBuildEntry } from '@yaac/shared/types'
import { mockFetch, renderWithClient } from './harness'

// jsdom has no ResizeObserver; Base UI needs one to exist.
beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
})

/** The overlay loads the selected build's log as soon as it opens. */
beforeEach(() => {
  mockFetch({ 'GET /api/image/builds/build-1/log': { log: '' } })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

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
    driver: 'k8s',
    workspaces: [], workspaceGroups: [], stale: [], projects: [], provisioning: [], queuedWorkspaces: [], heldWorkspaces: [], draftWorkspaces: [], gitAuthFailures: {},
    imageBuilds,
    planUsage: null,
    codexPlanUsage: null,
    forwardBindHost: '127.0.0.1',
  } as ServerSnapshot)
}

describe('ImageBuildIndicator', () => {
  it('shows a muted history pill when only finished builds remain in scope', () => {
    // Finished rows stay until dismissed, so the pill stays too, as the way
    // to reach them.
    stubSnapshot([build({ status: 'succeeded' })])
    renderWithClient(<ImageBuildIndicator projectSlug="proj" />)
    const pill = screen.getByRole('button', { name: 'Show image build history' })
    expect(pill.textContent).toBe('builds')
  })

  it('renders nothing when there are no builds in scope', () => {
    stubSnapshot([])
    renderWithClient(<ImageBuildIndicator projectSlug="proj" />)
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('renders nothing when the snapshot has not arrived yet', () => {
    vi.mocked(useSnapshot).mockReturnValue(undefined)
    renderWithClient(<ImageBuildIndicator projectSlug="proj" />)
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('shows a building pill while a build runs', () => {
    stubSnapshot([build()])
    renderWithClient(<ImageBuildIndicator projectSlug="proj" />)
    const pill = screen.getByRole('button', { name: 'Show image build progress' })
    expect(pill.textContent).toBe('building')
  })

  it('counts multiple concurrent builds', () => {
    stubSnapshot([build(), build({ id: 'build-2', tag: 'yaac-tools:def' })])
    renderWithClient(<ImageBuildIndicator projectSlug="proj" />)
    const pill = screen.getByRole('button', { name: 'Show image build progress' })
    expect(pill.textContent).toBe('building 2')
  })

  it('shows a failure pill when nothing runs but a build failed', () => {
    stubSnapshot([build({ status: 'failed', error: 'boom' })])
    renderWithClient(<ImageBuildIndicator projectSlug="proj" />)
    const pill = screen.getByRole('button', { name: 'Show failed image builds' })
    expect(pill.textContent).toBe('build failed')
  })

  it('prefers the building pill over the failure pill', () => {
    stubSnapshot([build(), build({ id: 'build-2', status: 'failed' })])
    renderWithClient(<ImageBuildIndicator projectSlug="proj" />)
    expect(screen.getByRole('button', { name: 'Show image build progress' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Show failed image builds' })).toBeNull()
  })

  it('opens the builds overlay on click', () => {
    stubSnapshot([build()])
    renderWithClient(<ImageBuildIndicator projectSlug="proj" />)
    expect(screen.queryByText('Image builds')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Show image build progress' }))
    expect(screen.getByText('Image builds')).toBeTruthy()
  })

  it('hides a build that belongs to a different project', () => {
    stubSnapshot([build({ projectSlugs: ['other'] })])
    renderWithClient(<ImageBuildIndicator projectSlug="proj" />)
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('always shows a project-less infra build (the proxy sidecar)', () => {
    stubSnapshot([build({ layer: 'proxy', projectSlugs: [] })])
    renderWithClient(<ImageBuildIndicator projectSlug="proj" />)
    expect(screen.getByRole('button', { name: 'Show image build progress' })).toBeTruthy()
  })

  it('with no active project, shows only project-less infra builds', () => {
    stubSnapshot([build(), build({ id: 'build-2', layer: 'proxy', projectSlugs: [] })])
    renderWithClient(<ImageBuildIndicator projectSlug={null} />)
    // The 'proj' build is hidden; the proxy build keeps the pill visible.
    expect(screen.getByRole('button', { name: 'Show image build progress' }).textContent).toBe('building')
  })
})
