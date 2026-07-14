import { describe, it, expect } from 'vitest'
import { deriveDeathCause } from '#lib/session/death-reason'
import type { SessionPod, SessionPodTerminalState } from '#lib/k8s/pods'

function pod(terminal?: SessionPodTerminalState): SessionPod {
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
    expect(deriveDeathCause(pod({ containerReason: 'OOMKilled', exitCode: 137 })))
      .toEqual({ reason: 'oom', detail: 'exit code 137' })
  })

  it('maps OOMKilled without an exit code to bare oom', () => {
    expect(deriveDeathCause(pod({ containerReason: 'OOMKilled' })))
      .toEqual({ reason: 'oom' })
  })

  it('maps pod-level Evicted to evicted with the message as detail', () => {
    expect(deriveDeathCause(pod({
      podReason: 'Evicted',
      podMessage: 'The node was low on resource: memory.',
    }))).toEqual({ reason: 'evicted', detail: 'The node was low on resource: memory.' })
  })

  it('prefers the container OOM verdict over a pod-level reason', () => {
    expect(deriveDeathCause(pod({
      podReason: 'Evicted',
      containerReason: 'OOMKilled',
      exitCode: 137,
    }))).toEqual({ reason: 'oom', detail: 'exit code 137' })
  })

  it('maps a nonzero exit to crashed, dropping the redundant Error reason', () => {
    expect(deriveDeathCause(pod({ exitCode: 1, containerReason: 'Error' })))
      .toEqual({ reason: 'crashed', detail: 'exit code 1' })
  })

  it('keeps a non-generic container reason on a crash', () => {
    expect(deriveDeathCause(pod({ exitCode: 128, containerReason: 'ContainerCannotRun' })))
      .toEqual({ reason: 'crashed', detail: 'exit code 128, ContainerCannotRun' })
  })

  it('maps a clean exit to pod-stopped', () => {
    expect(deriveDeathCause(pod({ exitCode: 0 })))
      .toEqual({ reason: 'pod-stopped' })
  })

  it('maps a pod with no terminal state to pod-stopped', () => {
    expect(deriveDeathCause(pod())).toEqual({ reason: 'pod-stopped' })
  })
})
