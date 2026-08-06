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
/** Directory inside session pods where the CA ConfigMap is mounted. */
export const CA_MOUNT_DIR = '/etc/yaac/certs'
/** Full in-container path of the proxy CA cert. */
export const CA_CERT_PATH = `${CA_MOUNT_DIR}/${CA_CONFIGMAP_KEY}`
/** Full in-container path of the combined trust bundle (roots + proxy CA). */
export const CA_BUNDLE_PATH = `${CA_MOUNT_DIR}/${CA_BUNDLE_KEY}`

/**
 * Directory inside session pods holding the forwarded ssh-agent socket, and
 * the socket path SSH_AUTH_SOCK names. Pod-local scratch (an emptyDir, see
 * buildSessionJobManifest): the agent itself lives in the proxy pod and is
 * reached over TCP (SSH_AGENT_PORT), so nothing here is shared between pods
 * — only the in-pod forwarder writes it, and only the session's own ssh
 * client reads it.
 */
export const SSH_AGENT_MOUNT = '/ssh-agent'
export const SSH_AGENT_SOCKET_PATH = `${SSH_AGENT_MOUNT}/socket`

/**
 * In-container path of the per-session ROOTFUL podman graphroot — podman's
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
 * Sized so a session can hold the yaac image chain (base, tools, nestable —
 * layer-shared, but ~6.5GiB unique) plus the upstream mirrors its cluster
 * pulls AND still build on top of them. At 8GiB that fit had no slack at
 * all: a warm image cache left the e2e image builds ENOSPC'ing.
 *
 * Only the pod's ephemeral-storage LIMIT clears this; the request does
 * not, so raising it does not cost scheduling density — but it does raise
 * each nested session's unaccounted worst case by the same amount. At node
 * disk saturation kubelet ranks eviction by usage-over-request, so the fat
 * nested sessions go first, which is fatal to them (backoffLimit 0) and is
 * the ordering the PriorityClass split already intends.
 */
export const NESTED_GRAPHROOT_TMPFS_BYTES = 12 * 1024 ** 3

/**
 * emptyDir sizeLimit for the graphroot volume: the sentry's `size=` cap
 * plus slack. The filestore file kubelet sees can carry sentry metadata
 * beyond the byte cap it enforces; a sizeLimit at exactly the cap would
 * race kubelet's du-based eviction (which kills the whole session) against
 * the sentry's ENOSPC (which fails just the write). The slack makes
 * eviction unreachable while still bounding a runaway volume.
 */
export const NESTED_GRAPHROOT_SIZELIMIT_BYTES = NESTED_GRAPHROOT_TMPFS_BYTES + 1024 ** 3

/**
 * Pod-template annotations that make the graphroot a sentry-INTERNAL tmpfs
 * (not a gofer-proxied emptyDir) with file-capability xattr support, DISK
 * backed. gVisor's containerd shim resolves the volume name to its kubelet
 * emptyDir path and infers the medium from the annotation's `type`
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
 */
export const NESTED_GRAPHROOT_ANNOTATIONS: Record<string, string> =
  graphrootMountAnnotations(NESTED_GRAPHROOT_TMPFS_BYTES)

/**
 * The annotation set above, parameterized on the sentry tmpfs size cap so
 * other podman-in-gvisor pods (the ephemeral builder pods of
 * docs/trust-split-builds.md) can size their graphroot independently
 * of session pods. Keys on NESTED_GRAPHROOT_VOLUME — the pod must mount
 * its graphroot emptyDir under that volume name.
 */
export function graphrootMountAnnotations(sizeBytes: number): Record<string, string> {
  return {
    [`dev.gvisor.spec.mount.${NESTED_GRAPHROOT_VOLUME}.type`]: 'bind',
    [`dev.gvisor.spec.mount.${NESTED_GRAPHROOT_VOLUME}.share`]: 'container',
    [`dev.gvisor.spec.mount.${NESTED_GRAPHROOT_VOLUME}.options`]: `rw,size=${sizeBytes}`,
  }
}

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
 * Where a session mount's bytes come from. The mount's container-side path
 * is fixed by the mount itself, never by the source, so re-sourcing a mount
 * is invisible inside the pod — which is the whole point: the storage tier
 * a path declares (SHARED / NODE-LOCAL, see packages/shared/src/paths.ts)
 * picks the source, and the pod spec is the only place that has to know.
 *
 *  - `hostPath` — what every tier renders as on the local backend, whose
 *    single node and server process share one filesystem.
 *  - `pvc` — a subPath of a claim: the RWX volume that carries the SHARED
 *    tier on a multi-node cluster, where the server pod and the session pod
 *    mount the same claim. Rendered here, but nothing selects it yet — the
 *    claims and the in-cluster server that provisions them are
 *    docs/plans/stock-k8s-multi-node.md §1–2.
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

/** One volume mounted into the session container, plus where it comes from. */
export interface SessionMount {
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

export interface SessionJobParams {
  jobName: string
  namespace: string
  /** Applied to the Job and its pod template (project, session-id, …). */
  labels: Record<string, string>
  image: string
  /** `NAME=VALUE` entries — same shape session-create builds today. */
  env: string[]
  /** Session mounts in render order, each declaring its own source. */
  mounts: SessionMount[]
  /**
   * Scheduler reservation (the guaranteed floor). Kept well below
   * memoryLimitBytes so many idle sessions pack onto one node — memory is
   * overcommitted the way the kernel already allows for limits. Omitting it
   * would make Kubernetes default the request up to the limit, hard-reserving
   * the full ceiling per session and starving new sessions of node memory.
   */
  memoryRequestBytes: number
  /** Hard cgroup cap; exceeding it OOM-kills the container. */
  memoryLimitBytes: number
  /**
   * CPU floor in millicores. Without a request a session pod is invisible to
   * the scheduler's bin-packing — it costs a node nothing, which is
   * survivable on one local node and wrong anywhere capacity is planned or
   * autoscaled. Under contention this is also the weight: cpu is
   * compressible, so equal requests share a busy node evenly.
   */
  cpuRequestMillis: number
  /**
   * CPU ceiling in millicores. On a runc pod a limit would be the wrong
   * default — it lands as a CFS quota that throttles inside every 100ms
   * period, stalling an interactive session on an otherwise idle node. Under
   * gVisor it does double duty, and that second job is why it is set.
   *
   * runsc sizes the sandbox's virtual CPU count from the container's cpu
   * quota (`-cpu-num-from-quota`, on by default, floor of 2). With no limit
   * there is no quota, so it falls back to the HOST's core count and the
   * systrap platform spawns one stub process per core — every sandbox
   * carries as many stubs as the node has cores no matter how small its
   * share. A session that then does syscall-heavy work (an e2e run: image
   * builds, container starts) drives all of them at once and takes the whole
   * node with it, since e2e traps every syscall through the sentry.
   *
   * So the ceiling bounds one session's blast radius rather than its
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
   * memory — a request far below the limit, since most sessions never come
   * near it.
   */
  ephemeralStorageRequestBytes: number
  /**
   * Ephemeral-storage ceiling; kubelet evicts the pod when the pod's total
   * usage exceeds it. Unlike cpu this limit earns its keep: node disk is
   * incompressible and shared, and one session filling it takes down every
   * pod on the node, so bounding the blast radius to the offender is worth
   * the eviction risk. Nested sessions get the graphroot emptyDir's own
   * sizeLimit added on top (see the resources block) — kubelet counts that
   * volume against this number.
   */
  ephemeralStorageLimitBytes: number
  /**
   * Pinned proxy Service ClusterIP. Session pods point their resolver at it
   * (dnsConfig below) so the proxy's DNS stub answers, and their 443/80
   * egress is redirected to it by netd's per-pod DNAT rules
   * (buildEgressRedirectCecManifest) — no per-pod redirect-init/relay sidecar.
   */
  proxyHost: string
  /**
   * In-pod podman: the rootful-engine graphroot, cap set, and gVisor
   * handler. False (or absent) leaves the pod spec byte-identical to one
   * built without the field. The engine's cross-session image cache needs
   * nothing here — it rides the project registry (image-promoter.ts), not
   * a mount.
   */
  nested?: boolean
  /**
   * postStart lifecycle hook command (argv). Session pods run
   * `yaac-session-init` here — the kubelet holds the container's Ready
   * transition until the hook exits, so "pod Ready" implies the in-pod
   * setup (git config, tmux server, streamd) is done. A hook that exits
   * nonzero kills the container (restartPolicy Never → Job failure), which
   * session-create's retry loop surfaces.
   */
  postStartExec?: string[]
  /**
   * True for a pod created by an inner (nested) yaac against its vcluster,
   * which has no RuntimeClass objects — so no `runtimeClassName` is stamped
   * and the vcluster syncer sets the host-side runtime. A host pod (the
   * default) is stamped `gvisor`, or `gvisor-nested` when `nested` is set.
   * Either way there is no user namespace: the sentry is the containment.
   */
  innerYaac?: boolean
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
 * Build the Job manifest for one session: a single-pod Job
 * (`backoffLimit: 0`, `restartPolicy: Never`) whose pod carries the
 * session container plus every caller-declared mount (each rendered from
 * its own source) and the proxy-CA ConfigMap.
 *
 * Pure — no cluster access — so the full spec shape is unit-testable.
 */
export function buildSessionJobManifest(p: SessionJobParams): Record<string, unknown> {
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

  if (p.nested) {
    // Per-session ROOTFUL graphroot: a disk emptyDir promoted to a
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
          // Nested pods carry the gVisor graphroot-tmpfs annotations.
          ...(p.nested ? { annotations: NESTED_GRAPHROOT_ANNOTATIONS } : {}),
        },
        spec: {
          restartPolicy: 'Never',
          terminationGracePeriodSeconds: p.terminationGracePeriodSeconds ?? 5,
          // The bottom scheduling tier: a full node sheds a session before
          // it sheds the proxy every session's network runs through. Inner
          // (vcluster) pods stamp none — see priorityClassSpec.
          ...priorityClassSpec({ inner: p.innerYaac }),
          // Session pods host untrusted agent workloads: no cluster API
          // credentials, and no service-discovery env pollution.
          automountServiceAccountToken: false,
          enableServiceLinks: false,
          // The runtime's default seccomp profile — podman applied this by
          // default, kubernetes leaves pods unconfined without it. (runsc
          // ignores it and installs its own host seccomp; harmless.) The
          // rootful nested graphroot is a root-owned tmpfs, so no fsGroup.
          securityContext: {
            seccompProfile: { type: 'RuntimeDefault' },
          },
          // Containment for in-container root (reachable via the image's
          // passwordless sudo, a feature — agents install packages
          // mid-session) is the sentry: in-sandbox root is a fiction with no
          // host authority. No user namespace anywhere — see runtimeClassSpec
          // for the tier policy (gvisor / gvisor-nested / inner stamps none).
          ...runtimeClassSpec({ inner: p.innerYaac, nested: !!p.nested }),
          // DNS: session pods resolve against the proxy's UDP/53 stub, which is
          // split-horizon — internal names (`*.svc`) are forwarded to the
          // cluster CoreDNS so the pod learns live ClusterIPs (the registry,
          // its vcluster API), while external names get a sinkhole IP since
          // egress is port-redirected on the node by netd (no per-pod
          // sidecar) and the proxy routes by SNI/Host. dnsPolicy None makes
          // this resolver the only one.
          dnsPolicy: 'None',
          dnsConfig: { nameservers: [p.proxyHost] },
          containers: [
            {
              name: 'session',
              image: p.image,
              // Content-hash tags are immutable — a tag hit in the node's
              // image store is always the right bytes.
              imagePullPolicy: 'IfNotPresent',
              workingDir: '/workspace',
              env: p.env.map(parseEnvEntry),
              volumeMounts,
              ...(p.postStartExec ? {
                lifecycle: { postStart: { exec: { command: p.postStartExec } } },
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
                  'ephemeral-storage': String(p.ephemeralStorageRequestBytes),
                },
                limits: {
                  // Also sets the sandbox's virtual cpu count, and with it
                  // how many systrap stubs it spawns — see cpuLimitMillis.
                  cpu: `${p.cpuLimitMillis}m`,
                  memory: String(p.memoryLimitBytes),
                  // kubelet charges a pod's emptyDir volumes to its
                  // ephemeral-storage limit, so a nested pod's limit must
                  // clear the graphroot volume's own sizeLimit or the first
                  // real `docker build` evicts the session — which is fatal
                  // (backoffLimit 0). Adding it here rather than at the call
                  // site keeps that accounting next to the constant.
                  'ephemeral-storage': String(
                    p.ephemeralStorageLimitBytes
                    + (p.nested ? NESTED_GRAPHROOT_SIZELIMIT_BYTES : 0),
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

/**
 * The uid session pods run as (`runAsUser`), and the uid baked into session
 * images as the `yaac` user (YAAC_UID build arg) so the two agree. Under
 * gVisor there is no userns and no idmap, so numeric uids pass through raw:
 * a hostPath file owned by host uid N appears in-container as uid N.
 * Server-created dirs (worktrees, cache volumes, config mounts) are owned by
 * the server's uid — the in-container user must carry the same uid to write
 * them. Falls back to 1000 when there is no uid to mirror (non-POSIX) or the
 * server runs as root (uid 0 is taken inside the image).
 */
export function sessionUid(): number {
  const uid = process.getuid?.() ?? 1000
  return uid > 0 ? uid : 1000
}
