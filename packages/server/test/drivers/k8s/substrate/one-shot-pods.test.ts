import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('#drivers/k8s/substrate/kubectl', () => ({
  isKubectlAbsentError: vi.fn(() => false),
  kubectlErrorSummary: vi.fn((e: unknown) => String(e)),
  dataDirHash: vi.fn(() => 'ddh0123456789abc'),
  k8sNamespace: vi.fn(() => 'test-ns'),
  kubectlApply: vi.fn().mockResolvedValue(undefined),
  kubectlGetJson: vi.fn(),
  kubectlWithRetry: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
}))

/** The API server's watch stream, faked at the client library. */
interface FakeWatch {
  path: string
  query: Record<string, unknown>
  emit: (type: string, obj: unknown) => void
  aborted: boolean
}
const watches = vi.hoisted(() => [] as FakeWatch[])
vi.mock('@kubernetes/client-node', async (importOriginal) => ({
  ...await importOriginal<typeof clientNode>(),
  Watch: class {
    watch(
      path: string,
      query: Record<string, unknown>,
      onEvent: (type: string, obj: unknown) => void,
    ): Promise<{ abort: () => void }> {
      const w: FakeWatch = { path, query, emit: onEvent, aborted: false }
      watches.push(w)
      return Promise.resolve({ abort: () => { w.aborted = true } })
    }
  },
}))

import type * as clientNode from '@kubernetes/client-node'
import { runOnEachNode, runPodToCompletion } from '#drivers/k8s/substrate'
import { PRIORITY_CLASS_INFRA } from '#drivers/k8s/substrate/priority-classes'
import { kubectlApply, kubectlGetJson, kubectlWithRetry } from '#drivers/k8s/substrate/kubectl'

const mockGetJson = vi.mocked(kubectlGetJson)

beforeEach(() => {
  watches.length = 0
})

describe('runPodToCompletion', () => {
  const MANIFEST = {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: { name: 'yaac-oneshot', namespace: 'test-ns' },
    spec: { restartPolicy: 'Never' },
  }
  const mockApply = vi.mocked(kubectlApply)
  const mockRetry = vi.mocked(kubectlWithRetry)

  beforeEach(() => {
    mockApply.mockReset()
    mockApply.mockResolvedValue(undefined)
    mockRetry.mockReset()
    mockRetry.mockResolvedValue({ stdout: '', stderr: '' })
    mockGetJson.mockReset()
  })

  it('deletes any stray namesake, applies, reads Succeeded, and returns the logs', async () => {
    mockGetJson.mockResolvedValue({ status: { phase: 'Succeeded' } })
    mockRetry.mockImplementation((args: string[]) =>
      Promise.resolve({ stdout: args[0] === 'logs' ? 'hello\n' : '', stderr: '' }))

    await expect(runPodToCompletion(MANIFEST, { timeoutMs: 5_000 }))
      .resolves.toEqual({ phase: 'Succeeded', logs: 'hello\n' })

    // Stray delete before the apply, cleanup delete after the logs.
    const retryCalls = mockRetry.mock.calls.map((c) => c[0])
    expect(retryCalls[0]).toEqual(
      ['delete', 'pod', 'yaac-oneshot', '-n', 'test-ns', '--ignore-not-found'])
    expect(retryCalls.at(-2)).toEqual(['logs', 'yaac-oneshot', '-n', 'test-ns'])
    expect(retryCalls.at(-1)).toEqual(
      ['delete', 'pod', 'yaac-oneshot', '-n', 'test-ns', '--ignore-not-found'])
    expect(mockApply).toHaveBeenCalledWith(MANIFEST)
    expect(mockGetJson).toHaveBeenCalledWith(
      ['get', 'pod', 'yaac-oneshot', '-n', 'test-ns'])
  })

  it('returns Failed immediately (with logs) instead of burning the timeout', async () => {
    mockGetJson.mockResolvedValue({ status: { phase: 'Failed' } })
    mockRetry.mockImplementation((args: string[]) =>
      Promise.resolve({ stdout: args[0] === 'logs' ? 'boom\n' : '', stderr: '' }))
    const start = Date.now()
    await expect(runPodToCompletion(MANIFEST, { timeoutMs: 60_000 }))
      .resolves.toEqual({ phase: 'Failed', logs: 'boom\n' })
    expect(Date.now() - start).toBeLessThan(5_000)
    expect(mockGetJson).toHaveBeenCalledTimes(1)
  })

  it('fails fast with phase Deleted when the pod vanishes after apply', async () => {
    // The pod was deleted after apply, so the wait stops at once.
    mockGetJson.mockResolvedValue(null)
    const start = Date.now()
    await expect(runPodToCompletion(MANIFEST, { timeoutMs: 60_000 }))
      .resolves.toEqual({ phase: 'Deleted', logs: '' })
    expect(Date.now() - start).toBeLessThan(5_000)
    expect(mockGetJson).toHaveBeenCalledTimes(1)
    expect(mockRetry.mock.calls.map((c) => c[0]).at(-1)).toEqual(
      ['delete', 'pod', 'yaac-oneshot', '-n', 'test-ns', '--ignore-not-found'])
  })

  it('returns the last seen phase when the deadline passes without a terminal one', async () => {
    mockGetJson.mockResolvedValue({ status: { phase: 'Pending' } })
    const { phase } = await runPodToCompletion(MANIFEST, { timeoutMs: 5 })
    expect(phase).toBe('Pending')
    expect(mockRetry.mock.calls.map((c) => c[0]).at(-1)).toEqual(
      ['delete', 'pod', 'yaac-oneshot', '-n', 'test-ns', '--ignore-not-found'])
  })

  it('routes kubectl and apply through the injected seams when provided', async () => {
    mockGetJson.mockResolvedValue({ status: { phase: 'Succeeded' } })
    const kubectl = vi.fn((args: string[]) =>
      Promise.resolve({ stdout: args[0] === 'logs' ? 'via-seam\n' : '' }))
    const apply = vi.fn().mockResolvedValue(undefined)

    await expect(runPodToCompletion(MANIFEST, { timeoutMs: 5_000, kubectl, apply }))
      .resolves.toEqual({ phase: 'Succeeded', logs: 'via-seam\n' })
    expect(apply).toHaveBeenCalledWith(MANIFEST)
    expect(kubectl).toHaveBeenCalledWith(
      ['delete', 'pod', 'yaac-oneshot', '-n', 'test-ns', '--ignore-not-found'])
    expect(mockApply).not.toHaveBeenCalled()
    expect(mockRetry).not.toHaveBeenCalled()
  })

  it('swallows logs failures ("" logs) but still deletes the pod', async () => {
    mockGetJson.mockResolvedValue({ status: { phase: 'Succeeded' } })
    mockRetry.mockImplementation((args: string[]) =>
      args[0] === 'logs'
        ? Promise.reject(new Error('container not found'))
        : Promise.resolve({ stdout: '', stderr: '' }))
    await expect(runPodToCompletion(MANIFEST, { timeoutMs: 5_000 }))
      .resolves.toEqual({ phase: 'Succeeded', logs: '' })
  })

  it('propagates apply failures after best-effort cleanup', async () => {
    mockApply.mockRejectedValue(new Error('admission denied'))
    await expect(runPodToCompletion(MANIFEST, { timeoutMs: 5_000 }))
      .rejects.toThrow('admission denied')
    // Stray delete and cleanup delete around the failed apply.
    expect(mockRetry.mock.calls.filter((c) => c[0][0] === 'delete')).toHaveLength(2)
  })

  it('follows a running pod through a watch from its resourceVersion', async () => {
    mockGetJson.mockResolvedValue({ metadata: { resourceVersion: '7' }, status: { phase: 'Running' } })
    const run = runPodToCompletion(MANIFEST, { timeoutMs: 60_000 })
    await vi.waitFor(() => expect(watches).toHaveLength(1))
    expect(watches[0].path).toBe('/api/v1/namespaces/test-ns/pods')
    expect(watches[0].query).toEqual({ fieldSelector: 'metadata.name=yaac-oneshot', resourceVersion: '7' })
    watches[0].emit('MODIFIED', { status: { phase: 'Running' } })
    watches[0].emit('MODIFIED', { metadata: { uid: 'u-1' }, status: { phase: 'Succeeded' } })
    // The uid names this run's pod, for reading its events.
    expect(await run).toMatchObject({ phase: 'Succeeded', uid: 'u-1' })
    expect(mockGetJson).toHaveBeenCalledTimes(1)
    expect(watches[0].aborted).toBe(true)
  })

  // An ERROR event (e.g. 410 Gone) carries a Status, not a pod.
  it('re-lists after a watch error instead of reading it as the pod', async () => {
    mockGetJson
      .mockResolvedValueOnce({ metadata: { resourceVersion: '7' }, status: { phase: 'Running' } })
      .mockResolvedValue({ status: { phase: 'Succeeded' } })
    const run = runPodToCompletion(MANIFEST, { timeoutMs: 60_000 })
    await vi.waitFor(() => expect(watches).toHaveLength(1))
    watches[0].emit('ERROR', { kind: 'Status', code: 410 })
    expect((await run).phase).toBe('Succeeded')
    expect(mockGetJson).toHaveBeenCalledTimes(2)
  })
})

describe('runOnEachNode', () => {
  const mockApply = vi.mocked(kubectlApply)
  const mockRetry = vi.mocked(kubectlWithRetry)
  const LABELS = { app: 'yaac-thing', 'yaac.thing-hash': 'h1' }

  beforeEach(() => {
    mockApply.mockReset().mockResolvedValue(undefined)
    mockRetry.mockReset().mockImplementation((args: string[]) =>
      Promise.resolve({ stdout: args[0] === 'logs' ? 'done\n' : '', stderr: '' }))
    mockGetJson.mockReset().mockImplementation((args: string[]) => Promise.resolve(args[1] === 'nodes'
      ? {
          items: [
            { metadata: { name: 'n1' }, status: { images: [{ names: ['a:1', 'a@sha'] }] } },
            { metadata: { name: 'n2' } },
          ],
        }
      : { status: { phase: args[2].includes('-1-') ? 'Failed' : 'Succeeded' } }))
  })

  it('deletes strays by label, then runs one pinned, tolerant pod per node in turn', async () => {
    const seen: string[][][] = []
    const runs = await runOnEachNode({
      name: 'yaac-thing',
      labels: LABELS,
      timeoutMs: 60_000,
      pod: (node) => {
        seen.push(node.images)
        return {
          image: 'img@sha256:x',
          command: ['sh', '-c', 'true'],
          container: { securityContext: { runAsUser: 0 } },
          spec: { hostPID: true },
        }
      },
    })

    expect(mockRetry.mock.calls[0][0]).toEqual(
      ['delete', 'pod', '-l', 'app=yaac-thing,yaac.thing-hash=h1', '-n', 'test-ns', '--ignore-not-found', '--wait=false'])
    expect(seen).toEqual([[['a:1', 'a@sha']], []])
    const pods = mockApply.mock.calls.map((c) => c[0] as {
      metadata: { name: string; labels: unknown }
      spec: Record<string, unknown> & { containers: Array<Record<string, unknown>> }
    })
    expect(pods.map((p) => p.spec.nodeName)).toEqual(['n1', 'n2'])
    expect(pods[0].metadata.name).toMatch(/^yaac-thing-0-[0-9a-f]{8}$/)
    expect(pods[0].metadata.labels).toEqual(LABELS)
    expect(pods[0].spec).toMatchObject({
      restartPolicy: 'Never',
      tolerations: [{ operator: 'Exists' }],
      automountServiceAccountToken: false,
      priorityClassName: PRIORITY_CLASS_INFRA,
      hostPID: true,
    })
    expect(pods[0].spec.containers[0]).toMatchObject({
      image: 'img@sha256:x', command: ['sh', '-c', 'true'], securityContext: { runAsUser: 0 },
    })
    // Every node is attempted; the caller judges each outcome.
    expect(runs.map((r) => [r.node, r.phase, r.logs])).toEqual([
      ['n1', 'Succeeded', 'done\n'],
      ['n2', 'Failed', 'done\n'],
    ])
  })

  it('runs nothing on a node the caller skips', async () => {
    const runs = await runOnEachNode({
      name: 'yaac-thing',
      labels: LABELS,
      timeoutMs: 60_000,
      pod: (node) => (node.name === 'n1' ? null : { image: 'i', command: ['true'] }),
    })
    expect(runs.map((r) => r.node)).toEqual(['n2'])
    expect(mockApply).toHaveBeenCalledTimes(1)
  })
})
