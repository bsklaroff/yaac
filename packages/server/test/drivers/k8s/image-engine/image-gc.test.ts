import { describe, it, expect, vi, beforeEach } from 'vitest'
import type * as runtimeModule from '#drivers/k8s/container/runtime'

const mockExecFileAsync = vi.hoisted(() => vi.fn())
vi.mock('#drivers/k8s/container/runtime', async (importOriginal) => ({
  ...(await importOriginal<typeof runtimeModule>()),
  execFileAsync: mockExecFileAsync,
}))

import { gcHostImages } from '#drivers/k8s/image-engine'
// Setup value, not a unit under test: the prune carries an age floor, so a
// test asserting the prune call has to speak the same number the module does.
import { HOST_PRUNE_UNTIL } from '#drivers/k8s/image-engine/image-gc'

// Newest-first, as `podman image ls --sort created` emits. Four yaac-base
// generations (2 stale at the default budget), one in-budget registry-staged
// yaac ref, three non-yaac tags, plus a dangling and a blank row.
const LS_OUTPUT = [
  'localhost/yaac-base|localhost/yaac-base:new1',
  'localhost/yaac-base|localhost/yaac-base:new2',
  'localhost/yaac-base|localhost/yaac-base:old1',
  'localhost/yaac-base|localhost/yaac-base:old2',
  'localhost:5001/yaac-user-demo|localhost:5001/yaac-user-demo:a',
  'docker.io/library/ubuntu|docker.io/library/ubuntu:26.04',
  'docker.io/library/ubuntu|docker.io/library/ubuntu:24.04',
  'docker.io/library/ubuntu|docker.io/library/ubuntu:22.04',
  '<none>|<none>:<none>',
  '',
].join('\n')

type Call = [string, string[]]
const callsMatching = (pred: (args: string[]) => boolean): string[][] =>
  (mockExecFileAsync.mock.calls as Call[]).map(([, args]) => args).filter(pred)
const rmiRefs = (): string[] => callsMatching((a) => a[0] === 'rmi').map((a) => a[1])

/** Serve `image ls` from LS_OUTPUT; everything else succeeds empty. */
function servingLs(overrides: (args: string[]) => Promise<unknown> | undefined = () => undefined) {
  mockExecFileAsync.mockImplementation((_cmd: string, args: string[]) => {
    const override = overrides(args)
    if (override) return override
    if (args[0] === 'image' && args[1] === 'ls') {
      return Promise.resolve({ stdout: LS_OUTPUT, stderr: '' })
    }
    return Promise.resolve({ stdout: '', stderr: '' })
  })
}

beforeEach(() => {
  mockExecFileAsync.mockReset().mockResolvedValue({ stdout: '', stderr: '' })
})

describe('gcHostImages', () => {
  it('retires stale generation tags, then prunes dangling images past the age floor', async () => {
    servingLs((args) => args[1] === 'prune'
      ? Promise.resolve({ stdout: `${'a'.repeat(64)}\n${'b'.repeat(64)}\n`, stderr: '' })
      : undefined)

    const { retired, pruned } = await gcHostImages()

    // No -f on rmi: a tag in use by a container, or mid-build as a FROM,
    // must fail its rmi and wait for the next sweep.
    expect(callsMatching((a) => a[0] === 'rmi')).toEqual([
      ['rmi', 'localhost/yaac-base:old1'],
      ['rmi', 'localhost/yaac-base:old2'],
    ])
    expect(callsMatching((a) => a[1] === 'prune')).toEqual([
      ['image', 'prune', '-f', '--filter', `until=${HOST_PRUNE_UNTIL}`],
    ])
    expect(retired).toEqual(['localhost/yaac-base:old1', 'localhost/yaac-base:old2'])
    expect(pruned).toBe(2)
  })

  it('keeps the newest generations per yaac repo and never touches non-yaac repos', async () => {
    servingLs()
    await gcHostImages()
    // yaac-base has 4 generations → the 2 oldest go. The registry-staged
    // yaac ref is in scope but within budget; ubuntu has 3 tags and is not
    // a yaac-built repo, so neither is a candidate.
    expect(rmiRefs()).toEqual(['localhost/yaac-base:old1', 'localhost/yaac-base:old2'])
  })

  it('ignores dangling and malformed rows in the listing', async () => {
    servingLs()
    await gcHostImages()
    expect(rmiRefs().some((ref) => ref.includes('<none>'))).toBe(false)
  })

  it('retires nothing when the engine has no images', async () => {
    mockExecFileAsync.mockResolvedValue({ stdout: '', stderr: '' })
    await expect(gcHostImages()).resolves.toEqual({ retired: [], pruned: 0 })
  })

  it('tolerates an rmi failure and still prunes', async () => {
    servingLs((args) => args[0] === 'rmi' && args[1] === 'localhost/yaac-base:old1'
      ? Promise.reject(new Error('image is in use by a container'))
      : undefined)

    const { retired } = await gcHostImages()

    expect(callsMatching((a) => a[1] === 'prune')).toHaveLength(1)
    // The failed tag stays for the next sweep; only the other is reported.
    expect(retired).toEqual(['localhost/yaac-base:old2'])
  })
})
