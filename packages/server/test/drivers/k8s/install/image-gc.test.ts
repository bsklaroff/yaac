import { describe, it, expect, vi, beforeEach } from 'vitest'
import type * as childProcess from 'node:child_process'

// Every podman call goes through the promisified execFile.
type ExecResult = { stdout: string; stderr: string }
type ExecCallback = (err: unknown, res?: ExecResult) => void
const mockExecFile = vi.hoisted(() => vi.fn<(file: string, args: string[]) => Promise<ExecResult>>())
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof childProcess>()),
  execFile: (file: string, args: string[], opts: unknown, cb?: ExecCallback) => {
    const done = (typeof opts === 'function' ? opts : cb) as ExecCallback
    void mockExecFile(file, args).then((res) => done(null, res), (err: unknown) => done(err))
  },
}))

import { retireStaleGenerations } from '#drivers/k8s/install'

// Newest first, as `podman image ls --sort created` prints: four
// generations of one repo, two of another, one of a third that is not
// matched, a dangling row and a blank row.
const LS_OUTPUT = [
  'localhost/yaac-test-base|localhost/yaac-test-base:new1',
  'localhost/yaac-test-base|localhost/yaac-test-base:new2',
  'localhost/yaac-test-base|localhost/yaac-test-base:old1',
  'localhost/yaac-test-base|localhost/yaac-test-base:old2',
  'yaac-test-proxy|yaac-test-proxy:p1',
  'yaac-test-proxy|yaac-test-proxy:p2',
  'docker.io/library/ubuntu|docker.io/library/ubuntu:26.04',
  '<none>|<none>:<none>',
  '',
].join('\n')

const TEST_REPOS = /^(localhost\/)?yaac-test-/

const rmiRefs = (): string[] =>
  mockExecFile.mock.calls.filter(([, a]) => a[0] === 'rmi').map(([, a]) => a[1])

beforeEach(() => {
  mockExecFile.mockReset()
  mockExecFile.mockImplementation((_file, args) => Promise.resolve({
    stdout: args[0] === 'image' && args[1] === 'ls' ? LS_OUTPUT : '',
    stderr: '',
  }))
})

describe('retireStaleGenerations', () => {
  it('untags every generation past the newest two of each matching repo, without -f', async () => {
    await expect(retireStaleGenerations(TEST_REPOS))
      .resolves.toEqual(['localhost/yaac-test-base:old1', 'localhost/yaac-test-base:old2'])
    // No -f: a tag in use by a container or a running build must fail rmi
    // and wait for the next sweep. Dangling rows are never named.
    expect(mockExecFile.mock.calls.filter(([, a]) => a[0] === 'rmi').map(([, a]) => a))
      .toEqual([['rmi', 'localhost/yaac-test-base:old1'], ['rmi', 'localhost/yaac-test-base:old2']])
  })

  it('spares protected tags, bare or localhost-qualified, without counting them toward the budget', async () => {
    await retireStaleGenerations(TEST_REPOS, new Set(['yaac-test-base:new1', 'localhost/yaac-test-base:old2']), 1)
    // new1 and old2 are protected; of the rest, new2 is the one kept.
    expect(rmiRefs()).toEqual(['localhost/yaac-test-base:old1', 'yaac-test-proxy:p2'])
  })

  it('reports only the tags it untagged when an rmi fails', async () => {
    mockExecFile.mockImplementation((_file, args) => {
      if (args[0] === 'rmi' && args[1] === 'localhost/yaac-test-base:old1') {
        return Promise.reject(new Error('image is in use by a container'))
      }
      return Promise.resolve({ stdout: args[1] === 'ls' ? LS_OUTPUT : '', stderr: '' })
    })
    // The failed tag stays for the next sweep.
    await expect(retireStaleGenerations(TEST_REPOS)).resolves.toEqual(['localhost/yaac-test-base:old2'])
  })

  it('retires nothing when the engine has no images', async () => {
    mockExecFile.mockResolvedValue({ stdout: '', stderr: '' })
    await expect(retireStaleGenerations(TEST_REPOS)).resolves.toEqual([])
  })
})
