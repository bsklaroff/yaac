import crypto from 'node:crypto'
import path from 'node:path'
import {
  GLOBAL_CLAIM_NAME,
  LABEL_INSTALL_ID,
  LABEL_ROLE,
  MOUNTD_APP_NAME,
  MOUNTD_PORT,
  ARBORIST_PORT,
  PRIORITY_CLASS_INFRA,
  ROLE_SERVER,
  VOLUMES_CLAIM_NAME,
  apiStatus,
  applyObject,
  createObject,
  installId,
  installSecurityContext,
  k8sNamespace,
  listObjects,
  nodeLocalNodePath,
  nodeMountsNodePath,
  readObject,
  waitForRollout,
} from '#drivers/k8s/substrate'
import { apiserverEndpoints } from './cluster-cidrs'
import { contextHash } from './image-tags'
import { prebuiltRef } from './registry'
import { MOUNTD_DIR } from '@yaac/shared/project-paths'
import { globalRoot } from '@yaac/shared/paths'
import { env, testEnv } from '@yaac/shared/env'
import { readBuildId } from '@yaac/shared/build-id'

/**
 * `yaac-mountd`: the per-node DaemonSet that makes a generic workspace
 * pod one workspace's (docs/generic-workspace-pods.md "mountd").
 * One image (k8s/mountd), two containers:
 *
 *  - the **mountd**, privileged and in the host's pid namespace,
 *    which `runsc exec` needs, sees the node-mounts root and the node-local
 *    root with bidirectional propagation, and the shared tier as ordinary
 *    volumes. It answers the server alone (a network policy and a token).
 *  - the **arborist**, the install uid with every capability dropped,
 *    builds working trees with native git from the main clones (read-only,
 *    at the server's own path) into `ready/`, and answers only the
 *    mountd, on the pod's loopback.
 *
 * Its build is the server's: a node whose mountd reports another build is
 * treated as having none (`readyNodes`), so a server upgrade waits for each
 * node's mountd pod to be replaced.
 */

const labels = (): Record<string, string> => ({ app: MOUNTD_APP_NAME, [LABEL_INSTALL_ID]: installId() })
const TOKEN_SECRET = `${MOUNTD_APP_NAME}-token`
/** How often the server asks every node's mountd for its report. */
const REPORT_INTERVAL_MS = 5_000
/** A node is ready while its mountd's last good report is this recent. */
const READY_WINDOW_MS = 15_000
const GiB = 1024 ** 3

/** Content-hash tag of mountd's image (the k8s/mountd context). */
export async function resolveMountdImageTag(image = testEnv.mountdImage): Promise<string> {
  return `${image}:${await contextHash(MOUNTD_DIR)}`
}

/** The server build mountd must report, so a node on another build is
 *  passed over. */
let cachedBuild: string | undefined
export async function serverBuild(): Promise<string> {
  cachedBuild ??= await readBuildId().catch(() => 'unbuilt')
  return cachedBuild
}

/** The main clones' directory, at the server's own path. */
function reposDir(): string {
  return path.posix.join(globalRoot(), 'repos')
}

function buildRbac(): Array<Record<string, unknown>> {
  const meta = { name: MOUNTD_APP_NAME, namespace: k8sNamespace(), labels: labels() }
  return [
    { apiVersion: 'v1', kind: 'ServiceAccount', metadata: meta },
    // Its node's pods: the one a bind names, and every one, to release the
    // node-mounts directories of those that are gone. It writes nothing.
    {
      apiVersion: 'rbac.authorization.k8s.io/v1',
      kind: 'Role',
      metadata: meta,
      rules: [{ apiGroups: [''], resources: ['pods'], verbs: ['get', 'list', 'watch'] }],
    },
    {
      apiVersion: 'rbac.authorization.k8s.io/v1',
      kind: 'RoleBinding',
      metadata: meta,
      roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'Role', name: MOUNTD_APP_NAME },
      subjects: [{ kind: 'ServiceAccount', name: MOUNTD_APP_NAME, namespace: k8sNamespace() }],
    },
  ]
}

/** mountd's one way out: the apiserver, for its watch of its
 *  node's pods. Everything else is denied by the namespace's
 *  `yaac-egress-world-deny`. */
function buildEgressNp(apiserver: { cidrs: string[]; ports: number[] }): Record<string, unknown> {
  return {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'NetworkPolicy',
    metadata: { name: `${MOUNTD_APP_NAME}-egress`, namespace: k8sNamespace(), labels: { app: MOUNTD_APP_NAME } },
    spec: {
      podSelector: { matchLabels: { app: MOUNTD_APP_NAME } },
      policyTypes: ['Egress'],
      egress: [{
        to: apiserver.cidrs.map((cidr) => ({ ipBlock: { cidr } })),
        ports: apiserver.ports.map((port) => ({ protocol: 'TCP', port })),
      }],
    },
  }
}

/** Only the server may dial mountd. */
function buildIngressNp(): Record<string, unknown> {
  return {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'NetworkPolicy',
    metadata: { name: `${MOUNTD_APP_NAME}-ingress`, namespace: k8sNamespace(), labels: { app: MOUNTD_APP_NAME } },
    spec: {
      podSelector: { matchLabels: { app: MOUNTD_APP_NAME } },
      policyTypes: ['Ingress'],
      ingress: [{
        from: [{ podSelector: { matchLabels: { [LABEL_ROLE]: ROLE_SERVER } } }],
        ports: [{ protocol: 'TCP', port: MOUNTD_PORT }],
      }],
    },
  }
}

export function buildMountdDaemonSetManifest(image: string, build: string): Record<string, unknown> {
  const { runAsUser: uid, runAsGroup: gid } = installSecurityContext()
  // kind keeps every workspace volume in one claim mountd mounts;
  // a byo volume is a claim of its own, in the pod that needs it.
  const kindVolumes = env.volumeStorageClass === undefined
  const ready = path.posix.join(nodeLocalNodePath(), 'ready')
  const repos = reposDir()
  return {
    apiVersion: 'apps/v1',
    kind: 'DaemonSet',
    metadata: { name: MOUNTD_APP_NAME, namespace: k8sNamespace(), labels: labels() },
    spec: {
      selector: { matchLabels: labels() },
      // One node at a time: a node whose mountd is being replaced takes no
      // new start, and its running workspaces need nothing from it.
      updateStrategy: { type: 'RollingUpdate', rollingUpdate: { maxUnavailable: 1 } },
      template: {
        metadata: { labels: labels() },
        spec: {
          serviceAccountName: MOUNTD_APP_NAME,
          enableServiceLinks: false,
          priorityClassName: PRIORITY_CLASS_INFRA,
          tolerations: [{ operator: 'Exists' }],
          hostPID: true,
          // The arborist's folder, which kubelet makes root-owned, given to
          // the install uid before the arborist starts: an init container
          // runs to completion before the others, with CHOWN alone. Not
          // `install -d -o`, whose chmod after the chown needs FOWNER.
          initContainers: [{
            name: 'prepare',
            image,
            imagePullPolicy: 'IfNotPresent',
            command: ['sh', '-c', `mkdir -p /node-local/ready && chown ${String(uid)}:${String(gid)} /node-local/ready`],
            securityContext: { runAsUser: 0, runAsGroup: 0, capabilities: { drop: ['ALL'], add: ['CHOWN'] } },
            resources: { requests: { cpu: '10m', memory: '16Mi' }, limits: { cpu: '100m', memory: '64Mi' } },
            volumeMounts: [{ name: 'node-local', mountPath: '/node-local' }],
          }],
          containers: [
            {
              name: 'mountd',
              image,
              imagePullPolicy: 'IfNotPresent',
              command: [
                'mountd',
                '--listen', `:${String(MOUNTD_PORT)}`,
                '--token-file', '/etc/yaac-mountd/token',
                '--build', build,
                '--node-mounts', '/node-mounts-root',
                '--node-mounts-on-node', nodeMountsNodePath(),
                '--node-local', '/node-local',
                '--tiers', ['shared=/shared', ...(kindVolumes ? ['volumes=/volumes'] : [])].join(','),
                '--host-run', '/host/run',
                '--runsc', '/host/bin/runsc',
                '--arborist', `http://127.0.0.1:${String(ARBORIST_PORT)}`,
                '--uid', String(uid), '--gid', String(gid),
              ],
              env: [
                { name: 'POD_NAMESPACE', valueFrom: { fieldRef: { fieldPath: 'metadata.namespace' } } },
                { name: 'NODE_NAME', valueFrom: { fieldRef: { fieldPath: 'spec.nodeName' } } },
              ],
              ports: [{ name: 'mountd', containerPort: MOUNTD_PORT }],
              securityContext: { privileged: true, runAsUser: 0, runAsGroup: 0 },
              resources: { requests: { cpu: '20m', memory: '32Mi' }, limits: { cpu: '1', memory: '256Mi' } },
              volumeMounts: [
                { name: 'node-mounts', mountPath: '/node-mounts-root', mountPropagation: 'Bidirectional' },
                { name: 'node-local', mountPath: '/node-local', mountPropagation: 'Bidirectional' },
                { name: 'shared', mountPath: '/shared' },
                ...(kindVolumes ? [{ name: 'volumes', mountPath: '/volumes' }] : []),
                { name: 'host-run', mountPath: '/host/run' },
                { name: 'host-bin', mountPath: '/host/bin', readOnly: true },
                { name: 'token', mountPath: '/etc/yaac-mountd', readOnly: true },
                { name: 'tmp', mountPath: '/tmp' },
              ],
            },
            {
              name: 'arborist',
              image,
              imagePullPolicy: 'IfNotPresent',
              command: ['arborist', '--listen', `127.0.0.1:${String(ARBORIST_PORT)}`, '--repos', repos, '--ready', '/ready'],
              securityContext: {
                runAsUser: uid,
                runAsGroup: gid,
                allowPrivilegeEscalation: false,
                readOnlyRootFilesystem: true,
                capabilities: { drop: ['ALL'] },
              },
              // Its limits are all that bound a burst of starts' builds; its
              // memory is the page cache of what it writes.
              resources: { requests: { cpu: '50m', memory: '128Mi' }, limits: { cpu: '4', memory: '1Gi' } },
              volumeMounts: [
                { name: 'shared', mountPath: repos, subPath: 'repos', readOnly: true },
                { name: 'ready', mountPath: '/ready' },
              ],
            },
          ],
          volumes: [
            { name: 'node-mounts', hostPath: { path: nodeMountsNodePath(), type: 'DirectoryOrCreate' } },
            { name: 'node-local', hostPath: { path: nodeLocalNodePath(), type: 'DirectoryOrCreate' } },
            { name: 'ready', hostPath: { path: ready, type: 'DirectoryOrCreate' } },
            { name: 'shared', persistentVolumeClaim: { claimName: GLOBAL_CLAIM_NAME } },
            ...(kindVolumes ? [{ name: 'volumes', persistentVolumeClaim: { claimName: VOLUMES_CLAIM_NAME } }] : []),
            { name: 'host-run', hostPath: { path: '/run', type: 'Directory' } },
            { name: 'host-bin', hostPath: { path: '/usr/local/bin', type: 'Directory' } },
            { name: 'token', secret: { secretName: TOKEN_SECRET } },
            { name: 'tmp', emptyDir: { sizeLimit: '16Mi' } },
          ],
        },
      },
    },
  }
}

/** The bearer token mountd takes, made once per install. */
let cachedToken: string | undefined
async function mountdToken(): Promise<string> {
  if (cachedToken !== undefined) return cachedToken
  const ref = { apiVersion: 'v1', kind: 'Secret', name: TOKEN_SECRET, namespace: k8sNamespace() }
  await createObject({
    ...ref,
    metadata: { name: TOKEN_SECRET, namespace: k8sNamespace(), labels: labels() },
    type: 'Opaque',
    data: { token: Buffer.from(crypto.randomBytes(32).toString('hex')).toString('base64') },
  }).catch((err: unknown) => {
    if (apiStatus(err) !== 409) throw err
  })
  const secret = await readObject<{ data?: Record<string, string> }>(ref)
  const token = secret?.data?.token
  if (!token) throw new Error(`mountd's token Secret ${TOKEN_SECRET} holds no token`)
  cachedToken = Buffer.from(token, 'base64').toString('utf8')
  return cachedToken
}

/** Image lookup only; `yaac cluster install` builds it. */
async function mountdImage(): Promise<string> {
  return prebuiltRef('mountd', await resolveMountdImageTag())
}

/** Apply mountd and wait for it on every node. */
export async function ensureMountd(): Promise<void> {
  const [image, build, apiserver] = await Promise.all([mountdImage(), serverBuild(), apiserverEndpoints(), mountdToken()])
  for (const manifest of [...buildRbac(), buildIngressNp(), buildEgressNp(apiserver), buildMountdDaemonSetManifest(image, build)]) {
    await applyObject(manifest)
  }
  await waitForRollout({
    workload: `daemonset/${MOUNTD_APP_NAME}`,
    namespace: k8sNamespace(),
    timeoutMs: 180_000,
    hint: `Inspect with \`kubectl -n ${k8sNamespace()} get pods -l app=${MOUNTD_APP_NAME} -o wide\` and its logs: `
      + 'mountd needs privileged, the host pid namespace and runsc on the node (docs/generic-workspace-pods.md).',
  })
}

interface AgentPodRow {
  spec?: { nodeName?: string }
  status?: { podIP?: string; phase?: string }
}

/** Each node's mountd address, read fresh. */
async function mountdAddresses(): Promise<Map<string, string>> {
  const pods = await listObjects<AgentPodRow>('v1', 'Pod', {
    namespace: k8sNamespace(),
    labelSelector: `app=${MOUNTD_APP_NAME},${LABEL_INSTALL_ID}=${installId()}`,
    fieldSelector: 'status.phase=Running',
  })
  const out = new Map<string, string>()
  for (const p of pods) {
    const ip = p.status?.podIP
    if (p.spec?.nodeName === undefined || ip === undefined) continue
    out.set(p.spec.nodeName, `http://${ip.includes(':') ? `[${ip}]` : ip}:${String(MOUNTD_PORT)}`)
  }
  return out
}

async function ask(base: string, method: string, route: string, body: unknown, timeoutMs: number): Promise<unknown> {
  const res = await fetch(`${base}${route}`, {
    method,
    headers: { Authorization: `Bearer ${await mountdToken()}`, 'Content-Type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const text = await res.text()
  if (!res.ok) {
    let why = text
    try { why = (JSON.parse(text) as { error?: string }).error ?? text } catch { /* not JSON */ }
    throw new Error(`mountd refused ${route}: ${why.trim() || String(res.status)}`)
  }
  return text === '' ? undefined : JSON.parse(text) as unknown
}

/** What the server reads of a mountd's report (k8s/mountd/cmd/mountd/mountd.go,
 *  which also sends its total space and the directories it could not
 *  release, for a person reading it by hand). */
export interface MountdReport {
  build: string
  arborist: boolean
  freeBytes: number
  trees: Array<{ repo: string; commit: string }>
}

interface Reading {
  at: number
  report?: MountdReport
  error?: string
}

const readings = new Map<string, Reading>()
let addressCache: Map<string, string> = new Map()

/** Ask every node's mountd for its report once. */
async function readAll(): Promise<void> {
  addressCache = await mountdAddresses()
  const build = await serverBuild()
  await Promise.all([...addressCache].map(async ([node, base]) => {
    try {
      const report = await ask(base, 'GET', '/report', undefined, 3_000) as MountdReport
      readings.set(node, { at: Date.now(), report, ...(report.build !== build ? { error: `its mountd runs build ${report.build}, not the server's` } : {}) })
    } catch (err) {
      readings.set(node, { at: readings.get(node)?.at ?? 0, error: err instanceof Error ? err.message : String(err) })
    }
  }))
  for (const node of readings.keys()) if (!addressCache.has(node)) readings.delete(node)
}

/** Ask every node's mountd every few seconds. Returns the stop function. */
export function watchMountd(): () => void {
  let busy = false
  const timer = setInterval(() => {
    if (busy) return
    busy = true
    readAll().catch(() => {}).finally(() => { busy = false })
  }, REPORT_INTERVAL_MS)
  timer.unref()
  void readAll().catch(() => {})
  return () => clearInterval(timer)
}

/** Why a node takes no new start, or null while it does: its mountd answered
 *  recently, on the server's build, with its arborist up and free
 *  space for trees above the disk stop floor. */
export function nodeUnreadyReason(node: string, now = Date.now()): string | null {
  const r = readings.get(node)
  if (r === undefined) return 'no mountd runs there'
  if (r.error !== undefined) return r.error
  if (r.report === undefined || now - r.at > READY_WINDOW_MS) return 'its mountd has not answered recently'
  if (!r.report.arborist) return 'its arborist does not answer'
  if (r.report.freeBytes < env.diskStopFloorGiB * GiB) return 'it is under the disk stop floor'
  return null
}

/** The nodes that take new starts, from the last reports. */
export function readyNodes(now = Date.now()): string[] {
  return [...readings.keys()].filter((n) => nodeUnreadyReason(n, now) === null)
}

/** Every mountd's last report, for the ready-trees step. */
export function mountdReports(): Map<string, MountdReport> {
  const out = new Map<string, MountdReport>()
  for (const [node, r] of readings) if (r.report !== undefined && r.error === undefined) out.set(node, r.report)
  return out
}

async function mountdOn(node: string): Promise<string> {
  let base = addressCache.get(node)
  if (base === undefined) {
    addressCache = await mountdAddresses()
    base = addressCache.get(node)
  }
  if (base === undefined) throw new Error(`no mountd runs on node ${node}`)
  return base
}

/** How long a bind waits for a mountd it cannot reach, as while the
 *  DaemonSet replaces its pod. */
const UNREACHABLE_WAIT_MS = 90_000

/** The connect failures (undici's fetch raises a TypeError with one of
 *  these as its cause's code) that mean a request never reached mountd. */
const NEVER_SENT = new Set(['ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT'])

/**
 * Make a pod its workspace's (mountd's `POST /bind`). A node's mountd with
 * no running pod, or one the request could not connect to, is looked up
 * again until UNREACHABLE_WAIT_MS has passed. Any other failure, such as a
 * refusal or a connection dropped mid-bind, fails the bind at once: mountd
 * repeats a finished bind only within the process that did it.
 */
export async function mountdBind(node: string, request: object): Promise<void> {
  const deadline = Date.now() + UNREACHABLE_WAIT_MS
  for (;;) {
    addressCache = await mountdAddresses()
    const base = addressCache.get(node)
    try {
      if (base === undefined) throw new Error(`no mountd runs on node ${node}`)
      await ask(base, 'POST', '/bind', request, 10 * 60_000)
      return
    } catch (err) {
      const unreachable = base === undefined
        || (err instanceof TypeError && NEVER_SENT.has((err.cause as { code?: string } | undefined)?.code ?? ''))
      if (!unreachable || Date.now() > deadline) throw err
    }
    await new Promise((r) => setTimeout(r, 1_000))
  }
}

/** Tell a node's arborist which trees to keep ready. */
export async function mountdKeepReady(node: string, want: Array<{ repo: string; commit: string }>): Promise<void> {
  await ask(await mountdOn(node), 'PUT', '/ready', { want }, 10_000)
}
