import { describe, it, expect, vi, beforeEach } from 'vitest'
import type * as kubectlModule from '#platform/k8s/kubectl'

// kubectl is the process boundary; the label constants, the selector and the
// patch this builds stay real, since they are what the test is about. Both
// entry points are stubbed because `kubectlGetJson` reaches its own module's
// `kubectlWithRetry` directly, not through the namespace a partial mock
// replaces — stubbing only the latter would leave the lookup shelling out
// for real.
const mockKubectl = vi.hoisted(() => vi.fn())
const mockGetJson = vi.hoisted(() => vi.fn())
vi.mock('#platform/k8s/kubectl', async (importOriginal) => ({
  ...(await importOriginal<typeof kubectlModule>()),
  kubectlWithRetry: mockKubectl,
  kubectlGetJson: mockGetJson,
}))

import { claimSpareWorkspace } from '#runtime/k8s/worktrees/claim'
import { LABEL_PREWARMED, LABEL_TOOL, LABEL_WORKTREE_ID_LEGACY } from '#platform/k8s/pods'
import { dataDirHash } from '#platform/k8s/kubectl'

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
    expect(selector).toContain(`${LABEL_WORKTREE_ID_LEGACY}=s1`)
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
