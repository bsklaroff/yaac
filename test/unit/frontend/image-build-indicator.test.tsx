// @vitest-environment jsdom
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'

vi.mock('@/frontend/lib/useSnapshot', () => ({ useSnapshot: vi.fn() }))
vi.mock('@/frontend/lib/imageBuildsApi', () => ({
  getImageBuildLog: vi.fn().mockResolvedValue({ log: '' }),
  dismissImageBuild: vi.fn().mockResolvedValue(undefined),
}))

import { ImageBuildIndicator } from '@/frontend/components/ImageBuildIndicator'
import { useSnapshot } from '@/frontend/lib/useSnapshot'
import type { DaemonSnapshot, ImageBuildEntry } from '@/shared/types'

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
    sessions: [], stale: [], projects: [], provisioning: [], gitAuthFailures: {}, imageBuilds,
  } as DaemonSnapshot)
}

describe('ImageBuildIndicator', () => {
  it('renders nothing when no build is running or failed', () => {
    stubSnapshot([build({ status: 'succeeded' })])
    render(<ImageBuildIndicator />)
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('renders nothing when the snapshot has not arrived yet', () => {
    vi.mocked(useSnapshot).mockReturnValue(undefined)
    render(<ImageBuildIndicator />)
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('shows a building pill while a build runs', () => {
    stubSnapshot([build()])
    render(<ImageBuildIndicator />)
    const pill = screen.getByRole('button', { name: 'Show image build progress' })
    expect(pill.textContent).toBe('building')
  })

  it('counts multiple concurrent builds', () => {
    stubSnapshot([build(), build({ id: 'build-2', tag: 'yaac-tools:def' })])
    render(<ImageBuildIndicator />)
    const pill = screen.getByRole('button', { name: 'Show image build progress' })
    expect(pill.textContent).toBe('building 2')
  })

  it('shows a failure pill when nothing runs but a build failed', () => {
    stubSnapshot([build({ status: 'failed', error: 'boom' })])
    render(<ImageBuildIndicator />)
    const pill = screen.getByRole('button', { name: 'Show failed image builds' })
    expect(pill.textContent).toBe('build failed')
  })

  it('prefers the building pill over the failure pill', () => {
    stubSnapshot([build(), build({ id: 'build-2', status: 'failed' })])
    render(<ImageBuildIndicator />)
    expect(screen.getByRole('button', { name: 'Show image build progress' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Show failed image builds' })).toBeNull()
  })

  it('opens the builds overlay on click', () => {
    stubSnapshot([build()])
    render(<ImageBuildIndicator />)
    expect(screen.queryByText('Image builds')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Show image build progress' }))
    expect(screen.getByText('Image builds')).toBeTruthy()
  })
})
