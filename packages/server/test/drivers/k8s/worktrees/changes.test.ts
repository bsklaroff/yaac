import { describe, it, expect, vi, beforeEach } from 'vitest'

// The real module with only `podExec` stubbed: its two error classes are
// what the folder classifies a failed run BY, so a factory that returned the
// stub alone would hand `changes.ts` an undefined `RelayExecError` to branch
// on and quietly pass every failure through untranslated.
vi.mock('#drivers/k8s/substrate/stream-relay', async (importOriginal) => ({
  ...await importOriginal<typeof StreamRelay>(),
  podExec: vi.fn(),
}))
import type * as StreamRelay from '#drivers/k8s/substrate/stream-relay'
import { RelayDialError, RelayExecError, podExec } from '#drivers/k8s/substrate/stream-relay'
import { getWorktreeChanges } from '#drivers/k8s/worktrees/changes'
import { CHANGES_BASE_UNRESOLVED, WorkspaceExecError } from '#drivers/contract'

const mockExec = vi.mocked(podExec)

describe('getWorktreeChanges', () => {
  const EMPTY = 'BASE deadbeef\nFORK 1\n@@NUMSTAT@@\n@@NAMESTATUS@@\n@@OK@@\n@@DIFF@@\n'

  beforeEach(() => { mockExec.mockReset() })

  it('runs the pod-side script via the relay exec and parses its output', async () => {
    mockExec.mockResolvedValue({
      stdout: 'BASE cafe1234\nFORK 1\n@@NUMSTAT@@\n2\t1\tsrc/x.ts\n@@NAMESTATUS@@\nM\tsrc/x.ts\n@@OK@@\n@@DIFF@@\n',
      stderr: '',
    })
    const out = await getWorktreeChanges('yaac-proj-abc')
    const [jobName, cmd, opts] = mockExec.mock.calls[0] ?? []
    expect(jobName).toBe('yaac-proj-abc')
    expect(cmd).toContain('git add -A')
    expect(cmd).toContain('GIT_INDEX_FILE')
    expect(opts).toMatchObject({ timeout: 20_000, maxAttempts: 2 })
    expect(out.base).toBe('cafe1234')
    expect(out.baseResolved).toBe(true)
    expect(out.files).toEqual([
      { path: 'src/x.ts', status: 'modified', additions: 2, deletions: 1, binary: false },
    ])
  })

  it('forwards the chosen base branch into the pod script', async () => {
    mockExec.mockResolvedValue({ stdout: EMPTY, stderr: '' })
    await getWorktreeChanges('yaac-proj-abc', 'dev')
    const [, cmd] = mockExec.mock.calls.at(-1) ?? []
    expect(cmd).toContain('"origin/$1"')
    expect(cmd).toContain("yaac-changes 'dev' ''")
  })

  it('forwards the fork-branch default into the pod script when no explicit base', async () => {
    mockExec.mockResolvedValue({ stdout: EMPTY, stderr: '' })
    await getWorktreeChanges('yaac-proj-abc', undefined, 'main')
    const [, cmd] = mockExec.mock.calls.at(-1) ?? []
    expect(cmd).toContain('"origin/$2"')
    expect(cmd).toContain("yaac-changes '' 'main'")
  })

  // The pane polls every few seconds and each open tab polls on its own, so
  // identical concurrent requests must ride one exec rather than piling work
  // onto the pod.
  it('coalesces identical concurrent requests into a single pod exec', async () => {
    // Build the gate up front: the exec body only runs on a later microtask,
    // so a `release` captured from inside the executor would still be unset by
    // the time we open it.
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    mockExec.mockImplementation(async () => {
      await gate
      return { stdout: EMPTY, stderr: '' }
    })
    const all = Promise.all([
      getWorktreeChanges('yaac-proj-abc', undefined, 'main'),
      getWorktreeChanges('yaac-proj-abc', undefined, 'main'),
      getWorktreeChanges('yaac-proj-abc', undefined, 'main'),
    ])
    release()
    const [a, b, c] = await all
    expect(mockExec).toHaveBeenCalledTimes(1)
    expect(a).toBe(b)
    expect(b).toBe(c)
    // A later request re-execs — the coalescing window is only "in flight".
    mockExec.mockResolvedValue({ stdout: EMPTY, stderr: '' })
    await getWorktreeChanges('yaac-proj-abc', undefined, 'main')
    expect(mockExec).toHaveBeenCalledTimes(2)
  })

  // Different bases are different diffs, but they share one pod-side index, so
  // they must run one at a time rather than racing on its lock.
  it('serializes differing requests for the same session', async () => {
    let running = 0
    let peak = 0
    mockExec.mockImplementation(async () => {
      peak = Math.max(peak, ++running)
      await new Promise((r) => setTimeout(r, 5))
      running--
      return { stdout: EMPTY, stderr: '' }
    })
    await Promise.all([
      getWorktreeChanges('yaac-proj-abc', 'dev'),
      getWorktreeChanges('yaac-proj-abc', 'main'),
      getWorktreeChanges('yaac-proj-abc', 'release'),
    ])
    expect(mockExec).toHaveBeenCalledTimes(3)
    expect(peak).toBe(1)
  })

  // A pod-side failure must reach the caller as an error. Rendering it as an
  // empty changeset is the "No changes" bug.
  it('throws rather than reporting no changes when the run failed partway', async () => {
    mockExec.mockResolvedValue({ stdout: 'BASE cafe1234\nFORK 1\n@@NUMSTAT@@\n', stderr: '' })
    await expect(getWorktreeChanges('yaac-proj-abc')).rejects.toThrow(/completion marker/)
  })

  // The script's exit codes are this folder's vocabulary, so a run that
  // exited nonzero has to leave it in the CONTRACT's — the code is what the
  // mediator reads to answer an unusable caller-named base with a 400, and a
  // substrate error is not a vocabulary the layer above may name.
  it('restates a nonzero exit as the contract error, carrying the code', async () => {
    mockExec.mockRejectedValue(
      new RelayExecError('command exited 4 in yaac-proj-abc: ', CHANGES_BASE_UNRESOLVED, '', ''),
    )

    const err = await getWorktreeChanges('yaac-proj-abc', 'no-such-branch').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(WorkspaceExecError)
    expect(err).toMatchObject({ code: CHANGES_BASE_UNRESOLVED })
    expect((err as WorkspaceExecError).cause).toBeInstanceOf(RelayExecError)
  })

  // The other direction, and the one that matters most: a workspace the exec
  // never reached proves nothing about the base. Translated, it would arrive
  // upstream indistinguishable from a real verdict and a cluster blip would
  // be answered as the caller's bad ref.
  it('passes a transport failure through untranslated', async () => {
    const dial = new RelayDialError('stream relay dial (yaac-pro...): connection refused')
    mockExec.mockRejectedValue(dial)

    const err = await getWorktreeChanges('yaac-proj-abc', 'dev').catch((e: unknown) => e)
    expect(err).toBe(dial)
    expect(err).not.toBeInstanceOf(WorkspaceExecError)
  })
})
