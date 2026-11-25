import fs from 'node:fs/promises'
import path from 'node:path'
import {
  LABEL_NPM_CACHE,
  LABEL_PREWARMED,
  LABEL_INSTALL_ID,
  LABEL_PROJECT_ID,
  LABEL_SITE_ID,
  LABEL_WORKSPACE_ID,
  PRIORITY_CLASS_RELEASE,
  applyObject,
  findWorkspacePod,
  installId,
  k8sNamespace,
  k8sWorkspacePaths,
  listObjects,
  deleteObject,
  patchObject,
  podClaim,
  podStreamToken,
  readWorkspacePods,
  resizePodCpu,
  storageTierOf,
  volumeClaimName,
  waitForJobPodReady,
  workspaceIdLabels,
  workspaceJobName,
} from '#drivers/k8s/substrate'
import { CONTAINER_TMUX_DIR } from '@yaac/shared/paths'
import { LIVES_DIR, START_FILE, type StartInstruction } from '@yaac/shared/tree-records'
import { env as yaacEnv } from '@yaac/shared/env'
import {
  LOCAL_ROOT,
  SCRATCH_ROOT,
  buildPodJobManifest,
  treeStartedMarker,
  type ClaimMount,
} from './pod-job'
import { genericPodParams, newNodeMountsDir, startNodes, taken } from './spares'
import {
  ensureUtilityImage,
  mountdBind,
  proxyServiceClusterIp,
  runSecretsName,
  servingNpmCacheUrl,
} from '#drivers/k8s/cluster'
import {
  applyProxyRegistration,
  buildProxyRegistration,
  proxyClient,
  type ProxyRegistration,
} from '#drivers/k8s/egress'
import { hostMatchesPattern } from '@yaac/shared/allowed-hosts'
import { serverLog } from '#lib/log'
import type { SecretProxyRule, ProjectConfig } from '@yaac/shared/types'
import type {
  RuntimeHandle,
  SubstrateIntent,
  WorkspaceMount,
  WorkspaceSpec,
  WorkspaceSubstrate,
} from '#drivers/contract'

/**
 * How the k8s driver starts a workspace (docs/generic-workspace-pods.md).
 *
 * `prepareWorkspaceSubstrate` runs once per create and sets up what the
 * workspace owns (its proxy registration). `launchWorkspace` runs per
 * attempt: it adopts the spare its start took, or applies a generic pod made
 * on demand, so a failed attempt leaves just a Job to delete
 * (`destroyWorkspace` with `unitOnly`). `awaitWorkspaceReady` then makes the
 * pod its workspace's: mountd mounts and binds everything the
 * workspace owns, and streamd's claim call sets its environment and opens
 * its session.
 */

/**
 * What `prepareWorkspaceSubstrate` set up, for `launchWorkspace` to use.
 * Opaque to callers: it travels on the spec and is narrowed here.
 */
interface K8sWorkspaceSubstrate extends WorkspaceSubstrate {
  /** Proxy Service ClusterIP: the pod's DNS resolver and egress target. */
  proxyHost: string
  /** The per-workspace token streamd's handshake requires. */
  streamToken: string
  /** The pod is labelled for npm-cache access, whether or not the cache is
   *  serving right now. */
  npmCacheAllowed: boolean
  /** The install's npm cache, when this workspace installs through it. */
  npmRegistry: string | null
  /** The workspace's proxy registration. Applied by `launch` just before the
   *  Job, so a prepare overlapping a long image build never leaves a
   *  registration with no pod behind it. */
  registration: ProxyRegistration
}

function narrow(substrate: WorkspaceSubstrate): K8sWorkspaceSubstrate {
  // Check `proxyHost` rather than `kind`: a foreign stub also carries
  // `kind`, and a missing proxyHost would otherwise produce a pod that
  // cannot resolve anything instead of an error here.
  const k8s = substrate as Partial<K8sWorkspaceSubstrate>
  if (typeof k8s.proxyHost !== 'string') {
    throw new Error(
      'launchWorkspace was handed a workspace receipt the k8s runtime did not '
      + 'prepare — the spec must carry the one its own prepareSubstrate returned',
    )
  }
  return substrate as K8sWorkspaceSubstrate
}

/** Set up what a workspace needs around it: its egress registration. */
export async function prepareWorkspaceSubstrate(
  intent: SubstrateIntent,
): Promise<WorkspaceSubstrate> {
  const { projectId, workspaceId, config } = intent
  const emit = (m: string): void => intent.onProgress?.(m)

  // The proxy injects GitHub / Claude / Codex tokens into outbound HTTPS.
  // Ensure it before building the registration, so a stale proxy is rolled
  // first and never misses the registration object.
  emit('Ensuring proxy deployment...')
  await proxyClient.ensureRunning()

  // netd's per-pod DNAT rules (k8s/netd) redirect the pod's outbound 443/80
  // to the proxy, which identifies the workspace by source pod IP. The pod
  // also uses the proxy as its DNS resolver and SSH tunnel endpoint. The
  // ClusterIP is allocator-assigned, so read it live; the Service is never
  // recreated.
  const proxyHost = await proxyServiceClusterIp()

  // Derived from the install's proxy secret, so nothing is stored. Only the
  // proxy can reach streamd, and the token opens only this pod's daemon.
  const streamToken = await podStreamToken(workspaceId)

  // Secret-injection rules and allowlist; written by `launch`. Git, GitHub,
  // Claude and Codex auth need no per-workspace rule: the proxy resolves
  // them from the owner's credentials by the registration's project. Rules name
  // their values, which already sit in the project's secrets object
  // (`syncProjectSecrets`).
  const registration = buildProxyRegistration({
    allowlist: intent.allowlist,
    projectId,
    owner: intent.owner,
    secretRules: intent.proxySecretRules,
  })

  // A failed lookup just skips the cache; npmjs serves the same packages.
  const npmCacheAllowed = npmCacheApplies(config, registration.allowedHosts, intent.proxySecretRules)
  const npmRegistry = npmCacheAllowed ? await servingNpmCacheUrl().catch(() => null) : null

  const receipt: K8sWorkspaceSubstrate = {
    kind: 'workspace-substrate',
    proxyHost,
    streamToken,
    npmCacheAllowed,
    npmRegistry,
    registration,
  }
  return receipt
}

/** The registry the npm cache stands in for. */
const NPMJS_HOST = 'registry.npmjs.org'

/**
 * Whether a workspace may use the npm cache. Not when the project sets
 * `npmCache: false`; not when its allowlist excludes npmjs (the cache
 * fetches outside the egress proxy); and not when the project
 * authenticates to npmjs through a proxied secret (the cache fetches
 * anonymously, so private packages would break). A token in the project's
 * own `.npmrc` is the project's concern (docs/workspace-storage.md).
 */
export function npmCacheApplies(
  config: ProjectConfig,
  allowedHosts: string[],
  secretRules: Record<string, SecretProxyRule>,
): boolean {
  if (config.npmCache === false) return false
  const allowed = allowedHosts.includes('*')
    || allowedHosts.some((pattern) => hostMatchesPattern(NPMJS_HOST, pattern))
  const authenticated = Object.values(secretRules)
    .some((rule) => rule.hosts.some((pattern) => hostMatchesPattern(NPMJS_HOST, pattern)))
  return allowed && !authenticated
}

/** The node a workspace's pod was scheduled on, if it has one. */
async function workspaceNode(workspaceId: string): Promise<string | undefined> {
  const pods = await listObjects<{ spec?: { nodeName?: string } }>('v1', 'Pod', {
    namespace: k8sNamespace(), labelSelector: `${LABEL_WORKSPACE_ID}=${workspaceId}`,
  })
  return pods.find((p) => p.spec?.nodeName !== undefined)?.spec?.nodeName
}

/**
 * What a pod is told when it becomes its workspace's: streamd's `claim`
 * request (dockerfiles/streamd/claim.js). The caller's variables go into
 * the tmux server's environment, so every window inherits them and no
 * object in the cluster holds them; the identity, trusted checkouts, cwd
 * and status line are read from them, as the containerless driver does.
 */
interface ClaimRequest {
  env: Record<string, string>
  git: { name: string; email: string; safeDirectories: string[] }
  npmRegistry?: string
  cwd: string
  statusRight: string
}

function claimRequest(spec: WorkspaceSpec, substrate: K8sWorkspaceSubstrate): ClaimRequest {
  const { workspaceDir } = k8sWorkspacePaths()
  const vars: Record<string, string> = {}
  for (const entry of spec.env) {
    const eq = entry.indexOf('=')
    if (eq > 0) vars[entry.slice(0, eq)] = entry.slice(eq + 1)
  }
  // One pnpm store per workspace: pnpm indexes the store in a SQLite WAL
  // database, which cannot be shared across pods. Put it inside the root
  // node_modules when that is a scratch dir, so pnpm hardlinks rather than
  // copies; otherwise on the pod's own disk. Set under both names: pnpm 11+
  // reads only `pnpm_config_` for this key, pnpm 10 only `npm_config_`.
  const rootModules = `${workspaceDir}/node_modules`
  const store = spec.scratchDirs.includes(rootModules)
    ? `${rootModules}/.pnpm-store`
    : '/home/yaac/.local/share/pnpm/store'
  vars.pnpm_config_store_dir = store
  vars.npm_config_store_dir = store
  return {
    env: vars,
    git: {
      name: vars.YAAC_GIT_NAME ?? '',
      email: vars.YAAC_GIT_EMAIL ?? '',
      safeDirectories: (vars.YAAC_CHECKOUTS ?? '').split(':').filter((c) => c !== '')
        .map((c) => (c === '.' ? workspaceDir : `${workspaceDir}/${c}`)),
    },
    ...(substrate.npmRegistry ? { npmRegistry: substrate.npmRegistry } : {}),
    cwd: spec.cwd === '' ? workspaceDir : `${workspaceDir}/${spec.cwd}`,
    statusRight: vars.YAAC_STATUS_RIGHT ?? '',
  }
}

/** A launched Job, until its pod is its workspace's. */
interface Launch {
  spec: WorkspaceSpec
  claim: ClaimRequest
  nodeMountsDir: string
}

const launches = new Map<string, Launch>()
/** How long a launched pod may take to be ready. */
const READY_TIMEOUT_MS = 180_000
/** How long a claim waits for its tree container: a restore of a large
 *  repository the agent cloned can take hours. */
const RESTORE_WAIT_MS = 4 * 60 * 60_000
const FILL_WAIT_MS = 10 * 60_000
/** Between looks for a life's start instruction, written on the shared
 *  tier once every checkout's `.git` exists. */
const START_POLL_MS = 50

/** A byo volume's own claim among the spec's mounts: kubelet must attach
 *  it, so it stays in the pod's spec, and the pod is made on demand. */
function claimMountsOf(spec: WorkspaceSpec): ClaimMount[] {
  if (yaacEnv.volumeStorageClass === undefined) return []
  return spec.mounts.flatMap((m) => (m.source.kind === 'volume'
    ? [{ claimName: volumeClaimName(m.source.volumeId), mountPath: m.mountPath }]
    : []))
}

/**
 * Launch the workspace's pod and return a handle for it: the spare its
 * start took, given its project label now that its row exists, or a pod
 * made on demand. The egress registration is written by then, so the pod
 * never runs as the workspace without it.
 */
export async function launchWorkspace(spec: WorkspaceSpec): Promise<RuntimeHandle> {
  const substrate = narrow(spec.substrate)
  const jobName = workspaceJobName(spec.workspaceId)
  // The contract makes `image` optional for runtimes that run none; here a
  // missing one means the create chose no image, a wiring bug.
  if (!spec.image) throw new Error(`launch ${jobName}: no image on the spec`)
  const claim = claimRequest(spec, substrate)
  // A run secret is the pod's own variable, which tmux's would hide.
  const shadowed = spec.runSecrets?.find((name) => name in claim.env)
  if (shadowed !== undefined) throw new Error(`run secret ${shadowed} shares its name with another variable`)

  const labels: Record<string, string> = {
    [LABEL_PROJECT_ID]: spec.projectId,
    ...workspaceIdLabels(spec.workspaceId),
    [LABEL_INSTALL_ID]: installId(),
    // Both of the npm cache's workspace policies select on this.
    ...(substrate.npmCacheAllowed ? { [LABEL_NPM_CACHE]: 'true' } : {}),
    // A site's release: its ingress policy admits the router, the router
    // may dial it, and the proxy refuses its calls to the server.
    ...(spec.siteId !== undefined ? { [LABEL_SITE_ID]: spec.siteId } : {}),
  }
  const claimMounts = claimMountsOf(spec)
  let spare = taken.get(jobName)
  // Run secrets, a byo volume's claim and a release's priority live in the
  // pod's spec, which a spare cannot take on, and an image built since the
  // take is not the spare's: the spare goes, and the pod is made on demand
  // under the same name. Its pod is waited out too, or the pool would see
  // it as an orphan of this id and reap the new Job.
  if (spare !== undefined && (spare.image !== spec.image
    || (spec.runSecrets?.length ?? 0) > 0 || claimMounts.length > 0 || spec.siteId !== undefined)) {
    const { podName } = spare
    spare = undefined
    await Promise.all([
      deleteObject({ apiVersion: 'batch/v1', kind: 'Job', name: jobName, namespace: k8sNamespace() }, { wait: true, gracePeriodSeconds: 0 }),
      deleteObject({ apiVersion: 'v1', kind: 'Pod', name: podName, namespace: k8sNamespace() }, { wait: true, gracePeriodSeconds: 0 }),
    ])
    taken.delete(jobName)
  }
  let nodeMountsDir: string
  if (spare !== undefined) {
    nodeMountsDir = spare.nodeMountsDir
    const pod = { apiVersion: 'v1', kind: 'Pod', name: spare.podName, namespace: k8sNamespace() }
    // Nothing in a spare reaches out until its claim call, so the
    // registration is written beside its labels.
    await Promise.all([
      applyProxyRegistration(spec.workspaceId, substrate.registration),
      patchObject(pod, { metadata: { labels } }),
      // The take removed the pod's spare label; the Job's goes here.
      patchObject({ apiVersion: 'batch/v1', kind: 'Job', name: jobName, namespace: k8sNamespace() }, { metadata: { labels: { ...labels, [LABEL_PREWARMED]: null } } }),
      // A workspace's share of a busy node; the spare idled on less. A
      // failure leaves it working on the spare's.
      resizePodCpu(pod, 'workspace', spec.resources.cpuRequestMillis).catch((err: unknown) => {
        serverLog(`[workspace] ${spec.workspaceId}: raising its CPU request failed: ${String(err)}`)
      }),
    ])
    taken.delete(jobName)
  } else {
    await applyProxyRegistration(spec.workspaceId, substrate.registration)
    nodeMountsDir = newNodeMountsDir(spec.workspaceId)
    // A claim (byo) may attach on one node only, and during a deploy's
    // handoff both releases mount it (docs/public-sites.md). A holder not
    // scheduled yet could still land elsewhere, so the launch is refused
    // rather than left to hang on the attach.
    let only: string | undefined
    if (spec.colocateWith !== undefined && claimMounts.length > 0) {
      only = await workspaceNode(spec.colocateWith)
      if (only === undefined) {
        throw new Error(`workspace ${spec.colocateWith.slice(0, 8)}, which holds the volume, is not on a node yet; deploy again once it is`)
      }
    }
    const params = await genericPodParams({
      workspaceId: spec.workspaceId,
      image: spec.image,
      scratchBytes: spec.scratchBytes,
      resources: spec.resources,
      nodeMountsDir,
      labels,
      nodes: await startNodes(only),
      tree: spec.tree !== undefined,
    })
    spec.onProgress?.(`Creating workspace job ${jobName}...`)
    await applyObject(buildPodJobManifest({
      ...params,
      ...(spec.runSecrets !== undefined ? { secretEnv: { secretName: runSecretsName(spec.projectId), names: spec.runSecrets } } : {}),
      ...(claimMounts.length > 0 ? { claimMounts, utilityImage: await ensureUtilityImage() } : {}),
      ...(spec.siteId !== undefined ? { priorityClassName: PRIORITY_CLASS_RELEASE } : {}),
    }))
  }
  launches.set(jobName, { spec, claim, nodeMountsDir })
  return {
    workspaceId: spec.workspaceId,
    projectId: spec.projectId,
    jobName,
    // The caller's next step, `awaitReady`, waits for the pod.
    running: false,
    state: 'pending',
    labels,
    createdAtMs: Date.now(),
    terminating: false,
    deathCause: { reason: 'pod-stopped' },
  }
}

/** A life's start instruction, once the domain has written it. */
async function awaitStartInstruction(spec: WorkspaceSpec, deadline: number): Promise<StartInstruction> {
  const tree = spec.tree
  if (tree === undefined) throw new Error('a life with no tree has no start instruction')
  const file = path.join(tree.checkpointsDir, LIVES_DIR, tree.life, START_FILE)
  for (;;) {
    const text = await fs.readFile(file, 'utf8').catch(() => null)
    if (text !== null) {
      try {
        const start = JSON.parse(text) as StartInstruction
        if (start.life === tree.life && Array.isArray(start.checkouts)) return start
      } catch { /* written partway: read again */ }
    }
    if (Date.now() > deadline) throw new Error(`no start instruction for life ${tree.life} after ${String(FILL_WAIT_MS / 60_000)} minutes`)
    await new Promise((r) => setTimeout(r, START_POLL_MS))
  }
}

/** One mount of a bind request (k8s/mountd/cmd/mountd/mountd.go `bindMount`). */
interface BindMount {
  tier: string
  path: string
  workspace?: string
  tree?: string
  readOnly?: boolean
}

/**
 * mountd's request for one pod (k8s/mountd/cmd/mountd/mountd.go
 * `bindRequest`): the trees to take or build, the node-local folders to
 * make, and every mount, in order, each with where the workspace container
 * and the tree container see it.
 */
export function bindRequest(args: {
  spec: WorkspaceSpec
  start: StartInstruction | undefined
  podName: string
  nodeMountsDir: string
}): Record<string, unknown> {
  const { spec, start } = args
  const root = k8sWorkspacePaths().workspaceDir
  const mounts: BindMount[] = []
  const dirs: string[] = []
  const folders: Array<{ from: 'scratch' | 'local'; target: string }> = []
  const rel = (p: string): string => storageTierOf({ kind: 'hostPath', path: p }).path
  const add = (source: WorkspaceMount['source'], targets: { workspace?: string; tree?: string }, readOnly = false): void => {
    const { tier, path: at } = storageTierOf(source)
    if (tier === 'node') dirs.push(at)
    const same = mounts.find((m) => m.tier === tier && m.path === at && (m.readOnly ?? false) === readOnly
      && (targets.workspace === undefined || m.workspace === undefined) && (targets.tree === undefined || m.tree === undefined))
    if (same !== undefined) {
      if (targets.workspace !== undefined) same.workspace = targets.workspace
      if (targets.tree !== undefined) same.tree = targets.tree
      return
    }
    mounts.push({ tier, path: at, ...targets, ...(readOnly ? { readOnly } : {}) })
  }
  const trees: Array<Record<string, string>> = []
  const tree = spec.tree
  if (tree !== undefined && start !== undefined) {
    const treeDir = path.posix.join(tree.lifeDir, 'tree')
    const scratch = path.posix.join(tree.lifeDir, 'scratch')
    // Outermost first: a checkout in a folder is moved into the tree a
    // checkout at the root already made.
    for (const c of [...start.checkouts].sort((a, b) => a.path.split('/').length - b.path.split('/').length || a.path.length - b.path.length)) {
      trees.push({
        repo: c.id,
        commit: c.commit,
        dest: rel(path.posix.join(treeDir, c.path)),
        index: rel(path.posix.join(scratch, 'arborist', `${c.id}.index`)),
      })
    }
    add({ kind: 'hostPath', path: treeDir }, { workspace: root, tree: '/tree' })
    add({ kind: 'hostPath', path: scratch }, { tree: '/scratch' })
    add({ kind: 'hostPath', path: tree.checkpointsDir }, { tree: '/ckpt' })
    for (const c of tree.checkouts) {
      add({ kind: 'hostPath', path: c.gitDir }, { workspace: path.posix.join(root, c.path, '.git'), tree: `/git/${c.id}` })
      dirs.push(rel(path.posix.join(treeDir, c.path, '.git')))
    }
    for (const m of tree.mainClones) add({ kind: 'hostPath', path: m }, { workspace: m, tree: m }, true)
    // The folders the workspace container mounts over inside the tree.
    for (const p of start.excluded) dirs.push(rel(path.posix.join(treeDir, p)))
  }
  for (const m of spec.mounts) {
    if (m.source.kind === 'emptyDir') {
      if (m.mountPath !== CONTAINER_TMUX_DIR) folders.push({ from: 'local', target: m.mountPath })
      continue
    }
    if (m.source.kind === 'volume' && yaacEnv.volumeStorageClass !== undefined) continue
    add(m.source, { workspace: m.mountPath }, m.readOnly === true)
  }
  for (const d of spec.scratchDirs) folders.push({ from: 'scratch', target: d })
  return {
    pod: args.podName,
    workspaceId: spec.workspaceId,
    dir: args.nodeMountsDir,
    life: tree?.life ?? 'none',
    trees,
    dirs: [...new Set(dirs)],
    mounts,
    folders,
    roots: { scratch: SCRATCH_ROOT, local: LOCAL_ROOT },
  }
}

/**
 * Wait for a launched workspace's pod to be ready, then make it its
 * workspace's: once the life's start instruction names each checkout's
 * commit, mountd takes or builds its trees and mounts and binds
 * what the workspace owns, and streamd's claim call, which first waits for
 * the tree container to report the files ready, sets the environment and
 * opens the session.
 */
export async function awaitWorkspaceReady(handle: RuntimeHandle): Promise<void> {
  const launch = launches.get(handle.jobName)
  try {
    await waitForJobPodReady(handle.jobName, READY_TIMEOUT_MS)
    if (launch === undefined) return
    const { spec } = launch
    const pod = findWorkspacePod(await readWorkspacePods(), spec.workspaceId)
    if (pod?.node === undefined) throw new Error(`workspace ${spec.workspaceId}'s pod is not on a node`)
    const wait = spec.tree?.restoring === true ? RESTORE_WAIT_MS : FILL_WAIT_MS
    const start = spec.tree !== undefined ? await awaitStartInstruction(spec, Date.now() + FILL_WAIT_MS) : undefined
    await mountdBind(pod.node, {
      token: `${handle.jobName}:${launch.nodeMountsDir}`,
      ...bindRequest({ spec, start, podName: pod.podName, nodeMountsDir: launch.nodeMountsDir }),
    })
    await podClaim(handle.jobName, {
      ...launch.claim,
      ...(spec.tree !== undefined ? { startedMarker: treeStartedMarker(spec.tree.life), waitMs: wait } : {}),
    }, { timeoutMs: wait + 60_000 })
  } finally {
    launches.delete(handle.jobName)
  }
}
