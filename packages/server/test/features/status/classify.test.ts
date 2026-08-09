import { describe, it, expect, vi, afterEach } from 'vitest'
import { classifyWorktreePods } from '#features/status/classify'
import { markWorktreeTerminating, _clearTerminatingForTests } from '#features/status/terminating'
import type { TmuxLiveness } from '#features/status/liveness'
import type { PodInfo, PodTerminalState } from '#platform/k8s/pods'

/** Grace window passed explicitly — production callers use testEnv.startingGraceMs. */
const GRACE_MS = 60_000

const NOW = 1_800_000_000_000
const now = (): number => NOW

/** A constant tri-state prober, typed so it slots into classifyWorktreePods. */
const probe = (v: TmuxLiveness) =>
  (): Promise<TmuxLiveness> => Promise.resolve(v)

function pod(overrides: {
  jobName?: string
  podName?: string
  worktreeId?: string
  project?: string
  running?: boolean
  terminating?: boolean
  phase?: string
  ageMs?: number
}): PodInfo {
  const createdAtMs = overrides.ageMs === undefined
    ? NOW - GRACE_MS - 1_000
    : NOW - overrides.ageMs
  const running = overrides.running ?? true
  return {
    jobName: overrides.jobName ?? 'yaac-proj-s1',
    podName: overrides.podName ?? `${overrides.jobName ?? 'yaac-proj-s1'}-abcde`,
    worktreeId: overrides.worktreeId ?? 's1',
    projectSlug: overrides.project ?? 'proj',
    tool: 'claude',
    phase: overrides.phase ?? (running ? 'Running' : 'Failed'),
    running,
    terminating: overrides.terminating ?? false,
    createdAtMs,
    labels: {},
  }
}

describe('classifyWorktreePods', () => {
  afterEach(() => _clearTerminatingForTests())

  it('puts running pods with live tmux into the running bucket', async () => {
    const p = pod({})
    const result = await classifyWorktreePods([p], now(), probe('alive'), GRACE_MS)
    expect(result.running).toEqual([p])
    expect(result.stale).toEqual([])
    expect(result.indeterminate).toEqual([])
  })

  it('still classifies prewarmed spares (the reaper must keep seeing them)', async () => {
    // listActiveWorktrees filters spares out, but the stale reaper relies on
    // classifyWorktreePods NOT special-casing them, so a stuck spare is reaped.
    const live = { ...pod({ jobName: 'yaac-proj-spare', worktreeId: 'sp1' }), labels: { 'yaac.prewarmed': 'true' } }
    const liveRes = await classifyWorktreePods([live], now(), probe('alive'), GRACE_MS)
    expect(liveRes.running).toEqual([live])

    const stuck = { ...pod({ jobName: 'yaac-proj-stuck', worktreeId: 'sp2', ageMs: GRACE_MS + 5_000 }), labels: { 'yaac.prewarmed': 'true' } }
    const stuckRes = await classifyWorktreePods([stuck], now(), probe('dead'), GRACE_MS)
    expect(stuckRes.stale).toEqual([
      {
        jobName: 'yaac-proj-stuck', projectSlug: 'proj', worktreeId: 'sp2', zombie: true,
        deathCause: { reason: 'agent-exited' },
      },
    ])
  })

  it('classifies old running pods with a conclusively dead tmux as zombie stale', async () => {
    const p = pod({ jobName: 'yaac-proj-zombie', worktreeId: 'z1' })
    const result = await classifyWorktreePods([p], now(), probe('dead'), GRACE_MS)
    expect(result.running).toEqual([])
    expect(result.stale).toEqual([
      {
        jobName: 'yaac-proj-zombie', projectSlug: 'proj', worktreeId: 'z1', zombie: true,
        deathCause: { reason: 'agent-exited' },
      },
    ])
  })

  it('keeps a running pod whose tmux probe is inconclusive (unknown) and never reaps it', async () => {
    // The false-positive guard: a transient kubectl-exec failure on a
    // healthy, long-running session must NOT trigger a reap.
    const p = pod({ jobName: 'yaac-proj-blip', worktreeId: 'b1', ageMs: GRACE_MS + 60_000 })
    const result = await classifyWorktreePods([p], now(), probe('unknown'), GRACE_MS)
    expect(result.running).toEqual([p])
    expect(result.stale).toEqual([])
    expect(result.indeterminate).toEqual([p])
  })

  it('classifies old non-running pods as non-zombie stale', async () => {
    const p = pod({ jobName: 'yaac-proj-dead', worktreeId: 'd1', running: false })
    const result = await classifyWorktreePods([p], now(), probe('alive'), GRACE_MS)
    expect(result.running).toEqual([])
    expect(result.stale).toEqual([
      {
        jobName: 'yaac-proj-dead', projectSlug: 'proj', worktreeId: 'd1', zombie: false,
        deathCause: { reason: 'pod-stopped' },
      },
    ])
  })

  // The death cause is derived from the pod's captured terminal state at
  // reap time — the last moment the evidence exists, since teardown deletes
  // the Job and pod. Each case below is a kubelet-reported shape.
  it.each([
    [
      'OOMKilled with an exit code',
      { containerReason: 'OOMKilled', exitCode: 137 },
      { reason: 'oom', detail: 'exit code 137' },
    ],
    [
      'OOMKilled without an exit code',
      { containerReason: 'OOMKilled' },
      { reason: 'oom' },
    ],
    [
      'a pod-level eviction, whose message is the detail',
      { podReason: 'Evicted', podMessage: 'The node was low on resource: memory.' },
      { reason: 'evicted', detail: 'The node was low on resource: memory.' },
    ],
    [
      'a container OOM verdict, preferred over a pod-level reason',
      { podReason: 'Evicted', containerReason: 'OOMKilled', exitCode: 137 },
      { reason: 'oom', detail: 'exit code 137' },
    ],
    [
      "a nonzero exit, dropping kubelet's redundant generic Error reason",
      { exitCode: 1, containerReason: 'Error' },
      { reason: 'crashed', detail: 'exit code 1' },
    ],
    [
      'a nonzero exit, keeping a non-generic container reason',
      { exitCode: 128, containerReason: 'ContainerCannotRun' },
      { reason: 'crashed', detail: 'exit code 128, ContainerCannotRun' },
    ],
    ['a clean exit', { exitCode: 0 }, { reason: 'pod-stopped' }],
    ['no terminal state at all', undefined, { reason: 'pod-stopped' }],
  ])('derives the death cause from %s', async (_what, terminal, expected) => {
    const p: PodInfo = {
      ...pod({ jobName: 'yaac-proj-dead', worktreeId: 'o1', running: false }),
      ...(terminal ? { terminal: terminal as PodTerminalState } : {}),
    }
    const result = await classifyWorktreePods([p], now(), probe('alive'), GRACE_MS)
    expect(result.stale[0].deathCause).toEqual(expected)
  })

  it('skips young running-but-no-tmux pods during the startup grace window', async () => {
    // Simulates session-create attempt N with the pod up but tmux
    // not yet started. Reaping this would clobber the proxy session.
    const p = pod({ jobName: 'yaac-proj-new', ageMs: GRACE_MS - 1_000 })
    const probeFn = vi.fn<(slug: string, worktreeId: string) => Promise<TmuxLiveness>>().mockResolvedValue('dead')
    const result = await classifyWorktreePods([p], now(), probeFn, GRACE_MS)
    expect(result.running).toEqual([])
    expect(result.stale).toEqual([])
  })

  it('skips young non-running pods so a retry can recreate them safely', async () => {
    // Simulates the window between attempt N dying and the retry loop
    // recreating the Job. The reaper must not race with it.
    const p = pod({ running: false, ageMs: GRACE_MS - 1_000 })
    const result = await classifyWorktreePods([p], now(), probe('alive'), GRACE_MS)
    expect(result.running).toEqual([])
    expect(result.stale).toEqual([])
  })

  it('reaps a pod that has been running with a dead tmux past the grace window', async () => {
    const p = pod({ jobName: 'yaac-proj-stuck', ageMs: GRACE_MS + 5_000 })
    const result = await classifyWorktreePods([p], now(), probe('dead'), GRACE_MS)
    expect(result.stale).toEqual([
      {
        jobName: 'yaac-proj-stuck', projectSlug: 'proj', worktreeId: 's1', zombie: true,
        deathCause: { reason: 'agent-exited' },
      },
    ])
  })

  it('does NOT reap a pod running past the grace window when the probe is unknown', async () => {
    const p = pod({ jobName: 'yaac-proj-stuck', ageMs: GRACE_MS + 5_000 })
    const result = await classifyWorktreePods([p], now(), probe('unknown'), GRACE_MS)
    expect(result.stale).toEqual([])
    expect(result.running).toEqual([p])
    expect(result.indeterminate).toEqual([p])
  })

  it('treats createdAtMs=0 (missing creationTimestamp) as old so legacy entries do not leak forever', async () => {
    const p = { ...pod({ running: false }), createdAtMs: 0 }
    const result = await classifyWorktreePods([p], now(), probe('alive'), GRACE_MS)
    expect(result.stale).toHaveLength(1)
    expect(result.stale[0].zombie).toBe(false)
  })

  it('tolerates empty labels — a pod without slug/session-id still becomes stale', async () => {
    const p = pod({ jobName: 'abc123', worktreeId: '', project: '', running: false })
    const result = await classifyWorktreePods([p], now(), probe('alive'), GRACE_MS)
    expect(result.stale).toEqual([
      {
        jobName: 'abc123', projectSlug: '', worktreeId: '', zombie: false,
        deathCause: { reason: 'pod-stopped' },
      },
    ])
  })

  it('passes (slug, worktreeId) from pod labels to the prober', async () => {
    const p = pod({ jobName: 'yaac-proj-s1', project: 'proj', worktreeId: 's1' })
    const probeFn = vi.fn<(slug: string, worktreeId: string) => Promise<TmuxLiveness>>().mockResolvedValue('alive')
    await classifyWorktreePods([p], now(), probeFn, GRACE_MS)
    expect(probeFn).toHaveBeenCalledWith('proj', 's1')
  })

  it('honors the graceMs argument', async () => {
    const p = pod({ running: false, ageMs: 500 })
    const zeroGrace = await classifyWorktreePods([p], now(), probe('alive'), 0)
    expect(zeroGrace.stale).toHaveLength(1)
    const largeGrace = await classifyWorktreePods([p], now(), probe('alive'), 10_000)
    expect(largeGrace.stale).toEqual([])
  })

  it('routes a pod with a deletionTimestamp to the terminating bucket, never stale', async () => {
    // Old enough to be stale and probe dead — but terminating wins, so it's
    // neither reaped nor shown as active.
    const p = pod({ jobName: 'yaac-proj-term', worktreeId: 't1', terminating: true, ageMs: GRACE_MS + 5_000 })
    const result = await classifyWorktreePods([p], now(), probe('dead'), GRACE_MS)
    expect(result.terminating).toEqual([p])
    expect(result.running).toEqual([])
    expect(result.stale).toEqual([])
  })

  it('routes a registry-marked session to terminating without probing it', async () => {
    markWorktreeTerminating('s1')
    const p = pod({ worktreeId: 's1' })
    const probeFn = vi.fn<(slug: string, worktreeId: string) => Promise<TmuxLiveness>>().mockResolvedValue('alive')
    const result = await classifyWorktreePods([p], now(), probeFn, GRACE_MS)
    expect(result.terminating).toEqual([p])
    expect(result.running).toEqual([])
    expect(probeFn).not.toHaveBeenCalled()
  })

  it('leaves the terminating bucket empty for ordinary pods', async () => {
    const result = await classifyWorktreePods([pod({})], now(), probe('alive'), GRACE_MS)
    expect(result.terminating).toEqual([])
  })
})
