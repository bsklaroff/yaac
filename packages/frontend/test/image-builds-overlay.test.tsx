// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { screen, fireEvent, cleanup, act, waitFor } from '@testing-library/react'
import { ImageBuildsOverlay } from '#components/ImageBuildsOverlay'
import { mockFetch, renderWithClient as render, serverError, type FetchMock } from './harness'
import type { ImageBuildEntry } from '@yaac/shared/types'

// jsdom has no ResizeObserver; Base UI needs one to exist.
beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
})

const LOG = 'GET /api/image/builds/:id/log'
const RETRY = 'POST /api/image/builds/:id/retry'
const DISMISS = 'DELETE /api/image/builds/:id'

/** The server's routes for every build id the tests use. */
function routes(): Record<string, unknown> {
  const table: Record<string, unknown> = {}
  for (const id of ['build-1', 'build-2', 'running-build', 'newest-failed', 'old-failed', 'ok-build', 'bad-build']) {
    table[LOG.replace(':id', id)] = { log: 'STEP 1/2: FROM ubuntu\n' }
    table[RETRY.replace(':id', id)] = { ok: true }
    table[DISMISS.replace(':id', id)] = { ok: true }
  }
  return table
}

/** The ids whose log was fetched, in order. */
const logFetches = (): string[] =>
  server.calls.filter((c) => c.method === 'GET' && c.path.endsWith('/log')).map((c) => c.path.split('/')[4])

let server: FetchMock
beforeEach(() => {
  server = mockFetch(routes())
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function build(overrides: Partial<ImageBuildEntry> = {}): ImageBuildEntry {
  return {
    id: 'build-1',
    tag: 'yaac-base:abc123def',
    layer: 'base',
    projectSlugs: ['proj'],
    reason: 'prewarm',
    status: 'running',
    startedAt: '2026-07-06 00:00:00',
    ...overrides,
  }
}

const flushEffects = (): Promise<void> => act(async () => { await vi.advanceTimersByTimeAsync(0) })

describe('ImageBuildsOverlay', () => {
  it('shows an empty state when nothing was tracked', async () => {
    render(<ImageBuildsOverlay open onOpenChange={() => {}} builds={[]} />)
    expect(screen.getByText('No image builds yet.')).toBeTruthy()
    await act(async () => { await Promise.resolve() })
    expect(server.calls).toEqual([])
  })

  it('renders build rows with layer, projects, step, and error details', () => {
    const builds = [
      build({ stepCurrent: 3, stepTotal: 14, stepText: 'RUN apt-get update' }),
      build({ id: 'build-2', tag: 'yaac-user-p:def', layer: 'user', status: 'failed', error: 'registry down' }),
    ]
    render(<ImageBuildsOverlay open onOpenChange={() => {}} builds={builds} />)

    expect(screen.getByText('Image builds')).toBeTruthy()
    expect(screen.getByText('base layer')).toBeTruthy()
    expect(screen.getByText('yaac-base:abc123')).toBeTruthy()
    expect(screen.getByText(/step 3\/14/)).toBeTruthy()
    expect(screen.getByText('RUN apt-get update')).toBeTruthy()
    expect(screen.getByText('user layer')).toBeTruthy()
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

    expect(logFetches()).toEqual(['running-build'])
    expect(screen.getByText(/STEP 1\/2: FROM ubuntu/)).toBeTruthy()

    await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
    expect(logFetches()).toEqual(['running-build', 'running-build', 'running-build'])
  })

  it('fetches a finished build once without polling', async () => {
    vi.useFakeTimers()
    render(<ImageBuildsOverlay open onOpenChange={() => {}} builds={[build({ status: 'succeeded' })]} />)
    await flushEffects()

    expect(logFetches()).toEqual(['build-1'])
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    expect(logFetches()).toEqual(['build-1'])
  })

  it('switches the log pane when a row is clicked', async () => {
    const builds = [
      build({ id: 'running-build' }),
      build({ id: 'old-failed', tag: 'yaac-tools:def', status: 'failed', error: 'x' }),
    ]
    render(<ImageBuildsOverlay open onOpenChange={() => {}} builds={builds} />)
    await waitFor(() => expect(logFetches()).toEqual(['running-build']))

    fireEvent.click(screen.getByText('yaac-tools:def'))
    await waitFor(() => expect(logFetches()).toEqual(['running-build', 'old-failed']))
  })

  it('dismisses a finished build and never offers dismiss on a running one', async () => {
    const builds = [
      build({ id: 'running-build' }),
      build({ id: 'old-failed', status: 'failed', error: 'x' }),
    ]
    render(<ImageBuildsOverlay open onOpenChange={() => {}} builds={builds} />)

    const dismissButtons = screen.getAllByRole('button', { name: 'Dismiss build entry' })
    expect(dismissButtons).toHaveLength(1)
    fireEvent.click(dismissButtons[0])
    await waitFor(() => expect(server.called(DISMISS.replace(':id', 'old-failed'))).toHaveLength(1))
  })

  it('offers Retry only on a failed build, and posts it for that build', async () => {
    const builds = [
      build({ id: 'ok-build', status: 'succeeded' }),
      build({ id: 'bad-build', tag: 'yaac-tools:def', status: 'failed', error: 'x' }),
    ]
    render(<ImageBuildsOverlay open onOpenChange={() => {}} builds={builds} />)

    // Retry appears once (on the failed row), while both finished rows can be dismissed.
    const retryButtons = screen.getAllByRole('button', { name: 'Retry build' })
    expect(retryButtons).toHaveLength(1)
    expect(screen.getAllByRole('button', { name: 'Dismiss build entry' })).toHaveLength(2)

    fireEvent.click(retryButtons[0])
    await waitFor(() => expect(server.called(RETRY.replace(':id', 'bad-build'))).toHaveLength(1))
    expect(server.calls.filter((c) => c.method === 'DELETE')).toEqual([])
  })

  it('shows why a retry or a dismiss failed', async () => {
    server.route(RETRY.replace(':id', 'bad-build'), serverError('NOT_FOUND', 'no such build to retry', 404))
    server.route(DISMISS.replace(':id', 'bad-build'), serverError('INTERNAL', 'dismiss exploded'))
    const builds = [build({ id: 'bad-build', status: 'failed', error: 'x' })]
    render(<ImageBuildsOverlay open onOpenChange={() => {}} builds={builds} />)

    fireEvent.click(screen.getByRole('button', { name: 'Retry build' }))
    expect(await screen.findByText('no such build to retry')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss build entry' }))
    expect(await screen.findByText('dismiss exploded')).toBeTruthy()
    expect(screen.queryByText('no such build to retry')).toBeNull()
  })
})
