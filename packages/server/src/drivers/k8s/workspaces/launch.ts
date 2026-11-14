import {
  LABEL_INSTALL_ID,
  LABEL_NPM_CACHE,
  LABEL_PREWARMED,
  LABEL_PROJECT_ID,
  LABEL_SITE_ID,
  LABEL_WORKSPACE_ID,
  PRIORITY_CLASS_RELEASE,
  installId,
  k8sNamespace,
  k8sWorkspacePaths,
  applyObject,
  listObjects,
  nodeLocalDirsOf,
  nodeLocalNodePath,
  podStreamToken,
  resolveMountSource,
  volumeClaimName,
  workspaceIdLabels,
  workspaceJobName,
} from '#drivers/k8s/substrate'
import { PRE_STOP_GRACE_SECONDS, buildPodJobManifest } from './pod-job'
import {
  ensureBuilderImage,
  proxyServiceClusterIp,
  runSecretsName,
  servingNpmCacheUrl,
} from '#drivers/k8s/cluster'
import {
  applyProxyRegistration,
  buildProxyRegistration,
  proxyClient,
  workspaceSshEnv,
  type ProxyRegistration,
} from '#drivers/k8s/egress'
import { hostMatchesPattern } from '@yaac/shared/allowed-hosts'
import type { SecretProxyRule, ProjectConfig } from '@yaac/shared/types'
import type {
  RuntimeHandle,
  SubstrateIntent,
  WorkspaceSpec,
  WorkspaceSubstrate,
} from '#drivers/contract'

/**
 * How the k8s driver starts a workspace (docs/layered-server.md).
 *
 * Two halves with different lifetimes, which makes retries safe.
 * `prepareWorkspaceSubstrate` runs once per create and sets up things the
 * workspace owns (its proxy registration). `launchWorkspace`
 * runs per attempt and applies only a Job, so a failed attempt leaves just
 * a Job to delete (`destroyWorkspace` with `unitOnly`).
 *
 * Callers pass a driver-neutral `WorkspaceSpec`; all labels, namespace,
 * manifest and priority-class details live here.
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

/** The node a workspace's pod was scheduled on, if it has one. */
async function workspaceNode(workspaceId: string): Promise<string | undefined> {
  const pods = await listObjects<{ spec?: { nodeName?: string } }>('v1', 'Pod', {
    namespace: k8sNamespace(), labelSelector: `${LABEL_WORKSPACE_ID}=${workspaceId}`,
  })
  return pods.find((p) => p.spec?.nodeName !== undefined)?.spec?.nodeName
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
    identity: intent.identity,
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

/**
 * Apply the workspace's Job and return a handle for it.
 *
 * Adds what the caller cannot name: stream token, CA trust, and SSH
 * transport. The spec's env and
 * mounts are copied, not appended to, because the same spec is relaunched
 * after a failed attempt.
 *
 * The handle is built from the values just written; the pod does not exist
 * yet (`awaitReady` waits for it).
 */
export async function launchWorkspace(spec: WorkspaceSpec): Promise<RuntimeHandle> {
  const substrate = narrow(spec.substrate)
  const jobName = workspaceJobName(spec.workspaceId)
  // The contract makes `image` optional for runtimes that run none; here a
  // missing one means `prepareImage` was skipped, a wiring bug.
  if (!spec.image) {
    throw new Error(`launch ${jobName}: no image on the spec (prepareImage was skipped)`)
  }
  const image = spec.image

  const env = [...spec.env]
  // Only CA trust: interception is transparent, so no HTTP(S)_PROXY vars.
  env.push(...proxyClient.getCaTrustEnv())
  env.push(`YAAC_STREAM_TOKEN=${substrate.streamToken}`)
  // One pnpm store per workspace: pnpm indexes the store in a SQLite WAL
  // database, which cannot be shared across pods. Put it inside the root
  // node_modules when that is a scratch dir, so pnpm hardlinks rather than
  // copies; otherwise on the pod's own disk. Set under both names: pnpm 11+
  // reads only `pnpm_config_` for this key, pnpm 10 only `npm_config_`.
  const rootModules = `${k8sWorkspacePaths().workspaceDir}/node_modules`
  const store = spec.scratchDirs.some((d) => d.path === rootModules)
    ? `${rootModules}/.pnpm-store`
    : '/home/yaac/.local/share/pnpm/store'
  env.push(`pnpm_config_store_dir=${store}`, `npm_config_store_dir=${store}`)
  // The init script writes this into the user-level `~/.npmrc`, not env,
  // because env would override a registry named in the project's `.npmrc`.
  if (substrate.npmRegistry) env.push(`YAAC_NPM_REGISTRY=${substrate.npmRegistry}`)

  // The proxy ends ssh sessions to the project's git hosts and checks their
  // host keys itself, so the workspace needs neither `spec.ssh`'s file nor
  // a key: only an ssh that reaches the proxy and trusts it.
  if (spec.ssh) env.push(...workspaceSshEnv())
  // Where the init script starts the keeper tmux session, relative to the
  // workspace dir.
  env.push(`YAAC_CWD=${spec.cwd}`)
  // Map each declared host path to its cluster source (a subPath of the
  // global claim, or the node's tree); see mount-sources.ts.
  const mounts = spec.mounts.map(resolveMountSource)

  const labels: Record<string, string> = {
    [LABEL_PROJECT_ID]: spec.projectId,
    ...workspaceIdLabels(spec.workspaceId),
    [LABEL_INSTALL_ID]: installId(),
    // Removed on claim, turning the spare into a normal workspace.
    ...(spec.prewarm ? { [LABEL_PREWARMED]: 'true' } : {}),
    // Both of the npm cache's workspace policies select on this.
    ...(substrate.npmCacheAllowed ? { [LABEL_NPM_CACHE]: 'true' } : {}),
    // A site's release: its ingress policy admits the router, the router
    // may dial it, and the proxy refuses its calls to the server.
    ...(spec.siteId !== undefined ? { [LABEL_SITE_ID]: spec.siteId } : {}),
  }
  // A claim (byo) may attach on one node only, and during a deploy's
  // handoff both releases mount it (docs/public-sites.md).
  // A holder not scheduled yet could still land elsewhere, so the launch is
  // refused rather than left to hang on the attach.
  let nodeName: string | undefined
  if (spec.colocateWith !== undefined
    && mounts.some((m) => m.source.kind === 'pvc' && m.source.claimName.startsWith(volumeClaimName('')))) {
    nodeName = await workspaceNode(spec.colocateWith)
    if (nodeName === undefined) {
      throw new Error(`workspace ${spec.colocateWith.slice(0, 8)}, which holds the volume, is not on a node yet; deploy again once it is`)
    }
  }

  const manifest = buildPodJobManifest({
    jobName,
    namespace: k8sNamespace(),
    labels,
    image,
    env,
    ...(spec.runSecrets !== undefined ? { secretEnv: { secretName: runSecretsName(spec.projectId), names: spec.runSecrets } } : {}),
    mounts,
    memoryRequestBytes: spec.resources.memoryRequestBytes,
    memoryLimitBytes: spec.resources.memoryLimitBytes,
    cpuRequestMillis: spec.resources.cpuRequestMillis,
    cpuLimitMillis: spec.resources.cpuLimitMillis,
    ephemeralStorageRequestBytes: spec.resources.ephemeralStorageRequestBytes,
    ephemeralStorageLimitBytes: spec.resources.ephemeralStorageLimitBytes,
    proxyHost: substrate.proxyHost,
    scratchDirs: spec.scratchDirs,
    // In-pod setup (git identity, tmux, streamd) runs as postStart, so
    // kubelet holds Ready until it finishes.
    postStartExec: spec.postStartExec,
    // preStop runs within the grace period, so size it for the hook.
    ...(spec.preStopExec
      ? { preStopExec: spec.preStopExec, terminationGracePeriodSeconds: PRE_STOP_GRACE_SECONDS }
      : {}),
    // Created on the node by the pod's own init container.
    nodeLocalDirs: nodeLocalDirsOf(mounts),
    nodeLocalRoot: nodeLocalNodePath(),
    nodeDirsImage: await ensureBuilderImage(),
    ...(spec.siteId !== undefined ? { priorityClassName: PRIORITY_CLASS_RELEASE } : {}),
    ...(nodeName !== undefined ? { nodeName } : {}),
  })

  spec.onProgress?.(`Creating session job ${jobName}...`)

  // Idempotent, so a relaunch rewrites the same object.
  await applyProxyRegistration(spec.workspaceId, substrate.registration)
  await applyObject(manifest)

  return {
    workspaceId: spec.workspaceId,
    projectId: spec.projectId,
    jobName,
    // The caller's next step, `awaitReady`, waits for the pod.
    running: false,
    state: 'pending',
    labels,
    createdAtMs: Date.now(),
    prewarmed: spec.prewarm,
    terminating: false,
    deathCause: { reason: 'pod-stopped' },
  }
}
