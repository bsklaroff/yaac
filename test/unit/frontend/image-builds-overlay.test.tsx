// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'

vi.mock('@/frontend/lib/imageBuildsApi', () => ({
  getImageBuildLog: vi.fn(),
  dismissImageBuild: vi.fn().mockResolvedValue(undefined),
}))

import { ImageBuildsOverlay } from '@/frontend/components/ImageBuildsOverlay'
import { dismissImageBuild, getImageBuildLog } from '@/frontend/lib/imageBuildsApi'
import type { ImageBuildEntry } from '@/shared/types'

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
})
