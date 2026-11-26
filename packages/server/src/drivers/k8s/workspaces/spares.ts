import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { globalPath } from '@yaac/shared/paths'
import {
  LABEL_INSTALL_ID,
  LABEL_PREWARMED,
  LABEL_PROJECT_ID,
  LABEL_WORKSPACE_ID,
  applyObject,
  deleteObject,
  installId,
  k8sNamespace,
  listObjects,
  podStreamToken,
  removeLabelIf,
  workspaceIdLabels,
  workspaceJobName,
} from '#drivers/k8s/substrate'
import { env as yaacEnv } from '@yaac/shared/env'
import { serverLog } from '#lib/log'
import {
  mountdKeepReady,
  mountdReports,
  nodeUnreadyReason,
  mountdImage,
  readyNodes,
  serverBuild,
} from '#drivers/k8s/cluster'
import { proxyClient, workspaceSshEnv } from '#drivers/k8s/egress'
import type { SpareUnit, WorkspaceResources } from '#drivers/contract'
import { SCRATCH_BYTES_ANNOTATION, buildPodJobManifest, helpersSubPath, type PodJobParams } from './pod-job'
import { treeImage } from './tree-mounts'

/**
 * Generic spare workspace pods (docs/generic-workspace-pods.md "Pool
 * policy"): pods that belong to no project, one pool per image and scratch
 * size, which a start takes before it names its workspace, so the spare's
 * id becomes the workspace's.
 *
 * A spare carries `yaac.prewarmed` and no project label, so no workspace
 * listing sees it. Taking one removes `yaac.prewarmed` in one conditional
 * write, which a second concurrent take is refused by; the launch that
 * follows, once its workspace's row exists, gives it its project label. A
 * pod with neither label that this process did not take is a take a dead
 * server left, and is reaped with the spares.
 */

/** Spares this process took, by job name, with their pods, images and
 *  node-mounts dirs, until their launch adopts them. */
export const taken = new Map<string, { podName: string; node: string; image: string; nodeMountsDir: string }>()

/** A spare's CPU request while it waits. It reserves a workspace's memory
 *  from creation, since a memory request cannot be raised in place on a
 *  node with swap, but its CPU request is raised to a workspace's at the
 *  take (docs/generic-workspace-pods.md "Cost"). */
export const SPARE_CPU_REQUEST_MILLIS = 100

/** How long a start waits for a node whose mountd is ready, about as long
 *  as a rolling update takes to replace one mountd pod. */
const NODE_WAIT_MS = 120_000

/** The nodes a new pod may run on, waiting a while for one; refuses with
 *  each node's reason when none is ready. `only` narrows them to one. */
export async function startNodes(only?: string): Promise<string[]> {
  const deadline = Date.now() + NODE_WAIT_MS
  for (;;) {
    const nodes = readyNodes().filter((n) => only === undefined || n === only)
    if (nodes.length > 0) return nodes
    if (Date.now() > deadline) {
      const named = only ?? 'any node'
      throw new Error(`no node can take a new workspace (${named}: ${only !== undefined ? nodeUnreadyReason(only) ?? 'not ready' : 'no mountd is ready'}); `
        + 'see `kubectl get pods -l app=yaac-mountd` and docs/generic-workspace-pods.md "When mountd is not there"')
    }
    await new Promise((r) => setTimeout(r, 1_000))
  }
}

/** A fresh node-mounts dir name for a pod of `workspaceId`: one life's,
 *  never reused. */
export function newNodeMountsDir(workspaceId: string): string {
  return `${workspaceId}.${crypto.randomBytes(4).toString('hex')}`
}

/** What every workspace pod's spec holds: the transport token, CA trust,
 *  ssh's route to the proxy and the workspace id. */
export async function genericEnv(workspaceId: string): Promise<string[]> {
  return [
    // Only CA trust: interception is transparent, so no HTTP(S)_PROXY vars.
    ...proxyClient.getCaTrustEnv(),
    `YAAC_STREAM_TOKEN=${await podStreamToken(workspaceId)}`,
    `YAAC_WORKSPACE_ID=${workspaceId}`,
    // The proxy ends ssh sessions to the project's git hosts and checks
    // their host keys itself, so a workspace needs only an ssh that reaches
    // the proxy and trusts it.
    ...workspaceSshEnv(),
  ]
}

/** The parts of a pod's manifest that are the same for a spare and a pod
 *  made on demand. */
export async function genericPodParams(args: {
  workspaceId: string
  image: string
  scratchBytes: number
  resources: WorkspaceResources
  nodeMountsDir: string
  labels: Record<string, string>
  nodes: string[]
  tree: boolean
}): Promise<PodJobParams> {
  const [netshimImage, build, tree, env] = await Promise.all([
    mountdImage(),
    serverBuild(),
    args.tree ? treeImage() : Promise.resolve(undefined),
    genericEnv(args.workspaceId),
  ])
  return {
    jobName: workspaceJobName(args.workspaceId),
    namespace: k8sNamespace(),
    labels: args.labels,
    image: args.image,
    env,
    nodeMountsDir: args.nodeMountsDir,
    helpers: helpersSubPath(build),
    scratchBytes: args.scratchBytes,
    ...args.resources,
    netshimImage,
    ...(tree !== undefined ? { treeImage: tree } : {}),
    nodeNames: args.nodes,
  }
}

interface SparePodRow {
  metadata?: {
    name?: string
    labels?: Record<string, string>
    annotations?: Record<string, string>
    creationTimestamp?: string | Date
    deletionTimestamp?: string | Date
  }
  spec?: { nodeName?: string; containers?: Array<{ image?: string }> }
  status?: { phase?: string; conditions?: Array<{ type?: string; status?: string }> }
}

/** How long a spare's Job may wait for the Job controller to make its pod
 *  before it counts as failed. */
const PODLESS_GRACE_MS = 60_000

type SpareJobRow = { metadata?: { labels?: Record<string, string>; creationTimestamp?: string | Date } }

/**
 * This install's spares, the takes a dead server left, and the per-project
 * spares an older server made. A spare Job with no pod is pending, then
 * listed as failed once past PODLESS_GRACE_MS, for the pool to reap.
 *
 * An older server's spare is a pod with `yaac.prewarmed` and its project's
 * label together, which no spare or take of this server ever is: a take
 * removes the first before a launch adds the second. Only pods are read,
 * since an older server's claim left the label on its workspace's Job
 * (docs/legacy-compat-shims.md).
 */
export async function listSpares(): Promise<SpareUnit[]> {
  const selector = { namespace: k8sNamespace(), labelSelector: `${LABEL_INSTALL_ID}=${installId()},${LABEL_WORKSPACE_ID},!${LABEL_PROJECT_ID}` }
  const older = { namespace: k8sNamespace(), labelSelector: `${LABEL_INSTALL_ID}=${installId()},${LABEL_PREWARMED}=true,${LABEL_PROJECT_ID}` }
  const [pods, jobs, olderPods] = await Promise.all([
    listObjects<SparePodRow>('v1', 'Pod', selector),
    listObjects<SpareJobRow>('batch/v1', 'Job', selector),
    listObjects<SparePodRow>('v1', 'Pod', older),
  ])
  const olderUnits = new Map<string, SpareUnit>()
  for (const o of olderPods) {
    const workspaceId = o.metadata?.labels?.[LABEL_WORKSPACE_ID]
    const projectId = o.metadata?.labels?.[LABEL_PROJECT_ID]
    if (workspaceId === undefined || projectId === undefined) continue
    const created = o.metadata?.creationTimestamp
    olderUnits.set(workspaceId, {
      workspaceId, jobName: workspaceJobName(workspaceId), image: '', scratchBytes: 0,
      createdAtMs: created === undefined ? 0 : new Date(created).getTime(), ready: false, failed: false, orphaned: false, projectId,
    })
  }
  const podless = jobs.flatMap((j): SpareUnit[] => {
    const workspaceId = j.metadata?.labels?.[LABEL_WORKSPACE_ID]
    if (workspaceId === undefined || taken.has(workspaceJobName(workspaceId))) return []
    if (pods.some((p) => p.metadata?.labels?.[LABEL_WORKSPACE_ID] === workspaceId)) return []
    const created = j.metadata?.creationTimestamp
    const createdAtMs = created === undefined ? 0 : new Date(created).getTime()
    const failed = Date.now() - createdAtMs > PODLESS_GRACE_MS
    return [{
      workspaceId, jobName: workspaceJobName(workspaceId), image: '', scratchBytes: 0,
      createdAtMs, ready: false, failed, orphaned: false, ...(failed ? {} : { pending: true as const }),
    }]
  })
  return [...olderUnits.values(), ...podless, ...pods.flatMap((p): SpareUnit[] => {
    const labels = p.metadata?.labels ?? {}
    const workspaceId = labels[LABEL_WORKSPACE_ID]
    if (workspaceId === undefined) return []
    const jobName = workspaceJobName(workspaceId)
    const prewarmed = labels[LABEL_PREWARMED] === 'true'
    // One this process took is a start's, not a spare.
    if (!prewarmed && taken.has(jobName)) return []
    const created = p.metadata?.creationTimestamp
    const phase = p.status?.phase ?? 'Pending'
    return [{
      workspaceId,
      jobName,
      image: p.spec?.containers?.[0]?.image ?? '',
      scratchBytes: Number(p.metadata?.annotations?.[SCRATCH_BYTES_ANNOTATION] ?? 0),
      ...(p.spec?.nodeName !== undefined ? { node: p.spec.nodeName } : {}),
      createdAtMs: created === undefined ? 0 : new Date(created).getTime(),
      ready: p.metadata?.deletionTimestamp === undefined
        && (p.status?.conditions ?? []).some((c) => c.type === 'Ready' && c.status === 'True'),
      failed: phase === 'Failed' || phase === 'Succeeded' || p.metadata?.deletionTimestamp !== undefined,
      orphaned: !prewarmed,
    }]
  })]
}

/** Start a spare for one image and scratch size. Returns its id. */
export async function warmSpare(args: { image: string; scratchBytes: number; resources: WorkspaceResources }): Promise<string> {
  const workspaceId = crypto.randomUUID()
  const nodes = readyNodes()
  if (nodes.length === 0) throw new Error('no mountd is ready, so a spare would have nowhere to be claimed')
  const labels = {
    ...workspaceIdLabels(workspaceId),
    [LABEL_INSTALL_ID]: installId(),
    [LABEL_PREWARMED]: 'true',
  }
  const params = await genericPodParams({
    workspaceId, image: args.image, scratchBytes: args.scratchBytes,
    resources: { ...args.resources, cpuRequestMillis: SPARE_CPU_REQUEST_MILLIS },
    nodeMountsDir: newNodeMountsDir(workspaceId), labels, nodes, tree: true,
  })
  await applyObject(buildPodJobManifest(params))
  return workspaceId
}

/**
 * Take a ready spare of `image` and `scratchBytes`, made at `madeSince` or
 * later, on a node whose mountd is ready, newest first, and return its id,
 * or undefined when none can be taken. The take is the conditional removal
 * of `yaac.prewarmed`, which a concurrent take, or a reap, of the same
 * spare loses.
 */
export async function takeSpare(args: { image: string; scratchBytes: number; madeSince: number }): Promise<string | undefined> {
  const ready = new Set(readyNodes())
  const candidates = (await listSpares())
    .filter((s) => !s.orphaned && s.ready && !s.failed && s.projectId === undefined && s.createdAtMs >= args.madeSince
      && s.image === args.image && s.scratchBytes === args.scratchBytes && s.node !== undefined && ready.has(s.node))
    .sort((a, b) => b.createdAtMs - a.createdAtMs)
  for (const spare of candidates) {
    const pods = await listObjects<SparePodRow>('v1', 'Pod', {
      namespace: k8sNamespace(), labelSelector: `${LABEL_WORKSPACE_ID}=${spare.workspaceId},${LABEL_PREWARMED}=true`,
    })
    const pod = pods[0]
    const podName = pod?.metadata?.name
    const volume = (pod as { spec?: { volumes?: Array<{ name?: string; hostPath?: { path?: string } }> } } | undefined)
      ?.spec?.volumes?.find((v) => v.name === 'node-mounts')?.hostPath?.path
    if (podName === undefined || volume === undefined || spare.node === undefined) continue
    try {
      await removeLabelIf({ apiVersion: 'v1', kind: 'Pod', name: podName, namespace: k8sNamespace() }, LABEL_PREWARMED, 'true')
    } catch {
      // Taken by a concurrent start, or gone.
      continue
    }
    taken.set(spare.jobName, { podName, node: spare.node, image: spare.image, nodeMountsDir: volume.slice(volume.lastIndexOf('/') + 1) })
    return spare.workspaceId
  }
  return undefined
}

/**
 * Delete a spare, or a taken pod no launch adopted. A spare has no files
 * and no row, so its Job is all there is. With `ifSpare`, the reap first
 * removes `yaac.prewarmed` the way a take does, so of a reap and a take of
 * one spare only one wins; one already taken, or gone, is left alone.
 */
export async function reapSpare(workspaceId: string, opts: { ifSpare?: boolean } = {}): Promise<void> {
  const jobName = workspaceJobName(workspaceId)
  if (opts.ifSpare === true) {
    if (taken.has(jobName)) return
    const [pod] = await listObjects<SparePodRow>('v1', 'Pod', {
      namespace: k8sNamespace(), labelSelector: `${LABEL_WORKSPACE_ID}=${workspaceId},${LABEL_PREWARMED}=true`,
    })
    const podName = pod?.metadata?.name
    if (podName === undefined) return
    try {
      await removeLabelIf({ apiVersion: 'v1', kind: 'Pod', name: podName, namespace: k8sNamespace() }, LABEL_PREWARMED, 'true')
    } catch {
      return
    }
  }
  taken.delete(jobName)
  await deleteObject({ apiVersion: 'batch/v1', kind: 'Job', name: jobName, namespace: k8sNamespace() }, { gracePeriodSeconds: 0 })
}

/**
 * Tell each node's mountd which trees to keep ready: the given ones on a
 * node that holds a spare, which is where a take lands, and none elsewhere
 * or on a node under the disk warn floor, so nothing is built ahead of
 * time there (docs/generic-workspace-pods.md "Trees").
 */
export async function keepReadyTrees(trees: Array<{ repoId: string; commit: string }>): Promise<void> {
  const holding = new Set((await listSpares()).flatMap((s) => (!s.failed && s.node !== undefined ? [s.node] : [])))
  const warnBytes = yaacEnv.diskWarnFloorGiB * 1024 ** 3
  await Promise.all([...mountdReports()].map(async ([node, report]) => {
    const want = holding.has(node) && report.freeBytes >= warnBytes ? trees.map((t) => ({ repo: t.repoId, commit: t.commit })) : []
    await mountdKeepReady(node, want).catch((err: unknown) => {
      serverLog(`[ready-trees] telling node ${node}'s agent failed: ${String(err)}`)
    })
  }))
}

/**
 * Remove another build's helpers folder once no pod of this install mounts
 * it: running workspaces keep the folder of the build that made them
 * (docs/generic-workspace-pods.md "Server restarts and upgrades").
 */
export async function reconcileHelpersGc(): Promise<void> {
  const root = globalPath('run', 'helpers')
  const builds = await fs.readdir(root).catch(() => [] as string[])
  if (builds.length === 0) return
  const pods = await listObjects<{ spec?: { containers?: Array<{ volumeMounts?: Array<{ name?: string; subPath?: string }> }> } }>('v1', 'Pod', {
    namespace: k8sNamespace(), labelSelector: `${LABEL_INSTALL_ID}=${installId()},${LABEL_WORKSPACE_ID}`,
  })
  const used = new Set([helpersSubPath(await serverBuild())])
  for (const p of pods) {
    for (const m of p.spec?.containers?.[0]?.volumeMounts ?? []) if (m.name === 'helpers' && m.subPath) used.add(m.subPath)
  }
  for (const build of builds) {
    // A folder being staged is renamed into place when it is whole.
    if (used.has(helpersSubPath(build)) || build.includes('.tmp-')) continue
    await fs.rm(path.join(root, build), { recursive: true, force: true }).catch((err: unknown) => {
      serverLog(`[helpers] removing build ${build}'s helpers failed: ${String(err)}`)
    })
  }
}
