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
 * Transparent-egress sidecar parameters. Pure values (image refs, ports,
 * the pinned proxy VIP, the per-session relay credential) so the
 * manifest stays unit-testable; the daemon resolves them at create time.
 *
 * Two init containers compose here: `yaac-redirect-init` installs the
 * pod-netns REDIRECT rules and runs to completion, then `yaac-relay`
 * (a native sidecar — `restartPolicy: Always`) accepts the redirected
 * traffic and forwards it to the shared proxy with a PROXY-protocol-v2
 * identity header. The relay holds the session credential; the workload
 * container (separate env) never sees it.
 */
export interface EgressSidecarParams {
  /** Content-hash tagged `yaac-redirect-init` image ref. */
  redirectImage: string
  /** Content-hash tagged `yaac-relay` image ref. */
  relayImage: string
  /** Loopback port for redirected 443 (relay HTTPS listener). */
  relayHttpsPort: number
  /** Loopback port for redirected 80 (relay HTTP listener). */
  relayHttpPort: number
  /** Loopback port git's ncat CONNECT targets (relay tunnel listener). */
  relayConnectPort: number
  /** Loopback UDP port of the relay's DNS stub (redirected udp/53). */
  relayDnsPort: number
  /**
   * uid the relay runs as (distinct from the workload's yaac uid) — also
   * the key of the redirect-init filter table's egress carve-out.
   */
  relayUid: number
  /**
   * Pinned proxy Service ClusterIP — an IP, never a DNS name. The relay
   * dials it without resolution (the pod's udp/53 is REDIRECTed to its
   * own stub), and redirect-init's filter carve-out admits relay egress
   * to exactly this address. See clusterIpForNamespace.
   */
  proxyHost: string
  transparentHttpsPort: number
  transparentHttpPort: number
  transparentTunnelPort: number
  /** The session this pod belongs to — half of the relay's PP2 identity. */
  sessionId: string
  /** HMAC(PROXY_AUTH_SECRET, "relay:"+sessionId); the proxy re-verifies it. */
  relayToken: string
  /**
   * Extra in-pod filter ACCEPTs — literal `<ipv4>:<port>` pairs the
   * redirect-init script installs above its REJECTs. Pinned Service VIPs
   * only (the rules are frozen for the pod's lifetime), on ports the nat
   * layer never captures (registry 5000, vcluster API 8443 — never
   * 443/80). Each entry needs a matching NetworkPolicy allowance at the
   * CNI layer; neither layer alone admits the flow.
   */
  extraTcpAccept?: string[]
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
  egress: EgressSidecarParams
  /** In-pod podman wiring; absent for non-nested sessions. */
  nested?: NestedContainersParams
  /**
   * Static /etc/hosts entries for in-cluster names the pod must resolve
   * without kube-dns (DNS never leaves the pod — the relay stub answers
   * everything with a dummy IP). glibc/musl consult files before the
   * resolver, so these beat the stub; the nestable image's
   * `base_hosts_file` extends them into nested containers. Used for the
   * per-project registry host → pinned VIP (vcluster sessions).
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
          // Transparent egress, two init containers in order:
          //   1. yaac-redirect-init (NET_ADMIN, run-to-completion): installs
          //      pod-netns REDIRECT rules sending outbound 443/80 to the
          //      relay. NET_ADMIN is scoped to the pod's user namespace
          //      (hostUsers: false) and to this container only.
          //   2. yaac-relay (native sidecar, restartPolicy Always): accepts
          //      the redirected traffic, recovers the original destination,
          //      and forwards to the proxy with a PP2 identity header. Its
          //      startupProbe gates the workload container, so no session
          //      byte can egress before the relay is up. Runs as a distinct
          //      uid with no added capability; only it holds the token.
          // Nested sessions prepend a chown init container: the shared
          // image store hostPath is root-owned (DirectoryOrCreate), and
          // root-in-userns (hostUsers: false) is enough to hand it to the
          // yaac uid — idmapped-mount identity across pods is proven by
          // the cluster-check uid probe.
          initContainers: [
            ...(p.nested ? [{
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
            }] : []),
            {
              name: 'yaac-redirect-init',
              image: p.egress.redirectImage,
              imagePullPolicy: 'IfNotPresent',
              securityContext: { capabilities: { add: ['NET_ADMIN'] } },
              env: [
                { name: 'REDIRECT_HTTPS_PORT', value: String(p.egress.relayHttpsPort) },
                { name: 'REDIRECT_HTTP_PORT', value: String(p.egress.relayHttpPort) },
                { name: 'REDIRECT_DNS_PORT', value: String(p.egress.relayDnsPort) },
                // Filter-table default-deny parameters: only the relay uid
                // may leave the pod, and only to the proxy VIP's transport
                // ports.
                { name: 'RELAY_UID', value: String(p.egress.relayUid) },
                { name: 'PROXY_CLUSTER_IP', value: p.egress.proxyHost },
                { name: 'TRANSPARENT_HTTPS_PORT', value: String(p.egress.transparentHttpsPort) },
                { name: 'TRANSPARENT_HTTP_PORT', value: String(p.egress.transparentHttpPort) },
                { name: 'TRANSPARENT_TUNNEL_PORT', value: String(p.egress.transparentTunnelPort) },
                // Pinned-VIP in-cluster carve-outs (vcluster sessions
                // only) — filter ACCEPTs the script installs above its
                // REJECTs. Omitted entirely otherwise.
                ...(p.egress.extraTcpAccept?.length ? [{
                  name: 'EXTRA_TCP_ACCEPT',
                  value: p.egress.extraTcpAccept.join(','),
                }] : []),
              ],
            },
            {
              name: 'yaac-relay',
              image: p.egress.relayImage,
              imagePullPolicy: 'IfNotPresent',
              // Native sidecar: a long-running init container. The kubelet
              // starts it after redirect-init completes and holds the
              // workload container until its startupProbe passes.
              restartPolicy: 'Always',
              securityContext: {
                runAsUser: p.egress.relayUid,
                allowPrivilegeEscalation: false,
                capabilities: { drop: ['ALL'] },
              },
              env: [
                { name: 'LISTEN_HTTPS_PORT', value: String(p.egress.relayHttpsPort) },
                { name: 'LISTEN_HTTP_PORT', value: String(p.egress.relayHttpPort) },
                { name: 'LISTEN_CONNECT_PORT', value: String(p.egress.relayConnectPort) },
                { name: 'LISTEN_DNS_PORT', value: String(p.egress.relayDnsPort) },
                { name: 'PROXY_HOST', value: p.egress.proxyHost },
                { name: 'TRANSPARENT_HTTPS_PORT', value: String(p.egress.transparentHttpsPort) },
                { name: 'TRANSPARENT_HTTP_PORT', value: String(p.egress.transparentHttpPort) },
                { name: 'TRANSPARENT_TUNNEL_PORT', value: String(p.egress.transparentTunnelPort) },
                { name: 'SESSION_ID', value: p.egress.sessionId },
                { name: 'RELAY_TOKEN', value: p.egress.relayToken },
              ],
              // Exec probe, not tcpSocket: the relay listens on loopback
              // only (127.0.0.1) — security-critical, since a pod's
              // NetworkPolicy is Egress-only and a relay reachable on the
              // pod IP would let any in-cluster peer tunnel out under this
              // session's credential. The kubelet's tcpSocket probe dials
              // the pod IP, which loopback refuses; the relay instead
              // writes a ready file once both listeners bind, which this
              // probe checks from inside the netns.
              startupProbe: {
                exec: { command: ['sh', '-c', 'test -f /tmp/yaac-relay-ready'] },
                periodSeconds: 1,
                failureThreshold: 30,
              },
            },
          ],
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
