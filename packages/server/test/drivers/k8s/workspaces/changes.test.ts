import { describe, it, expect, vi, beforeEach } from 'vitest'

// Stub only `podExec`; changes.ts needs the module's real error classes.
vi.mock('#drivers/k8s/substrate/stream-relay', async (importOriginal) => ({
  ...await importOriginal<typeof StreamRelay>(),
  podExec: vi.fn(),
}))
import type * as StreamRelay from '#drivers/k8s/substrate/stream-relay'
import { RelayDialError, podExec } from '#drivers/k8s/substrate/stream-relay'
import { getWorkspaceChanges } from '#drivers/k8s/workspaces/changes'
import { CHANGES_BASE_UNRESOLVED, WorkspaceExecError } from '#drivers/contract'

const mockExec = vi.mocked(podExec)

describe('getWorkspaceChanges', () => {
  const EMPTY = 'BASE deadbeef\nFORK 1\n@@NUMSTAT@@\n@@NAMESTATUS@@\n@@LISTING@@\n@@OK@@\n@@DIFF@@\n'

  beforeEach(() => { mockExec.mockReset() })

  it('runs the pod-side script via the relay exec and parses its output', async () => {
    mockExec.mockResolvedValue({
      stdout: 'BASE cafe1234\nFORK 1\n@@NUMSTAT@@\n2\t1\tsrc/x.ts\n@@NAMESTATUS@@\nM\tsrc/x.ts\n@@LISTING@@\n@@OK@@\n@@DIFF@@\n',
      stderr: '',
    })
    const out = await getWorkspaceChanges('yaac-proj-abc', { diff: true })
    const [jobName, cmd, opts] = mockExec.mock.calls[0] ?? []
    expect(jobName).toBe('yaac-proj-abc')
    expect(cmd).toContain('add -A --ignore-errors')
    expect(cmd).toContain('GIT_INDEX_FILE')
    expect(opts).toMatchObject({ timeout: 20_000, maxAttempts: 2 })
    expect(out.changes.base).toBe('cafe1234')
    expect(out.changes.baseResolved).toBe(true)
    expect(out.changes.files).toEqual([
      { path: 'src/x.ts', status: 'modified', additions: 2, deletions: 1, binary: false, stages: {} },
    ])
  })

  it('forwards the chosen base branch into the pod script', async () => {
    mockExec.mockResolvedValue({ stdout: EMPTY, stderr: '' })
    await getWorkspaceChanges('yaac-proj-abc', { base: 'dev', diff: true })
    const [, cmd] = mockExec.mock.calls.at(-1) ?? []
    expect(cmd).toContain('"origin/$1"')
    expect(cmd).toContain("yaac-changes 'dev' ''")
  })

  it('forwards the fork-branch default into the pod script when no explicit base', async () => {
    mockExec.mockResolvedValue({ stdout: EMPTY, stderr: '' })
    await getWorkspaceChanges('yaac-proj-abc', { defaultBase: 'main', diff: true })
    const [, cmd] = mockExec.mock.calls.at(-1) ?? []
    expect(cmd).toContain('"origin/$2"')
    expect(cmd).toContain("yaac-changes '' 'main'")
    await getWorkspaceChanges('yaac-proj-abc', { defaultBase: 'main', diff: false })
    expect(mockExec.mock.calls.at(-1)?.[1]).toContain("yaac-changes '' 'main' nodiff")
  })

  // Every open tab polls, so identical concurrent requests share one exec.
  it('coalesces identical concurrent requests into a single pod exec', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    mockExec.mockImplementation(async () => {
      await gate
      return { stdout: EMPTY, stderr: '' }
    })
    const all = Promise.all([
      getWorkspaceChanges('yaac-proj-abc', { defaultBase: 'main', diff: true }),
      getWorkspaceChanges('yaac-proj-abc', { defaultBase: 'main', diff: true }),
      getWorkspaceChanges('yaac-proj-abc', { defaultBase: 'main', diff: true }),
    ])
    release()
    const [a, b, c] = await all
    expect(mockExec).toHaveBeenCalledTimes(1)
    expect(a).toBe(b)
    expect(b).toBe(c)
    // Only in-flight requests are shared.
    mockExec.mockResolvedValue({ stdout: EMPTY, stderr: '' })
    await getWorkspaceChanges('yaac-proj-abc', { defaultBase: 'main', diff: true })
    expect(mockExec).toHaveBeenCalledTimes(2)
  })

  // Different bases share one git index in the pod, so they run in turn.
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
      getWorkspaceChanges('yaac-proj-abc', { base: 'dev', diff: true }),
      getWorkspaceChanges('yaac-proj-abc', { base: 'main', diff: true }),
      getWorkspaceChanges('yaac-proj-abc', { base: 'release', diff: true }),
    ])
    expect(mockExec).toHaveBeenCalledTimes(3)
    expect(peak).toBe(1)
  })

  // A failure must not be shown as "No changes".
  it('throws rather than reporting no changes when the run failed partway', async () => {
    mockExec.mockResolvedValue({ stdout: 'BASE cafe1234\nFORK 1\n@@NUMSTAT@@\n', stderr: '' })
    await expect(getWorkspaceChanges('yaac-proj-abc', { diff: true })).rejects.toThrow(/completion marker/)
  })

  // Callers map the exit code (e.g. a bad base → 400), so it must arrive
  // as the contract's error type.
  it('passes a nonzero exit through as the contract error, carrying the code', async () => {
    mockExec.mockRejectedValue(
      new WorkspaceExecError('command exited 4 in yaac-proj-abc: ', CHANGES_BASE_UNRESOLVED, '', ''),
    )

    const err = await getWorkspaceChanges('yaac-proj-abc', { base: 'no-such-branch', diff: true }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(WorkspaceExecError)
    expect(err).toMatchObject({ code: CHANGES_BASE_UNRESOLVED })
  })

  // A transport failure says nothing about the base, so it must not look
  // like a script verdict.
  it('passes a transport failure through untranslated', async () => {
    const dial = new RelayDialError('stream relay dial (yaac-pro...): connection refused')
    mockExec.mockRejectedValue(dial)

    const err = await getWorkspaceChanges('yaac-proj-abc', { base: 'dev', diff: true }).catch((e: unknown) => e)
    expect(err).toBe(dial)
    expect(err).not.toBeInstanceOf(WorkspaceExecError)
  })
})
