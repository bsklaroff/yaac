import fs from 'node:fs/promises'
import path from 'node:path'
import {
  LABEL_DATA_DIR_HASH,
  LABEL_MODE,
  LABEL_PREWARMED,
  LABEL_PROJECT,
  LABEL_TOOL,
  awaitDeferredClusterBoot,
  buildPodJobManifest,
  dataDirHash,
  ensurePriorityClasses,
  k8sNamespace,
  kubectlApply,
  podStreamToken,
  worktreeIdLabels,
  worktreeJobName,
  type PodMount,
} from '#runtime/k8s/substrate'
import {
  ensureActivator,
  ensureProjectRegistry,
  ensureVclusterImages,
  ensureWorktreeVcluster,
  projectRegistryConfDropIn,
  projectRegistryHost,
  proxyServiceClusterIp,
  sleepVcluster,
  vclusterName,
  waitForVclusterKubeconfig,
} from '#runtime/k8s/cluster'
import {
  proxyClient,
  registerWorkspace,
  resolveProxyImageTag,
  syncProxySecrets,
  workspaceSshTransport,
} from '#runtime/k8s/egress'
import { ensureNodeImageStore, nodeImageStoreMount } from '#runtime/k8s/images'
import { env as yaacEnv, testEnv } from '@yaac/shared/env'
import { nestedYaacDataDir, worktreeVclusterDir } from '@yaac/shared/project-paths'
import type {
  RuntimeHandle,
  SubstrateIntent,
  WorkspaceSpec,
  WorkspaceSubstrate,
} from '#runtime/contract'

/**
 * How the k8s runtime starts a workspace: what it stands up around one
 * before it can run, and the Job that runs it (docs/layered-server.md).
 *
 * Split in two because the halves have different lifetimes, and the split
 * is what makes a retry safe. `prepareWorkspaceSubstrate` runs ONCE per
 * create — its products (a proxy registration, a project registry, a
 * virtual cluster with its own state) belong to the workspace, not to an
 * attempt at launching it, and re-running it would re-touch a cluster the
 * workspace is already using. `launchWorkspace` is per attempt: it applies
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
  /** The kubeconfig and nested-data mounts a virtual cluster implies. */
  vclusterMounts: PodMount[]
  vclusterEnv: string[]
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
 * Stand up everything a workspace needs around it: its egress
 * registration, the image plumbing its engine will pull through, and — for
 * a `virtualCluster` project — its own nested cluster.
 *
 * Ordering inside is load-bearing in two places. The deferred cluster boot
 * is awaited first because everything below applies into the namespace it
 * ensures. And the vcluster is CREATED early but its kubeconfig awaited
 * last, so its cold start overlaps the caller's own legs (an image build, a
 * checkout) instead of serializing behind them.
 */
export async function prepareWorkspaceSubstrate(
  intent: SubstrateIntent,
): Promise<WorkspaceSubstrate> {
  const { projectSlug, workspaceId, config } = intent
  const emit = (m: string): void => intent.onProgress?.(m)

  // A nested server defers its boot-time cluster attach so it doesn't wake
  // its own born-at-zero vcluster; the first workspace is the "cluster is
  // really needed now" signal. Awaited so the namespace ensure inside it
  // lands before anything below applies into it. Immediate no-op on the
  // outer server (nothing is ever armed).
  await awaitDeferredClusterBoot()

  // The proxy is always required — it reads the host-mounted credentials
  // dir directly and injects GitHub / Claude / Codex tokens into outbound
  // HTTPS requests. Credential updates propagate to every running workspace
  // without restarting pods.
  emit('Ensuring proxy deployment...')
  await proxyClient.ensureRunning()

  // Every nested workspace gets the per-project push registry: it is the
  // image source for vcluster synced pods and yaac-in-yaac, AND the bus the
  // in-pod engine's cross-worktree image cache rides (salvage pushes, the
  // next workspace pulls — see image-promoter.ts). Never inside an INNER
  // yaac: the ensure's node-write pods hostPath-mount the node's containerd
  // `certs.d`, and its vcluster's pod guard denies any hostPath outside the
  // workspace's own data dir, so the ensure could not finish. Those
  // workspaces run without a cross-worktree image cache (image-promoter
  // self-gates too).
  const projectRegistry = intent.nestedContainers && !yaacEnv.nested
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

  // virtualCluster workspaces additionally get their own virtual cluster,
  // created here so its cold start overlaps the caller's other legs; the
  // kubeconfig is awaited at the end, just before the mounts are assembled.
  let vclusterFreshlyCreated = false
  if (intent.virtualCluster) {
    // The wake activator that serves this (and every) vcluster's
    // scale-to-zero — before the vcluster so its pod IP is available to the
    // sleep step below. Runs the proxy image the ensureRunning() above just
    // built and pushed.
    emit('Ensuring vcluster activator...')
    await ensureActivator(await resolveProxyImageTag(testEnv.proxyImage))

    emit('Creating virtual cluster...')
    await ensureVclusterImages()
    const { freshlyCreated } = await ensureWorktreeVcluster({
      worktreeId: workspaceId,
      allowedHostPathPrefix: nestedYaacDataDir(projectSlug, workspaceId),
      onProgress: emit,
    })
    vclusterFreshlyCreated = freshlyCreated
  }

  // Egress: the workspace pod's outbound 443/80 is redirected to the proxy
  // at the node level by netd's per-pod DNAT rules (k8s/netd) — no per-pod
  // sidecar. The pod also points its resolver at the proxy (DNS stub) and
  // dials the SSH tunnel sentinel; both are admitted by the same workspace
  // NetworkPolicy. The proxy identifies the workspace by the source pod IP
  // it watches, so nothing per-workspace needs injecting here.
  //
  // The proxy Service ClusterIP is allocator-assigned (no longer pinned) —
  // for both the outer and the vcluster-allocated inner proxy — so read it
  // live. Stable for the cluster's lifetime: the Service is never
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
  // their values by name; the values land in the proxy-secrets credentials
  // file FIRST so the registration's secretRefs resolve from the proxy's
  // first request onward.
  await syncProxySecrets(config)
  await registerWorkspace({
    workspaceId,
    projectSlug,
    tool: intent.tool,
    config,
    remoteUrl: intent.remoteUrl,
  })

  // vcluster kubeconfig: wait for the syncer to publish it (the cold start
  // has been running since the ensure above), write it under the worktree
  // dir, and dir-mount it at ~/.kube. Speaks to the pinned VIP:8443 (IP
  // SAN) — no DNS involved.
  const vclusterMounts: PodMount[] = []
  const vclusterEnv: string[] = []
  if (intent.virtualCluster) {
    emit('Waiting for the virtual cluster API...')
    const kubeconfig = await waitForVclusterKubeconfig(vclusterName(workspaceId))
    const vcDir = worktreeVclusterDir(projectSlug, workspaceId)
    await fs.mkdir(vcDir, { recursive: true })
    await fs.writeFile(path.join(vcDir, 'config'), kubeconfig, { mode: 0o600 })
    // SHARED: the server writes (and heals) the kubeconfig, the pod reads it.
    vclusterMounts.push({
      source: { kind: 'hostPath', path: vcDir },
      mountPath: '/home/yaac/.kube',
    })
    vclusterEnv.push('KUBECONFIG=/home/yaac/.kube/config')

    // Born-at-zero: with the kubeconfig captured, the freshly-booted (never
    // used) control plane is scaled to 0 — the activator wakes it on the
    // workspace's first API touch. Only a vcluster THIS create booted may be
    // slept: re-sleeping an existing one would discard its state.db.
    // Best-effort — a failed sleep just leaves the vcluster running.
    if (vclusterFreshlyCreated) {
      emit('Scaling idle virtual cluster to zero...')
      try {
        await sleepVcluster(vclusterName(workspaceId), workspaceId)
      } catch (err) {
        console.warn(`vcluster sleep (${workspaceId}): ${(err as Error).message}`)
      }
    }

    // yaac-in-yaac preset: the nested data dir is mounted at the IDENTICAL
    // absolute path in the pod, because inner synced-pod hostPaths resolve
    // on the NODE (which sees the host path via the kind $HOME extraMount).
    // It is also the VAP guard's only allowed hostPath prefix for this
    // workspace's synced pods. The registry env points the inner server's
    // pushes at the project's registry (resolvable in-pod via the proxy's
    // split-horizon DNS, on the node via hosts.toml) — no repo-path prefix,
    // that registry is already scoped.
    const nestedDataDir = nestedYaacDataDir(projectSlug, workspaceId)
    await fs.mkdir(nestedDataDir, { recursive: true })
    // SHARED, and a hostPath the NODE must resolve too: the inner yaac's
    // synced pods carry hostPaths under this dir (see nestedYaacDataDir).
    vclusterMounts.push({
      source: { kind: 'hostPath', path: nestedDataDir },
      mountPath: nestedDataDir,
    })
    vclusterEnv.push(`YAAC_DATA_DIR=${nestedDataDir}`)
    vclusterEnv.push('YAAC_NESTED=1')
    vclusterEnv.push(`YAAC_K8S_REGISTRY=${projectRegistryHost(projectSlug)}`)
  }

  const receipt: K8sWorkspaceSubstrate = {
    kind: 'workspace-substrate',
    proxyHost,
    streamToken,
    storeMounts,
    vclusterMounts,
    vclusterEnv,
    projectRegistry,
  }
  return receipt
}

/**
 * Apply the workspace's Job, and answer with the handle that addresses it.
 *
 * Everything the caller could not have named is added here: the transport
 * token, CA trust, the registries.conf drop-in a nested engine needs, the
 * kubeconfig wiring of a virtual cluster, and the SSH transport. The
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
    // registry is plain HTTP, and the image cache pushes/pulls through it
    // even when there is no vcluster.
    const conf = Buffer.from(projectRegistryConfDropIn(spec.projectSlug), 'utf8')
      .toString('base64')
    env.push(`YAAC_REGISTRY_CONF_B64=${conf}`)
  }
  env.push(...substrate.vclusterEnv)

  const mounts: PodMount[] = [...spec.mounts]
  // NODE-LOCAL, read-only: this node's image store generation.
  mounts.push(...substrate.storeMounts)
  mounts.push(...substrate.vclusterMounts)
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
  }

  const manifest = buildPodJobManifest({
    jobName,
    namespace: k8sNamespace(),
    labels,
    image: spec.image,
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
    // Inside a nested (inner) yaac no runtimeClassName is stamped — the
    // vcluster has no RuntimeClass objects, and the syncer sets the synced
    // pod's host runtime. Host pods get gvisor (pod-spec maps nested to the
    // gvisor-nested handler).
    innerYaac: yaacEnv.nested,
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
