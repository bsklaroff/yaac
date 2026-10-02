import { Watch, type V1Pod } from '@kubernetes/client-node'
import { getCoreApi, getKubeConfig } from './client'
import { k8sNamespace } from './kubectl'
import { JOB_NAME_LABEL } from './pods'

/**
 * Waits on single pods by listing them, then watching for status changes
 * instead of polling: a workspace pod becoming Ready (workspace create),
 * and one-shot pods running to completion (one-shot-pods.ts).
 */

/** Outcome of evaluating one pod snapshot against "ready to exec into". */
type PodReadyVerdict =
  | { kind: 'ready' }
  | { kind: 'fatal'; reason: string }
  | { kind: 'pending'; detail: string }

/**
 * Classify a workspace pod's status. The container has no readiness probe,
 * and its postStart hook (yaac-workspace-init) runs before it counts as
 * running, so ready means in-pod setup finished. Terminal phases and image
 * pull failures are fatal: tags are content hashes, so a failed pull will
 * not fix itself.
 */
function evaluatePodReady(pod: V1Pod): PodReadyVerdict {
  const phase = pod.status?.phase ?? 'Unknown'
  // The workspace container is the pod's only container.
  const cs = pod.status?.containerStatuses?.[0]
  if (cs?.ready) return { kind: 'ready' }
  if (phase === 'Failed' || phase === 'Succeeded') {
    // Include the termination detail, e.g. a failed postStart hook.
    const term = cs?.state?.terminated ?? cs?.lastState?.terminated
    const detail = term?.reason
      ? ` (${term.reason}${term.message ? `: ${term.message}` : ''})`
      : ''
    return { kind: 'fatal', reason: `reached terminal phase ${phase}${detail}` }
  }
  const waiting = cs?.state?.waiting
  if (waiting?.reason === 'ErrImagePull' || waiting?.reason === 'ImagePullBackOff') {
    const detail = `${waiting.reason}${waiting.message ? `: ${waiting.message}` : ''}`
    return { kind: 'fatal', reason: `cannot pull its image (${detail})` }
  }
  const detail = waiting?.reason
    ? `${waiting.reason}${waiting.message ? `: ${waiting.message}` : ''}`
    : `phase ${phase}`
  return { kind: 'pending', detail }
}

/** List/watch seam so unit tests drive a wait with fake pod streams. */
export interface PodReadyDeps {
  listPods: () => Promise<{ resourceVersion?: string; pods: V1Pod[] }>
  watchPods: (
    resourceVersion: string | undefined,
    onEvent: (eventType: string, pod: V1Pod) => void,
    onDone: (err: unknown) => void,
  ) => Promise<{ abort: () => void }>
}

/** Watch pods in `namespace` matching a label or field selector. */
export function watchPodsBy(
  namespace: string,
  selector: { labelSelector: string } | { fieldSelector: string },
): PodReadyDeps['watchPods'] {
  return async (resourceVersion, onEvent, onDone) => {
    const watch = new Watch(getKubeConfig())
    const controller = await watch.watch(
      `/api/v1/namespaces/${namespace}/pods`,
      { ...selector, ...(resourceVersion ? { resourceVersion } : {}) },
      (type, obj) => onEvent(type, obj as V1Pod),
      (err) => onDone(err),
    )
    return { abort: () => controller.abort() }
  }
}

function jobPodDeps(jobName: string): PodReadyDeps {
  const labelSelector = `${JOB_NAME_LABEL}=${jobName}`
  return {
    listPods: async () => {
      const list = await getCoreApi().listNamespacedPod({ namespace: k8sNamespace(), labelSelector })
      return { resourceVersion: list.metadata?.resourceVersion, pods: list.items }
    },
    watchPods: watchPodsBy(k8sNamespace(), { labelSelector }),
  }
}

/** Max watch duration before re-listing, in case a watch silently stalls. */
const WATCH_EPISODE_MS = 15_000

/** Pause before re-listing after a failed list or watch, so a broken API
 *  connection is not hammered. */
const RETRY_PAUSE_MS = 1_000

/**
 * Follow the first pod `deps` lists until `decide` answers, instead of
 * polling. Each round lists, then watches from the list's resourceVersion.
 * A DELETED event, a watch error (including 410 Gone) or a stalled watch
 * starts another round. `decide` sees `undefined` when no pod matches, and
 * may throw to fail the wait. Resolves `undefined` at the deadline.
 */
export async function followPod<T>(
  deps: PodReadyDeps,
  decide: (pod: V1Pod | undefined) => T | undefined,
  timeoutMs: number,
): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    let listed: { resourceVersion?: string; pods: V1Pod[] }
    try {
      listed = await deps.listPods()
    } catch {
      await new Promise((r) => setTimeout(r, RETRY_PAUSE_MS))
      continue
    }
    const now = decide(listed.pods[0])
    if (now !== undefined) return now

    const episodeMs = Math.min(WATCH_EPISODE_MS, deadline - Date.now())
    if (episodeMs <= 0) break
    const outcome = await new Promise<{ value: T } | 'relist' | 'pause'>((resolve, reject) => {
      let settled = false
      let abort: (() => void) | null = null
      const settle = (fn: () => void): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        abort?.()
        fn()
      }
      const timer = setTimeout(() => settle(() => resolve('relist')), episodeMs)
      deps.watchPods(
        listed.resourceVersion,
        (eventType, pod) => {
          // A DELETED event carries the pod's last state, and an ERROR
          // event carries a Status, not a pod; re-list instead of trusting
          // either.
          if (eventType === 'DELETED' || eventType === 'ERROR') {
            settle(() => resolve('relist'))
            return
          }
          try {
            const value = decide(pod)
            if (value !== undefined) settle(() => resolve({ value }))
          } catch (err) {
            settle(() => reject(err as Error))
          }
        },
        () => settle(() => resolve('pause')),
      ).then(
        (handle) => {
          abort = handle.abort
          if (settled) handle.abort()
        },
        () => settle(() => resolve('pause')),
      )
    })
    if (typeof outcome === 'object') return outcome.value
    if (outcome === 'pause') await new Promise((r) => setTimeout(r, RETRY_PAUSE_MS))
  }
  return undefined
}

/**
 * Resolve when the Job's workspace pod is Ready; reject on a terminal state,
 * an image-pull failure, or the deadline.
 */
export async function waitForJobPodReady(
  jobName: string,
  timeoutMs = 180_000,
  deps?: PodReadyDeps,
): Promise<void> {
  let lastDetail = 'pod not created yet'
  const ready = await followPod(deps ?? jobPodDeps(jobName), (pod) => {
    if (!pod) return undefined
    const verdict = evaluatePodReady(pod)
    if (verdict.kind === 'ready') return true
    if (verdict.kind === 'fatal') {
      throw new Error(`workspace pod for ${jobName} ${verdict.reason}`)
    }
    lastDetail = verdict.detail
    return undefined
  }, timeoutMs)
  if (ready) return
  throw new Error(
    `workspace pod for ${jobName} not ready after ${timeoutMs}ms (${lastDetail})`,
  )
}
