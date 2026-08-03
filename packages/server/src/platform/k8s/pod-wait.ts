import { Watch, type V1Pod } from '@kubernetes/client-node'
import { getCoreApi, getKubeConfig } from './client'
import { k8sNamespace } from './kubectl'
import { JOB_NAME_LABEL } from './pods'

/**
 * Waiting for one session pod to become Ready, event-driven: a typed-client
 * list seeds the state, then a watch on the Job's pod label delivers status
 * transitions the moment the apiserver records them — no kubectl child per
 * poll and no fixed poll-interval latency. Session-create is the only
 * consumer; the long-lived caches stay on InformerCache (this is a bounded
 * one-shot wait, not a cache).
 */

/** Outcome of evaluating one pod snapshot against "ready to exec into". */
export type PodReadyVerdict =
  | { kind: 'ready' }
  | { kind: 'fatal'; reason: string }
  | { kind: 'pending'; detail: string }

/**
 * Classify a session pod's status. Ready means the session container
 * reports ready — with no readiness probe that is "running", and the
 * postStart hook (yaac-session-init) gates running, so ready implies the
 * in-pod setup finished. Terminal phases and image-pull failures are
 * fatal: content-hash tags are immutable, so a pull failure never
 * self-heals — the bytes are either in the registry or they aren't.
 */
export function evaluateSessionPodReady(pod: V1Pod): PodReadyVerdict {
  const phase = pod.status?.phase ?? 'Unknown'
  // containerStatuses[0] is the session container (egress is redirected at
  // the cluster level, so there is no per-pod sidecar to gate on).
  const cs = pod.status?.containerStatuses?.[0]
  if (cs?.ready) return { kind: 'ready' }
  if (phase === 'Failed' || phase === 'Succeeded') {
    // Carry the container's termination detail when there is one — a
    // failed postStart hook (setup script exited nonzero) lands here with
    // the kubelet's hook-failure message.
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

/** Cap on one watch episode before re-listing — bounds the lifetime of a
 *  missed event (dropped watch stream that never errors). */
const WATCH_EPISODE_MS = 15_000

/**
 * Resolve when the Job's session pod is Ready; reject on a terminal state,
 * an image-pull failure, or the deadline. Each round lists (fresh state +
 * resourceVersion), then watches from there; any watch error — including a
 * 410 Gone from an expired resourceVersion — just starts the next round's
 * list. Transient list failures retry inside the deadline.
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
    const verdict = evaluateSessionPodReady(pod)
    if (verdict.kind === 'ready') return true
    if (verdict.kind === 'fatal') {
      throw new Error(`session pod for ${jobName} ${verdict.reason}`)
    }
    lastDetail = verdict.detail
    return false
  }

  while (Date.now() < deadline) {
    let listed: { resourceVersion?: string; pods: V1Pod[] }
    try {
      listed = await d.listPods()
    } catch {
      // Transient apiserver failure — same tolerance the kubectl retry
      // wrapper gave the old poll loop.
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
          // A DELETED event carries the pod's LAST-KNOWN object — which may
          // still read ready — for a pod that no longer exists (deleted
          // out-of-band mid-boot). Never trust it as a verdict; end the
          // episode so the re-list observes the true (absent) state.
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
        // Watch ended (error, 410, connection drop) — re-list and re-watch.
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
    `session pod for ${jobName} not ready after ${timeoutMs}ms (${lastDetail})`,
  )
}
