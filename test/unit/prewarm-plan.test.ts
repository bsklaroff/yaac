import { describe, it, expect, vi } from 'vitest'

// prewarm.ts pulls these heavy modules in transitively; the pure planner +
// isPrewarmed never touch them, so stub them out to keep the test light.
vi.mock('@yaac/server/session-create', () => ({ shellEscape: (s: string) => s }))
vi.mock('@yaac/server/lib/session/cleanup', () => ({ isTmuxSessionAlive: vi.fn() }))

import { computePrewarmPlan } from '@yaac/server/prewarm'
import { LABEL_PREWARMED, isPrewarmed, type SessionPod } from '@yaac/server/lib/k8s/pods'
import type { AgentTool } from '@yaac/shared/types'

function pod(o: Partial<SessionPod> & { prewarmed?: boolean } = {}): SessionPod {
  const { prewarmed, labels, ...rest } = o
  return {
    jobName: 'yaac-p-s1',
    podName: 'yaac-p-s1-x',
    sessionId: 's1',
    projectSlug: 'p',
    tool: 'claude',
    phase: 'Running',
    running: true,
    createdAtMs: 1_000,
    labels: labels ?? (prewarmed ? { [LABEL_PREWARMED]: 'true' } : {}),
    ...rest,
  }
}

const CLAUDE: AgentTool = 'claude'

describe('isPrewarmed', () => {
  it('is true only when the label is exactly "true"', () => {
    expect(isPrewarmed(pod({ prewarmed: true }))).toBe(true)
    expect(isPrewarmed(pod({}))).toBe(false)
    expect(isPrewarmed(pod({ labels: { [LABEL_PREWARMED]: 'false' } }))).toBe(false)
  })
})

describe('computePrewarmPlan', () => {
  const empty = (): Map<string, number> => new Map()
  const noClaim = (): Set<string> => new Set()

  it('returns nothing for an empty cluster', () => {
    expect(computePrewarmPlan([], 1, CLAUDE, empty(), noClaim())).toEqual({ toSpawn: [], toReap: [] })
  })

  it('spawns one spare for an active project with no spare', () => {
    const pods = [pod({ jobName: 'yaac-p-real', sessionId: 'r1' })]
    const plan = computePrewarmPlan(pods, 1, CLAUDE, empty(), noClaim())
    expect(plan.toSpawn).toEqual([{ projectSlug: 'p', tool: CLAUDE }])
    expect(plan.toReap).toEqual([])
  })

  it('is a no-op when the spare already exists', () => {
    const pods = [
      pod({ jobName: 'yaac-p-real', sessionId: 'r1' }),
      pod({ jobName: 'yaac-p-spare', sessionId: 's2', prewarmed: true }),
    ]
    expect(computePrewarmPlan(pods, 1, CLAUDE, empty(), noClaim())).toEqual({ toSpawn: [], toReap: [] })
  })

  it('refills when the only spare is being claimed (excluded from the count)', () => {
    const pods = [
      pod({ jobName: 'yaac-p-real', sessionId: 'r1' }),
      pod({ jobName: 'yaac-p-spare', sessionId: 's2', prewarmed: true }),
    ]
    const claiming = new Set(['yaac-p-spare'])
    const plan = computePrewarmPlan(pods, 1, CLAUDE, empty(), claiming)
    expect(plan.toSpawn).toEqual([{ projectSlug: 'p', tool: CLAUDE }])
    // the claiming spare must never be a reap target
    expect(plan.toReap).toEqual([])
  })

  it('does not spawn while a spawn is in flight', () => {
    const pods = [pod({ jobName: 'yaac-p-real', sessionId: 'r1' })]
    const plan = computePrewarmPlan(pods, 1, CLAUDE, new Map([['p', 1]]), noClaim())
    expect(plan.toSpawn).toEqual([])
  })

  it('counts a still-pending spare toward the pool (no over-spawn)', () => {
    const pods = [
      pod({ jobName: 'yaac-p-real', sessionId: 'r1' }),
      pod({ jobName: 'yaac-p-spare', sessionId: 's2', prewarmed: true, running: false, phase: 'Pending' }),
    ]
    expect(computePrewarmPlan(pods, 1, CLAUDE, empty(), noClaim())).toEqual({ toSpawn: [], toReap: [] })
  })

  it('reaps a spare for an idle project (0 claimed sessions)', () => {
    const pods = [pod({ jobName: 'yaac-p-spare', sessionId: 's2', prewarmed: true })]
    const plan = computePrewarmPlan(pods, 1, CLAUDE, empty(), noClaim())
    expect(plan.toSpawn).toEqual([])
    expect(plan.toReap).toEqual([{ jobName: 'yaac-p-spare', projectSlug: 'p', sessionId: 's2' }])
  })

  it('keeps a wrong-tool spare in the pool (tool-agnostic; retooled at claim time)', () => {
    const pods = [
      pod({ jobName: 'yaac-p-real', sessionId: 'r1' }),
      pod({ jobName: 'yaac-p-codex', sessionId: 's2', tool: 'codex', prewarmed: true }),
    ]
    expect(computePrewarmPlan(pods, 1, CLAUDE, empty(), noClaim())).toEqual({ toSpawn: [], toReap: [] })
  })

  it('spawns poolSize spares when the pool is larger', () => {
    const pods = [pod({ jobName: 'yaac-p-real', sessionId: 'r1' })]
    const plan = computePrewarmPlan(pods, 2, CLAUDE, empty(), noClaim())
    expect(plan.toSpawn).toEqual([
      { projectSlug: 'p', tool: CLAUDE },
      { projectSlug: 'p', tool: CLAUDE },
    ])
  })

  it('reaps the oldest excess spare when the pool size is lowered', () => {
    const pods = [
      pod({ jobName: 'yaac-p-real', sessionId: 'r1' }),
      pod({ jobName: 'yaac-p-old', sessionId: 'old', prewarmed: true, createdAtMs: 1_000 }),
      pod({ jobName: 'yaac-p-new', sessionId: 'new', prewarmed: true, createdAtMs: 9_000 }),
    ]
    const plan = computePrewarmPlan(pods, 1, CLAUDE, empty(), noClaim())
    expect(plan.toSpawn).toEqual([])
    expect(plan.toReap).toEqual([{ jobName: 'yaac-p-old', projectSlug: 'p', sessionId: 'old' }])
  })

  it('handles multiple projects independently', () => {
    const pods = [
      pod({ jobName: 'yaac-a-real', sessionId: 'a1', projectSlug: 'a' }),
      pod({ jobName: 'yaac-a-spare', sessionId: 'a2', projectSlug: 'a', prewarmed: true }),
      pod({ jobName: 'yaac-b-real', sessionId: 'b1', projectSlug: 'b' }),
    ]
    const plan = computePrewarmPlan(pods, 1, CLAUDE, empty(), noClaim())
    expect(plan.toSpawn).toEqual([{ projectSlug: 'b', tool: CLAUDE }])
    expect(plan.toReap).toEqual([])
  })
})
