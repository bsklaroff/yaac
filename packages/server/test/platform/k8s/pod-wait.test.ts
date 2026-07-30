import { describe, it, expect, vi } from 'vitest'
import type { V1Pod } from '@kubernetes/client-node'
import {
  evaluateSessionPodReady,
  waitForJobPodReady,
  type PodReadyDeps,
} from '#platform/k8s/pod-wait'

function pod(status: V1Pod['status']): V1Pod {
  return { status } as V1Pod
}

describe('evaluateSessionPodReady', () => {
  it('is ready when the session container reports ready', () => {
    const verdict = evaluateSessionPodReady(pod({
      phase: 'Running',
      containerStatuses: [{ ready: true } as never],
    }))
    expect(verdict).toEqual({ kind: 'ready' })
  })

  it('is fatal on a terminal phase, carrying the termination detail', () => {
    const verdict = evaluateSessionPodReady(pod({
      phase: 'Failed',
      containerStatuses: [{
        ready: false,
        state: { terminated: { reason: 'StartError', message: 'hook exited 1' } },
      } as never],
    }))
    expect(verdict.kind).toBe('fatal')
    expect((verdict as { reason: string }).reason)
      .toBe('reached terminal phase Failed (StartError: hook exited 1)')
  })

  it('is fatal on image-pull failures (immutable tags never self-heal)', () => {
    for (const reason of ['ErrImagePull', 'ImagePullBackOff']) {
      const verdict = evaluateSessionPodReady(pod({
        phase: 'Pending',
        containerStatuses: [{ ready: false, state: { waiting: { reason } } } as never],
      }))
      expect(verdict.kind).toBe('fatal')
      expect((verdict as { reason: string }).reason).toContain(reason)
    }
  })

  it('is pending otherwise, with the waiting reason or phase as detail', () => {
    expect(evaluateSessionPodReady(pod({
      phase: 'Pending',
      containerStatuses: [{ ready: false, state: { waiting: { reason: 'ContainerCreating' } } } as never],
    }))).toEqual({ kind: 'pending', detail: 'ContainerCreating' })
    expect(evaluateSessionPodReady(pod({ phase: 'Pending' })))
      .toEqual({ kind: 'pending', detail: 'phase Pending' })
  })

  it('gates on the FIRST container status (the session container)', () => {
    const verdict = evaluateSessionPodReady(pod({
      phase: 'Running',
      containerStatuses: [{ ready: false } as never, { ready: true } as never],
    }))
    expect(verdict.kind).toBe('pending')
  })
})

const READY = pod({ phase: 'Running', containerStatuses: [{ ready: true } as never] })
const CREATING = pod({
  phase: 'Pending',
  containerStatuses: [{ ready: false, state: { waiting: { reason: 'ContainerCreating' } } } as never],
})

/** Deps whose watch immediately delivers `events` then stays open. */
function fakeDeps(listPods: PodReadyDeps['listPods'], events: V1Pod[][]): {
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
      for (const p of events.shift() ?? []) onEvent(p)
      return Promise.resolve({ abort: () => { aborts[mine]++ } })
    },
  }
  return { deps, aborts }
}

describe('waitForJobPodReady', () => {
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

  it('rejects on a fatal verdict from a watch event', async () => {
    const failed = pod({
      phase: 'Failed',
      containerStatuses: [{ ready: false, state: { terminated: { reason: 'Error' } } } as never],
    })
    const { deps } = fakeDeps(
      () => Promise.resolve({ resourceVersion: '1', pods: [CREATING] }),
      [[failed]],
    )
    await expect(waitForJobPodReady('job-a', 2_000, deps))
      .rejects.toThrow(/job-a reached terminal phase Failed/)
  })

  it('rejects on an image-pull failure surfaced by the initial list', async () => {
    const pulling = pod({
      phase: 'Pending',
      containerStatuses: [{ ready: false, state: { waiting: { reason: 'ErrImagePull' } } } as never],
    })
    const { deps } = fakeDeps(
      () => Promise.resolve({ resourceVersion: '1', pods: [pulling] }),
      [],
    )
    await expect(waitForJobPodReady('job-a', 2_000, deps))
      .rejects.toThrow(/cannot pull its image \(ErrImagePull\)/)
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
