import { describe, it, expect, vi } from 'vitest'
import type * as childProcessModule from 'node:child_process'

// The process boundary: podman, reached through a promisified execFile.
type ExecResult = { stdout: string; stderr: string }
type ExecCallback = (err: unknown, res?: ExecResult) => void
const mockExecFile = vi.hoisted(() => vi.fn<(file: string, args: string[]) => Promise<ExecResult>>())
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof childProcessModule>()),
  execFile: (file: string, args: string[], opts: unknown, cb?: ExecCallback) => {
    const done = (typeof opts === 'function' ? opts : cb) as ExecCallback
    void mockExecFile(file, args).then((res) => done(null, res), (err: unknown) => done(err))
  },
}))

import { gcTestImages } from '#test-images'

// Newest-first, as `podman image ls --sort created` emits.
const LS_OUTPUT = [
  'localhost/yaac-test-server|localhost/yaac-test-server:s1',
  'localhost/yaac-test-server|localhost/yaac-test-server:s2',
  'localhost/yaac-test-server|localhost/yaac-test-server:s3',
  'localhost/yaac-test-tools|localhost/yaac-test-tools:t1',
  'localhost/yaac-test-upstream-registry|localhost/yaac-test-upstream-registry:2',
  'localhost/yaac-server|localhost/yaac-server:p1',
  'localhost/yaac-server|localhost/yaac-server:p2',
  'localhost/yaac-server|localhost/yaac-server:p3',
].join('\n')

describe('gcTestImages', () => {
  it('retires only yaac-test-* generations past the newest two, leaving install images and kept tags alone', async () => {
    mockExecFile.mockImplementation((_file, args) => Promise.resolve({
      stdout: args[0] === 'image' && args[1] === 'ls' ? LS_OUTPUT : '',
      stderr: '',
    }))

    // s1 is in use (named bare, as the global setup resolves it), so it is
    // kept without counting toward the two; s2 and s3 stay.
    const retired = await gcTestImages(['yaac-test-server:s1'])
    expect(retired).toEqual([])
    mockExecFile.mockClear()

    // Without it, s3 is past the budget. Install repos (yaac-server) are
    // left to `gcHostImages`.
    expect(await gcTestImages()).toEqual(['localhost/yaac-test-server:s3'])
    const podmanCalls = mockExecFile.mock.calls.map(([, args]) => args)
    expect(podmanCalls.filter((a) => a[0] === 'rmi')).toEqual([['rmi', 'localhost/yaac-test-server:s3']])
    expect(podmanCalls.some((a) => a.includes('prune') || a.includes('-f'))).toBe(false)
  })
})
