import { describe, it, expect, afterEach } from 'vitest'

import type { SessionPod, SessionPodTerminalState } from '#platform/k8s/pods'
import {
  normalizeTool,
  deriveDeathCause,
  TERMINATING_TTL_MS,
  markSessionTerminating,
  isSessionTerminating,
  clearSessionTerminating,
  pruneTerminating,
  _clearTerminatingForTests,
} from '#features/sessions/state'

// ---------------------------------------------------------------------------
// normalizeTool
// ---------------------------------------------------------------------------

describe('normalizeTool', () => {
  it('returns claude when the raw label is undefined', () => {
    expect(normalizeTool(undefined)).toBe('claude')
  })

  it('returns claude when the raw label is claude', () => {
    expect(normalizeTool('claude')).toBe('claude')
  })

  it('returns codex when the raw label is codex', () => {
    expect(normalizeTool('codex')).toBe('codex')
  })

  it('returns opencode when the raw label is opencode', () => {
    expect(normalizeTool('opencode')).toBe('opencode')
  })

  it('returns pi when the raw label is pi', () => {
    expect(normalizeTool('pi')).toBe('pi')
  })

  it('returns claude for an empty string', () => {
    expect(normalizeTool('')).toBe('claude')
  })

  it('returns claude for unknown tool values', () => {
    expect(normalizeTool('unknown')).toBe('claude')
  })
})

// ---------------------------------------------------------------------------
// deriveDeathCause
// ---------------------------------------------------------------------------

function deathPod(terminal?: SessionPodTerminalState): SessionPod {
  return {
    jobName: 'yaac-demo-s1',
    podName: 'yaac-demo-s1-x1',
    sessionId: 's1',
    projectSlug: 'demo',
    tool: 'claude',
    phase: 'Failed',
    running: false,
    terminating: false,
    createdAtMs: 0,
    labels: {},
    ...(terminal ? { terminal } : {}),
  }
}

describe('deriveDeathCause', () => {
  it('maps OOMKilled to oom with the exit code as detail', () => {
    expect(deriveDeathCause(deathPod({ containerReason: 'OOMKilled', exitCode: 137 })))
      .toEqual({ reason: 'oom', detail: 'exit code 137' })
  })

  it('maps OOMKilled without an exit code to bare oom', () => {
    expect(deriveDeathCause(deathPod({ containerReason: 'OOMKilled' })))
      .toEqual({ reason: 'oom' })
  })

  it('maps pod-level Evicted to evicted with the message as detail', () => {
    expect(deriveDeathCause(deathPod({
      podReason: 'Evicted',
      podMessage: 'The node was low on resource: memory.',
    }))).toEqual({ reason: 'evicted', detail: 'The node was low on resource: memory.' })
  })

  it('prefers the container OOM verdict over a pod-level reason', () => {
    expect(deriveDeathCause(deathPod({
      podReason: 'Evicted',
      containerReason: 'OOMKilled',
      exitCode: 137,
    }))).toEqual({ reason: 'oom', detail: 'exit code 137' })
  })

  it('maps a nonzero exit to crashed, dropping the redundant Error reason', () => {
    expect(deriveDeathCause(deathPod({ exitCode: 1, containerReason: 'Error' })))
      .toEqual({ reason: 'crashed', detail: 'exit code 1' })
  })

  it('keeps a non-generic container reason on a crash', () => {
    expect(deriveDeathCause(deathPod({ exitCode: 128, containerReason: 'ContainerCannotRun' })))
      .toEqual({ reason: 'crashed', detail: 'exit code 128, ContainerCannotRun' })
  })

  it('maps a clean exit to pod-stopped', () => {
    expect(deriveDeathCause(deathPod({ exitCode: 0 })))
      .toEqual({ reason: 'pod-stopped' })
  })

  it('maps a pod with no terminal state to pod-stopped', () => {
    expect(deriveDeathCause(deathPod())).toEqual({ reason: 'pod-stopped' })
  })
})

// ---------------------------------------------------------------------------
// Terminating registry
// ---------------------------------------------------------------------------

describe('terminating registry', () => {
  afterEach(() => _clearTerminatingForTests())

  it('marks and reports a session as terminating', () => {
    expect(isSessionTerminating('s1')).toBe(false)
    markSessionTerminating('s1')
    expect(isSessionTerminating('s1')).toBe(true)
  })

  it('ignores an empty session id', () => {
    markSessionTerminating('')
    expect(isSessionTerminating('')).toBe(false)
  })

  it('marking is idempotent and preserves the original timestamp for the TTL', () => {
    markSessionTerminating('s1', 1_000)
    markSessionTerminating('s1', 5_000) // ignored — first mark wins
    // Still within TTL of the FIRST mark at t=1_000.
    pruneTerminating(new Set(['s1']), 1_000 + TERMINATING_TTL_MS)
    expect(isSessionTerminating('s1')).toBe(true)
    // Just past the TTL of the first mark → pruned.
    pruneTerminating(new Set(['s1']), 1_000 + TERMINATING_TTL_MS + 1)
    expect(isSessionTerminating('s1')).toBe(false)
  })

  it('clearSessionTerminating drops a mark (id reuse on restart)', () => {
    markSessionTerminating('s1')
    clearSessionTerminating('s1')
    expect(isSessionTerminating('s1')).toBe(false)
  })

  it('pruneTerminating forgets a mark whose pod is gone', () => {
    markSessionTerminating('s1', 1_000)
    markSessionTerminating('s2', 1_000)
    // s1's pod vanished (teardown finished); s2 still present.
    pruneTerminating(new Set(['s2']), 2_000)
    expect(isSessionTerminating('s1')).toBe(false)
    expect(isSessionTerminating('s2')).toBe(true)
  })

  it('pruneTerminating forgets a mark past the TTL even if the pod lingers', () => {
    markSessionTerminating('s1', 1_000)
    // A failed teardown: the pod is still live but the mark has aged out.
    pruneTerminating(new Set(['s1']), 1_000 + TERMINATING_TTL_MS + 1)
    expect(isSessionTerminating('s1')).toBe(false)
  })
})
