import { z } from 'zod'
import {
  dataDirHash,
  k8sNamespace,
  kubectlApply,
  kubectlGetJson,
  kubectlWithRetry,
} from './kubectl'

/** Label keys attached to every worktree Job and its Pod. */
export const LABEL_PROJECT = 'yaac.project'
/**
 * The worktree a pod runs. Every list query, informer and cluster-side
 * NetworkPolicy podSelector matches on this key, so it is what makes a
 * worktree pod findable at all.
 */
export const LABEL_WORKTREE_ID = 'yaac.worktree-id'
export const LABEL_DATA_DIR_HASH = 'yaac.data-dir-hash'
export const LABEL_TOOL = 'yaac.tool'
/**
 * Which protocol drives the worktree's agents — `tui` or `acp` (AgentMode).
 * Stamped only for `acp`, so every pod that predates modes (and every TUI pod)
 * simply lacks it and reads as `tui`. It rides a label rather than a DB lookup
 * because the status watcher picks its driver from informer deltas, where a
 * per-pod query would put the database on the pod-event hot path.
 */
export const LABEL_MODE = 'yaac.mode'
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
 * Deliberately NOT 443: netd redirects worktree 443/80 egress to the proxy,
 * so the API the worktree dials lives on a port that rides the per-worktree
 * NetworkPolicy (buildVclusterWorktreeNetworkPolicyManifest) straight to the
 * control plane instead. values.yaml exposes it as the `yaac-api` Service
 * port (alongside the chart's 443, which synced pods use — their egress is
 * not redirected to the proxy). Same cycle-free home as
 * LABEL_VCLUSTER_MANAGED_BY (bootstrap's vcluster fallback references it).
 */
export const VCLUSTER_API_PORT = 8443
/**
 * Marks a worktree pod as a prewarmed spare — fully provisioned with its
 * agent booted and waiting, but not yet handed to a user. Spares are hidden
 * from user-facing views and claimed on `worktree create` by removing this
 * label (see `src/server/prewarm.ts`). Stamped only when present, so a
 * normal worktree pod simply lacks the label.
 */
export const LABEL_PREWARMED = 'yaac.prewarmed'

/** The worktree-id stamp, for a writer labelling a worktree Job or Pod. */
export function worktreeIdLabels(worktreeId: string): Record<string, string> {
  return { [LABEL_WORKTREE_ID]: worktreeId }
}

/**
 * Kubernetes object names must be lowercase DNS-1123 and the `job-name`
 * label on pods caps the Job name at 63 chars. `yaac-` (5) + UUID (36) +
 * separator (1) leaves 21 chars for the slug, so long project names are
 * truncated. Uniqueness comes from the worktree UUID, and the full slug
 * always travels in the `yaac.project` label.
 */
export function worktreeJobName(projectSlug: string, worktreeId: string): string {
  const safeSlug = projectSlug
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 21)
  return `yaac-${safeSlug}-${worktreeId}`.replace(/--+/g, '-')
}

/**
 * Recover the worktree id from a worktree Job name — always its last 36
 * chars: the UUID tail survives `worktreeJobName`'s collapsing untouched (a
 * UUID has no consecutive dashes, and the slug part is trimmed before the
 * join). Lets jobName-keyed call sites reach the relay, which addresses
 * streams by worktree id.
 */
export function worktreeIdFromJobName(jobName: string): string {
  if (jobName.length < 36) throw new Error(`not a worktree job name: ${jobName}`)
  return jobName.slice(-36)
}

/**
 * Terminal-state evidence from a dead or dying pod — what the stale reaper
 * reads to derive a worktree death reason before its own teardown deletes
 * the pod (and with it, the only record of why the worktree died). Absent
 * on healthy pods.
 */
export interface PodTerminalState {
  /** Pod-level `status.reason`, e.g. `Evicted`. */
  podReason?: string
  /** Pod-level `status.message` accompanying `podReason`. */
  podMessage?: string
  /** Worktree container's terminated exit code. */
  exitCode?: number
  /** Worktree container's terminated reason, e.g. `OOMKilled`. */
  containerReason?: string
  /** Worktree container's terminated `finishedAt` as epoch ms. */
  finishedAtMs?: number
}

export interface PodInfo {
  /** Job name (`yaac-<slug>-<worktreeId>`) — the stable worktree handle. */
  jobName: string
  /** Concrete Pod name (Job name + random suffix); needed for logs etc. */
  podName: string
  worktreeId: string
  projectSlug: string
  tool: string
  /** `yaac.mode` when stamped; absent on every TUI pod (see LABEL_MODE). */
  mode?: string
  /** Pod phase: Pending | Running | Succeeded | Failed | Unknown. */
  phase: string
  /** True when the pod is Running and not terminating. */
  running: boolean
  /** The pod has a deletionTimestamp — Kubernetes is tearing it down. Kept
   *  distinct from `running` (which folds it in) so the display path can
   *  render the worktree as a "terminating…" placeholder instead of dropping
   *  it or misreading it as stale. */
  terminating: boolean
  /** Pod creationTimestamp as epoch ms. */
  createdAtMs: number
  labels: Record<string, string>
  /** Set only when the pod carries terminal-state evidence. */
  terminal?: PodTerminalState
}

/** True when a pod is a prewarmed spare (carries the `yaac.prewarmed` label). */
export function isPrewarmed(pod: PodInfo): boolean {
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
 * Timestamps arrive as ISO strings from kubectl JSON and informer watch
 * events (raw JSON), but as `Date` instances from informer list calls
 * (client-node deserializes those into generated classes) — accept both.
 */
const timestampSchema = z.union([z.string().min(1), z.date()])

export function toEpochMs(ts: string | Date): number {
  return typeof ts === 'string' ? Date.parse(ts) : ts.getTime()
}

/**
 * Every field below is guaranteed: name/creationTimestamp/phase by the
 * API server, the yaac labels by worktree-create (the label selector
 * admits only yaac-created worktree objects). A validation failure is
 * therefore a yaac bug or a hand-edited object — fail the whole list
 * loudly up-front rather than mapping rows with silently empty fields.
 *
 * Exported (with `mapPodItem`) so the informer cache can validate
 * and map individual watch-event objects with the same rules.
 */
export const podItemSchema = z.object({
  metadata: z.object({
    name: z.string().min(1),
    labels: z.object({
      [JOB_NAME_LABEL]: z.string().min(1),
      [LABEL_WORKTREE_ID]: z.string().min(1),
      [LABEL_PROJECT]: z.string().min(1),
      [LABEL_TOOL]: z.string().min(1),
    }).catchall(z.string()),
    creationTimestamp: timestampSchema,
    deletionTimestamp: timestampSchema.optional(),
  }),
  status: z.object({
    phase: z.string().min(1),
    // Terminal-state evidence (all optional — absent on healthy pods):
    // pod-level reason/message cover evictions, the first container status
    // covers the worktree container's exit (index 0 is the worktree container,
    // the same invariant worktree-create's waitForJobPodReady relies on).
    reason: z.string().optional(),
    message: z.string().optional(),
    containerStatuses: z.array(z.object({
      state: z.object({
        terminated: z.object({
          exitCode: z.number(),
          reason: z.string().optional(),
          finishedAt: timestampSchema.optional(),
        }).optional(),
      }).optional(),
    })).optional(),
  }),
})

export type PodItem = z.infer<typeof podItemSchema>

/** Map a validated pod object to the PodInfo row the rest of yaac uses. */
export function mapPodItem({ metadata, status }: PodItem): PodInfo {
  const terminating = metadata.deletionTimestamp !== undefined
  const terminated = status.containerStatuses?.[0]?.state?.terminated
  const terminal: PodTerminalState | undefined =
    terminated || status.reason
      ? {
          podReason: status.reason,
          podMessage: status.message,
          exitCode: terminated?.exitCode,
          containerReason: terminated?.reason,
          finishedAtMs: terminated?.finishedAt !== undefined
            ? toEpochMs(terminated.finishedAt)
            : undefined,
        }
      : undefined
  return {
    jobName: metadata.labels[JOB_NAME_LABEL],
    podName: metadata.name,
    worktreeId: metadata.labels[LABEL_WORKTREE_ID],
    projectSlug: metadata.labels[LABEL_PROJECT],
    tool: metadata.labels[LABEL_TOOL],
    ...(metadata.labels[LABEL_MODE] !== undefined ? { mode: metadata.labels[LABEL_MODE] } : {}),
    phase: status.phase,
    running: status.phase === 'Running' && !terminating,
    terminating,
    createdAtMs: toEpochMs(metadata.creationTimestamp),
    labels: metadata.labels,
    ...(terminal ? { terminal } : {}),
  }
}

/** Validate+map one raw pod object (informer events); null = malformed. */
export function mapPodObject(obj: unknown): PodInfo | null {
  const res = podItemSchema.safeParse(obj)
  return res.success ? mapPodItem(res.data) : null
}

const podListSchema = z.object({
  items: z.array(podItemSchema),
})

const jobItemSchema = z.object({
  metadata: z.object({
    name: z.string().min(1),
    labels: z.object({
      [LABEL_WORKTREE_ID]: z.string().min(1),
      [LABEL_PROJECT]: z.string().min(1),
    }).catchall(z.string()),
    creationTimestamp: timestampSchema,
  }),
})

/** Validate+map one raw Job object (informer events); null = malformed. */
export function mapJobObject(obj: unknown): JobInfo | null {
  const res = jobItemSchema.safeParse(obj)
  if (!res.success) return null
  const { metadata } = res.data
  return {
    jobName: metadata.name,
    worktreeId: metadata.labels[LABEL_WORKTREE_ID],
    projectSlug: metadata.labels[LABEL_PROJECT],
    createdAtMs: toEpochMs(metadata.creationTimestamp),
  }
}

const jobListSchema = z.object({
  items: z.array(jobItemSchema),
})

/** Validate a kubectl list payload, naming the object kind in the error. */
function parseListPayload<T>(schema: z.ZodType<T>, payload: unknown, kind: string): T {
  const res = schema.safeParse(payload)
  if (!res.success) {
    throw new Error(`malformed worktree ${kind} list from kubectl: ${z.prettifyError(res.error)}`)
  }
  return res.data
}

/**
 * List worktree pods for this yaac install (scoped by the data-dir-hash
 * label), optionally filtered to one project. The k8s replacement for
 * `podman.listContainers({filters: {label: ['yaac.data-dir=...']}})`.
 * Throws when the payload fails podListSchema validation.
 */
export async function listWorktreePods(projectFilter?: string): Promise<PodInfo[]> {
  const list = await kubectlGetJson<unknown>([
    'get', 'pods', '-n', k8sNamespace(), '-l', worktreePodSelector(projectFilter),
  ])
  if (!list) return []
  const { items } = parseListPayload(podListSchema, list, 'pod')
  return items.map(mapPodItem)
}

/** The label selector `listWorktreePods` and the pod watcher share. */
export function worktreePodSelector(projectFilter?: string): string {
  return [
    `${LABEL_DATA_DIR_HASH}=${dataDirHash()}`,
    `${LABEL_WORKTREE_ID}`,
    ...(projectFilter ? [`${LABEL_PROJECT}=${projectFilter}`] : []),
  ].join(',')
}

/**
 * Match a worktree pod by worktree-id prefix or exact Job/Pod name —
 * mirrors the podman-era matching (worktree-id prefix, container name
 * exact). Names are deliberately NOT prefix-matched: every Job name
 * starts with `yaac-`, so a short name prefix would resolve to an
 * arbitrary worktree.
 */
export function findWorktreePod(pods: PodInfo[], idOrName: string): PodInfo | undefined {
  return pods.find((p) =>
    p.jobName === idOrName
    || p.podName === idOrName
    || p.worktreeId.startsWith(idOrName),
  )
}

export interface JobInfo {
  jobName: string
  worktreeId: string
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
  /**
   * Terminal phase; the sentinel `Deleted` when the pod vanished mid-poll
   * (deleted out from under us — it can never complete); or the last
   * phase seen when the deadline passed.
   */
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
      // NotFound after a successful apply means something deleted the pod
      // out from under us (a namesake run in another process, an external
      // sweep). It can never reach a terminal phase — fail fast instead
      // of polling NotFound until the deadline.
      if (pod === null) {
        phase = 'Deleted'
        break
      }
      phase = pod.status?.phase ?? 'Unknown'
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
 * List worktree Jobs for this install. Used by the orphan-Job sweep: a Job
 * whose pod was evicted/deleted out-of-band is invisible to the pod-based
 * reaper, so the reconciler cross-references this list.
 * Throws when the payload fails jobListSchema validation.
 */
export async function listWorktreeJobs(): Promise<JobInfo[]> {
  const list = await kubectlGetJson<unknown>([
    'get', 'jobs', '-n', k8sNamespace(), '-l', worktreeJobSelector(),
  ])
  if (!list) return []
  const { items } = parseListPayload(jobListSchema, list, 'job')
  return items.flatMap((item) => mapJobObject(item) ?? [])
}

/** The label selector `listWorktreeJobs` and the Jobs informer share. */
export function worktreeJobSelector(): string {
  return `${LABEL_DATA_DIR_HASH}=${dataDirHash()},${LABEL_WORKTREE_ID}`
}
