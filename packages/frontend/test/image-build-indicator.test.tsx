import { describe, it, expect, afterEach } from 'vitest'
import { screen, fireEvent, cleanup } from '@testing-library/react'
import { ImageBuildIndicator } from '#components/ImageBuildIndicator'
import { useUiStore } from '#lib/store'
import type { ImageBuild } from '@yaac/shared/types'
import { imageBuild, renderWithClient, serverSnapshot, testQueryClient } from './harness'

afterEach(() => {
  cleanup()
  useUiStore.getState().openBuild(null)
})

/** Render the indicator over a snapshot holding `imageBuilds` (none:
 *  before the first snapshot). */
function show(imageBuilds?: ImageBuild[], projectIds: string[] = ['proj']): void {
  renderWithClient(
    <ImageBuildIndicator projectIds={projectIds} />,
    testQueryClient(undefined, imageBuilds && serverSnapshot({ imageBuilds })),
  )
}

describe('ImageBuildIndicator', () => {
  it('renders nothing with no builds in scope, or before the first snapshot', () => {
    show([])
    expect(screen.queryByRole('button')).toBeNull()
    cleanup()
    show()
    expect(screen.queryByRole('button')).toBeNull()
    cleanup()
    show([imageBuild({ projectId: 'other' })])
    expect(screen.queryByRole('button')).toBeNull()
    cleanup()
    show([imageBuild()], [])
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('counts the queued and running builds of every project in scope, and links to the newest one\'s page', () => {
    show([
      imageBuild({ id: 'b-old', queuedAt: '2026-11-20T00:00:00Z' }),
      imageBuild({ id: 'b-new', status: 'queued', projectId: 'other', queuedAt: '2026-11-20T00:05:00Z' }),
      imageBuild({ id: 'b-third', projectId: 'third' }),
      imageBuild({ id: 'b-failed', status: 'failed', queuedAt: '2026-11-21T00:00:00Z' }),
    ], ['proj', 'other'])
    // The building pill wins over a failure.
    const pill = screen.getByRole('button', { name: 'Show image build progress' })
    expect(pill.textContent).toBe('building 2')
    fireEvent.click(pill)
    expect(useUiStore.getState().buildPageId).toBe('b-new')
    expect(new URLSearchParams(window.location.search).get('build')).toBe('b-new')
  })

  it('shows a failure pill when nothing runs, linking to the failed build', () => {
    show([imageBuild({ status: 'failed', error: 'boom' })])
    const pill = screen.getByRole('button', { name: 'Show failed image build' })
    expect(pill.textContent).toBe('build failed')
    fireEvent.click(pill)
    expect(useUiStore.getState().buildPageId).toBe('build-1')
  })
})
