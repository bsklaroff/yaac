import { runtimeClassSpec } from '#platform/k8s/gvisor'
import { LABEL_SESSION_ID } from '#platform/k8s/pods'

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
 * In-container mount point of the cross-session shared image store
 * (`additionalimagestores` in the nestable image's storage.conf). Mounted
 * rw because podman unconditionally creates lock-file directories inside
 * the store path (containers/storage#1733) — store CONTENT is only ever
 * written node-side by the salvage writer pod (image-promoter.ts);
 * session-side writes are lock files only.
 */
export const SHARED_IMAGE_STORE_PATH = '/var/lib/shared-images'

/**
 * A second mount of the SAME shared-image-store hostPath, used by the
 * salvage survey as its tar handoff directory (a bulk sequential write —
 * the one gofer write pattern that's fast). Distinct path, same
 * directory: the store is also listed in `additionalimagestores`, which
 * podman opens with a read-only lock, so in-pod writes addressed under
 * SHARED_IMAGE_STORE_PATH would collide with that lock; a separate path
 * podman doesn't recognize as its own additional store stays out of the
 * way, and the node-side writer sees the tar in the same directory.
 */
export const SHARED_IMAGE_STORE_DST_PATH = '/var/lib/shared-images-dst'

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
 */
export const NESTED_GRAPHROOT_TMPFS_BYTES = 8 * 1024 ** 3

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

export interface HostPathMount {
  hostPath: string
  mountPath: string
  readOnly?: boolean
  /**
   * Defaults to 'Directory'. Use 'File' for single-file binds, and `''`
   * (kubernetes' "no check" type) for user-supplied paths that may be
   * either.
   */
  type?: 'Directory' | 'DirectoryOrCreate' | 'File' | 'FileOrCreate' | ''
}

/**
 * Nested-containers (in-pod rootless podman) parameters. Present only for
 * `nestedContainers: true` sessions — non-nested pod specs are
 * byte-identical to a spec built without this field.
 */
export interface NestedContainersParams {
  /**
   * Node-local hostPath backing the cross-session shared image store
   * (`/var/lib/yaac/imagecache/<dataDirHash>/<projectSlug>`). Root-owned
   * `DirectoryOrCreate`: the rootful in-sandbox engine reads it (as its
   * `additionalimagestores` lower), the salvage survey drops its tar
   * handoff in it, and the node-side writer pod populates it — all as
   * root, so no ownership fixup is needed.
   */
  sharedImagesHostPath: string
}

export interface SessionJobParams {
  jobName: string
  namespace: string
  /** Applied to the Job and its pod template (project, session-id, …). */
  labels: Record<string, string>
  image: string
  /** `NAME=VALUE` entries — same shape session-create builds today. */
  env: string[]
  hostPathMounts: HostPathMount[]
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
   * Pinned proxy Service ClusterIP. Session pods point their resolver at it
   * (dnsConfig below) so the proxy's DNS stub answers, and their 443/80
   * egress is redirected to it by netd's per-pod DNAT rules
   * (buildEgressRedirectCecManifest) — no per-pod redirect-init/relay sidecar.
   */
  proxyHost: string
  /** In-pod podman wiring; absent for non-nested sessions. */
  nested?: NestedContainersParams
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
 * session container plus all hostPath mounts and the proxy-CA ConfigMap.
 *
 * Pure — no cluster access — so the full spec shape is unit-testable.
 */
export function buildSessionJobManifest(p: SessionJobParams): Record<string, unknown> {
  const volumes: Array<Record<string, unknown>> = []
  const volumeMounts: Array<Record<string, unknown>> = []

  p.hostPathMounts.forEach((m, i) => {
    const name = `hp-${i}`
    volumes.push({
      name,
      hostPath: { path: m.hostPath, type: m.type ?? 'Directory' },
    })
    volumeMounts.push({
      name,
      mountPath: m.mountPath,
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
    // Cross-session shared image store (additionalimagestores). rw — see
    // SHARED_IMAGE_STORE_PATH. Mounted at a second path too
    // (SHARED_IMAGE_STORE_DST_PATH) so the teardown promoter can write to
    // it without colliding with the read-only additional-store lock.
    volumes.push({
      name: 'shared-images',
      hostPath: { path: p.nested.sharedImagesHostPath, type: 'DirectoryOrCreate' },
    })
    volumeMounts.push({ name: 'shared-images', mountPath: SHARED_IMAGE_STORE_PATH })
    volumeMounts.push({ name: 'shared-images', mountPath: SHARED_IMAGE_STORE_DST_PATH })
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
                requests: { memory: String(p.memoryRequestBytes) },
                limits: { memory: String(p.memoryLimitBytes) },
              },
            },
          ],
          volumes,
        },
      },
    },
  }
}

/** Sanity guard used by session-create: labels must carry the session id. */
export function assertSessionLabels(labels: Record<string, string>): void {
  if (!labels[LABEL_SESSION_ID]) {
    throw new Error(`session Job labels missing ${LABEL_SESSION_ID}`)
  }
}
