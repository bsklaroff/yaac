import path from 'node:path'
import { runtimeClassSpec } from './gvisor'
import { priorityClassSpec } from './priority-classes'

/** ConfigMap (cluster-scoped to the yaac namespace) holding the proxy CA. */
export const CA_CONFIGMAP_NAME = 'yaac-proxy-ca'
/** Key inside the CA ConfigMap / filename inside the mount dir. */
export const CA_CONFIGMAP_KEY = 'proxy-ca.pem'
/**
 * Second key in the CA ConfigMap: the combined trust bundle
 * `{public roots} ∪ {proxy CA}`. The own-bundle tools in nested containers
 * (curl / requests / cargo / git-libcurl) point CURL_CA_BUNDLE & friends at
 * it — a superset, so they trust the proxy on intercepted hosts AND real
 * upstreams on tunnelled hosts. See docs/nested-containers.md.
 */
export const CA_BUNDLE_KEY = 'ca-bundle.pem'
/** Directory inside worktree pods where the CA ConfigMap is mounted. */
export const CA_MOUNT_DIR = '/etc/yaac/certs'
/** Full in-container path of the proxy CA cert. */
export const CA_CERT_PATH = `${CA_MOUNT_DIR}/${CA_CONFIGMAP_KEY}`
/** Full in-container path of the combined trust bundle (roots + proxy CA). */
export const CA_BUNDLE_PATH = `${CA_MOUNT_DIR}/${CA_BUNDLE_KEY}`

/**
 * Directory inside worktree pods holding the forwarded ssh-agent socket, and
 * the socket path SSH_AUTH_SOCK names. Pod-local scratch (an emptyDir, see
 * buildPodJobManifest): the agent itself lives in the proxy pod and is
 * reached over TCP (SSH_AGENT_PORT), so nothing here is shared between pods
 * — only the in-pod forwarder writes it, and only the worktree's own ssh
 * client reads it.
 */
export const SSH_AGENT_MOUNT = '/ssh-agent'
export const SSH_AGENT_SOCKET_PATH = `${SSH_AGENT_MOUNT}/socket`

/**
 * In-container path of the per-worktree ROOTFUL podman graphroot — podman's
 * default `/var/lib/containers/storage` lives under this dir (the image's
 * storage.conf sets graphroot there). Backed by a sentry-internal tmpfs
 * (see NESTED_GRAPHROOT_ANNOTATIONS): gVisor's gofer filesystem refuses
 * WRITES to the `security.*` xattr namespace (goferfs
 * checkXattrPermissions → EOPNOTSUPP — the unprivileged host-side gofer
 * couldn't set `security.capability` on host files anyway), so a `docker
 * build` RUN step doing `setcap` fails on any gofer-backed (hostPath/
 * emptyDir) graphroot — only a sentry tmpfs holds file caps. The tmpfs is
 * DISK-backed: runsc pages it against a `.gvisor.filestore.*` file it
 * creates inside the (disk-medium) emptyDir, so layer data is reclaimable
 * page cache on the node's disk, not memory pinned against the pod limit.
 */
export const NESTED_GRAPHROOT_PATH = '/var/lib/containers'

/**
 * Name of the graphroot volume — referenced by the gVisor mount annotations
 * (dev.gvisor.spec.mount.<name>.*), which key on the volume name.
 */
export const NESTED_GRAPHROOT_VOLUME = 'podman-graphroot'

/**
 * Size cap for the tmpfs graphroot — the sentry enforces it (`size=` mount
 * option), so an oversized build ENOSPCs inside the build instead of
 * filling the node's disk. Disk-backed (see NESTED_GRAPHROOT_ANNOTATIONS),
 * so this is an ephemeral-storage budget, not pod memory — independent of
 * memoryLimitBytes.
 *
 * Sized so a worktree can hold the yaac image chain (base, tools, nestable —
 * layer-shared, but ~6.5GiB unique) plus the upstream mirrors its cluster
 * pulls AND still build on top of them. At 8GiB that fit had no slack at
 * all: a warm image cache left the e2e image builds ENOSPC'ing.
 *
 * Only the pod's ephemeral-storage LIMIT clears this; the request does
 * not, so raising it does not cost scheduling density — but it does raise
 * each nested worktree's unaccounted worst case by the same amount. At node
 * disk saturation kubelet ranks eviction by usage-over-request, so the fat
 * nested worktrees go first, which is fatal to them (backoffLimit 0) and is
 * the ordering the PriorityClass split already intends.
 */
export const NESTED_GRAPHROOT_TMPFS_BYTES = 12 * 1024 ** 3

/**
 * emptyDir sizeLimit for the graphroot volume: the sentry's `size=` cap
 * plus slack. The filestore file kubelet sees can carry sentry metadata
 * beyond the byte cap it enforces; a sizeLimit at exactly the cap would
 * race kubelet's du-based eviction (which kills the whole worktree) against
 * the sentry's ENOSPC (which fails just the write). The slack makes
 * eviction unreachable while still bounding a runaway volume.
 */
export const NESTED_GRAPHROOT_SIZELIMIT_BYTES = NESTED_GRAPHROOT_TMPFS_BYTES + 1024 ** 3

/**
 * Pod-template annotations that make the graphroot a sentry-INTERNAL tmpfs
 * (not a gofer-proxied emptyDir) with file-capability xattr support, DISK
 * backed — see `sentryTmpfsAnnotations`.
 */
export const NESTED_GRAPHROOT_ANNOTATIONS: Record<string, string> =
  sentryTmpfsAnnotations(NESTED_GRAPHROOT_VOLUME, NESTED_GRAPHROOT_TMPFS_BYTES)

/**
 * Pod-template annotations that turn the emptyDir `volume` into a
 * sentry-INTERNAL tmpfs of at most `sizeBytes`, DISK backed. gVisor's
 * containerd shim resolves the volume name to its kubelet emptyDir path and
 * infers the medium from the annotation's `type`
 * (pkg/shim/v1/utils/volumes.go):
 *  - `type: tmpfs` → the container mount arrives at runsc as type tmpfs →
 *    memory-backed sentry tmpfs (pages pinned against the pod cgroup);
 *  - `type: bind` → the container mount stays a bind, the shim still
 *    rewrites the HINT type to tmpfs for an (empty) emptyDir → runsc mounts
 *    a sentry tmpfs paged against a self filestore file in the emptyDir —
 *    node-disk page cache, reclaimable under memory pressure.
 * `share: container` scopes it to the pod; `size=` bounds it (sentry
 * ENOSPC). Passed through to runsc by the containerd
 * `pod_annotations = ["dev.gvisor.*"]` allowlist (see
 * gvisorContainerdRuntimesToml). Verified live: setcap works, a forced
 * cgroup reclaim pages a 2GiB graphroot down to ~0 with intact readback.
 *
 * The hint matches the volume's own kubelet path, so it applies to a mount
 * of the WHOLE volume and never to a `subPath` of it — one volume per
 * mount point.
 */
export function sentryTmpfsAnnotations(volume: string, sizeBytes: number): Record<string, string> {
  return {
    [`dev.gvisor.spec.mount.${volume}.type`]: 'bind',
    [`dev.gvisor.spec.mount.${volume}.share`]: 'container',
    [`dev.gvisor.spec.mount.${volume}.options`]: `rw,size=${sizeBytes}`,
  }
}

/**
 * Volume-name prefix of a worktree's module dirs (`PodJobParams.moduleDirs`),
 * one volume per dir: `pnpm-modules-0` for the first, and so on.
 */
export const MODULES_VOLUME_PREFIX = 'pnpm-modules'

/**
 * Sentry tmpfs cap of each module-dir volume. Sized for a large monorepo's
 * root `node_modules` WITH the pnpm store inside it (the two share blocks —
 * the store hardlinks into `.pnpm`), with room to spare; this repo's is
 * ~1.5GiB. Disk-backed like the graphroot, so an ephemeral-storage budget,
 * not pod memory.
 */
export const MODULES_TMPFS_BYTES = 8 * 1024 ** 3

/** emptyDir sizeLimit of each module-dir volume: the cap plus the same
 *  slack as NESTED_GRAPHROOT_SIZELIMIT_BYTES, for the same reason. */
export const MODULES_SIZELIMIT_BYTES = MODULES_TMPFS_BYTES + 1024 ** 3

/**
 * What a worktree's modules add to its ephemeral-storage REQUEST: one
 * ordinary install, which every worktree that runs `pnpm install` really
 * does hold for its whole life.
 */
export const MODULES_REQUEST_BYTES = 2 * 1024 ** 3

/**
 * In-sandbox capabilities the rootful nested engine needs. Under the sentry
 * these grant NO host authority (the sandbox's host process is unprivileged
 * regardless), so this is the upstream docker-in-gvisor posture — broad
 * in-sandbox caps — not a host-security decision:
 *  - SYS_ADMIN, SYS_CHROOT: crun mount() family + pivot_root for container
 *    rootfs (overlay/proc/tmpfs).
 *  - MKNOD: device nodes (/dev/null, …) in containers.
 *  - SETFCAP: `setcap` in `docker build` RUN steps (apt/apk postinsts for
 *    ping, nginx, …) — the reason the graphroot must be a tmpfs.
 *  - NET_RAW, NET_ADMIN: raw sockets + in-netstack route/iptables config for
 *    nested containers (the gvisor-nested handler also passes --net-raw).
 *  - SYS_PTRACE, SYS_RESOURCE: debuggers / rlimit raises some builds need.
 * Verified end-to-end on the dev cluster (pull, run, build+setcap, promote).
 */
export const NESTED_ENGINE_CAPS = [
  'SYS_ADMIN', 'SYS_CHROOT', 'MKNOD', 'SETFCAP',
  'NET_RAW', 'NET_ADMIN', 'SYS_PTRACE', 'SYS_RESOURCE',
]

/**
 * hostPath `type` check. Defaults to 'Directory'. Use 'File' for
 * single-file binds, and `''` (kubernetes' "no check" type) for
 * user-supplied paths that may be either.
 */
export type HostPathType = 'Directory' | 'DirectoryOrCreate' | 'File' | 'FileOrCreate' | ''

/**
 * Where a worktree mount's bytes come from. The mount's container-side path
 * is fixed by the mount itself, never by the source, so re-sourcing a mount
 * is invisible inside the pod — which is the whole point: the storage tier
 * a path declares (GLOBAL / NODE-LOCAL, see packages/shared/src/paths.ts)
 * picks the source (`resolveMountSource`), and the pod spec is the only
 * place that has to render one.
 *
 *  - `hostPath` — a NODE-LOCAL path, on the node's own disk.
 *  - `pvc` — a subPath of a claim: the RWX `yaac-global` claim that carries
 *    the GLOBAL tier, which the server pod and every worktree pod mount.
 *  - `emptyDir` — pod-local scratch: a NODE-LOCAL path that nothing outside
 *    the pod ever opens needs no node identity at all, so it never has to
 *    survive the pod or be found again. The tmux socket dir is the standing
 *    example (see CONTAINER_TMUX_DIR).
 *
 * One bound worth knowing before moving a UNIX SOCKET onto an emptyDir:
 * under gVisor's `host-uds=all` the gofer binds the socket at the volume's
 * backing path on the node,
 * `/var/lib/kubelet/pods/<uid>/volumes/kubernetes.io~empty-dir/<name>/…`,
 * against the kernel's 107-usable-byte `sun_path` limit. That prefix is 91
 * bytes before the volume name, so the budget is the name plus the socket
 * file — comfortable for the sockets here (tmux's `ed-<i>/server` lands at
 * 102), but it shrinks by a byte each time a mount is prepended ahead of
 * one and the index gains a digit.
 */
export type MountSource =
  | { kind: 'hostPath'; path: string; type?: HostPathType }
  | { kind: 'pvc'; claimName: string; subPath?: string }
  | { kind: 'emptyDir'; sizeLimit?: number }

/** One volume mounted into the worktree container, plus where it comes from. */
export interface PodMount {
  source: MountSource
  mountPath: string
  readOnly?: boolean
}

/**
 * Volume-name prefix per source kind. The index is the mount's position in
 * the list, so a name is unique whatever the mix; keeping `hp-` for
 * hostPath means the local backend's rendered manifest is unchanged.
 */
const VOLUME_NAME_PREFIX: Record<MountSource['kind'], string> = {
  hostPath: 'hp',
  pvc: 'pv',
  emptyDir: 'ed',
}

/** The volume body (everything but `name`) for one mount source. */
function volumeSourceSpec(source: MountSource): Record<string, unknown> {
  switch (source.kind) {
    case 'hostPath':
      return { hostPath: { path: source.path, type: source.type ?? 'Directory' } }
    case 'pvc':
      // subPath rides on the volumeMount, not here: one claim backs many
      // mounts, each addressing its own subtree of it.
      return { persistentVolumeClaim: { claimName: source.claimName } }
    case 'emptyDir':
      return {
        emptyDir: source.sizeLimit === undefined ? {} : { sizeLimit: String(source.sizeLimit) },
      }
  }
}

export interface PodJobParams {
  jobName: string
  namespace: string
  /** Applied to the Job and its pod template (project, worktree-id, …). */
  labels: Record<string, string>
  image: string
  /** `NAME=VALUE` entries — same shape worktree-create builds today. */
  env: string[]
  /** Worktree mounts in render order, each declaring its own source. */
  mounts: PodMount[]
  /**
   * Scheduler reservation (the guaranteed floor). Kept well below
   * memoryLimitBytes so many idle worktrees pack onto one node — memory is
   * overcommitted the way the kernel already allows for limits. Omitting it
   * would make Kubernetes default the request up to the limit, hard-reserving
   * the full ceiling per worktree and starving new worktrees of node memory.
   */
  memoryRequestBytes: number
  /** Hard cgroup cap; exceeding it OOM-kills the container. */
  memoryLimitBytes: number
  /**
   * CPU floor in millicores. Without a request a worktree pod is invisible to
   * the scheduler's bin-packing — it costs a node nothing, which is
   * survivable on one local node and wrong anywhere capacity is planned or
   * autoscaled. Under contention this is also the weight: cpu is
   * compressible, so equal requests share a busy node evenly.
   */
  cpuRequestMillis: number
  /**
   * CPU ceiling in millicores. On a runc pod a limit would be the wrong
   * default — it lands as a CFS quota that throttles inside every 100ms
   * period, stalling an interactive worktree on an otherwise idle node. Under
   * gVisor it does double duty, and that second job is why it is set.
   *
   * runsc sizes the sandbox's virtual CPU count from the container's cpu
   * quota (`-cpu-num-from-quota`, on by default, floor of 2). With no limit
   * there is no quota, so it falls back to the HOST's core count and the
   * systrap platform spawns one stub process per core — every sandbox
   * carries as many stubs as the node has cores no matter how small its
   * share. A worktree that then does syscall-heavy work (an e2e run: image
   * builds, container starts) drives all of them at once and takes the whole
   * node with it, since e2e traps every syscall through the sentry.
   *
   * So the ceiling bounds one worktree's blast radius rather than its
   * ordinary latency. Keep it well ABOVE the request — the CFS-throttling
   * concern is real for a limit near the request, but a ceiling set many
   * multiples above it is never reached by interactive work (an agent
   * between turns, a single-threaded command) and only binds on the parallel
   * bursts it exists to bound.
   */
  cpuLimitMillis: number
  /**
   * Node-disk floor: the container's writable layer, its logs, and its
   * emptyDir volumes (hostPath and PVC mounts are not ephemeral storage, so
   * the repo, worktrees and caches don't count). Same overcommit shape as
   * memory — a request far below the limit, since most worktrees never come
   * near it.
   */
  ephemeralStorageRequestBytes: number
  /**
   * Ephemeral-storage ceiling; kubelet evicts the pod when the pod's total
   * usage exceeds it. Unlike cpu this limit earns its keep: node disk is
   * incompressible and shared, and one worktree filling it takes down every
   * pod on the node, so bounding the blast radius to the offender is worth
   * the eviction risk. Nested worktrees get the graphroot emptyDir's own
   * sizeLimit added on top (see the resources block) — kubelet counts that
   * volume against this number. So do `moduleDirs`.
   */
  ephemeralStorageLimitBytes: number
  /**
   * Pinned proxy Service ClusterIP. Worktree pods point their resolver at it
   * (dnsConfig below) so the proxy's DNS stub answers, and their 443/80
   * egress is redirected to it by netd's per-pod DNAT rules
   * (buildEgressRedirectCecManifest) — no per-pod redirect-init/relay sidecar.
   */
  proxyHost: string
  /**
   * In-pod podman: the rootful-engine graphroot, cap set, and gVisor
   * handler. False (or absent) leaves the pod spec byte-identical to one
   * built without the field. The engine's cross-worktree image cache needs
   * nothing here — it rides the project registry (image-promoter.ts), not
   * a mount.
   */
  nested?: boolean
  /**
   * Container paths of the worktree's module dirs (`WorkspaceSpec.moduleDirs`),
   * each backed by its own pod-local emptyDir promoted to a disk-backed
   * sentry tmpfs (`sentryTmpfsAnnotations`): pnpm's link and stat traffic
   * stays inside the sandbox instead of crossing the gofer, and a store
   * placed inside the root one is on the same mount as `node_modules/.pnpm`,
   * so pnpm hardlinks instead of copying. Gone with the pod, which is what
   * "ephemeral" means here — a worktree Job never restarts in place, and a
   * restart's init commands reinstall.
   */
  moduleDirs?: string[]
  /**
   * postStart lifecycle hook command (argv). Worktree pods run
   * `yaac-worktree-init` here — the kubelet holds the container's Ready
   * transition until the hook exits, so "pod Ready" implies the in-pod
   * setup (git config, tmux server, streamd) is done. A hook that exits
   * nonzero kills the container (restartPolicy Never → Job failure), which
   * worktree-create's retry loop surfaces.
   */
  postStartExec?: string[]
  /**
   * preStop lifecycle hook command (argv), run before the container is
   * signalled and bounded by the grace period: a hook that outruns it is
   * killed, not waited on. Worktree pods checkpoint opencode's working
   * copy here.
   */
  preStopExec?: string[]
  /**
   * NODE-LOCAL directories on the node this pod lands on, as node paths
   * under `nodeLocalRoot`, for the `node-dirs` init container to create.
   * hostPath ignores `fsGroup` and `DirectoryOrCreate` makes root-owned
   * directories, so the pod creates them itself, as root, and chowns each
   * one it made to the identity the pod runs as. Absent or empty renders
   * no init container.
   */
  nodeLocalDirs?: string[]
  /** The node root the init container mounts to create `nodeLocalDirs`
   *  under; required when they are given. */
  nodeLocalRoot?: string
  /** Matches the podman-era `container.stop({t: 5})` grace. */
  terminationGracePeriodSeconds?: number
}

/** Split a `NAME=VALUE` env entry at the first `=`. */
export function parseEnvEntry(entry: string): { name: string; value: string } {
  const idx = entry.indexOf('=')
  if (idx < 0) return { name: entry, value: '' }
  return { name: entry.slice(0, idx), value: entry.slice(idx + 1) }
}

/**
 * Build the Job manifest for one worktree: a single-pod Job
 * (`backoffLimit: 0`, `restartPolicy: Never`) whose pod carries the
 * worktree container plus every caller-declared mount (each rendered from
 * its own source) and the proxy-CA ConfigMap.
 *
 * Pure — no cluster access — so the full spec shape is unit-testable.
 */
export function buildPodJobManifest(p: PodJobParams): Record<string, unknown> {
  const volumes: Array<Record<string, unknown>> = []
  const volumeMounts: Array<Record<string, unknown>> = []

  p.mounts.forEach((m, i) => {
    const name = `${VOLUME_NAME_PREFIX[m.source.kind]}-${i}`
    volumes.push({ name, ...volumeSourceSpec(m.source) })
    volumeMounts.push({
      name,
      mountPath: m.mountPath,
      ...(m.source.kind === 'pvc' && m.source.subPath ? { subPath: m.source.subPath } : {}),
      ...(m.readOnly ? { readOnly: true } : {}),
    })
  })

  // Proxy CA cert — distributed via ConfigMap instead of the podman-era
  // `putArchive` copy, so a CA rotation only needs a ConfigMap update.
  volumes.push({
    name: 'proxy-ca',
    configMap: { name: CA_CONFIGMAP_NAME },
  })
  volumeMounts.push({ name: 'proxy-ca', mountPath: CA_MOUNT_DIR, readOnly: true })

  // Scratch dir for the ssh-agent forwarder's socket (SSH_AUTH_SOCK). An
  // emptyDir, unconditionally: it is pod-local by design (the agent is in
  // the proxy pod, reached over TCP), and creating it here keeps the
  // forwarder from needing root to mkdir it in the container rootfs. Pods
  // whose project has no SSH remote simply leave it empty.
  volumes.push({ name: 'ssh-agent', emptyDir: {} })
  volumeMounts.push({ name: 'ssh-agent', mountPath: SSH_AGENT_MOUNT })

  const initContainers: Array<Record<string, unknown>> = []
  if (p.nodeLocalDirs && p.nodeLocalDirs.length > 0) {
    if (!p.nodeLocalRoot) throw new Error('nodeLocalDirs given without nodeLocalRoot')
    volumes.push({
      name: 'node-root',
      hostPath: { path: p.nodeLocalRoot, type: 'DirectoryOrCreate' },
    })
    initContainers.push(nodeDirsInitContainer(p.image, p.nodeLocalRoot, p.nodeLocalDirs))
  }

  if (p.nested) {
    // Per-worktree ROOTFUL graphroot: a disk emptyDir promoted to a
    // disk-backed sentry-internal tmpfs by NESTED_GRAPHROOT_ANNOTATIONS so
    // `docker build` setcap steps work (goferfs refuses security.* xattr
    // writes) without layer data pinning pod memory. Owned by root — the
    // rootful engine runs as root, so no fsGroup/chown. sizeLimit bounds
    // ephemeral-storage above the sentry's size= cap (see
    // NESTED_GRAPHROOT_SIZELIMIT_BYTES).
    volumes.push({
      name: NESTED_GRAPHROOT_VOLUME,
      emptyDir: { sizeLimit: String(NESTED_GRAPHROOT_SIZELIMIT_BYTES) },
    })
    volumeMounts.push({ name: NESTED_GRAPHROOT_VOLUME, mountPath: NESTED_GRAPHROOT_PATH })
  }

  // One volume per module dir, never subPaths of one: the tmpfs hint keys
  // on a whole volume (see sentryTmpfsAnnotations). Not owned by root like
  // the graphroot — the sentry makes a tmpfs root world-writable, the way
  // the kernel's does, so the unprivileged worktree user can install into
  // it.
  const moduleDirs = p.moduleDirs ?? []
  let annotations: Record<string, string> = p.nested ? { ...NESTED_GRAPHROOT_ANNOTATIONS } : {}
  moduleDirs.forEach((dir, i) => {
    const name = `${MODULES_VOLUME_PREFIX}-${i}`
    volumes.push({ name, emptyDir: { sizeLimit: String(MODULES_SIZELIMIT_BYTES) } })
    volumeMounts.push({ name, mountPath: dir })
    annotations = { ...annotations, ...sentryTmpfsAnnotations(name, MODULES_TMPFS_BYTES) }
  })
  // kubelet charges emptyDir volumes to the pod's ephemeral storage. The
  // limit clears ONE module dir's sizeLimit on top of everything else: a
  // runaway install ENOSPCs inside its own dir long before it evicts the
  // worktree (which is fatal, backoffLimit 0), and a pod with several dirs
  // keeps its total bounded rather than multiplying the ceiling. That fits
  // a pnpm workspace, whose nested dirs hold only symlinks; several dirs
  // that are independent installs each hold a full copy (the store is on
  // another mount), and between them can reach the limit. The request
  // counts the one install every such worktree really holds.
  const modulesLimit = moduleDirs.length > 0 ? MODULES_SIZELIMIT_BYTES : 0
  const modulesRequest = moduleDirs.length > 0 ? MODULES_REQUEST_BYTES : 0

  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: {
      name: p.jobName,
      namespace: p.namespace,
      labels: p.labels,
    },
    spec: {
      backoffLimit: 0,
      template: {
        metadata: {
          labels: p.labels,
          // The gVisor tmpfs hints: the nested graphroot, the module dirs.
          ...(Object.keys(annotations).length > 0 ? { annotations } : {}),
        },
        spec: {
          restartPolicy: 'Never',
          terminationGracePeriodSeconds: p.terminationGracePeriodSeconds ?? 5,
          // The bottom scheduling tier: a full node sheds a worktree before
          // it sheds the proxy every worktree's network runs through.
          ...priorityClassSpec(),
          // Worktree pods host untrusted agent workloads: no cluster API
          // credentials, and no service-discovery env pollution.
          automountServiceAccountToken: false,
          enableServiceLinks: false,
          // The runtime's default seccomp profile — podman applied this by
          // default, kubernetes leaves pods unconfined without it. (runsc
          // ignores it and installs its own host seccomp; harmless.) The
          // rootful nested graphroot is a root-owned tmpfs, so no fsGroup —
          // which is why hostUidSecurityContext carries none.
          securityContext: {
            seccompProfile: { type: 'RuntimeDefault' },
            // Stamped rather than left to the image's own USER: the image
            // bakes a fixed uid, and what a worktree must run as is the host
            // uid that owns its checkout.
            ...hostUidSecurityContext(),
          },
          // Containment for in-container root (reachable via the image's
          // passwordless sudo, a feature — agents install packages
          // mid-worktree) is the sentry: in-sandbox root is a fiction with no
          // host authority. No user namespace anywhere — see runtimeClassSpec
          // for the tier policy (gvisor / gvisor-nested).
          ...runtimeClassSpec({ nested: !!p.nested }),
          // DNS: worktree pods resolve against the proxy's UDP/53 stub, which is
          // split-horizon — internal names (`*.svc`) are forwarded to the
          // cluster CoreDNS so the pod learns live ClusterIPs (the registry,
          // the project registry), while external names get a sinkhole IP since
          // egress is port-redirected on the node by netd (no per-pod
          // sidecar) and the proxy routes by SNI/Host. dnsPolicy None makes
          // this resolver the only one.
          dnsPolicy: 'None',
          dnsConfig: { nameservers: [p.proxyHost] },
          ...(initContainers.length > 0 ? { initContainers } : {}),
          containers: [
            {
              name: 'worktree',
              image: p.image,
              // Content-hash tags are immutable — a tag hit in the node's
              // image store is always the right bytes.
              imagePullPolicy: 'IfNotPresent',
              workingDir: '/workspace',
              env: p.env.map(parseEnvEntry),
              volumeMounts,
              ...(p.postStartExec || p.preStopExec ? {
                lifecycle: {
                  ...(p.postStartExec ? { postStart: { exec: { command: p.postStartExec } } } : {}),
                  ...(p.preStopExec ? { preStop: { exec: { command: p.preStopExec } } } : {}),
                },
              } : {}),
              // Nested only: the in-sandbox capabilities the rootful engine
              // needs (NESTED_ENGINE_CAPS). Under the sentry they grant no
              // host authority. No explicit allowPrivilegeEscalation: the
              // kubelet forces it true whenever a container holds
              // CAP_SYS_ADMIN, so setting it would be redundant (and false
              // would be rejected).
              ...(p.nested ? {
                securityContext: {
                  capabilities: { add: NESTED_ENGINE_CAPS },
                },
              } : {}),
              resources: {
                requests: {
                  cpu: `${p.cpuRequestMillis}m`,
                  memory: String(p.memoryRequestBytes),
                  'ephemeral-storage': String(p.ephemeralStorageRequestBytes + modulesRequest),
                },
                limits: {
                  // Also sets the sandbox's virtual cpu count, and with it
                  // how many systrap stubs it spawns — see cpuLimitMillis.
                  cpu: `${p.cpuLimitMillis}m`,
                  memory: String(p.memoryLimitBytes),
                  // kubelet charges a pod's emptyDir volumes to its
                  // ephemeral-storage limit, so a nested pod's limit must
                  // clear the graphroot volume's own sizeLimit or the first
                  // real `docker build` evicts the worktree — which is fatal
                  // (backoffLimit 0). Adding it here rather than at the call
                  // site keeps that accounting next to the constant.
                  'ephemeral-storage': String(
                    p.ephemeralStorageLimitBytes
                    + (p.nested ? NESTED_GRAPHROOT_SIZELIMIT_BYTES : 0)
                    + modulesLimit,
                  ),
                },
              },
            },
          ],
          volumes,
        },
      },
    },
  }
}

/** Where the init container sees the node root. */
const NODE_ROOT_MOUNT = '/node'

/**
 * Grace period of a pod with a preStop hook (seconds): a budget for the
 * hook (an opencode checkpoint — a SQLite backup plus a copy) rather than
 * the few seconds a bare SIGTERM needs. The detached teardown's Job
 * delete waits longer than this before it removes the pod's File-mount
 * sources (worktrees/teardown.ts).
 */
export const PRE_STOP_GRACE_SECONDS = 60

/**
 * The `node-dirs` init container: the pod's own image, as root, under the
 * pod's RuntimeClass like every other container of the pod — no extra
 * image, no extra pull. It walks each NODE-LOCAL directory the mount
 * list names one path component at a time, creating the component when
 * it is missing and chowning it to the pod's own identity either way —
 * never recursively, so a full pnpm store is never walked. The chown has
 * to be unconditional: kubelet sets every volume up before any init
 * container runs, so the leaf directory a `DirectoryOrCreate` hostPath
 * names already exists, root-owned, by the time this container sees it.
 * A component that is a symlink is removed and recreated as a directory:
 * the tree is writable by every pod of the project, and a walk that
 * followed a planted link would create and chown wherever it pointed.
 *
 * On kind the node root is host disk through the extraMount, and on macOS
 * a chown through virtiofs is cosmetic; both are fine, because the host
 * uid owns everything on that side anyway (docs/server-in-cluster.md "The
 * uid everything runs as").
 */
function nodeDirsInitContainer(
  image: string,
  nodeRoot: string,
  dirs: string[],
): Record<string, unknown> {
  const { runAsUser, runAsGroup } = hostUidSecurityContext()
  const script = [
    'set -e',
    'for d in "$@"; do',
    `  case "$d" in ${NODE_ROOT_MOUNT}/*) ;; *) echo "not under ${NODE_ROOT_MOUNT}: $d" >&2; exit 1;; esac`,
    `  p=${NODE_ROOT_MOUNT}`,
    `  rel=\${d#${NODE_ROOT_MOUNT}/}`,
    '  oldifs=$IFS; IFS=/',
    '  for seg in $rel; do',
    '    IFS=$oldifs',
    '    p="$p/$seg"',
    // A link planted by an earlier pod (the tree is pod-writable) would
    // redirect the mkdir and chown; remove it, never follow it.
    '    if [ -L "$p" ]; then rm -f "$p"; fi',
    '    [ -d "$p" ] || mkdir "$p"',
    `    chown ${String(runAsUser)}:${String(runAsGroup)} "$p"`,
    '    IFS=/',
    '  done',
    '  IFS=$oldifs',
    'done',
  ].join('\n')
  return {
    name: 'node-dirs',
    image,
    imagePullPolicy: 'IfNotPresent',
    securityContext: { runAsUser: 0, runAsGroup: 0 },
    command: [
      'sh', '-c', `${script}
`, '--',
      ...dirs.map((d) => `${NODE_ROOT_MOUNT}/${path.posix.relative(nodeRoot, d)}`),
    ],
    volumeMounts: [{ name: 'node-root', mountPath: NODE_ROOT_MOUNT }],
  }
}

/**
 * securityContext for every yaac pod that runs as this machine's own user:
 * the server, the proxy, worktree pods, the install's probe pods.
 *
 * Its two halves answer different questions.
 *
 * **The uid and gid are the HOST's.** Under gVisor there is no userns and no
 * idmap, so numeric uids pass through raw: a hostPath file owned by host uid
 * N appears in-container as uid N. That number is the install host's and on
 * macOS cannot be anything else — the data dir reaches the node over
 * virtiofs, whose host end performs every read and write as the user running
 * the VM, so the host uid is a ceiling no chown escapes in either direction
 * (docs/server-in-cluster.md). Inside the server pod this needs no
 * special-casing: the pod runs as the uid its install stamped, so
 * `process.getuid()` there IS the install host's uid, and every path the
 * server pre-creates for a worktree lands owned by it.
 *
 * **The supplementary group 0 is the IMAGE's.** yaac images bake a fixed
 * `yaac` user (uid 1000, primary group 0) and leave everything it owns
 * group-writable, which is what lets ONE image serve every host rather than
 * one image per uid (docs/arbitrary-uid-images.md). Membership in group 0 is
 * how a pod picks that grant up; without it a pod on a host whose uid is not
 * 1000 can write nothing in its own home. Supplementary rather than
 * `runAsGroup: 0` so that files the pod creates on a hostPath keep landing
 * in the host user's own group, exactly as they did when the uid was baked.
 *
 * `fsGroup` is deliberately absent: it applies only to ownership-managed
 * volumes (emptyDir), never to hostPath, and the one emptyDir a worktree pod
 * has that matters is the nested engine's root-owned graphroot. The proxy
 * Deployment adds `fsGroup: runAsGroup` at its call site, its HOME being an
 * emptyDir the kubelet has to hand over; nothing else here has a volume
 * `fsGroup` would touch.
 *
 * Throws rather than defaulting when getuid/getgid are unavailable: the
 * hostPath/uid model is POSIX-only, and emitting a manifest with an invented
 * uid would move the failure to a place that cannot explain it.
 */
export function hostUidSecurityContext(): {
  runAsUser: number
  runAsGroup: number
  supplementalGroups: number[]
} {
  const uid = process.getuid?.()
  const gid = process.getgid?.()
  if (uid === undefined || gid === undefined) {
    throw new Error(
      'hostUidSecurityContext: process.getuid/getgid unavailable — '
      + 'the yaac server requires a POSIX host',
    )
  }
  return { runAsUser: uid, runAsGroup: gid, supplementalGroups: [0] }
}
