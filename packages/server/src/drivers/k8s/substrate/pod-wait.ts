import { Watch, type V1Pod } from '@kubernetes/client-node'
import { getCoreApi, getKubeConfig } from './client'
import { k8sNamespace } from './kubectl'
import { JOB_NAME_LABEL } from './pods'

/**
 * Wait for one workspace pod to become Ready: list the Job's pod, then
 * watch it for status changes instead of polling. Used by workspace
 * create.
 */

/** Outcome of evaluating one pod snapshot against "ready to exec into". */
export type PodReadyVerdict =
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
export function evaluatePodReady(pod: V1Pod): PodReadyVerdict {
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

/** List/watch seam so unit tests drive the wait with fake pod streams. */
export interface PodReadyDeps {
  listPods: () => Promise<{ resourceVersion?: string; pods: V1Pod[] }>
  watchPods: (
    resourceVersion: string | undefined,
    onEvent: (eventType: string, pod: V1Pod) => void,
    onDone: (err: unknown) => void,
  ) => Promise<{ abort: () => void }>
}

function realDeps(jobName: string): PodReadyDeps {
  const selector = `${JOB_NAME_LABEL}=${jobName}`
  return {
    listPods: async () => {
      const list = await getCoreApi().listNamespacedPod({
        namespace: k8sNamespace(),
        labelSelector: selector,
      })
      return { resourceVersion: list.metadata?.resourceVersion, pods: list.items }
    },
    watchPods: async (resourceVersion, onEvent, onDone) => {
      const watch = new Watch(getKubeConfig())
      const controller = await watch.watch(
        `/api/v1/namespaces/${k8sNamespace()}/pods`,
        {
          labelSelector: selector,
          ...(resourceVersion ? { resourceVersion } : {}),
        },
        (type, obj) => onEvent(type, obj as V1Pod),
        (err) => onDone(err),
      )
      return { abort: () => controller.abort() }
    },
  }
}

/** Max watch duration before re-listing, in case a watch silently stalls. */
const WATCH_EPISODE_MS = 15_000

/**
 * Resolve when the Job's workspace pod is Ready; reject on a terminal state,
 * an image-pull failure, or the deadline. Each round lists, then watches
 * from the list's resourceVersion. Any watch error (including 410 Gone) or
 * list failure just starts another round.
 */
export async function waitForJobPodReady(
  jobName: string,
  timeoutMs = 180_000,
  deps?: PodReadyDeps,
): Promise<void> {
  const d = deps ?? realDeps(jobName)
  const deadline = Date.now() + timeoutMs
  let lastDetail = 'pod not created yet'

  const check = (pod: V1Pod | undefined): boolean => {
    if (!pod) return false
    const verdict = evaluatePodReady(pod)
    if (verdict.kind === 'ready') return true
    if (verdict.kind === 'fatal') {
      throw new Error(`workspace pod for ${jobName} ${verdict.reason}`)
    }
    lastDetail = verdict.detail
    return false
  }

  while (Date.now() < deadline) {
    let listed: { resourceVersion?: string; pods: V1Pod[] }
    try {
      listed = await d.listPods()
    } catch {
      await new Promise((r) => setTimeout(r, 1_000))
      continue
    }
    if (check(listed.pods[0])) return

    const episodeMs = Math.min(WATCH_EPISODE_MS, deadline - Date.now())
    if (episodeMs <= 0) break
    const ready = await new Promise<boolean>((resolve, reject) => {
      let settled = false
      let abort: (() => void) | null = null
      const settle = (fn: () => void): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        abort?.()
        fn()
      }
      const timer = setTimeout(() => settle(() => resolve(false)), episodeMs)
      d.watchPods(
        listed.resourceVersion,
        (eventType, pod) => {
          // A DELETED event carries the pod's last state, which may still
          // read ready. Re-list instead of trusting it.
          if (eventType === 'DELETED') {
            lastDetail = 'pod deleted while waiting'
            settle(() => resolve(false))
            return
          }
          try {
            if (check(pod)) settle(() => resolve(true))
          } catch (err) {
            settle(() => reject(err as Error))
          }
        },
        () => settle(() => resolve(false)),
      ).then(
        (handle) => {
          abort = handle.abort
          if (settled) handle.abort()
        },
        () => settle(() => resolve(false)),
      )
    })
    if (ready) return
  }
  throw new Error(
    `workspace pod for ${jobName} not ready after ${timeoutMs}ms (${lastDetail})`,
  )
}
