import { z } from 'zod'
import { dataDirHash, k8sNamespace, listObjects } from './api'
import { serverLog } from '#log'

/** Label keys attached to every workspace Job and its Pod. */
export const LABEL_PROJECT = 'yaac.project'
/**
 * The project's immutable id (`ProjectRef`), on workspace pods and on the
 * project's registry and image-store objects. Registry NetworkPolicies and
 * the orphan GCs key on it, so a later project with the same slug can never
 * claim an object.
 */
export const LABEL_PROJECT_ID = 'yaac.project-id'
/**
 * The workspace a pod runs. Every list query, informer and NetworkPolicy
 * podSelector for workspace pods matches on it.
 */
export const LABEL_WORKSPACE_ID = 'yaac.workspace-id'
export const LABEL_DATA_DIR_HASH = 'yaac.data-dir-hash'
export const LABEL_TOOL = 'yaac.tool'
/**
 * The workspace's agent mode (`AgentMode`). Set only for `acp`; a pod
 * without it is `tui`. A label lets the status watcher pick its driver from
 * informer events without a database query per pod event.
 */
export const LABEL_MODE = 'yaac.mode'
/**
 * Marks a workspace pod as a prewarmed spare: provisioned with its agent
 * booted, but not yet handed to a user. Spares are hidden from user views,
 * and `workspace create` claims one by removing this label. Absent on
 * normal workspace pods.
 */
export const LABEL_PREWARMED = 'yaac.prewarmed'
/**
 * Marks a workspace pod that runs the in-pod container engine
 * (`nestedContainers`). Absent otherwise. A label lets the image salvage
 * step pick nested workspaces from informer data, which lacks the pod spec.
 */
export const LABEL_NESTED = 'yaac.nested'

/** The workspace-id stamp, for a writer labelling a workspace Job or Pod. */
export function workspaceIdLabels(workspaceId: string): Record<string, string> {
  return { [LABEL_WORKSPACE_ID]: workspaceId }
}

/**
 * Job name for a workspace. Names must be lowercase DNS-1123, and the
 * pods' `job-name` label caps them at 63 chars, leaving 21 for the slug
 * after `yaac-`, the UUID and a separator. The UUID makes it unique; the
 * full slug is in the `yaac.project` label.
 */
export function workspaceJobName(projectSlug: string, workspaceId: string): string {
  const safeSlug = projectSlug
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 21)
  return `yaac-${safeSlug}-${workspaceId}`.replace(/--+/g, '-')
}

/**
 * The workspace id from a workspace Job name: its last 36 chars, which
 * `workspaceJobName` never alters (a UUID has no consecutive dashes).
 */
export function workspaceIdFromJobName(jobName: string): string {
  if (jobName.length < 36) throw new Error(`not a workspace job name: ${jobName}`)
  return jobName.slice(-36)
}

/**
 * Why a dead or dying pod stopped. The stale reaper reads it to record a
 * death reason before teardown deletes the pod. Absent on healthy pods.
 */
export interface PodTerminalState {
  /** Pod-level `status.reason`, e.g. `Evicted`. */
  podReason?: string
  /** Pod-level `status.message` accompanying `podReason`. */
  podMessage?: string
  /** Workspace container's terminated exit code. */
  exitCode?: number
  /** Workspace container's terminated reason, e.g. `OOMKilled`. */
  containerReason?: string
  /** Workspace container's terminated `finishedAt` as epoch ms. */
  finishedAtMs?: number
}

export interface PodInfo {
  /** Job name (`yaac-<slug>-<workspaceId>`) — the stable workspace handle. */
  jobName: string
  /** Concrete Pod name (Job name + random suffix); needed for logs etc. */
  podName: string
  workspaceId: string
  projectSlug: string
  /** See LABEL_PROJECT_ID. */
  projectId: string
  tool: string
  /** `yaac.mode` when stamped; absent on every TUI pod (see LABEL_MODE). */
  mode?: string
  /** Pod phase: Pending | Running | Succeeded | Failed | Unknown. */
  phase: string
  /** True when the pod is Running and not terminating. */
  running: boolean
  /** The pod has a deletionTimestamp. Lets the UI show "terminating…"
   *  rather than dropping the workspace or treating it as stale. */
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

/** True when a pod runs the in-pod engine (carries the `yaac.nested` label). */
export function isNested(pod: PodInfo): boolean {
  return pod.labels[LABEL_NESTED] === 'true'
}

/**
 * Job-name label Kubernetes puts on every pod a Job creates (the prefixed
 * form, k8s 1.27+).
 */
export const JOB_NAME_LABEL = 'batch.kubernetes.io/job-name'

/**
 * Timestamps are ISO strings from kubectl and watch events, but `Date`s
 * from client-node list calls.
 */
const timestampSchema = z.union([z.string().min(1), z.date()])

function toEpochMs(ts: string | Date): number {
  return typeof ts === 'string' ? Date.parse(ts) : ts.getTime()
}

/**
 * Schema for a workspace pod. The API server guarantees name, timestamp and
 * phase, and workspace create sets the labels, so a failure means a yaac bug
 * or a hand-edited object, which every reader skips.
 */
const podItemSchema = z.object({
  metadata: z.object({
    name: z.string().min(1),
    labels: z.object({
      [JOB_NAME_LABEL]: z.string().min(1),
      [LABEL_WORKSPACE_ID]: z.string().min(1),
      [LABEL_PROJECT]: z.string().min(1),
      [LABEL_PROJECT_ID]: z.string().min(1),
      [LABEL_TOOL]: z.string().min(1),
    }).catchall(z.string()),
    creationTimestamp: timestampSchema,
    deletionTimestamp: timestampSchema.optional(),
  }),
  status: z.object({
    phase: z.string().min(1),
    // Terminal-state evidence: pod reason/message cover evictions, and
    // containerStatuses[0] (the workspace container) covers its exit.
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

type PodItem = z.infer<typeof podItemSchema>

/** Map a validated pod object to the PodInfo row the rest of yaac uses. */
function mapPodItem({ metadata, status }: PodItem): PodInfo {
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
    workspaceId: metadata.labels[LABEL_WORKSPACE_ID],
    projectSlug: metadata.labels[LABEL_PROJECT],
    projectId: metadata.labels[LABEL_PROJECT_ID],
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

/** Pods already reported as malformed, so a skip is logged once per pod
 *  rather than on every list and informer event. */
const reportedMalformed = new Set<string>()

/**
 * Validate+map one raw pod object; null = malformed. A skipped pod is
 * invisible to every reader, so its Job reads as having no pod and the
 * stale reaper tears it down; the log line names the pod and the fields
 * it lacks, so that reap can be traced.
 */
export function mapPodObject(obj: unknown): PodInfo | null {
  const res = podItemSchema.safeParse(obj)
  if (res.success) return mapPodItem(res.data)
  const name = (obj as { metadata?: { name?: string } } | null)?.metadata?.name ?? '<unnamed>'
  if (!reportedMalformed.has(name)) {
    reportedMalformed.add(name)
    const fields = res.error.issues.map((i) => i.path.join('.')).join(', ')
    serverLog(`[server] ignoring workspace pod ${name}: missing or invalid ${fields}`)
  }
  return null
}

const jobItemSchema = z.object({
  metadata: z.object({
    name: z.string().min(1),
    labels: z.object({
      [LABEL_WORKSPACE_ID]: z.string().min(1),
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
    workspaceId: metadata.labels[LABEL_WORKSPACE_ID],
    projectSlug: metadata.labels[LABEL_PROJECT],
    createdAtMs: toEpochMs(metadata.creationTimestamp),
  }
}

/**
 * List this install's workspace pods live, optionally for one project. A
 * malformed pod is skipped, as the informer skips it. Most callers want
 * `readWorkspacePods`, which answers from the watch when it can.
 */
export async function listWorkspacePods(projectFilter?: string): Promise<PodInfo[]> {
  const items = await listObjects<unknown>('v1', 'Pod', {
    namespace: k8sNamespace(), labelSelector: workspacePodSelector(projectFilter),
  })
  return items.flatMap((item) => mapPodObject(item) ?? [])
}

/** The label selector `listWorkspacePods` and the pod watcher share. */
export function workspacePodSelector(projectFilter?: string): string {
  return [
    `${LABEL_DATA_DIR_HASH}=${dataDirHash()}`,
    `${LABEL_WORKSPACE_ID}`,
    ...(projectFilter ? [`${LABEL_PROJECT}=${projectFilter}`] : []),
  ].join(',')
}

/**
 * The pod for a workspace id. Unclaimed spares are skipped unless
 * `spares` is set (teardown needs to reach a failed spare).
 */
export function findWorkspacePod(
  pods: PodInfo[],
  workspaceId: string,
  opts: { spares?: boolean } = {},
): PodInfo | undefined {
  return pods.find((p) => p.workspaceId === workspaceId && (opts.spares === true || !isPrewarmed(p)))
}

export interface JobInfo {
  jobName: string
  workspaceId: string
  projectSlug: string
  createdAtMs: number
}

/**
 * List this install's workspace Jobs live. A Job whose pod was deleted is
 * invisible to the pod listing, so teardown and the orphan-Job sweep need
 * this too.
 */
export async function listWorkspaceJobs(): Promise<JobInfo[]> {
  const items = await listObjects<unknown>('batch/v1', 'Job', {
    namespace: k8sNamespace(), labelSelector: workspaceJobSelector(),
  })
  return items.flatMap((item) => mapJobObject(item) ?? [])
}

/** The label selector `listWorkspaceJobs` and the Jobs informer share. */
export function workspaceJobSelector(): string {
  return `${LABEL_DATA_DIR_HASH}=${dataDirHash()},${LABEL_WORKSPACE_ID}`
}
