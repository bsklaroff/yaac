import {
  LABEL_DATA_DIR_HASH,
  LABEL_MODE,
  LABEL_NESTED,
  LABEL_PREWARMED,
  LABEL_PROJECT,
  LABEL_TOOL,
  buildPodJobManifest,
  dataDirHash,
  ensurePriorityClasses,
  k8sNamespace,
  kubectlApply,
  podStreamToken,
  worktreeIdLabels,
  worktreeJobName,
  type PodMount,
} from '#drivers/k8s/substrate'
import {
  ensureProjectRegistry,
  projectRegistryConfDropIn,
  proxyServiceClusterIp,
} from '#drivers/k8s/cluster'
import {
  proxyClient,
  registerWorkspace,
  writeProxySecrets,
  workspaceSshTransport,
} from '#drivers/k8s/egress'
import { ensureNodeImageStore, nodeImageStoreMount } from '#drivers/k8s/images'
import type {
  RuntimeHandle,
  SubstrateIntent,
  WorkspaceSpec,
  WorkspaceSubstrate,
} from '#drivers/contract'

/**
 * How the k8s runtime starts a workspace: what it stands up around one
 * before it can run, and the Job that runs it (docs/layered-server.md).
 *
 * Split in two because the halves have different lifetimes, and the split
 * is what makes a retry safe. `prepareWorkspaceSubstrate` runs ONCE per
 * create — its products (a proxy registration, a project registry) belong
 * to the workspace, not to an attempt at launching it, and re-running it
 * would re-touch a cluster the workspace is already using. `launchWorkspace` is per attempt: it applies
 * a Job and nothing else, so a failed attempt leaves nothing but a Job to
 * delete (`destroyWorkspace` with `unitOnly`).
 *
 * The caller supplies decisions and this decides spellings. Every label,
 * the namespace, the data-dir hash, the manifest and the priority classes
 * are here and nowhere above; what arrives is a `WorkspaceSpec` that could
 * as easily be read by a driver with no cluster at all.
 */

/**
 * The k8s receipt: what `prepareWorkspaceSubstrate` stood up, in the terms
 * `launchWorkspace` finishes the job in. Opaque to every caller — it
 * travels on the spec and comes back here to be narrowed.
 */
interface K8sWorkspaceSubstrate extends WorkspaceSubstrate {
  /** Live proxy Service ClusterIP — the pod's resolver and egress target. */
  proxyHost: string
  /** The per-worktree token streamd's handshake requires. */
  streamToken: string
  /** Read-only lower of this node's image store, when the project has one. */
  storeMounts: PodMount[]
  /** The project has its own push registry, so the in-pod engine needs its
   *  registries.conf drop-in. */
  projectRegistry: boolean
}

function narrow(substrate: WorkspaceSubstrate): K8sWorkspaceSubstrate {
  // Checked on a field THIS driver wrote, not on `kind`: the receipt a
  // foreign caller most plausibly arrives with is a neutral stub, and a
  // stub carries the discriminant precisely because the contract declares
  // it. `proxyHost` is the one to test because it is the field whose
  // absence is quietest — `undefined` lands in the manifest as the pod's
  // DNS resolver and egress target, and the pod comes up unable to resolve
  // anything rather than failing here with a name for what went wrong.
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
 * Stand up everything a workspace needs around it: its egress registration
 * and the image plumbing its engine will pull through.
 */
export async function prepareWorkspaceSubstrate(
  intent: SubstrateIntent,
): Promise<WorkspaceSubstrate> {
  const { projectSlug, workspaceId, config } = intent
  const emit = (m: string): void => intent.onProgress?.(m)

  // The proxy is always required — it reads the host-mounted credentials
  // dir directly and injects GitHub / Claude / Codex tokens into outbound
  // HTTPS requests. Credential updates propagate to every running workspace
  // without restarting pods.
  emit('Ensuring proxy deployment...')
  await proxyClient.ensureRunning()

  // Every nested workspace gets the per-project push registry: it is the
  // bus the in-pod engine's cross-worktree image cache rides (salvage
  // pushes, the next workspace pulls — see image-promoter.ts).
  const projectRegistry = intent.nestedContainers
  const storeMounts: PodMount[] = []
  if (projectRegistry) {
    emit('Ensuring project registry...')
    await ensureProjectRegistry(projectSlug)

    // The node-local image store: the read-only containers/storage lower
    // this pod mounts at /var/lib/shared-images, so the project's warm
    // layers are visible to its engine at first touch with no pull and no
    // graphroot spend (store-writer.ts).
    //
    // The generation is PINNED here, at pod create, and never changes for
    // this pod's life — which is what lets the builder's GC tell a store in
    // use from a stale one. A cold node has none yet and simply mounts
    // nothing. The refresh is fired DETACHED because a build is a pod run
    // of minutes whose product this pod could not adopt anyway (its mount
    // is already chosen); what it buys is the generation the NEXT workspace
    // of the project mounts.
    const storeMount = await nodeImageStoreMount(projectSlug)
    if (storeMount) storeMounts.push(storeMount)
    void ensureNodeImageStore(projectSlug)
  }

  // Egress: the workspace pod's outbound 443/80 is redirected to the proxy
  // at the node level by netd's per-pod DNAT rules (k8s/netd) — no per-pod
  // sidecar. The pod also points its resolver at the proxy (DNS stub) and
  // dials the SSH tunnel sentinel; both are admitted by the same workspace
  // NetworkPolicy. The proxy identifies the workspace by the source pod IP
  // it watches, so nothing per-workspace needs injecting here.
  //
  // The proxy Service ClusterIP is allocator-assigned (no longer pinned), so
  // read it live. Stable for the cluster's lifetime: the Service is never
  // deleted/recreated.
  const proxyHost = await proxyServiceClusterIp()

  // streamd auth: the per-workspace token its handshake requires, derived
  // from the install's proxy secret (no new storage — survives server
  // restarts). Leaking it grants nothing: the ingress lock means only the
  // proxy reaches streamd, and the token only opens the pod's OWN daemon.
  const streamToken = await podStreamToken(workspaceId)

  // Register this workspace's state (envSecretProxy rules, allowlist, repo
  // URL) with the proxy. GitHub / Claude / Codex auth is handled
  // dynamically by the proxy from the mounted credentials dir — no
  // per-workspace rule is needed for those. envSecretProxy rules reference
  // their values by name; the values (resolved by the caller, which owns
  // where they come from) land in the proxy-secrets file FIRST so the
  // registration's secretRefs resolve from the proxy's first request onward.
  await writeProxySecrets(intent.proxySecrets)
  await registerWorkspace({
    workspaceId,
    projectSlug,
    tool: intent.tool,
    config,
    remoteUrl: intent.remoteUrl,
    proxySecretNames: Object.keys(intent.proxySecrets),
  })

  const receipt: K8sWorkspaceSubstrate = {
    kind: 'workspace-substrate',
    proxyHost,
    streamToken,
    storeMounts,
    projectRegistry,
  }
  return receipt
}

/**
 * Apply the workspace's Job, and answer with the handle that addresses it.
 *
 * Everything the caller could not have named is added here: the transport
 * token, CA trust, the registries.conf drop-in a nested engine needs, and
 * the SSH transport. The
 * caller's own env and mounts go first so its values are the ones a reader
 * sees at the head of the list — and they are COPIED, never appended to,
 * because the same spec is relaunched after a failed attempt and a second
 * pass must not stack a second set of injections on top of the first.
 *
 * The returned handle is built from what was just stamped rather than read
 * back: the pod does not exist yet (that is `awaitReady`'s wait), and every
 * field here is a fact this function decided.
 */
export async function launchWorkspace(spec: WorkspaceSpec): Promise<RuntimeHandle> {
  const substrate = narrow(spec.substrate)
  const jobName = worktreeJobName(spec.projectSlug, spec.workspaceId)
  // The spec's image is optional because a runtime that runs none takes no
  // ref; for this one it is what the pod starts from, so an absent one is a
  // caller that skipped `prepareImage` for a driver that needs it — a wiring
  // bug, and one worth naming before a manifest goes out without an image.
  if (!spec.image) {
    throw new Error(`launch ${jobName}: no image on the spec (prepareImage was skipped)`)
  }
  const image = spec.image

  const env = [...spec.env]
  // CA-trust env only — no HTTP(S)_PROXY routing vars. Interception is
  // transparent at the network layer, so the container needs nothing but
  // trust in the MITM CA.
  env.push(...proxyClient.getCaTrustEnv())
  env.push(`YAAC_STREAM_TOKEN=${substrate.streamToken}`)
  if (spec.nestedContainers && substrate.projectRegistry) {
    // The per-project registries.conf drop-in, written by the in-pod init
    // script (sudo) before the engine starts. Base64 keeps the TOML free of
    // env-value quoting concerns. Every nested workspace needs it: the
    // registry is plain HTTP, and the image cache pushes/pulls through it.
    const conf = Buffer.from(projectRegistryConfDropIn(spec.projectSlug), 'utf8')
      .toString('base64')
    env.push(`YAAC_REGISTRY_CONF_B64=${conf}`)
  }

  const mounts: PodMount[] = [...spec.mounts]
  // NODE-LOCAL, read-only: this node's image store generation.
  mounts.push(...substrate.storeMounts)
  if (spec.ssh) {
    const ssh = workspaceSshTransport(spec.ssh.knownHostsFile, substrate.proxyHost)
    mounts.push(...ssh.mounts)
    env.push(...ssh.env)
  }

  const labels: Record<string, string> = {
    [LABEL_PROJECT]: spec.projectSlug,
    ...worktreeIdLabels(spec.workspaceId),
    [LABEL_DATA_DIR_HASH]: dataDirHash(),
    [LABEL_TOOL]: spec.tool,
    // Stamped only for acp: the status watcher picks its driver from this,
    // and every pod without it (every TUI pod, and every pod predating
    // modes) reads as tui.
    ...(spec.mode === 'acp' ? { [LABEL_MODE]: spec.mode } : {}),
    // Prewarmed spares carry this until claimed; claiming removes it,
    // flipping the pod to a normal workspace that lists in user-facing views.
    ...(spec.prewarm ? { [LABEL_PREWARMED]: 'true' } : {}),
    // Stamped only when this pod runs the in-pod engine, so the image
    // salvage can tell from a pod alone whether there is anything to
    // salvage — the engine's own marker (YAAC_NESTED_ENGINE, below) lives
    // in the spec's env, which the reconciler never has.
    ...(spec.nestedContainers ? { [LABEL_NESTED]: 'true' } : {}),
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
    // In-pod setup (git identity, tmux server + options, streamd, the
    // nested engine) runs as the container's postStart hook, so the kubelet
    // holds Ready until it's done and no per-command exec round trips are
    // paid. Prewarmed spares take this same path.
    postStartExec: spec.postStartExec,
  })

  spec.onProgress?.(`Creating session job ${jobName}...`)

  // The pod names a PriorityClass, and the apiserver rejects a pod whose
  // class is missing — the Job applies and no pod ever appears. The boot
  // bootstrap ensures the classes, but best-effort (one logged catch), so an
  // upgraded install whose one boot found the cluster unreachable would fail
  // every create until a restart. Idempotent and cheap next to a pod create.
  await ensurePriorityClasses()
  await kubectlApply(manifest)

  return {
    workspaceId: spec.workspaceId,
    projectSlug: spec.projectSlug,
    jobName,
    tool: spec.tool,
    declaredTool: spec.tool,
    mode: spec.mode,
    // Applied, not running: the pod is scheduled and booted behind
    // `awaitReady`, which is the caller's next step.
    running: false,
    state: 'pending',
    labels,
    createdAtMs: Date.now(),
    prewarmed: spec.prewarm,
    terminating: false,
    deathCause: { reason: 'pod-stopped' },
  }
}
