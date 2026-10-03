import {
  LABEL_DATA_DIR_HASH,
  LABEL_MODE,
  LABEL_NESTED,
  LABEL_NPM_CACHE,
  LABEL_PREWARMED,
  LABEL_PROJECT,
  LABEL_PROJECT_ID,
  LABEL_TOOL,
  buildPodJobManifest,
  dataDirHash,
  k8sNamespace,
  k8sWorkspacePaths,
  applyObject,
  nodeLocalDirsOf,
  nodeLocalNodePath,
  podStreamToken,
  resolveMountSource,
  workspaceIdLabels,
  workspaceJobName,
  type PodMount,
  PRE_STOP_GRACE_SECONDS,
} from '#drivers/k8s/substrate'
import {
  ensureProjectRegistry,
  projectRegistryConfDropIn,
  proxyServiceClusterIp,
  servingNpmCacheUrl,
} from '#drivers/k8s/cluster'
import {
  applyProxyRegistration,
  buildProxyRegistration,
  proxyClient,
  workspaceSshTransport,
  type ProxyRegistration,
} from '#drivers/k8s/egress'
import { ensureNodeImageStore, nodeImageStoreMount } from '#drivers/k8s/images'
import { hostMatchesPattern } from '#lib/allowed-hosts'
import type { SecretProxyRule, YaacConfig } from '@yaac/shared/types'
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
 * workspace owns (proxy registration, project registry). `launchWorkspace`
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
  /** The project's id, labelled on the pod so the project registry's
   *  NetworkPolicies can select it. */
  projectId: string
  /** Proxy Service ClusterIP: the pod's DNS resolver and egress target. */
  proxyHost: string
  /** The per-workspace token streamd's handshake requires. */
  streamToken: string
  /** Read-only lower of this node's image store, when the project has one. */
  storeMounts: PodMount[]
  /** The project has its own push registry, so the in-pod engine needs its
   *  registries.conf drop-in. */
  projectRegistry: boolean
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

/**
 * Set up what a workspace needs around it: its egress registration and the
 * image plumbing its engine pulls through.
 */
export async function prepareWorkspaceSubstrate(
  intent: SubstrateIntent,
): Promise<WorkspaceSubstrate> {
  const { projectSlug, projectId, workspaceId, config } = intent
  const project = { slug: projectSlug, id: projectId }
  const emit = (m: string): void => intent.onProgress?.(m)

  // The proxy injects GitHub / Claude / Codex tokens into outbound HTTPS.
  // Ensure it before building the registration, so a stale proxy is rolled
  // first and never misses the registration object.
  emit('Ensuring proxy deployment...')
  await proxyClient.ensureRunning()

  // Nested workspaces get the per-project push registry, which carries the
  // cross-workspace image cache (see image-promoter.ts).
  const projectRegistry = intent.nestedContainers
  const storeMounts: PodMount[] = []
  if (projectRegistry) {
    emit('Ensuring project registry...')
    await ensureProjectRegistry(project)

    // Mount the node-local image store read-only at /var/lib/shared-images
    // so the project's warm layers are available without a pull
    // (store-writer.ts). The generation is pinned at pod create, which lets
    // the builder's GC tell in-use stores from stale ones; a cold node
    // mounts nothing. The refresh runs detached and benefits the project's
    // next workspace, since this pod's mount is already chosen.
    const storeMount = await nodeImageStoreMount(projectId)
    if (storeMount) storeMounts.push(storeMount)
    void ensureNodeImageStore(project)
  }

  // netd's per-pod DNAT rules (k8s/netd) redirect the pod's outbound 443/80
  // to the proxy, which identifies the workspace by source pod IP. The pod
  // also uses the proxy as its DNS resolver and SSH tunnel endpoint. The
  // ClusterIP is allocator-assigned, so read it live; the Service is never
  // recreated.
  const proxyHost = await proxyServiceClusterIp()

  // Derived from the install's proxy secret, so nothing is stored. Only the
  // proxy can reach streamd, and the token opens only this pod's daemon.
  const streamToken = await podStreamToken(workspaceId)

  // Secret-injection rules, allowlist and repo URL; written by `launch`.
  // GitHub / Claude / Codex auth needs no per-workspace rule. Rules name
  // their values, which already sit in the project's secrets object
  // (`syncProjectSecrets`).
  const registration = buildProxyRegistration({
    config,
    remoteUrl: intent.remoteUrl,
    tool: intent.tool,
    projectSlug,
    secretRules: intent.proxySecretRules,
  })

  // A failed lookup just skips the cache; npmjs serves the same packages.
  const npmCacheAllowed = npmCacheApplies(config, registration.allowedHosts, intent.proxySecretRules)
  const npmRegistry = npmCacheAllowed ? await servingNpmCacheUrl().catch(() => null) : null

  const receipt: K8sWorkspaceSubstrate = {
    kind: 'workspace-substrate',
    projectId,
    proxyHost,
    streamToken,
    storeMounts,
    projectRegistry,
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
  config: YaacConfig,
  allowedHosts: string[],
  secretRules: Record<string, SecretProxyRule>,
): boolean {
  if (config.npmCache === false) return false
  const allowed = (allowedHosts.length === 1 && allowedHosts[0] === '*')
    || allowedHosts.some((pattern) => hostMatchesPattern(NPMJS_HOST, pattern))
  const authenticated = Object.values(secretRules)
    .some((rule) => rule.hosts.some((pattern) => hostMatchesPattern(NPMJS_HOST, pattern)))
  return allowed && !authenticated
}

/**
 * Apply the workspace's Job and return a handle for it.
 *
 * Adds what the caller cannot name: stream token, CA trust, the nested
 * engine's registries.conf drop-in, and SSH transport. The spec's env and
 * mounts are copied, not appended to, because the same spec is relaunched
 * after a failed attempt.
 *
 * The handle is built from the values just written; the pod does not exist
 * yet (`awaitReady` waits for it).
 */
export async function launchWorkspace(spec: WorkspaceSpec): Promise<RuntimeHandle> {
  const substrate = narrow(spec.substrate)
  const jobName = workspaceJobName(spec.projectSlug, spec.workspaceId)
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
  // One pnpm store per workspace: pnpm 11 indexes the store in a SQLite WAL
  // database, which cannot be shared across pods. Put it inside the root
  // node_modules when that is a module dir, so pnpm hardlinks rather than
  // copies; otherwise on the pod's own disk. Set under both names: pnpm 11+
  // reads only `pnpm_config_` for this key, pnpm 10 only `npm_config_`.
  const rootModules = `${k8sWorkspacePaths().workspaceDir}/node_modules`
  const store = spec.moduleDirs.includes(rootModules)
    ? `${rootModules}/.pnpm-store`
    : '/home/yaac/.local/share/pnpm/store'
  env.push(`pnpm_config_store_dir=${store}`, `npm_config_store_dir=${store}`)
  // The init script writes this into the user-level `~/.npmrc`, not env,
  // because env would override a registry named in the project's `.npmrc`.
  if (substrate.npmRegistry) env.push(`YAAC_NPM_REGISTRY=${substrate.npmRegistry}`)
  if (spec.nestedContainers && substrate.projectRegistry) {
    // Written by the in-pod init script before the engine starts. Base64
    // avoids quoting issues. Needed because the registry is plain HTTP.
    const conf = Buffer.from(projectRegistryConfDropIn(substrate.projectId), 'utf8')
      .toString('base64')
    env.push(`YAAC_REGISTRY_CONF_B64=${conf}`)
  }

  const declared: PodMount[] = [...spec.mounts]
  // Read-only node-local image store.
  declared.push(...substrate.storeMounts)
  if (spec.ssh) {
    const ssh = workspaceSshTransport(spec.ssh.knownHostsFile, substrate.proxyHost)
    declared.push(...ssh.mounts)
    env.push(...ssh.env)
  }
  // Map each declared host path to its cluster source (a subPath of the
  // global claim, or the node's tree); see mount-sources.ts.
  const mounts = declared.map(resolveMountSource)

  const labels: Record<string, string> = {
    [LABEL_PROJECT]: spec.projectSlug,
    [LABEL_PROJECT_ID]: substrate.projectId,
    ...workspaceIdLabels(spec.workspaceId),
    [LABEL_DATA_DIR_HASH]: dataDirHash(),
    [LABEL_TOOL]: spec.tool,
    // Only acp pods are labelled; the status watcher reads a missing label
    // as tui.
    ...(spec.mode === 'acp' ? { [LABEL_MODE]: spec.mode } : {}),
    // Removed on claim, turning the spare into a normal workspace.
    ...(spec.prewarm ? { [LABEL_PREWARMED]: 'true' } : {}),
    // Lets image salvage tell from the pod alone whether there is anything
    // to salvage; the reconciler never sees the spec's env.
    ...(spec.nestedContainers ? { [LABEL_NESTED]: 'true' } : {}),
    // Both of the npm cache's workspace policies select on this.
    ...(substrate.npmCacheAllowed ? { [LABEL_NPM_CACHE]: 'true' } : {}),
  }

  const manifest = buildPodJobManifest({
    jobName,
    namespace: k8sNamespace(),
    labels,
    image,
    env,
    mounts,
    memoryRequestBytes: spec.resources.memoryRequestBytes,
    memoryLimitBytes: spec.resources.memoryLimitBytes,
    cpuRequestMillis: spec.resources.cpuRequestMillis,
    cpuLimitMillis: spec.resources.cpuLimitMillis,
    ephemeralStorageRequestBytes: spec.resources.ephemeralStorageRequestBytes,
    ephemeralStorageLimitBytes: spec.resources.ephemeralStorageLimitBytes,
    proxyHost: substrate.proxyHost,
    nested: spec.nestedContainers,
    moduleDirs: spec.moduleDirs,
    // In-pod setup (git identity, tmux, streamd, nested engine) runs as
    // postStart, so kubelet holds Ready until it finishes.
    postStartExec: spec.postStartExec,
    // preStop runs within the grace period, so size it for the hook.
    ...(spec.preStopExec
      ? { preStopExec: spec.preStopExec, terminationGracePeriodSeconds: PRE_STOP_GRACE_SECONDS }
      : {}),
    // Created on the node by the pod's own init container.
    nodeLocalDirs: nodeLocalDirsOf(mounts),
    nodeLocalRoot: nodeLocalNodePath(),
  })

  spec.onProgress?.(`Creating session job ${jobName}...`)

  // Idempotent, so a relaunch rewrites the same object.
  await applyProxyRegistration(spec.workspaceId, substrate.registration)
  await applyObject(manifest)

  return {
    workspaceId: spec.workspaceId,
    projectSlug: spec.projectSlug,
    jobName,
    tool: spec.tool,
    declaredTool: spec.tool,
    mode: spec.mode,
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
