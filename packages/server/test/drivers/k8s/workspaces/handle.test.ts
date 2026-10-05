import { describe, it, expect } from 'vitest'
import { runtimeHandleFromPod } from '#drivers/k8s/workspaces'
import type { PodInfo } from '#drivers/k8s/substrate/pods'

const NOW = 1_800_000_000_000

function pod(overrides: Partial<PodInfo> = {}): PodInfo {
  return {
    jobName: 'yaac-proj-s1',
    podName: 'yaac-proj-s1-abcde',
    workspaceId: 's1',
    projectSlug: 'proj',
    projectId: '3f2a9c1e-7b4d-4e8a-9c2f-5d6e7f8a9b0c',
    tool: 'claude',
    phase: 'Running',
    running: true,
    terminating: false,
    createdAtMs: NOW,
    labels: {},
    ...overrides,
  }
}

describe('runtimeHandleFromPod', () => {
  it('describes a running pod in contract vocabulary', () => {
    expect(runtimeHandleFromPod(pod())).toEqual({
      workspaceId: 's1',
      projectSlug: 'proj',
      jobName: 'yaac-proj-s1',
      tool: 'claude',
      declaredTool: 'claude',
      mode: 'tui',
      running: true,
      state: 'running',
      labels: {},
      createdAtMs: NOW,
      prewarmed: false,
      terminating: false,
      deathCause: { reason: 'pod-stopped' },
    })
  })

  it('reports a stopped pod by its lowercased phase', () => {
    const h = runtimeHandleFromPod(pod({ running: false, phase: 'Failed' }))
    expect(h.state).toBe('failed')
    expect(h.running).toBe(false)
  })

  it('normalizes the tool and mode labels, so nothing above reads raw strings', () => {
    expect(runtimeHandleFromPod(pod({ mode: 'acp' })).mode).toBe('acp')
    // Anything that isn't `acp` is the tmux-driven default, including absent.
    expect(runtimeHandleFromPod(pod({ mode: 'nonsense' })).mode).toBe('tui')
    expect(runtimeHandleFromPod(pod({ mode: undefined })).mode).toBe('tui')
    expect(runtimeHandleFromPod(pod({ tool: 'not-a-tool' })).tool).toBe('claude')
  })

  // A guessed tool would override the server's default for workspaces
  // spawned from this one, so an unknown label yields no tool.
  it('declares no tool when the pod is stamped with one this build does not know', () => {
    const h = runtimeHandleFromPod(pod({ tool: 'not-a-tool' }))
    expect(h.tool).toBe('claude')
    expect(h.declaredTool).toBeUndefined()
  })

  it('reads the prewarm label, so a spare is one by its own account', () => {
    expect(runtimeHandleFromPod(pod({ labels: { 'yaac.prewarmed': 'true' } })).prewarmed).toBe(true)
    expect(runtimeHandleFromPod(pod()).prewarmed).toBe(false)
  })

  it('carries the terminating mark through', () => {
    expect(runtimeHandleFromPod(pod({ terminating: true })).terminating).toBe(true)
  })

  // The death reason is derived from the pod's terminal state. Each case is
  // a shape kubelet actually reports.
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
  ])('derives the death cause from %s', (_what, terminal, expected) => {
    const p = pod({
      running: false,
      ...(terminal ? { terminal: terminal } : {}),
    })
    expect(runtimeHandleFromPod(p).deathCause).toEqual(expected)
  })
})
