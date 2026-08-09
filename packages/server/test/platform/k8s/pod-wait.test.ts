import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type * as clientNode from '@kubernetes/client-node'
import type { KubernetesListObject, V1Pod } from '@kubernetes/client-node'

/**
 * Boundary for the no-deps path: the typed client and the watch stream are
 * what talk to the apiserver. Faking them (over a real KubeConfig loaded
 * from a temp kubeconfig) runs the client singletons and the real
 * list/watch wiring the session-create caller gets.
 */
type WatchCb = (type: string, obj: unknown) => void
const listNamespacedPodMock = vi.fn<
  (opts: { namespace: string; labelSelector: string }) => Promise<KubernetesListObject<V1Pod>>
>()
const watchMock = vi.fn<
  (p: string, q: Record<string, string>, onEvent: WatchCb, onDone: (err: unknown) => void)
  => Promise<{ abort: () => void }>
>()
vi.mock('@kubernetes/client-node', async (importOriginal) => {
  const actual = await importOriginal<typeof clientNode>()
  return {
    ...actual,
    CoreV1Api: class { listNamespacedPod = listNamespacedPodMock },
    Watch: class { watch = watchMock },
  }
})

import { waitForJobPodReady } from '#platform/k8s'
// Internals: the list/watch seam the wait drives, and the client reset hook.
import type { PodReadyDeps } from '#platform/k8s/pod-wait'
import { _resetK8sClientForTests } from '#platform/k8s/client'

const KUBECONFIG_YAML = `apiVersion: v1
kind: Config
clusters:
- name: test-cluster
  cluster:
    server: https://127.0.0.1:1
users:
- name: test-user
  user: {}
contexts:
- name: test-context
  context:
    cluster: test-cluster
    user: test-user
current-context: test-context
`

function pod(status: V1Pod['status']): V1Pod {
  return { status } as V1Pod
}

const READY = pod({ phase: 'Running', containerStatuses: [{ ready: true } as never] })
const CREATING = pod({
  phase: 'Pending',
  containerStatuses: [{ ready: false, state: { waiting: { reason: 'ContainerCreating' } } } as never],
})

/** Deps whose watch immediately delivers `events` then stays open. Each
 *  event is `[type, pod]`; a bare pod means an ADDED/MODIFIED-style event. */
type FakeEvent = V1Pod | [string, V1Pod]

function fakeDeps(listPods: PodReadyDeps['listPods'], events: FakeEvent[][]): {
  deps: PodReadyDeps
  aborts: number[]
} {
  const aborts: number[] = []
  let episode = 0
  const deps: PodReadyDeps = {
    listPods,
    watchPods: (_rv, onEvent) => {
      const mine = episode++
      aborts[mine] = 0
      for (const e of events.shift() ?? []) {
        if (Array.isArray(e)) onEvent(e[0], e[1])
        else onEvent('MODIFIED', e)
      }
      return Promise.resolve({ abort: () => { aborts[mine]++ } })
    },
  }
  return { deps, aborts }
}

let tmpDir: string

beforeEach(async () => {
  vi.clearAllMocks()
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-pod-wait-'))
  await fs.writeFile(path.join(tmpDir, 'config'), KUBECONFIG_YAML)
  vi.stubEnv('KUBECONFIG', path.join(tmpDir, 'config'))
  vi.stubEnv('YAAC_K8S_NAMESPACE', 'test-ns')
  _resetK8sClientForTests()
})

afterEach(async () => {
  _resetK8sClientForTests()
  vi.unstubAllEnvs()
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('waitForJobPodReady', () => {
  it('lists and watches the Job\'s pod through the typed client when given no deps', async () => {
    listNamespacedPodMock.mockResolvedValueOnce({
      metadata: { resourceVersion: '77' }, items: [CREATING],
    } as unknown as KubernetesListObject<V1Pod>)
    const abort = vi.fn()
    watchMock.mockImplementation((_p, _q, onEvent) => {
      onEvent('MODIFIED', READY)
      return Promise.resolve({ abort })
    })

    await expect(waitForJobPodReady('job-a', 2_000)).resolves.toBeUndefined()
    expect(listNamespacedPodMock).toHaveBeenCalledWith({
      namespace: 'test-ns',
      labelSelector: 'batch.kubernetes.io/job-name=job-a',
    })
    // The watch resumes from the list's resourceVersion, on the same
    // selector, and is aborted once the pod is ready.
    expect(watchMock).toHaveBeenCalledWith(
      '/api/v1/namespaces/test-ns/pods',
      { labelSelector: 'batch.kubernetes.io/job-name=job-a', resourceVersion: '77' },
      expect.any(Function),
      expect.any(Function),
    )
    expect(abort).toHaveBeenCalled()
  })

  it('retries a failed list inside the deadline instead of giving up', async () => {
    listNamespacedPodMock
      .mockRejectedValueOnce(new Error('apiserver restarting'))
      .mockResolvedValue({ metadata: {}, items: [READY] } as unknown as KubernetesListObject<V1Pod>)
    await expect(waitForJobPodReady('job-a', 5_000)).resolves.toBeUndefined()
    expect(listNamespacedPodMock).toHaveBeenCalledTimes(2)
    // No resourceVersion in the list → the watch starts from now.
    expect(watchMock).not.toHaveBeenCalled()
  })

  it('returns immediately when the list already shows a ready pod', async () => {
    const { deps } = fakeDeps(
      () => Promise.resolve({ resourceVersion: '1', pods: [READY] }),
      [],
    )
    await expect(waitForJobPodReady('job-a', 1_000, deps)).resolves.toBeUndefined()
  })

  it('resolves on the watch event that flips the pod ready, then aborts the watch', async () => {
    const { deps, aborts } = fakeDeps(
      () => Promise.resolve({ resourceVersion: '1', pods: [CREATING] }),
      [[CREATING, READY]],
    )
    await expect(waitForJobPodReady('job-a', 2_000, deps)).resolves.toBeUndefined()
    expect(aborts[0]).toBeGreaterThan(0)
  })

  it('rejects on a terminal phase, carrying the container termination detail', async () => {
    // A failed postStart hook (the session setup script) lands here with the
    // kubelet's hook-failure message on the container's terminated state.
    const failed = pod({
      phase: 'Failed',
      containerStatuses: [{
        ready: false,
        state: { terminated: { reason: 'StartError', message: 'hook exited 1' } },
      } as never],
    })
    const { deps } = fakeDeps(
      () => Promise.resolve({ resourceVersion: '1', pods: [CREATING] }),
      [[failed]],
    )
    await expect(waitForJobPodReady('job-a', 2_000, deps))
      .rejects.toThrow('worktree pod for job-a reached terminal phase Failed (StartError: hook exited 1)')
  })

  it('falls back to the container lastState when the current state is empty', async () => {
    const succeeded = pod({
      phase: 'Succeeded',
      containerStatuses: [{ ready: false, lastState: { terminated: { reason: 'Completed' } } } as never],
    })
    const { deps } = fakeDeps(
      () => Promise.resolve({ resourceVersion: '1', pods: [succeeded] }),
      [],
    )
    await expect(waitForJobPodReady('job-a', 2_000, deps))
      .rejects.toThrow('worktree pod for job-a reached terminal phase Succeeded (Completed)')
  })

  it('rejects on either image-pull failure — a content-hash tag never self-heals', async () => {
    for (const reason of ['ErrImagePull', 'ImagePullBackOff']) {
      const pulling = pod({
        phase: 'Pending',
        containerStatuses: [{
          ready: false,
          state: { waiting: { reason, message: 'manifest unknown' } },
        } as never],
      })
      const { deps } = fakeDeps(
        () => Promise.resolve({ resourceVersion: '1', pods: [pulling] }),
        [],
      )
      await expect(waitForJobPodReady('job-a', 2_000, deps))
        .rejects.toThrow(`cannot pull its image (${reason}: manifest unknown)`)
    }
  })

  it('gates on the FIRST container status (the session container)', async () => {
    // A second, ready container must not be mistaken for the session one.
    const sidecarReady = pod({
      phase: 'Running',
      containerStatuses: [{ ready: false } as never, { ready: true } as never],
    })
    const { deps } = fakeDeps(
      () => Promise.resolve({ resourceVersion: '1', pods: [sidecarReady] }),
      [[]],
    )
    await expect(waitForJobPodReady('job-a', 50, deps))
      .rejects.toThrow(/not ready after 50ms \(phase Running\)/)
  })

  it('never trusts a DELETED event as ready — it re-lists instead', async () => {
    // DELETED delivers the pod's last-known object, which can still read
    // ready for a pod that no longer exists.
    const listPods = vi.fn<PodReadyDeps['listPods']>()
      .mockResolvedValueOnce({ resourceVersion: '1', pods: [CREATING] })
      .mockResolvedValueOnce({ resourceVersion: '2', pods: [READY] })
    const { deps } = fakeDeps(listPods, [[['DELETED', READY]], []])
    await expect(waitForJobPodReady('job-a', 5_000, deps)).resolves.toBeUndefined()
    // The DELETED event ended the first episode; readiness came from the
    // second list, not the deleted pod's stale object.
    expect(listPods).toHaveBeenCalledTimes(2)
  })

  it('re-lists after a watch ends and succeeds on the fresh list', async () => {
    const listPods = vi.fn<PodReadyDeps['listPods']>()
      .mockResolvedValueOnce({ resourceVersion: '1', pods: [CREATING] })
      .mockResolvedValueOnce({ resourceVersion: '2', pods: [READY] })
    const deps: PodReadyDeps = {
      listPods,
      // Watch dies immediately (410-style) — the loop must re-list.
      watchPods: (_rv, _onEvent, onDone) => {
        onDone(new Error('410 gone'))
        return Promise.resolve({ abort: () => {} })
      },
    }
    await expect(waitForJobPodReady('job-a', 5_000, deps)).resolves.toBeUndefined()
    expect(listPods).toHaveBeenCalledTimes(2)
  })

  it('times out with the last pending detail', async () => {
    const { deps } = fakeDeps(
      () => Promise.resolve({ resourceVersion: '1', pods: [CREATING] }),
      [[], [], []],
    )
    // Short episode budget: the deadline expires between episodes.
    await expect(waitForJobPodReady('job-a', 50, deps))
      .rejects.toThrow(/not ready after 50ms \(ContainerCreating\)/)
  })
})
