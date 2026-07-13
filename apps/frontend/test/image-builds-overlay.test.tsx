// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'

vi.mock('#lib/imageBuildsApi', () => ({
  getImageBuildLog: vi.fn(),
  dismissImageBuild: vi.fn().mockResolvedValue(undefined),
  retryImageBuild: vi.fn().mockResolvedValue(undefined),
}))

import { ImageBuildsOverlay } from '#components/ImageBuildsOverlay'
import { dismissImageBuild, getImageBuildLog, retryImageBuild } from '#lib/imageBuildsApi'
import type { ImageBuildEntry } from '@yaac/shared/types'

const mockGetLog = vi.mocked(getImageBuildLog)

// jsdom has no ResizeObserver; Base UI needs one to exist.
beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
})

beforeEach(() => {
  vi.clearAllMocks()
  mockGetLog.mockResolvedValue({ log: 'STEP 1/2: FROM ubuntu\n' })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

function build(overrides: Partial<ImageBuildEntry> = {}): ImageBuildEntry {
  return {
    id: 'build-1',
    tag: 'yaac-base:abc123def',
    layer: 'base',
    action: 'build',
    projectSlugs: ['proj'],
    reason: 'prewarm',
    status: 'running',
    startedAt: '2026-07-06 00:00:00',
    ...overrides,
  }
}

const flushEffects = (): Promise<void> => act(async () => { await Promise.resolve() })

describe('ImageBuildsOverlay', () => {
  it('shows an empty state when nothing was tracked', async () => {
    render(<ImageBuildsOverlay open onOpenChange={() => {}} builds={[]} />)
    await flushEffects()
    expect(screen.getByText('No image builds yet.')).toBeTruthy()
    expect(mockGetLog).not.toHaveBeenCalled()
  })

  it('renders build rows with layer, projects, step, and error details', async () => {
    const builds = [
      build({ stepCurrent: 3, stepTotal: 14, stepText: 'RUN apt-get update' }),
      build({ id: 'build-2', tag: 'yaac-tools:def', layer: 'push', action: 'push', status: 'failed', error: 'registry down' }),
    ]
    render(<ImageBuildsOverlay open onOpenChange={() => {}} builds={builds} />)
    await flushEffects()

    expect(screen.getByText('base layer')).toBeTruthy()
    expect(screen.getByText('yaac-base:abc123')).toBeTruthy()
    expect(screen.getByText(/step 3\/14/)).toBeTruthy()
    expect(screen.getByText('RUN apt-get update')).toBeTruthy()
    expect(screen.getByText('push')).toBeTruthy()
    expect(screen.getByText('registry down')).toBeTruthy()
  })

  it('defaults the log pane to the newest running build and polls it', async () => {
    vi.useFakeTimers()
    const builds = [
      build({ id: 'newest-failed', status: 'failed', error: 'x' }),
      build({ id: 'running-build' }),
    ]
    render(<ImageBuildsOverlay open onOpenChange={() => {}} builds={builds} />)
    await flushEffects()

    expect(mockGetLog).toHaveBeenCalledWith('running-build')
    expect(screen.getByText(/STEP 1\/2: FROM ubuntu/)).toBeTruthy()

    await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
    expect(mockGetLog).toHaveBeenCalledTimes(3)
  })

  it('fetches a finished build once without polling', async () => {
    vi.useFakeTimers()
    render(<ImageBuildsOverlay open onOpenChange={() => {}} builds={[build({ status: 'succeeded' })]} />)
    await flushEffects()

    expect(mockGetLog).toHaveBeenCalledTimes(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    expect(mockGetLog).toHaveBeenCalledTimes(1)
  })

  it('switches the log pane when a row is clicked', async () => {
    const builds = [
      build({ id: 'running-build' }),
      build({ id: 'old-failed', tag: 'yaac-tools:def', status: 'failed', error: 'x' }),
    ]
    render(<ImageBuildsOverlay open onOpenChange={() => {}} builds={builds} />)
    await flushEffects()
    expect(mockGetLog).toHaveBeenCalledWith('running-build')

    fireEvent.click(screen.getByText('yaac-tools:def'))
    await flushEffects()
    expect(mockGetLog).toHaveBeenCalledWith('old-failed')
  })

  it('labels a proxy sidecar build', async () => {
    const builds = [build({ layer: 'proxy', projectSlugs: [], status: 'succeeded' })]
    render(<ImageBuildsOverlay open onOpenChange={() => {}} builds={builds} />)
    await flushEffects()
    expect(screen.getByText('proxy sidecar')).toBeTruthy()
  })

  it('dismisses a finished build and never offers dismiss on a running one', async () => {
    const builds = [
      build({ id: 'running-build' }),
      build({ id: 'old-failed', status: 'failed', error: 'x' }),
    ]
    render(<ImageBuildsOverlay open onOpenChange={() => {}} builds={builds} />)
    await flushEffects()

    const dismissButtons = screen.getAllByRole('button', { name: 'Dismiss build entry' })
    expect(dismissButtons).toHaveLength(1)
    fireEvent.click(dismissButtons[0])
    expect(vi.mocked(dismissImageBuild)).toHaveBeenCalledWith('old-failed')
  })

  it('offers Retry only on a failed build, wired to retryImageBuild', async () => {
    const builds = [
      build({ id: 'ok-build', status: 'succeeded' }),
      build({ id: 'bad-build', tag: 'yaac-tools:def', status: 'failed', error: 'x' }),
    ]
    render(<ImageBuildsOverlay open onOpenChange={() => {}} builds={builds} />)
    await flushEffects()

    // Retry appears once (on the failed row), while both finished rows can be dismissed.
    const retryButtons = screen.getAllByRole('button', { name: 'Retry build' })
    expect(retryButtons).toHaveLength(1)
    expect(screen.getAllByRole('button', { name: 'Dismiss build entry' })).toHaveLength(2)

    fireEvent.click(retryButtons[0])
    expect(vi.mocked(retryImageBuild)).toHaveBeenCalledWith('bad-build')
    expect(vi.mocked(dismissImageBuild)).not.toHaveBeenCalled()
  })
})
