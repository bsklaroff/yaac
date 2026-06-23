import { describe, it, expect, vi, afterEach } from 'vitest'
import { classifySessionPods, resolveStartingGraceMs, STARTING_GRACE_MS } from '@/lib/session/list'
import type { SessionPod } from '@/lib/k8s/pods'

const NOW = 1_800_000_000_000
const now = (): number => NOW

function pod(overrides: {
  jobName?: string
  podName?: string
  sessionId?: string
  project?: string
  running?: boolean
  phase?: string
  ageMs?: number
}): SessionPod {
  const createdAtMs = overrides.ageMs === undefined
    ? NOW - STARTING_GRACE_MS - 1_000
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
    createdAtMs,
    labels: {},
  }
}

describe('classifySessionPods', () => {
  it('puts running pods with live tmux into the running bucket', async () => {
    const p = pod({})
    const result = await classifySessionPods([p], now(), () => Promise.resolve(true))
    expect(result.running).toEqual([p])
    expect(result.stale).toEqual([])
  })

  it('still classifies prewarmed spares (the reaper must keep seeing them)', async () => {
    // listActiveSessions filters spares out, but the stale reaper relies on
    // classifySessionPods NOT special-casing them, so a stuck spare is reaped.
    const live = { ...pod({ jobName: 'yaac-proj-spare', sessionId: 'sp1' }), labels: { 'yaac.prewarmed': 'true' } }
    const liveRes = await classifySessionPods([live], now(), () => Promise.resolve(true))
    expect(liveRes.running).toEqual([live])

    const stuck = { ...pod({ jobName: 'yaac-proj-stuck', sessionId: 'sp2', ageMs: STARTING_GRACE_MS + 5_000 }), labels: { 'yaac.prewarmed': 'true' } }
    const stuckRes = await classifySessionPods([stuck], now(), () => Promise.resolve(false))
    expect(stuckRes.stale).toEqual([
      { jobName: 'yaac-proj-stuck', projectSlug: 'proj', sessionId: 'sp2', zombie: true },
    ])
  })

  it('classifies old running-but-no-tmux pods as zombie stale', async () => {
    const p = pod({ jobName: 'yaac-proj-zombie', sessionId: 'z1' })
    const result = await classifySessionPods([p], now(), () => Promise.resolve(false))
    expect(result.running).toEqual([])
    expect(result.stale).toEqual([
      { jobName: 'yaac-proj-zombie', projectSlug: 'proj', sessionId: 'z1', zombie: true },
    ])
  })

  it('classifies old non-running pods as non-zombie stale', async () => {
    const p = pod({ jobName: 'yaac-proj-dead', sessionId: 'd1', running: false })
    const result = await classifySessionPods([p], now(), () => Promise.resolve(true))
    expect(result.running).toEqual([])
    expect(result.stale).toEqual([
      { jobName: 'yaac-proj-dead', projectSlug: 'proj', sessionId: 'd1', zombie: false },
    ])
  })

  it('skips young running-but-no-tmux pods during the startup grace window', async () => {
    // Simulates session-create attempt N with the pod up but tmux
    // not yet started. Reaping this would clobber the proxy session.
    const p = pod({ jobName: 'yaac-proj-new', ageMs: STARTING_GRACE_MS - 1_000 })
    const isTmuxAlive = vi.fn().mockResolvedValue(false)
    const result = await classifySessionPods([p], now(), isTmuxAlive)
    expect(result.running).toEqual([])
    expect(result.stale).toEqual([])
  })

  it('skips young non-running pods so a retry can recreate them safely', async () => {
    // Simulates the window between attempt N dying and the retry loop
    // recreating the Job. The reaper must not race with it.
    const p = pod({ running: false, ageMs: STARTING_GRACE_MS - 1_000 })
    const result = await classifySessionPods([p], now(), () => Promise.resolve(true))
    expect(result.running).toEqual([])
    expect(result.stale).toEqual([])
  })

  it('reaps a pod that has been running without tmux past the grace window', async () => {
    const p = pod({ jobName: 'yaac-proj-stuck', ageMs: STARTING_GRACE_MS + 5_000 })
    const result = await classifySessionPods([p], now(), () => Promise.resolve(false))
    expect(result.stale).toEqual([
      { jobName: 'yaac-proj-stuck', projectSlug: 'proj', sessionId: 's1', zombie: true },
    ])
  })

  it('treats createdAtMs=0 (missing creationTimestamp) as old so legacy entries do not leak forever', async () => {
    const p = { ...pod({ running: false }), createdAtMs: 0 }
    const result = await classifySessionPods([p], now(), () => Promise.resolve(true))
    expect(result.stale).toHaveLength(1)
    expect(result.stale[0].zombie).toBe(false)
  })

  it('tolerates empty labels — a pod without slug/session-id still becomes stale', async () => {
    const p = pod({ jobName: 'abc123', sessionId: '', project: '', running: false })
    const result = await classifySessionPods([p], now(), () => Promise.resolve(true))
    expect(result.stale).toEqual([
      { jobName: 'abc123', projectSlug: '', sessionId: '', zombie: false },
    ])
  })

  it('passes (slug, sessionId) from pod labels to isTmuxAlive', async () => {
    const p = pod({ jobName: 'yaac-proj-s1', project: 'proj', sessionId: 's1' })
    const isTmuxAlive = vi.fn().mockResolvedValue(true)
    await classifySessionPods([p], now(), isTmuxAlive)
    expect(isTmuxAlive).toHaveBeenCalledWith('proj', 's1')
  })

  it('honors an explicit graceMs override', async () => {
    const p = pod({ running: false, ageMs: 500 })
    const zeroGrace = await classifySessionPods([p], now(), () => Promise.resolve(true), 0)
    expect(zeroGrace.stale).toHaveLength(1)
    const largeGrace = await classifySessionPods([p], now(), () => Promise.resolve(true), 10_000)
    expect(largeGrace.stale).toEqual([])
  })
})

describe('resolveStartingGraceMs', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('returns the default when YAAC_STARTING_GRACE_MS is unset', () => {
    vi.stubEnv('YAAC_STARTING_GRACE_MS', '')
    expect(resolveStartingGraceMs()).toBe(STARTING_GRACE_MS)
  })

  it('returns the parsed env value when set', () => {
    vi.stubEnv('YAAC_STARTING_GRACE_MS', '0')
    expect(resolveStartingGraceMs()).toBe(0)
    vi.stubEnv('YAAC_STARTING_GRACE_MS', '2500')
    expect(resolveStartingGraceMs()).toBe(2500)
  })

  it('falls back to the default for unparseable or negative values', () => {
    vi.stubEnv('YAAC_STARTING_GRACE_MS', 'not-a-number')
    expect(resolveStartingGraceMs()).toBe(STARTING_GRACE_MS)
    vi.stubEnv('YAAC_STARTING_GRACE_MS', '-5')
    expect(resolveStartingGraceMs()).toBe(STARTING_GRACE_MS)
  })
})
