import { z } from 'zod'
import {
  dataDirHash,
  k8sNamespace,
  kubectlApply,
  kubectlGetJson,
  kubectlWithRetry,
} from '@/lib/k8s/kubectl'

/** Label keys attached to every session Job and its Pod. */
export const LABEL_PROJECT = 'yaac.project'
export const LABEL_SESSION_ID = 'yaac.session-id'
export const LABEL_DATA_DIR_HASH = 'yaac.data-dir-hash'
export const LABEL_TOOL = 'yaac.tool'
/**
 * Label the SYNCER stamps on every host object a vcluster creates (value =
 * the vcluster name). Lives here — not in vcluster.ts, which defines the
 * other vcluster constants — because bootstrap.ts needs it too and
 * vcluster.ts imports bootstrap (a vcluster.ts home would be an import
 * cycle).
 */
export const LABEL_VCLUSTER_MANAGED_BY = 'vcluster.loft.sh/managed-by'
/**
 * Host-Service port the SESSION pod uses to reach the vcluster API.
 * Deliberately NOT 443: Cilium redirects session 443/80 egress to the proxy,
 * so the API the session dials lives on a port that rides the session-egress
 * CNP's in-cluster carve-out (toEndpoints 5000/8443) instead. values.yaml
 * exposes it as the `yaac-api` Service port (alongside the chart's 443,
 * which synced pods use — their egress is not redirected to the proxy).
 * Same cycle-free home as LABEL_VCLUSTER_MANAGED_BY (bootstrap's carve-outs
 * reference it).
 */
export const VCLUSTER_API_PORT = 8443
/**
 * Marks a session pod as a prewarmed spare — fully provisioned with its
 * agent booted and waiting, but not yet handed to a user. Spares are hidden
 * from user-facing views and claimed on `session create` by removing this
 * label (see `src/daemon/prewarm.ts`). Stamped only when present, so a
 * normal session pod simply lacks the label.
 */
export const LABEL_PREWARMED = 'yaac.prewarmed'

/**
 * Kubernetes object names must be lowercase DNS-1123 and the `job-name`
 * label on pods caps the Job name at 63 chars. `yaac-` (5) + UUID (36) +
 * separator (1) leaves 21 chars for the slug, so long project names are
 * truncated. Uniqueness comes from the session UUID, and the full slug
 * always travels in the `yaac.project` label.
 */
export function sessionJobName(projectSlug: string, sessionId: string): string {
  const safeSlug = projectSlug
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 21)
  return `yaac-${safeSlug}-${sessionId}`.replace(/--+/g, '-')
}

export interface SessionPod {
  /** Job name (`yaac-<slug>-<sessionId>`) — the stable session handle. */
  jobName: string
  /** Concrete Pod name (Job name + random suffix); needed for logs etc. */
  podName: string
  sessionId: string
  projectSlug: string
  tool: string
  /** Pod phase: Pending | Running | Succeeded | Failed | Unknown. */
  phase: string
  /** True when the pod is Running and not terminating. */
  running: boolean
  /** Pod creationTimestamp as epoch ms. */
  createdAtMs: number
  labels: Record<string, string>
}

/** True when a pod is a prewarmed spare (carries the `yaac.prewarmed` label). */
export function isPrewarmed(pod: SessionPod): boolean {
  return pod.labels[LABEL_PREWARMED] === 'true'
}

/**
 * Job-name label kubernetes stamps on every pod a Job creates. The
 * canonical prefixed form exists on all supported clusters (added in
 * k8s 1.27); the legacy unprefixed `job-name` is deliberately not
 * consulted.
 */
export const JOB_NAME_LABEL = 'batch.kubernetes.io/job-name'

/**
 * Every field below is guaranteed: name/creationTimestamp/phase by the
 * API server, the yaac labels by session-create (the label selector
 * admits only yaac-created session objects). A validation failure is
 * therefore a yaac bug or a hand-edited object — fail the whole list
 * loudly up-front rather than mapping rows with silently empty fields.
 *
 * Exported (with `mapSessionPodItem`) so the pod watcher can validate
 * and map individual watch-event objects with the same rules.
 */
export const sessionPodItemSchema = z.object({
  metadata: z.object({
    name: z.string().min(1),
    labels: z.object({
      [JOB_NAME_LABEL]: z.string().min(1),
      [LABEL_SESSION_ID]: z.string().min(1),
      [LABEL_PROJECT]: z.string().min(1),
      [LABEL_TOOL]: z.string().min(1),
    }).catchall(z.string()),
    creationTimestamp: z.string().min(1),
    deletionTimestamp: z.string().optional(),
  }),
  status: z.object({ phase: z.string().min(1) }),
})

export type SessionPodItem = z.infer<typeof sessionPodItemSchema>

/** Map a validated pod object to the SessionPod row the rest of yaac uses. */
export function mapSessionPodItem({ metadata, status }: SessionPodItem): SessionPod {
  const terminating = metadata.deletionTimestamp !== undefined
  return {
    jobName: metadata.labels[JOB_NAME_LABEL],
    podName: metadata.name,
    sessionId: metadata.labels[LABEL_SESSION_ID],
    projectSlug: metadata.labels[LABEL_PROJECT],
    tool: metadata.labels[LABEL_TOOL],
    phase: status.phase,
    running: status.phase === 'Running' && !terminating,
    createdAtMs: Date.parse(metadata.creationTimestamp),
    labels: metadata.labels,
  }
}

const sessionPodListSchema = z.object({
  items: z.array(sessionPodItemSchema),
})

const sessionJobListSchema = z.object({
  items: z.array(z.object({
    metadata: z.object({
      name: z.string().min(1),
      labels: z.object({
        [LABEL_SESSION_ID]: z.string().min(1),
        [LABEL_PROJECT]: z.string().min(1),
      }).catchall(z.string()),
      creationTimestamp: z.string().min(1),
    }),
  })),
})

/** Validate a kubectl list payload, naming the object kind in the error. */
function parseListPayload<T>(schema: z.ZodType<T>, payload: unknown, kind: string): T {
  const res = schema.safeParse(payload)
  if (!res.success) {
    throw new Error(`malformed session ${kind} list from kubectl: ${z.prettifyError(res.error)}`)
  }
  return res.data
}

/**
 * List session pods for this yaac install (scoped by the data-dir-hash
 * label), optionally filtered to one project. The k8s replacement for
 * `podman.listContainers({filters: {label: ['yaac.data-dir=...']}})`.
 * Throws when the payload fails sessionPodListSchema validation.
 */
export async function listSessionPods(projectFilter?: string): Promise<SessionPod[]> {
  const list = await kubectlGetJson<unknown>([
    'get', 'pods', '-n', k8sNamespace(), '-l', sessionPodSelector(projectFilter),
  ])
  if (!list) return []
  const { items } = parseListPayload(sessionPodListSchema, list, 'pod')
  return items.map(mapSessionPodItem)
}

/** The label selector `listSessionPods` and the pod watcher share. */
export function sessionPodSelector(projectFilter?: string): string {
  return [
    `${LABEL_DATA_DIR_HASH}=${dataDirHash()}`,
    `${LABEL_SESSION_ID}`,
    ...(projectFilter ? [`${LABEL_PROJECT}=${projectFilter}`] : []),
  ].join(',')
}

/**
 * Match a session pod by session-ID prefix or exact Job/Pod name —
 * mirrors the podman-era matching (session-id prefix, container name
 * exact). Names are deliberately NOT prefix-matched: every Job name
 * starts with `yaac-`, so a short name prefix would resolve to an
 * arbitrary session.
 */
export function findSessionPod(pods: SessionPod[], idOrName: string): SessionPod | undefined {
  return pods.find((p) =>
    p.jobName === idOrName
    || p.podName === idOrName
    || p.sessionId.startsWith(idOrName),
  )
}

export interface SessionJob {
  jobName: string
  sessionId: string
  projectSlug: string
  createdAtMs: number
}

export interface RunPodOptions {
  /** Deadline for the pod to reach a terminal phase. */
  timeoutMs: number
  /** Poll interval between phase checks (default 1000ms). */
  pollMs?: number
  /** kubectl argv runner for the delete/logs calls; injectable for tests. */
  kubectl?: (args: string[]) => Promise<{ stdout: string }>
  /** Manifest apply; injectable for tests. */
  apply?: (manifest: object) => Promise<void>
}

export interface PodRunResult {
  /** Terminal phase, or the last phase seen when the deadline passed. */
  phase: string
  /** Pod logs, best-effort ('' when unavailable). */
  logs: string
}

/**
 * Run a one-shot pod (restartPolicy: Never) to completion: delete any
 * stray namesake, apply the manifest, poll to a terminal phase, fetch the
 * logs, and always delete the pod afterwards. Polling (not `kubectl
 * wait`) so a Failed pod returns immediately instead of burning the whole
 * timeout. Name and namespace come from the manifest; the caller owns the
 * verdict on the returned phase/logs.
 */
export async function runPodToCompletion(
  manifest: Record<string, unknown>,
  opts: RunPodOptions,
): Promise<PodRunResult> {
  const { name, namespace } = (manifest as { metadata: { name: string; namespace: string } }).metadata
  const kubectl = opts.kubectl ?? ((args: string[]) => kubectlWithRetry(args))
  const apply = opts.apply ?? kubectlApply
  await kubectl(['delete', 'pod', name, '-n', namespace, '--ignore-not-found'])
  try {
    await apply(manifest)
    const deadline = Date.now() + opts.timeoutMs
    let phase = 'Pending'
    while (Date.now() < deadline) {
      const pod = await kubectlGetJson<{ status?: { phase?: string } }>([
        'get', 'pod', name, '-n', namespace,
      ])
      phase = pod?.status?.phase ?? 'Unknown'
      if (phase === 'Succeeded' || phase === 'Failed') break
      await new Promise((r) => setTimeout(r, opts.pollMs ?? 1000))
    }
    const logs = await kubectl(['logs', name, '-n', namespace])
      .then((r) => r.stdout)
      .catch(() => '')
    return { phase, logs }
  } finally {
    await kubectl(['delete', 'pod', name, '-n', namespace, '--ignore-not-found'])
      .catch(() => { /* best-effort cleanup */ })
  }
}

/**
 * List session Jobs for this install. Used by the orphan-Job sweep: a Job
 * whose pod was evicted/deleted out-of-band is invisible to the pod-based
 * reaper, so the background loop cross-references this list.
 * Throws when the payload fails sessionJobListSchema validation.
 */
export async function listSessionJobs(): Promise<SessionJob[]> {
  const selector = `${LABEL_DATA_DIR_HASH}=${dataDirHash()},${LABEL_SESSION_ID}`
  const list = await kubectlGetJson<unknown>([
    'get', 'jobs', '-n', k8sNamespace(), '-l', selector,
  ])
  if (!list) return []
  const { items } = parseListPayload(sessionJobListSchema, list, 'job')
  return items.map(({ metadata }) => ({
    jobName: metadata.name,
    sessionId: metadata.labels[LABEL_SESSION_ID],
    projectSlug: metadata.labels[LABEL_PROJECT],
    createdAtMs: Date.parse(metadata.creationTimestamp),
  }))
}
