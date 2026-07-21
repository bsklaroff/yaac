import { describe, it, expect, vi, afterEach } from 'vitest'
import { classifySessionPods } from '#features/sessions/list'
import { markSessionTerminating, _clearTerminatingForTests } from '#features/sessions/terminating'
import type { TmuxLiveness } from '#features/sessions/cleanup'
import type { SessionPod } from '#platform/k8s/pods'

/** Grace window passed explicitly — production callers use testEnv.startingGraceMs. */
const GRACE_MS = 60_000

const NOW = 1_800_000_000_000
const now = (): number => NOW

/** A constant tri-state prober, typed so it slots into classifySessionPods. */
const probe = (v: TmuxLiveness) =>
  (): Promise<TmuxLiveness> => Promise.resolve(v)

function pod(overrides: {
  jobName?: string
  podName?: string
  sessionId?: string
  project?: string
  running?: boolean
  terminating?: boolean
  phase?: string
  ageMs?: number
}): SessionPod {
  const createdAtMs = overrides.ageMs === undefined
    ? NOW - GRACE_MS - 1_000
    : NOW - overrides.ageMs
  const running = overrides.running ?? true
  return {
    jobName: overrides.jobName ?? 'yaac-proj-s1',
    podName: overrides.podName ?? `${overrides.jobName ?? 'yaac-proj-s1'}-abcde`,
    sessionId: overrides.sessionId ?? 's1',
    projectSlug: overrides.project ?? 'proj',
    tool: 'claude',
    phase: overrides.phase ?? (running ? 'Running' : 'Failed'),
    running,
    terminating: overrides.terminating ?? false,
    createdAtMs,
    labels: {},
  }
}

describe('classifySessionPods', () => {
  afterEach(() => _clearTerminatingForTests())

  it('puts running pods with live tmux into the running bucket', async () => {
    const p = pod({})
    const result = await classifySessionPods([p], now(), probe('alive'), GRACE_MS)
    expect(result.running).toEqual([p])
    expect(result.stale).toEqual([])
    expect(result.indeterminate).toEqual([])
  })

  it('still classifies prewarmed spares (the reaper must keep seeing them)', async () => {
    // listActiveSessions filters spares out, but the stale reaper relies on
    // classifySessionPods NOT special-casing them, so a stuck spare is reaped.
    const live = { ...pod({ jobName: 'yaac-proj-spare', sessionId: 'sp1' }), labels: { 'yaac.prewarmed': 'true' } }
    const liveRes = await classifySessionPods([live], now(), probe('alive'), GRACE_MS)
    expect(liveRes.running).toEqual([live])

    const stuck = { ...pod({ jobName: 'yaac-proj-stuck', sessionId: 'sp2', ageMs: GRACE_MS + 5_000 }), labels: { 'yaac.prewarmed': 'true' } }
    const stuckRes = await classifySessionPods([stuck], now(), probe('dead'), GRACE_MS)
    expect(stuckRes.stale).toEqual([
      {
        jobName: 'yaac-proj-stuck', projectSlug: 'proj', sessionId: 'sp2', zombie: true,
        deathCause: { reason: 'agent-exited' },
      },
    ])
  })

  it('classifies old running pods with a conclusively dead tmux as zombie stale', async () => {
    const p = pod({ jobName: 'yaac-proj-zombie', sessionId: 'z1' })
    const result = await classifySessionPods([p], now(), probe('dead'), GRACE_MS)
    expect(result.running).toEqual([])
    expect(result.stale).toEqual([
      {
        jobName: 'yaac-proj-zombie', projectSlug: 'proj', sessionId: 'z1', zombie: true,
        deathCause: { reason: 'agent-exited' },
      },
    ])
  })

  it('keeps a running pod whose tmux probe is inconclusive (unknown) and never reaps it', async () => {
    // The false-positive guard: a transient kubectl-exec failure on a
    // healthy, long-running session must NOT trigger a reap.
    const p = pod({ jobName: 'yaac-proj-blip', sessionId: 'b1', ageMs: GRACE_MS + 60_000 })
    const result = await classifySessionPods([p], now(), probe('unknown'), GRACE_MS)
    expect(result.running).toEqual([p])
    expect(result.stale).toEqual([])
    expect(result.indeterminate).toEqual([p])
  })

  it('classifies old non-running pods as non-zombie stale', async () => {
    const p = pod({ jobName: 'yaac-proj-dead', sessionId: 'd1', running: false })
    const result = await classifySessionPods([p], now(), probe('alive'), GRACE_MS)
    expect(result.running).toEqual([])
    expect(result.stale).toEqual([
      {
        jobName: 'yaac-proj-dead', projectSlug: 'proj', sessionId: 'd1', zombie: false,
        deathCause: { reason: 'pod-stopped' },
      },
    ])
  })

  it('derives the death cause from a stopped pod\'s terminal state', async () => {
    const p = {
      ...pod({ jobName: 'yaac-proj-oomed', sessionId: 'o1', running: false }),
      terminal: { containerReason: 'OOMKilled', exitCode: 137 },
    }
    const result = await classifySessionPods([p], now(), probe('alive'), GRACE_MS)
    expect(result.stale[0].deathCause).toEqual({ reason: 'oom', detail: 'exit code 137' })
  })

  it('skips young running-but-no-tmux pods during the startup grace window', async () => {
    // Simulates session-create attempt N with the pod up but tmux
    // not yet started. Reaping this would clobber the proxy session.
    const p = pod({ jobName: 'yaac-proj-new', ageMs: GRACE_MS - 1_000 })
    const probeFn = vi.fn<(slug: string, sessionId: string) => Promise<TmuxLiveness>>().mockResolvedValue('dead')
    const result = await classifySessionPods([p], now(), probeFn, GRACE_MS)
    expect(result.running).toEqual([])
    expect(result.stale).toEqual([])
  })

  it('skips young non-running pods so a retry can recreate them safely', async () => {
    // Simulates the window between attempt N dying and the retry loop
    // recreating the Job. The reaper must not race with it.
    const p = pod({ running: false, ageMs: GRACE_MS - 1_000 })
    const result = await classifySessionPods([p], now(), probe('alive'), GRACE_MS)
    expect(result.running).toEqual([])
    expect(result.stale).toEqual([])
  })

  it('reaps a pod that has been running with a dead tmux past the grace window', async () => {
    const p = pod({ jobName: 'yaac-proj-stuck', ageMs: GRACE_MS + 5_000 })
    const result = await classifySessionPods([p], now(), probe('dead'), GRACE_MS)
    expect(result.stale).toEqual([
      {
        jobName: 'yaac-proj-stuck', projectSlug: 'proj', sessionId: 's1', zombie: true,
        deathCause: { reason: 'agent-exited' },
      },
    ])
  })

  it('does NOT reap a pod running past the grace window when the probe is unknown', async () => {
    const p = pod({ jobName: 'yaac-proj-stuck', ageMs: GRACE_MS + 5_000 })
    const result = await classifySessionPods([p], now(), probe('unknown'), GRACE_MS)
    expect(result.stale).toEqual([])
    expect(result.running).toEqual([p])
    expect(result.indeterminate).toEqual([p])
  })

  it('treats createdAtMs=0 (missing creationTimestamp) as old so legacy entries do not leak forever', async () => {
    const p = { ...pod({ running: false }), createdAtMs: 0 }
    const result = await classifySessionPods([p], now(), probe('alive'), GRACE_MS)
    expect(result.stale).toHaveLength(1)
    expect(result.stale[0].zombie).toBe(false)
  })

  it('tolerates empty labels — a pod without slug/session-id still becomes stale', async () => {
    const p = pod({ jobName: 'abc123', sessionId: '', project: '', running: false })
    const result = await classifySessionPods([p], now(), probe('alive'), GRACE_MS)
    expect(result.stale).toEqual([
      {
        jobName: 'abc123', projectSlug: '', sessionId: '', zombie: false,
        deathCause: { reason: 'pod-stopped' },
      },
    ])
  })

  it('passes (slug, sessionId) from pod labels to the prober', async () => {
    const p = pod({ jobName: 'yaac-proj-s1', project: 'proj', sessionId: 's1' })
    const probeFn = vi.fn<(slug: string, sessionId: string) => Promise<TmuxLiveness>>().mockResolvedValue('alive')
    await classifySessionPods([p], now(), probeFn, GRACE_MS)
    expect(probeFn).toHaveBeenCalledWith('proj', 's1')
  })

  it('honors the graceMs argument', async () => {
    const p = pod({ running: false, ageMs: 500 })
    const zeroGrace = await classifySessionPods([p], now(), probe('alive'), 0)
    expect(zeroGrace.stale).toHaveLength(1)
    const largeGrace = await classifySessionPods([p], now(), probe('alive'), 10_000)
    expect(largeGrace.stale).toEqual([])
  })

  it('routes a pod with a deletionTimestamp to the terminating bucket, never stale', async () => {
    // Old enough to be stale and probe dead — but terminating wins, so it's
    // neither reaped nor shown as active.
    const p = pod({ jobName: 'yaac-proj-term', sessionId: 't1', terminating: true, ageMs: GRACE_MS + 5_000 })
    const result = await classifySessionPods([p], now(), probe('dead'), GRACE_MS)
    expect(result.terminating).toEqual([p])
    expect(result.running).toEqual([])
    expect(result.stale).toEqual([])
  })

  it('routes a registry-marked session to terminating without probing it', async () => {
    markSessionTerminating('s1')
    const p = pod({ sessionId: 's1' })
    const probeFn = vi.fn<(slug: string, sessionId: string) => Promise<TmuxLiveness>>().mockResolvedValue('alive')
    const result = await classifySessionPods([p], now(), probeFn, GRACE_MS)
    expect(result.terminating).toEqual([p])
    expect(result.running).toEqual([])
    expect(probeFn).not.toHaveBeenCalled()
  })

  it('leaves the terminating bucket empty for ordinary pods', async () => {
    const result = await classifySessionPods([pod({})], now(), probe('alive'), GRACE_MS)
    expect(result.terminating).toEqual([])
  })
})
