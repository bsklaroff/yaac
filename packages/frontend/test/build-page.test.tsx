import { describe, it, expect, afterEach, vi } from 'vitest'
import { act, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react'
import { BuildPage } from '#components/BuildPage'
import { useUiStore } from '#lib/store'
import type { ImageBuild } from '@yaac/shared/types'
import {
  imageBuild, mockFetch, renderWithClient, serverError, serverSnapshot, testQueryClient, type FetchCall, type FetchMock,
} from './harness'

afterEach(() => {
  vi.useRealTimers()
  cleanup()
  useUiStore.getState().openBuild(null)
})

/** A failed BuildKit run: its steps interleave, and the error trails off
 *  into lines no step names. */
const FAILED_LOG = [
  '#1 [internal] load build definition from Dockerfile',
  '#1 transferring dockerfile: 120B done',
  '#1 DONE 0.0s',
  '#2 [1/3] FROM docker.io/library/node:22',
  '#2 CACHED',
  '#3 [2/3] RUN npm install',
  '#3 0.512 fetching',
  '#4 [3/3] COPY . .',
  '#3 1.20 npm ERR! 403',
  '#3 ERROR: process "/bin/sh -c npm install" did not complete successfully: exit code: 1',
  '------',
  ' > [2/3] RUN npm install:',
  '',
].join('\n')

const FAILED = imageBuild({
  status: 'failed', error: 'exit code: 1', reason: 'save', cachedSteps: 2, totalSteps: 5,
  startedAt: '2026-11-20T00:00:00Z', finishedAt: '2026-11-20T00:01:20Z',
  parentTag: 'yaac-tools:t1', baseDigests: { 'node:22': 'sha256:abc' }, buildkitVersion: 'v0.20.0',
  warnings: [{ message: 'JSONArgsRecommended', line: 3 }], blockedHosts: ['registry.npmjs.org'],
})

/** Open `build`'s page over a server that has it, and `build-2`, the
 *  rebuild a retry starts. */
function openPage(build: ImageBuild, log: unknown = { text: FAILED_LOG, offset: FAILED_LOG.length, done: true }): FetchMock {
  const rebuild = imageBuild({ id: 'build-2', status: 'queued' })
  const server = mockFetch({
    'GET /api/image/builds/build-1': build,
    'GET /api/image/builds/build-1/log': log,
    'GET /api/image/builds/build-2': rebuild,
    'GET /api/image/builds/build-2/log': { text: '', offset: 0, done: false },
    'POST /api/image/builds/build-1/retry': [rebuild],
    'POST /api/image/builds/build-1/allow-host': { allowed: ['registry.npmjs.org'], builds: [rebuild] },
    'POST /api/image/builds/build-2/cancel': undefined,
  })
  act(() => useUiStore.getState().openBuild('build-1'))
  renderWithClient(<BuildPage />, testQueryClient(undefined, serverSnapshot()))
  return server
}

const section = (title: string): HTMLDetailsElement =>
  screen.getByText(title, { exact: false, selector: 'summary *' }).closest('details')!

describe('BuildPage', () => {
  it('shows what a build consumed and its warnings, its log as one section per step, opening the one that failed', async () => {
    openPage(FAILED)
    await screen.findByRole('heading', { name: 'node · revision 1' })
    expect(screen.getByText('exit code: 1')).toBeTruthy()
    expect(screen.getByText('2 of 5 steps')).toBeTruthy()
    expect(screen.getByText('1m 20s')).toBeTruthy()
    expect(screen.getByText('yaac-tools:t1')).toBeTruthy()
    expect(screen.getByText('sha256:abc')).toBeTruthy()
    expect(screen.getByText('v0.20.0')).toBeTruthy()
    expect(screen.getByText('Line 3: JSONArgsRecommended')).toBeTruthy()

    await waitFor(() => expect(document.querySelectorAll('details')).toHaveLength(5))
    expect([...document.querySelectorAll('summary')].map((s) => s.textContent)).toEqual([
      '#1 [internal] load build definition from Dockerfile0.0s',
      '#2 [1/3] FROM docker.io/library/node:22cached',
      '#3 [2/3] RUN npm installerror',
      '#4 [3/3] COPY . .',
      'Output',
    ])
    // A step's lines are gathered from wherever they fall in the log.
    const failed = section('RUN npm install')
    expect(failed.open).toBe(true)
    expect(failed.querySelector('pre')?.textContent).toBe(
      '0.512 fetching\n1.20 npm ERR! 403\nERROR: process "/bin/sh -c npm install" did not complete successfully: exit code: 1')
    expect(section('load build definition').open).toBe(false)
    expect(section('Output').querySelector('pre')?.textContent).toBe('------\n > [2/3] RUN npm install:')
  })

  it('polls a running build\'s log from where the last read ended, through a failed read, until it is done', async () => {
    // Testing Library's async helpers wait on a real setTimeout, which is
    // faked here, so this waits with vi.waitFor.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let failed = false
    const server = openPage(imageBuild(), ({ query }: FetchCall) => {
      if (query.get('offset') === '0') return { text: '#1 [1/2] FROM x\n', offset: 16, done: false }
      if (!failed) {
        failed = true
        return serverError('INTERNAL', 'log unavailable')
      }
      return { text: '#1 DONE 0.1s\n', offset: 29, done: true }
    })
    await vi.waitFor(() => expect(screen.getByText('[1/2] FROM x')).toBeTruthy())
    // The step running is the open one.
    expect(section('[1/2] FROM x').open).toBe(true)
    await act(() => vi.advanceTimersByTimeAsync(1_000))
    await vi.waitFor(() => expect(screen.getByText('log unavailable')).toBeTruthy())
    await act(() => vi.advanceTimersByTimeAsync(1_000))
    await vi.waitFor(() => expect(screen.getByText('0.1s')).toBeTruthy())
    expect(screen.queryByText('log unavailable')).toBeNull()
    expect(server.called('GET /api/image/builds/build-1/log').map((c) => c.query.get('offset'))).toEqual(['0', '16', '16'])
  })

  it('asks for nothing until the snapshot says the server builds images', () => {
    const server = mockFetch({})
    useUiStore.setState({ snapshot: undefined })
    act(() => useUiStore.getState().openBuild('build-1'))
    renderWithClient(<BuildPage />)
    act(() => useUiStore.getState().receiveSnapshot(serverSnapshot({ driver: 'containerless' })))
    expect(server.called('GET /api/image/builds/build-1')).toEqual([])
    expect(server.called('GET /api/image/builds/build-1/log')).toEqual([])
  })

  it('retries, following the rebuild to its page, where it can be cancelled', async () => {
    const server = openPage(FAILED)
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(useUiStore.getState().buildPageId).toBe('build-2'))
    expect(server.called('POST /api/image/builds/build-1/retry').map((c) => c.body)).toEqual([{}])
    expect(new URLSearchParams(window.location.search).get('build')).toBe('build-2')

    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(server.called('POST /api/image/builds/build-2/cancel')).toHaveLength(1))
  })

  it('rebuilds without the cache, and allows a refused host for the project, building again', async () => {
    const server = openPage(FAILED)
    fireEvent.click(await screen.findByRole('button', { name: 'Rebuild without cache' }))
    await waitFor(() => expect(server.called('POST /api/image/builds/build-1/retry').map((c) => c.body)).toEqual([{ noCache: true }]))
    cleanup()

    const again = openPage(FAILED)
    const blocked = await screen.findByRole('region', { name: 'Blocked hosts' })
    expect(within(blocked).getByText('registry.npmjs.org')).toBeTruthy()
    fireEvent.click(within(blocked).getByRole('button', { name: 'Allow for this project' }))
    await waitFor(() => expect(useUiStore.getState().buildPageId).toBe('build-2'))
    expect(again.called('POST /api/image/builds/build-1/allow-host').map((c) => c.body)).toEqual([{ host: 'registry.npmjs.org' }])
  })

  it('closes, dropping the build from the URL', async () => {
    openPage(FAILED)
    fireEvent.click(await screen.findByRole('button', { name: 'Close build' }))
    expect(useUiStore.getState().buildPageId).toBeNull()
    expect(new URLSearchParams(window.location.search).has('build')).toBe(false)
  })
})
