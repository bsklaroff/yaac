import { LABEL_SESSION_ID } from '@/lib/k8s/pods'

/** ConfigMap (cluster-scoped to the yaac namespace) holding the proxy CA. */
export const CA_CONFIGMAP_NAME = 'yaac-proxy-ca'
/** Key inside the CA ConfigMap / filename inside the mount dir. */
export const CA_CONFIGMAP_KEY = 'proxy-ca.pem'
/** Directory inside session pods where the CA ConfigMap is mounted. */
export const CA_MOUNT_DIR = '/etc/yaac/certs'
/** Full in-container path of the proxy CA cert. */
export const CA_CERT_PATH = `${CA_MOUNT_DIR}/${CA_CONFIGMAP_KEY}`

/**
 * In-container mount point of the cross-session shared image store
 * (`additionalimagestores` in the nestable image's storage.conf). Mounted
 * rw because podman unconditionally creates lock-file directories inside
 * the store path (containers/storage#1733) — the promoter is the only
 * intentional writer; session-side writes are lock files only.
 */
export const SHARED_IMAGE_STORE_PATH = '/var/lib/shared-images'

/**
 * A second mount of the SAME shared-image-store hostPath, used only as the
 * promoter's write-side destination root. Distinct path, same directory:
 * the store is also listed in `additionalimagestores`, which podman opens
 * with a read-only lock, so a destination addressed as
 * SHARED_IMAGE_STORE_PATH fails ("not a read-write lock"). Writing through
 * a different path that podman doesn't recognize as its own additional
 * store gets a read-write lock; the bytes land in the same directory the
 * next session reads. Mirrors the pre-migration promoter's `/dst` mount.
 */
export const SHARED_IMAGE_STORE_DST_PATH = '/var/lib/shared-images-dst'

/**
 * In-container path of the per-session podman graphroot (an emptyDir, so
 * its lifetime matches the single-pod Job). The kind node mounts a real
 * filesystem at /var, so kubelet emptyDirs support native rootless
 * overlay (no fuse).
 */
export const NESTED_GRAPHROOT_PATH = '/home/yaac/.local/share/containers'

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
   * uid of the in-image yaac user (= the daemon uid, see sessionUid).
   * Used as the pod fsGroup so the kubelet chowns the graphroot emptyDir,
   * and as the chown target for the shared image store.
   */
  uid: number
  /**
   * Node-local hostPath backing the cross-session shared image store
   * (`/var/lib/yaac/imagecache/<dataDirHash>/<projectSlug>`). Root-owned
   * `DirectoryOrCreate` — a chown init container hands it to `uid`.
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
  memoryLimitBytes: number
  /**
   * Pinned proxy Service ClusterIP. Session pods point their resolver at it
   * (dnsConfig below) so the proxy's DNS stub answers, and their 443/80
   * egress is redirected to it by the cluster-level Cilium CEC + CNP
   * (buildEgressRedirectCecManifest) — no per-pod redirect-init/relay sidecar.
   */
  proxyHost: string
  /** In-pod podman wiring; absent for non-nested sessions. */
  nested?: NestedContainersParams
  /**
   * Static /etc/hosts entries for in-cluster names the pod must resolve
   * without the proxy DNS stub (which answers everything with a dummy IP).
   * glibc/musl consult files before the resolver, so these beat the stub;
   * the nestable image's `base_hosts_file` extends them into nested
   * containers. Used for the per-project registry host → pinned VIP
   * (vcluster sessions).
   */
  hostAliases?: Array<{ ip: string; hostnames: string[] }>
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
    // Per-session graphroot: emptyDir, chowned to the yaac uid via the
    // pod fsGroup (fsGroup touches ownership-managed volumes only —
    // hostPath mounts are unaffected).
    volumes.push({ name: 'podman-graphroot', emptyDir: {} })
    volumeMounts.push({ name: 'podman-graphroot', mountPath: NESTED_GRAPHROOT_PATH })
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
        metadata: { labels: p.labels },
        spec: {
          restartPolicy: 'Never',
          terminationGracePeriodSeconds: p.terminationGracePeriodSeconds ?? 5,
          ...(p.hostAliases?.length ? { hostAliases: p.hostAliases } : {}),
          // Session pods host untrusted agent workloads: no cluster API
          // credentials, and no service-discovery env pollution.
          automountServiceAccountToken: false,
          enableServiceLinks: false,
          // The runtime's default seccomp profile — podman applied this
          // by default, kubernetes leaves pods unconfined without it.
          // Nested sessions add fsGroup so the kubelet chowns the
          // graphroot emptyDir to the yaac uid.
          securityContext: {
            seccompProfile: { type: 'RuntimeDefault' },
            ...(p.nested ? { fsGroup: p.nested.uid } : {}),
          },
          // Run every session pod in a user namespace: in-container root
          // (reachable via the image's passwordless sudo, a feature —
          // agents install packages mid-session) maps to an unprivileged
          // node uid, restoring the containment the rootless-podman
          // backend had. Requirements the cluster must satisfy: an
          // unmasked sysfs mount on the kind node (setup-kind-cluster.sh
          // applies it; kind#3436) and idmapped-mount support on the
          // filesystem behind hostPath volumes — ext4/xfs/btrfs on
          // Linux; on macOS this means the libkrun podman-machine
          // provider with libkrun-efi >= 1.17 (applehv's virtiofs server
          // does not negotiate FUSE idmap support). See "Cluster setup"
          // in the README; `yaac cluster check` probes this end to end.
          hostUsers: false,
          // DNS: session pods resolve against the proxy's UDP/53 stub — every
          // A query gets a dummy IP. Resolution is decorative: Cilium
          // redirects egress by port (cluster-level CEC + CNP, no per-pod
          // redirect-init/relay sidecar) and the proxy routes by SNI/Host.
          // hostAliases still beat it for in-cluster names. dnsPolicy None
          // makes this resolver the only one.
          dnsPolicy: 'None',
          dnsConfig: { nameservers: [p.proxyHost] },
          // Nested sessions prepend a chown init container: the shared image
          // store hostPath is root-owned (DirectoryOrCreate), and
          // root-in-userns (hostUsers: false) hands it to the yaac uid —
          // idmapped-mount identity across pods is proven by the
          // cluster-check uid probe.
          ...(p.nested ? {
            initContainers: [{
              name: 'yaac-imagestore-init',
              image: p.image,
              imagePullPolicy: 'IfNotPresent',
              securityContext: { runAsUser: 0 },
              command: [
                'sh', '-c',
                `chown ${p.nested.uid}:${p.nested.uid} ${SHARED_IMAGE_STORE_PATH}`,
              ],
              volumeMounts: [
                { name: 'shared-images', mountPath: SHARED_IMAGE_STORE_PATH },
              ],
            }],
          } : {}),
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
              // Nested only: seccompProfile stays RuntimeDefault; the
              // userns-scoped SYS_ADMIN (hostUsers: false — no host
              // authority) exists to make containerd's static profile
              // compile the mount-family syscalls into the seccomp
              // allowlist, which rootless podman needs for overlay/proc/
              // tmpfs mounts (and `docker build` RUN steps cannot avoid
              // mount()). No explicit allowPrivilegeEscalation: the kubelet
              // forces it true whenever a container holds CAP_SYS_ADMIN, so
              // setting it would be redundant (and false would be rejected).
              ...(p.nested ? {
                securityContext: {
                  capabilities: { add: ['SYS_ADMIN'] },
                },
              } : {}),
              resources: {
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
