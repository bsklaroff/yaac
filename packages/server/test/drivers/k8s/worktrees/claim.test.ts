import { describe, it, expect, vi, beforeEach } from 'vitest'
import type * as kubectlModule from '#drivers/k8s/substrate/kubectl'

// kubectl is the process boundary; the label constants, the selector and the
// patch this builds stay real, since they are what the test is about. Both
// entry points are stubbed because `kubectlGetJson` reaches its own module's
// `kubectlWithRetry` directly, not through the namespace a partial mock
// replaces — stubbing only the latter would leave the lookup shelling out
// for real.
const mockKubectl = vi.hoisted(() => vi.fn())
const mockGetJson = vi.hoisted(() => vi.fn())
vi.mock('#drivers/k8s/substrate/kubectl', async (importOriginal) => ({
  ...(await importOriginal<typeof kubectlModule>()),
  kubectlWithRetry: mockKubectl,
  kubectlGetJson: mockGetJson,
}))

import { claimSpareWorkspace } from '#drivers/k8s/worktrees/claim'
import { LABEL_PREWARMED, LABEL_TOOL, LABEL_WORKTREE_ID } from '#drivers/k8s/substrate/pods'
import { dataDirHash } from '#drivers/k8s/substrate/kubectl'

/** The argv of the lookup a claim does before its write. */
function getArgv(): string[] {
  return mockGetJson.mock.calls[0][0] as string[]
}

/** The argv of the write, if one was made. */
function patchArgv(): string[] | undefined {
  const call = mockKubectl.mock.calls.find(([args]) => (args as string[])[0] === 'patch')
  return call ? call[0] as string[] : undefined
}

/** The value of a flag in the argv, e.g. `-l`. */
function flag(args: string[], name: string): string {
  return args[args.indexOf(name) + 1]
}

/** The JSON-patch document the claim sent. */
function patchOps(): Array<{ op: string; path: string; value?: string }> {
  return JSON.parse(flag(patchArgv()!, '-p')) as Array<{ op: string; path: string; value?: string }>
}

beforeEach(() => {
  mockKubectl.mockReset().mockResolvedValue({ stdout: '', stderr: '' })
  mockGetJson.mockReset().mockResolvedValue({ items: [{ metadata: { name: 'yaac-proj-s1-abcde' } }] })
})

describe('claimSpareWorkspace', () => {
  it('finds the spare by workspace id, so the caller never needs a pod name', async () => {
    await claimSpareWorkspace('s1', 'codex')

    const selector = flag(getArgv(), '-l').split(',')
    expect(selector).toContain(`${LABEL_WORKTREE_ID}=s1`)
    expect(selector).toContain(`yaac.data-dir-hash=${dataDirHash()}`)
    expect(selector).toContain(`${LABEL_PREWARMED}=true`)
    // The pod name is the runtime's own, resolved here and never asked for.
    expect(patchArgv()).toContain('yaac-proj-s1-abcde')
  })

  it('refuses when no spare is left to claim, rather than reporting a claim', async () => {
    mockGetJson.mockResolvedValue({ items: [] })
    await expect(claimSpareWorkspace('s1', 'codex')).rejects.toThrow(/no prewarmed spare/)
    expect(patchArgv()).toBeUndefined()
  })

  // The load-bearing half. A selector only filters the LIST — `kubectl label
  // -l` would patch unconditionally afterwards, so two claimants could both
  // list the spare still prewarmed and both believe they won. The `test` op
  // is what makes the API server itself reject the second.
  it('writes under a compare-and-swap on the spare still being one', async () => {
    await claimSpareWorkspace('s1', 'codex')

    const ops = patchOps()
    expect(patchArgv()).toContain('--type=json')
    expect(ops[0]).toEqual({
      op: 'test', path: `/metadata/labels/${LABEL_PREWARMED}`, value: 'true',
    })
  })

  it('drops the prewarmed mark and stamps the claimed tool in the same write', async () => {
    await claimSpareWorkspace('s1', 'codex')

    const ops = patchOps()
    expect(ops).toContainEqual({ op: 'remove', path: `/metadata/labels/${LABEL_PREWARMED}` })
    expect(ops).toContainEqual({
      op: 'add', path: `/metadata/labels/${LABEL_TOOL}`, value: 'codex',
    })
  })

  // Always stamped, even when it is the tool the spare already booted: what
  // the workspace DECLARES is what a spawn from it reads, and leaving that
  // to a conditional would make the guarantee depend on the caller's luck.
  it('stamps the tool even when it already matches', async () => {
    await claimSpareWorkspace('s1', 'claude')
    expect(patchOps()).toContainEqual({
      op: 'add', path: `/metadata/labels/${LABEL_TOOL}`, value: 'claude',
    })
  })

  // What losing the race looks like on the wire: the API server fails the
  // whole patch. Not a transient error, so it is never retried into a win —
  // it surfaces, and the claim path reads a throw as "fall back to a cold
  // create".
  it('propagates the rejected compare-and-swap when another claim won', async () => {
    mockKubectl.mockRejectedValue(Object.assign(
      new Error('the server rejected our request'),
      { stderr: 'Unprocessable Entity: the test operation failed' },
    ))

    await expect(claimSpareWorkspace('s1', 'codex'))
      .rejects.toThrow(/rejected our request/)
  })

  it('propagates a failed lookup', async () => {
    mockGetJson.mockRejectedValue(new Error('apiserver down'))
    await expect(claimSpareWorkspace('s1', 'codex')).rejects.toThrow('apiserver down')
  })
})

describe('claimSpareWorkspace and the npm cache', () => {
  /** Serve the spare's pod (labelled or not) and the cache's readiness. */
  function stage(opts: { admitted: boolean; serving: boolean }): void {
    mockGetJson.mockImplementation((args: string[]) => Promise.resolve(
      args[1] === 'endpointslices'
        ? { items: [{ endpoints: [{ conditions: { ready: opts.serving } }] }] }
        : {
          items: [{
            metadata: {
              name: 'yaac-proj-s1-abcde',
              labels: opts.admitted ? { 'yaac.npm-cache': 'true' } : {},
            },
          }],
        },
    ))
  }
  const execArgv = (): string[] | undefined =>
    mockKubectl.mock.calls.map(([a]) => a as string[]).find((a) => a[0] === 'exec')

  // A spare is warmed long before it is claimed: pointed at a cache that
  // has since gone down, every install would fail, so the claim re-decides.
  it('re-decides a spare\'s registry against the cache as it is at claim time', async () => {
    stage({ admitted: true, serving: false })
    await claimSpareWorkspace('s1', 'codex')
    const down = execArgv()!
    expect(down).toEqual(expect.arrayContaining(['exec', 'yaac-proj-s1-abcde', '-c', 'worktree']))
    // No URL: the script only strips the cache's own line.
    expect(down.at(-1)).toBe('')
    expect(down.join(' ')).toContain('registry=http://yaac-npm-cache')

    mockKubectl.mockClear()
    stage({ admitted: true, serving: true })
    await claimSpareWorkspace('s1', 'codex')
    expect(execArgv()!.at(-1)).toMatch(/^http:\/\/yaac-npm-cache\..*:4873\/$/)
  })

  it('leaves a spare the cache does not admit alone, and never fails a claim over it', async () => {
    stage({ admitted: false, serving: true })
    await claimSpareWorkspace('s1', 'codex')
    expect(execArgv()).toBeUndefined()

    stage({ admitted: true, serving: true })
    mockKubectl.mockImplementation((args: string[]) => args[0] === 'exec'
      ? Promise.reject(new Error('container not running'))
      : Promise.resolve({ stdout: '', stderr: '' }))
    await expect(claimSpareWorkspace('s1', 'codex')).resolves.toBeUndefined()
  })
})
