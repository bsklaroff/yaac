import { describe, it, expect, vi, beforeEach } from 'vitest'
import { apiError, fakeCluster, type FakeObject } from '@yaac/test-utils/k8s-stub'

/** The API server's watch stream, faked at the client library. */
interface FakeWatch {
  path: string
  query: Record<string, unknown>
  emit: (type: string, obj: unknown) => void
  aborted: boolean
}
const watches: FakeWatch[] = []

import { runOnEachNode, runPodToCompletion } from '#drivers/k8s/substrate'
import { PRIORITY_CLASS_INFRA } from '#drivers/k8s/substrate/priority-classes'

/** Answer reads of a stored pod from `status(name)`; null reads as deleted. */
function podReads(status: (name: string) => Record<string, unknown> | null): void {
  fakeCluster.intercept((call) => {
    if (call.verb !== 'read' || call.kind !== 'Pod') return undefined
    const pod = fakeCluster.get('Pod', call.name ?? '', call.namespace) && status(call.name ?? '')
    if (!pod) throw apiError(404)
    return pod
  })
}

beforeEach(() => {
  watches.length = 0
  fakeCluster.onWatch = (path, query, emit) => {
    const w: FakeWatch = { path, query, emit, aborted: false }
    watches.push(w)
    return { abort: () => { w.aborted = true } }
  }
  vi.stubEnv('YAAC_K8S_NAMESPACE', 'test-ns')
})

describe('runPodToCompletion', () => {
  const MANIFEST = {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: { name: 'yaac-oneshot', namespace: 'test-ns' },
    spec: { restartPolicy: 'Never' },
  }
  const verbs = () => fakeCluster.calls.map((c) => c.verb)

  it('replaces a stray namesake, applies, reads Succeeded, returns the logs and deletes the pod', async () => {
    fakeCluster.seed({ ...MANIFEST, spec: { stray: true } })
    fakeCluster.podLogs.set('yaac-oneshot', 'hello\n')
    podReads(() => ({ status: { phase: 'Succeeded' } }))

    await expect(runPodToCompletion(MANIFEST, { timeoutMs: 5_000 }))
      .resolves.toEqual({ phase: 'Succeeded', logs: 'hello\n' })
    // The stray delete waits until the name is free before the apply.
    expect(verbs()[0]).toBe('delete')
    expect(verbs().indexOf('apply')).toBeGreaterThan(verbs().indexOf('read'))
    expect(fakeCluster.callsOf('apply')[0].body).toEqual(MANIFEST)
    expect(verbs().at(-1)).toBe('delete')
    expect(fakeCluster.get('Pod', 'yaac-oneshot', 'test-ns')).toBeUndefined()
  })

  it('returns Failed at once (with logs) instead of burning the timeout', async () => {
    fakeCluster.podLogs.set('yaac-oneshot', 'boom\n')
    podReads(() => ({ status: { phase: 'Failed' } }))
    const start = Date.now()
    await expect(runPodToCompletion(MANIFEST, { timeoutMs: 60_000 }))
      .resolves.toEqual({ phase: 'Failed', logs: 'boom\n' })
    expect(Date.now() - start).toBeLessThan(5_000)
  })

  it('fails fast with phase Deleted when the pod vanishes after apply', async () => {
    podReads(() => null)
    const start = Date.now()
    await expect(runPodToCompletion(MANIFEST, { timeoutMs: 60_000 }))
      .resolves.toEqual({ phase: 'Deleted', logs: '' })
    expect(Date.now() - start).toBeLessThan(5_000)
  })

  it('returns the last seen phase when the deadline passes, and still cleans up', async () => {
    podReads(() => ({ status: { phase: 'Pending' } }))
    const { phase } = await runPodToCompletion(MANIFEST, { timeoutMs: 5 })
    expect(phase).toBe('Pending')
    expect(fakeCluster.get('Pod', 'yaac-oneshot', 'test-ns')).toBeUndefined()
  })

  it('propagates an apply failure after best-effort cleanup', async () => {
    fakeCluster.intercept((call) => {
      if (call.verb === 'apply') throw apiError(403, 'admission denied')
      return undefined
    })
    await expect(runPodToCompletion(MANIFEST, { timeoutMs: 5_000 })).rejects.toThrow('admission denied')
    expect(fakeCluster.callsOf('delete')).toHaveLength(2)
  })

  it('follows a running pod through a watch from its resourceVersion', async () => {
    podReads(() => ({ metadata: { resourceVersion: '7' }, status: { phase: 'Running' } }))
    const run = runPodToCompletion(MANIFEST, { timeoutMs: 60_000 })
    await vi.waitFor(() => expect(watches).toHaveLength(1))
    expect(watches[0].path).toBe('/api/v1/namespaces/test-ns/pods')
    expect(watches[0].query).toEqual({ fieldSelector: 'metadata.name=yaac-oneshot', resourceVersion: '7' })
    watches[0].emit('MODIFIED', { status: { phase: 'Running' } })
    watches[0].emit('MODIFIED', { metadata: { uid: 'u-1' }, status: { phase: 'Succeeded' } })
    // The uid names this run's pod, for reading its events.
    expect(await run).toMatchObject({ phase: 'Succeeded', uid: 'u-1' })
    expect(fakeCluster.callsOf('read')).toHaveLength(1)
    expect(watches[0].aborted).toBe(true)
  })

  // An ERROR event (e.g. 410 Gone) carries a Status, not a pod.
  it('re-lists after a watch error instead of reading it as the pod', async () => {
    let reads = 0
    podReads(() => (reads++ === 0
      ? { metadata: { resourceVersion: '7' }, status: { phase: 'Running' } }
      : { status: { phase: 'Succeeded' } }))
    const run = runPodToCompletion(MANIFEST, { timeoutMs: 60_000 })
    await vi.waitFor(() => expect(watches).toHaveLength(1))
    watches[0].emit('ERROR', { kind: 'Status', code: 410 })
    expect((await run).phase).toBe('Succeeded')
    expect(reads).toBe(2)
  })
})

describe('runOnEachNode', () => {
  const LABELS = { app: 'yaac-thing', 'yaac.thing-hash': 'h1' }

  beforeEach(() => {
    fakeCluster.seed(
      { apiVersion: 'v1', kind: 'Node', metadata: { name: 'n1' }, status: { images: [{ names: ['a:1', 'a@sha'] }] } },
      { apiVersion: 'v1', kind: 'Node', metadata: { name: 'n2' } },
      { apiVersion: 'v1', kind: 'Pod', metadata: { name: 'yaac-thing-0-old', namespace: 'test-ns', labels: LABELS } },
    )
    podReads((name) => ({ status: { phase: name.includes('-1-') ? 'Failed' : 'Succeeded' } }))
    fakeCluster.intercept((call) => {
      if (call.verb === 'apply') fakeCluster.podLogs.set(call.name ?? '', 'done\n')
      return undefined
    })
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

    expect(fakeCluster.calls[0]).toMatchObject({ verb: 'list', kind: 'Pod', labelSelector: 'app=yaac-thing,yaac.thing-hash=h1' })
    expect(fakeCluster.get('Pod', 'yaac-thing-0-old', 'test-ns')).toBeUndefined()
    expect(seen).toEqual([[['a:1', 'a@sha']], []])
    const pods = fakeCluster.callsOf('apply').map((c) => c.body as unknown as FakeObject & {
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
    expect(fakeCluster.callsOf('apply')).toHaveLength(1)
  })
})
