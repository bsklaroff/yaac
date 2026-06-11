import { LABEL_SESSION_ID } from '@/lib/k8s/pods'

/** ConfigMap (cluster-scoped to the yaac namespace) holding the proxy CA. */
export const CA_CONFIGMAP_NAME = 'yaac-proxy-ca'
/** Key inside the CA ConfigMap / filename inside the mount dir. */
export const CA_CONFIGMAP_KEY = 'proxy-ca.pem'
/** Directory inside session pods where the CA ConfigMap is mounted. */
export const CA_MOUNT_DIR = '/etc/yaac/certs'
/** Full in-container path of the proxy CA cert. */
export const CA_CERT_PATH = `${CA_MOUNT_DIR}/${CA_CONFIGMAP_KEY}`

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
          // Session pods host untrusted agent workloads: no cluster API
          // credentials, and no service-discovery env pollution.
          automountServiceAccountToken: false,
          enableServiceLinks: false,
          // The runtime's default seccomp profile — podman applied this
          // by default, kubernetes leaves pods unconfined without it.
          securityContext: { seccompProfile: { type: 'RuntimeDefault' } },
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
