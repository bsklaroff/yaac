import { describe, it, expect, beforeEach } from 'vitest'
import { screen, fireEvent } from '@testing-library/react'
import { ImageBuildIndicator } from '#components/ImageBuildIndicator'
import type { ImageBuildEntry } from '@yaac/shared/types'
import { mockFetch, renderWithClient, serverSnapshot, testQueryClient } from './harness'

/** The overlay loads the selected build's log as soon as it opens. */
beforeEach(() => {
  mockFetch({ 'GET /api/image/builds/build-1/log': { log: '' } })
})

function build(overrides: Partial<ImageBuildEntry> = {}): ImageBuildEntry {
  return {
    id: 'build-1',
    tag: 'yaac-base:abc123',
    layer: 'base',
    projectIds: ['proj'],
    reason: 'prewarm',
    status: 'running',
    startedAt: '2026-07-06 00:00:00',
    ...overrides,
  }
}

/** Render the indicator over a snapshot holding `imageBuilds` (none:
 *  before the first snapshot). */
function show(imageBuilds?: ImageBuildEntry[], projectId: string | null = 'proj'): void {
  renderWithClient(
    <ImageBuildIndicator projectId={projectId} />,
    testQueryClient(undefined, imageBuilds && serverSnapshot({ imageBuilds })),
  )
}

describe('ImageBuildIndicator', () => {
  it('shows a muted history pill when only finished builds remain in scope', () => {
    // Finished rows stay until dismissed, so the pill stays too, as the way
    // to reach them.
    show([build({ status: 'succeeded' })])
    const pill = screen.getByRole('button', { name: 'Show image build history' })
    expect(pill.textContent).toBe('builds')
  })

  it('renders nothing when there are no builds in scope', () => {
    show([])
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('renders nothing when the snapshot has not arrived yet', () => {
    show()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('shows a building pill while a build runs', () => {
    show([build()])
    const pill = screen.getByRole('button', { name: 'Show image build progress' })
    expect(pill.textContent).toBe('building')
  })

  it('counts multiple concurrent builds', () => {
    show([build(), build({ id: 'build-2', tag: 'yaac-tools:def' })])
    const pill = screen.getByRole('button', { name: 'Show image build progress' })
    expect(pill.textContent).toBe('building 2')
  })

  it('shows a failure pill when nothing runs but a build failed', () => {
    show([build({ status: 'failed', error: 'boom' })])
    const pill = screen.getByRole('button', { name: 'Show failed image builds' })
    expect(pill.textContent).toBe('build failed')
  })

  it('prefers the building pill over the failure pill', () => {
    show([build(), build({ id: 'build-2', status: 'failed' })])
    expect(screen.getByRole('button', { name: 'Show image build progress' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Show failed image builds' })).toBeNull()
  })

  it('opens the builds overlay on click', () => {
    show([build()])
    expect(screen.queryByText('Image builds')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Show image build progress' }))
    expect(screen.getByText('Image builds')).toBeTruthy()
  })

  it('hides a build that belongs to a different project', () => {
    show([build({ projectIds: ['other'] })])
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('shows nothing with no active project', () => {
    show([build()], null)
    expect(screen.queryByRole('button')).toBeNull()
  })
})
