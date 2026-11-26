import path from 'node:path'
import { DNS_SINKHOLE } from './proxy-constants'
import { socketsNodePath } from './mount-sources'

/** ConfigMap (cluster-scoped to the yaac namespace) holding the proxy CA. */
export const CA_CONFIGMAP_NAME = 'yaac-proxy-ca'
/** Key inside the CA ConfigMap / filename inside the mount dir. */
export const CA_CONFIGMAP_KEY = 'proxy-ca.pem'
/**
 * Second key in the CA ConfigMap: public roots plus the proxy CA. Tools
 * that take one file as their whole trust set (curl, requests, cargo, git)
 * point `CURL_CA_BUNDLE` and similar at it, so they trust both intercepted
 * and tunnelled hosts (docs/workspace-egress.md "CA trust in a workspace").
 */
export const CA_BUNDLE_KEY = 'ca-bundle.pem'
/**
 * Third key in the CA ConfigMap: a known_hosts file holding the proxy's ssh
 * host key under `SSH_HOST_KEY_ALIAS`, which a workspace's git trusts for
 * every ssh remote.
 */
export const CA_SSH_KNOWN_HOSTS_KEY = 'ssh_known_hosts'

/**
 * Pod annotations that turn emptyDir `volume` into a sentry-internal tmpfs
 * of at most `sizeBytes`, paged to a file in the emptyDir on node disk.
 * `type: bind` gives the disk-backed variant; `type: tmpfs` would pin
 * pages in pod memory (gVisor's pkg/shim/v1/utils/volumes.go). containerd
 * passes `dev.gvisor.*` annotations through (gvisorContainerdRuntimesToml).
 *
 * The hint applies only to a mount of the whole volume, never a `subPath`,
 * so each mount point needs its own volume.
 */
export function sentryTmpfsAnnotations(volume: string, sizeBytes: number): Record<string, string> {
  return {
    [`dev.gvisor.spec.mount.${volume}.type`]: 'bind',
    [`dev.gvisor.spec.mount.${volume}.share`]: 'container',
    [`dev.gvisor.spec.mount.${volume}.options`]: `rw,size=${sizeBytes}`,
  }
}

/**
 * hostPath `type` check. Defaults to 'Directory'. Use 'File' for
 * single-file binds, and `''` (kubernetes' "no check" type) for
 * user-supplied paths that may be either.
 */
type HostPathType = 'Directory' | 'DirectoryOrCreate' | 'File' | 'FileOrCreate' | ''

/**
 * Where a workspace mount's bytes come from. `resolveMountSource` picks it
 * from the path's storage tier (packages/shared/src/paths.ts); the
 * container path does not change.
 *
 *  - `hostPath`: a node-local path on the node's disk.
 *  - `pvc`: a subPath of the global tier's claim, `yaac-global`.
 *  - `emptyDir`: pod-local scratch, e.g. the tmux socket dir
 *    (CONTAINER_TMUX_DIR).
 *
 * Caution for UNIX sockets on an emptyDir: with `host-uds=all` the socket
 * is bound at the node path
 * `/var/lib/kubelet/pods/<uid>/volumes/kubernetes.io~empty-dir/<name>/…`,
 * and `sun_path` allows 107 bytes. tmux's `ed-<i>/server` uses 102, so a
 * longer volume name or index can overflow it.
 */
export type MountSource =
  | { kind: 'hostPath'; path: string; type?: HostPathType }
  | { kind: 'pvc'; claimName: string; subPath?: string }
  | { kind: 'emptyDir'; sizeLimit?: number }

/** One volume mounted into the workspace container, plus where it comes from. */
export interface PodMount {
  source: MountSource
  mountPath: string
  readOnly?: boolean
}

/** The uid and gid an install's pods run as (docs/server-in-cluster.md). */
export interface InstallIdentity {
  uid: number
  gid: number
}

/**
 * This process's uid and gid. Inside the server pod this is the install
 * identity, since install sets it on the Deployment. Throws on non-POSIX
 * platforms rather than inventing a uid.
 */
export function processIdentity(): InstallIdentity {
  const uid = process.getuid?.()
  const gid = process.getgid?.()
  if (uid === undefined || gid === undefined) {
    throw new Error(
      'processIdentity: process.getuid/getgid unavailable — '
      + 'the yaac server requires a POSIX host',
    )
  }
  return { uid, gid }
}

/**
 * securityContext for yaac pods that run as the install's identity (server,
 * proxy, workspace pods, install probe pods).
 *
 * The uid and gid are the install's (docs/server-in-cluster.md). gVisor
 * has no user namespace, so uids on shared storage pass through unchanged.
 * Inside the cluster the default (this process's identity) is the
 * install's; host-side callers such as `cluster check` pass the one the
 * live Deployment records.
 *
 * Supplementary group 0 lets the pod write the image's group-0-writable
 * files, so one image serves every install (docs/arbitrary-uid-images.md).
 * It is supplementary so files created on a claim keep the install's group.
 *
 * No `fsGroup`: it does not apply to hostPath. The proxy adds one itself
 * for its emptyDir HOME.
 */
export function installSecurityContext(identity: InstallIdentity = processIdentity()): {
  runAsUser: number
  runAsGroup: number
  supplementalGroups: number[]
} {
  return { runAsUser: identity.uid, runAsGroup: identity.gid, supplementalGroups: [0] }
}

/**
 * The RuntimeClass every untrusted pod sets: the gVisor sandbox (runsc with
 * systrap) with no network interface but loopback, whose traffic goes
 * through netshim's sockets (docs/workspace-egress.md). Infra pods set none
 * and get runc.
 */
export const RUNTIME_CLASS_GVISOR = 'gvisor-nonet'

/** Where a sandbox's netshim container sees its socket directory. */
export const SOCKET_MOUNT_DIR = '/run/yaac'

/**
 * A sandbox's socket directory on its node, `<socket root>/<dir>`, as the
 * `sockets` volume netd's relay finds it by. Only the netshim container
 * mounts it: code a project wrote never sees `egress.sock`, nor can it
 * plant a link where the relay connects.
 */
export function socketVolume(dir: string): Record<string, unknown> {
  return { name: 'sockets', hostPath: { path: path.posix.join(socketsNodePath(), dir), type: 'DirectoryOrCreate' } }
}

/**
 * The netshim container (docs/workspace-egress.md "netshim"): an init
 * container with `restartPolicy: Always`, placed first, so it is up before
 * anything else in the pod starts and kubelet restarts it if it exits. It
 * routes every address to loopback, takes every TCP dial and DNS query
 * there, and carries them through its socket directory, which needs
 * `NET_ADMIN` and `NET_RAW` and nothing else. Its root stays writable, since
 * `iptables` takes a lock under `/run`. It declares limits like every
 * container in the pod, since kubelet sets the pod's memory cap only when
 * all of them do.
 */
export function netshimContainer(image: string): Record<string, unknown> {
  return {
    name: 'netshim',
    image,
    imagePullPolicy: 'IfNotPresent',
    restartPolicy: 'Always',
    command: ['/usr/local/bin/netshim'],
    env: [{ name: 'POD_IP', valueFrom: { fieldRef: { fieldPath: 'status.podIP' } } }],
    securityContext: {
      runAsUser: 0,
      runAsGroup: 0,
      capabilities: { drop: ['ALL'], add: ['NET_ADMIN', 'NET_RAW'] },
    },
    startupProbe: {
      exec: { command: ['test', '-S', `${SOCKET_MOUNT_DIR}/ingress.sock`] },
      periodSeconds: 1,
      failureThreshold: 30,
    },
    resources: {
      requests: { cpu: '10m', memory: '16Mi' },
      limits: { cpu: '1', memory: '128Mi' },
    },
    volumeMounts: [{ name: 'sockets', mountPath: SOCKET_MOUNT_DIR }],
  }
}

/**
 * The DNS a sandbox resolves through: netshim's stub, at the sinkhole
 * address, which answers every name with the sinkhole.
 */
export const SANDBOX_DNS = { dnsPolicy: 'None', dnsConfig: { nameservers: [DNS_SINKHOLE] } }

/**
 * Node label the gVisor installer sets once the runtime works on a node;
 * the RuntimeClass schedules only on it. A node labelled
 * `yaac.workspaces=false` never gets it (see WORKSPACE_POOL_KEY).
 */
export const GVISOR_NODE_LABEL = 'yaac.gvisor'

/**
 * A taint a node pool may register its nodes with, to keep every pod off a
 * node until the runtime is installed. The installer removes it after
 * labelling the node. A cluster autoscaler told it is a startup taint
 * counts the node as still starting until then, rather than scaling up
 * again for the pods it cannot yet take (infra/hetzner-k3s).
 */
export const GVISOR_PENDING_TAINT = 'yaac.gvisor/pending'

/**
 * The key a node uses to declare its share of the work (docs/cluster-setup.md
 * "A dedicated workspace node pool"). Every node runs workspaces and yaac's
 * infrastructure unless it says otherwise:
 *  - a taint with this key (conventionally `yaac.workspaces=true:NoSchedule`)
 *    keeps infrastructure off, since only sandboxed pods tolerate it;
 *  - the label `yaac.workspaces=false` keeps workspaces off, since the
 *    installer leaves such a node without the gVisor labels.
 */
export const WORKSPACE_POOL_KEY = 'yaac.workspaces'
