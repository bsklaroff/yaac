import crypto from 'node:crypto'
import {
  LABEL_INSTALL_ID,
  LABEL_WORKSPACE_ID,
  MOUNTD_APP_NAME,
  MOUNTD_PORT,
  RUNTIME_CLASS_GVISOR,
  applyObject,
  deleteObject,
  execFileAsync,
  installId,
  installSecurityContext,
  invalidatePortForward,
  k8sErrorSummary,
  k8sNamespace,
  listObjects,
  nodeMountsNodePath,
  readObject,
  resolvePortForward,
} from '#drivers/k8s/substrate'
import type { InstallIdentity } from '#drivers/k8s/substrate'
import type { CheckResult } from '@yaac/shared/types'

/**
 * The `mountd` gate (docs/generic-workspace-pods.md "Platforms"): every
 * workspace start needs its node's mountd to bind into a gVisor sandbox, so
 * a probe pod shaped like a workspace pod is bound for real. It has the
 * mountd mount a node-local folder read-only under the pod's
 * node-mounts directory and enter the sandbox to bind it and a folder of a
 * pod-local volume, then checks from inside that the first is visible and
 * read-only, the second writable, and the node-mounts directory itself
 * read-only. That proves the three things a platform must give: a mount
 * under a node-mounts directory reaches the sandbox, mountd finds runsc
 * and its state and enters a container, and mountd's own mounts are
 * what it binds from.
 */

const POD_NAME = 'yaac-cluster-check-mountd'
const TIMEOUT_MS = 120_000

const fix = (): string => 'mountd is the yaac-mountd DaemonSet the server applies when it starts; '
  + `see \`kubectl -n ${k8sNamespace()} get pods -l app=${MOUNTD_APP_NAME} -o wide\` and its mountd's `
  + 'logs. It needs privileged, the host pid namespace, runsc under /usr/local/bin and runsc\'s state under /run.'

interface PodRow {
  spec?: { nodeName?: string }
  status?: { phase?: string; podIP?: string; containerStatuses?: Array<{ name?: string; state?: { running?: object } }> }
}

async function waitRunning(timeoutMs: number): Promise<PodRow> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const pod = await readObject<PodRow>({ apiVersion: 'v1', kind: 'Pod', name: POD_NAME, namespace: k8sNamespace() })
    if (pod?.status?.containerStatuses?.some((c) => c.name === 'workspace' && c.state?.running !== undefined)) return pod
    if (Date.now() > deadline) throw new Error(`the probe pod is still ${pod?.status?.phase ?? 'absent'} after ${String(timeoutMs / 1000)}s`)
    await new Promise((r) => setTimeout(r, 1_000))
  }
}

interface DaemonSetRow {
  metadata?: { generation?: number }
  status?: { observedGeneration?: number; desiredNumberScheduled?: number; numberReady?: number }
}

/**
 * The running mountd pod on `node`. The server applies the DaemonSet when
 * it starts, so right after an install its pods may not exist yet: this
 * waits while the DaemonSet is absent or still bringing its pods up, until
 * `deadline`. Once it has settled with every pod ready, a node with none is
 * one it does not schedule on, which waiting cannot fix.
 */
async function mountdOn(node: string | undefined, deadline: number): Promise<string | undefined> {
  for (;;) {
    const pods = await listObjects<PodRow & { metadata?: { name?: string } }>('v1', 'Pod', {
      namespace: k8sNamespace(), labelSelector: `app=${MOUNTD_APP_NAME},${LABEL_INSTALL_ID}=${installId()}`,
    })
    const name = pods.find((a) => a.spec?.nodeName === node && a.status?.phase === 'Running')?.metadata?.name
    if (name !== undefined) return name
    const ds = await readObject<DaemonSetRow>({ apiVersion: 'apps/v1', kind: 'DaemonSet', name: MOUNTD_APP_NAME, namespace: k8sNamespace() })
    const settled = ds?.status !== undefined && ds.status.observedGeneration === ds.metadata?.generation
      && (ds.status.numberReady ?? 0) >= (ds.status.desiredNumberScheduled ?? 0)
    if (settled || Date.now() > deadline) return undefined
    await new Promise((r) => setTimeout(r, 1_000))
  }
}

export async function runMountdProbe(imageRef: string, identity: InstallIdentity): Promise<CheckResult> {
  const name = 'mountd'
  const workspaceId = `check-${crypto.randomBytes(4).toString('hex')}`
  const dir = `${workspaceId}.probe`
  try {
    await applyObject({
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: { name: POD_NAME, namespace: k8sNamespace(), labels: { [LABEL_WORKSPACE_ID]: workspaceId, [LABEL_INSTALL_ID]: installId() } },
      spec: {
        restartPolicy: 'Never',
        automountServiceAccountToken: false,
        enableServiceLinks: false,
        runtimeClassName: RUNTIME_CLASS_GVISOR,
        securityContext: { seccompProfile: { type: 'RuntimeDefault' }, ...installSecurityContext(identity) },
        containers: [{
          name: 'workspace',
          image: imageRef,
          command: ['sleep', '600'],
          resources: { requests: { cpu: '10m', memory: '16Mi' }, limits: { cpu: '200m', memory: '64Mi' } },
          volumeMounts: [
            { name: 'node-mounts', mountPath: '/node-mounts', readOnly: true, mountPropagation: 'HostToContainer' },
            { name: 'local', mountPath: '/yaac-local' },
          ],
        }],
        volumes: [
          { name: 'node-mounts', hostPath: { path: `${nodeMountsNodePath()}/${dir}`, type: 'DirectoryOrCreate' } },
          { name: 'local', emptyDir: {} },
        ],
      },
    })
    const deadline = Date.now() + TIMEOUT_MS
    const pod = await waitRunning(TIMEOUT_MS)
    const mountdName = await mountdOn(pod.spec?.nodeName, deadline)
    if (mountdName === undefined) {
      return { name, status: 'fail', detail: `no mountd runs on node ${pod.spec?.nodeName ?? '?'}`, fix: fix() }
    }
    const secret = await readObject<{ data?: Record<string, string> }>({
      apiVersion: 'v1', kind: 'Secret', name: `${MOUNTD_APP_NAME}-token`, namespace: k8sNamespace(),
    })
    const token = Buffer.from(secret?.data?.token ?? '', 'base64').toString('utf8')
    // mountd admits only the server's pods; a port-forward reaches it
    // through the kubelet instead.
    const key = `mountd-check:${mountdName}`
    const addr = await resolvePortForward(key, { namespace: k8sNamespace(), target: `pod/${mountdName}`, remotePort: MOUNTD_PORT })
    try {
      const res = await fetch(`http://${addr.host}:${String(addr.port)}/bind`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: workspaceId, pod: POD_NAME, workspaceId, dir, life: 'check', trees: [], dirs: [],
          mounts: [{ tier: 'node', path: 'ready', workspace: '/mnt/ready', readOnly: true }],
          folders: [{ from: 'local', target: '/mnt/local' }],
          roots: { local: '/yaac-local' },
        }),
        signal: AbortSignal.timeout(60_000),
      })
      if (!res.ok) return { name, status: 'fail', detail: `mountd could not bind the probe pod: ${(await res.text()).trim()}`, fix: fix() }
    } finally {
      invalidatePortForward(key)
    }
    const script = [
      'grep -q " /mnt/ready " /proc/mounts || { echo "the node\'s mount did not reach the sandbox"; exit 1; }',
      'touch /mnt/ready/x 2>/dev/null && { echo "a read-only source is writable"; exit 1; }',
      'touch /mnt/local/x || { echo "a writable bind is not writable"; exit 1; }',
      'touch /node-mounts/x 2>/dev/null && { echo "the node-mounts directory is writable"; exit 1; }',
      'exit 0',
    ].join('\n')
    try {
      await execFileAsync('kubectl', ['exec', '-n', k8sNamespace(), POD_NAME, '-c', 'workspace', '--', 'sh', '-c', script], { timeout: 30_000 })
    } catch (err) {
      const out = (err as { stdout?: string }).stdout?.trim()
      return { name, status: 'fail', detail: `the probe pod's binds are wrong: ${out || String(err)}`, fix: fix() }
    }
    return { name, status: 'pass', detail: 'mountd binds into a gVisor sandbox and enters it' }
  } catch (err) {
    return { name, status: 'fail', detail: `could not probe mountd: ${k8sErrorSummary(err)}`, fix: fix() }
  } finally {
    await deleteObject({ apiVersion: 'v1', kind: 'Pod', name: POD_NAME, namespace: k8sNamespace() }, { gracePeriodSeconds: 0 }).catch(() => {})
  }
}
