/**
 * `pnpm kind-byo up|down|env` — kind-byo, the cloud install run locally on
 * Linux (docs/cluster-setup.md "Running byo locally: kind-byo").
 *
 * `up` stands up a second kind cluster set up to look like a cloud one —
 * none of yaac's kind-config patches, Calico applied here rather than by
 * yaac, an NFS server behind csi-driver-nfs for RWX storage, a provisioned
 * default block class for RWO, the Tailscale operator for fronting — and
 * then runs the built CLI's `yaac cluster install` against it, as an
 * operator would. Nothing in the CLI knows kind-byo exists, which is what
 * makes it a test of the cloud path rather than a third backend.
 *
 * It is a separate install beside any normal one: its own data dir
 * (`KIND_BYO_DATA_DIR`, default `~/.yaac-byo`), its own kubeconfig in that
 * install's client-local dir, never merged into the default one. `env`
 * prints what to export to drive it. `up` is idempotent; `down` deletes the
 * cluster and keeps the data dir, whose bytes are the install's.
 */
import { execFile, spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { parseAllDocuments, stringify } from 'yaml'
import { calicoManifestUrl, CALICO_VERSION, calicoImageRefs } from '@yaac/server/drivers/k8s/install/install'
import { ensureRootfulPodmanHost } from '@yaac/server/drivers/k8s/container'
import { contextHash, stringHash } from '@yaac/server/drivers/k8s/image-engine'
import { NODE_PIDS_LIMIT } from '@yaac/server/drivers/k8s/install/check'
import { kindByoLayout, type KindByoLayout } from '#kind-byo-layout'

const execFileAsync = promisify(execFile)

const CLUSTER = 'yaac-byo'
const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..')
const KIND_BYO_DIR = path.join(REPO_ROOT, 'test', 'kind-byo')
const GANESHA_CONTEXT = path.join(KIND_BYO_DIR, 'ganesha')

/** The names the stand-in cloud's classes and server go by. */
export const KIND_BYO_NFS_CLASS = 'kind-byo-nfs'
export const KIND_BYO_LOCAL_CLASS = 'kind-byo-local'
/**
 * A second, non-default block class, which install is told to use for
 * `yaac-server-local`: named rather than defaulted, so a named class that
 * were ignored in favor of the default would show.
 */
export const KIND_BYO_RWO_CLASS = 'kind-byo-rwo'
export const KIND_BYO_NFS_NAMESPACE = 'kind-byo-nfs'
const GANESHA_NAME = 'nfs-ganesha'
/** Where the csi node plugin mounts from — the ganesha Service's name. */
export const KIND_BYO_NFS_SERVER = `${GANESHA_NAME}.${KIND_BYO_NFS_NAMESPACE}.svc.cluster.local`
/** The export's pseudo path, which a class names as its `share`. */
export const KIND_BYO_NFS_SHARE = '/export'

const CSI_NFS_VERSION = 'v4.13.4'
const LOCAL_PATH_VERSION = 'v0.0.37'
const TAILSCALE_OPERATOR_VERSION = 'v1.102.4'
/**
 * The images the fetched manifests name by tag, pinned by digest like the
 * manifests themselves: the operator and the proxies it runs, and the
 * helper local-path runs as root, with a hostPath into the data dir, on
 * every provision (its manifest names `busybox` with no tag at all).
 */
const PINNED_IMAGES = {
  operator: `tailscale/k8s-operator:${TAILSCALE_OPERATOR_VERSION}@sha256:3c8958c42fb3c46068e8553e11b944f2133b4671d4f36c86adc11f206746bf34`,
  proxy: `tailscale/tailscale:${TAILSCALE_OPERATOR_VERSION}@sha256:2667499ed87ae29218f292556ba062918402dd5e92e93637af14867e4df12dd3`,
  helper: 'docker.io/library/busybox:1.37.0@sha256:bdf57e528e45e4433820e045b29b4597825a1c9e38353532d90a01445013f82e',
}
/** The ProxyClass every kind-byo proxy defaults to: staging certificates. */
const STAGING_PROXY_CLASS = 'kind-byo-letsencrypt-staging'
const STAGING_ROOTS = [
  'letsencrypt-stg-root-x1.pem', 'letsencrypt-stg-root-x2.pem', 'gen-y/root-ye.pem', 'gen-y/root-yr.pem',
]
const CSI_NFS_FILES = [
  'crd-csi-snapshot.yaml', 'rbac-csi-nfs.yaml', 'csi-nfs-driverinfo.yaml',
  'csi-nfs-controller.yaml', 'csi-nfs-node.yaml',
]


/** The ganesha image's tag: this directory's content, like every test image. */
export async function ganeshaImageTag(): Promise<string> {
  return `yaac-kind-byo-ganesha:${stringHash(await contextHash(GANESHA_CONTEXT))}`
}

function log(message: string): void {
  console.log(`[kind-byo] ${message}`)
}

function kubectlEnv(layout: KindByoLayout): NodeJS.ProcessEnv {
  return { ...process.env, KUBECONFIG: layout.kubeconfig, KIND_EXPERIMENTAL_PROVIDER: 'podman' }
}

async function run(
  layout: KindByoLayout,
  file: string,
  args: string[],
  opts: { input?: string; timeout?: number } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { env: kubectlEnv(layout), stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.on('data', (c: Buffer) => { out += c.toString() })
    child.stderr.on('data', (c: Buffer) => { err += c.toString() })
    const timer = opts.timeout ? setTimeout(() => child.kill('SIGTERM'), opts.timeout) : undefined
    child.on('error', reject)
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve(out)
      else reject(new Error(`${file} ${args.join(' ')} exited ${String(code)}: ${err.trim() || out.trim()}`))
    })
    child.stdin.end(opts.input ?? '')
  })
}

async function kubectlApplyDocs(layout: KindByoLayout, docs: unknown[]): Promise<void> {
  await run(layout, 'kubectl', ['apply', '--server-side', '--force-conflicts', '-f', '-'], {
    input: docs.map((d) => stringify(d)).join('---\n'),
    timeout: 120_000,
  })
}

/**
 * A pinned upstream manifest: from this install's client-local cache when
 * it is there and matches the committed checksum, else downloaded once and
 * cached — the Calico scheme, so the stand-in cloud is as reproducible as
 * an install.
 */
async function fetchPinned(layout: KindByoLayout, name: string, url: string): Promise<string> {
  const pins = await fs.readFile(path.join(KIND_BYO_DIR, 'pins.sha256'), 'utf8')
  const expected = pins.split('\n').map((l) => l.trim().split(/\s+/))
    .find(([, n]) => n === name)?.[0]
  if (!expected) throw new Error(`no pin for ${name} in test/kind-byo/pins.sha256`)
  return fetchVerified(path.join(layout.clientDir, 'cache', 'kind-byo', name), url, expected)
}

async function fetchVerified(cache: string, url: string, expected: string): Promise<string> {
  const sha = (text: string): string => crypto.createHash('sha256').update(text).digest('hex')
  const cached = await fs.readFile(cache, 'utf8').catch(() => null)
  if (cached !== null && sha(cached) === expected) return cached
  log(`fetching ${url}`)
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000) })
  if (!res.ok) throw new Error(`GET ${url}: HTTP ${String(res.status)}`)
  const text = await res.text()
  if (sha(text) !== expected) {
    throw new Error(`${url} does not match its pinned sha256 (expected ${expected}, got ${sha(text)})`)
  }
  await fs.mkdir(path.dirname(cache), { recursive: true })
  await fs.writeFile(cache, text)
  return text
}

function docsOf(text: string): Array<Record<string, unknown>> {
  return parseAllDocuments(text)
    .map((d) => d.toJS() as Record<string, unknown> | null)
    .filter((d): d is Record<string, unknown> => d !== null && typeof d === 'object')
}

type Obj = Record<string, unknown> & { kind?: string; metadata?: { name?: string } }

// ---------------------------------------------------------------------------

/**
 * The FSAL_VFS export needs file handles that outlive the kernel's inode
 * cache, which ext4, xfs and btrfs give and tmpfs, overlay and a macOS
 * virtiofs share do not — ganesha refuses to export them at all.
 */
async function preflight(layout: KindByoLayout): Promise<void> {
  if (process.platform !== 'linux') {
    throw new Error('kind-byo is Linux-only: its NFS export needs a real host filesystem under the '
      + 'kind nodes, which a macOS virtiofs share cannot give. A macOS host runs the kind tiers.')
  }
  for (const bin of ['podman', 'kind', 'kubectl']) {
    await execFileAsync('sh', ['-c', `command -v ${bin}`]).catch(() => { throw new Error(`${bin} is not on PATH`) })
  }
  await fs.mkdir(layout.dataDir, { recursive: true })
  await fs.mkdir(layout.clientDir, { recursive: true })
  const { stdout } = await execFileAsync('stat', ['-f', '-c', '%T', layout.dataDir])
  const fsType = stdout.trim()
  if (!['ext2/ext3', 'xfs', 'btrfs'].includes(fsType)) {
    throw new Error(`${layout.dataDir} is on ${fsType}; ganesha's VFS export needs ext4, xfs or `
      + 'btrfs. Point KIND_BYO_DATA_DIR somewhere on one.')
  }
  ensureRootfulPodmanHost()
}

async function nodeImage(): Promise<string> {
  const config = await fs.readFile(path.join(REPO_ROOT, 'k8s', 'kind-config.yaml'), 'utf8')
  const image = /^\s*image:\s*(\S+)\s*$/m.exec(config)?.[1]
  if (!image) throw new Error('no node image pinned in k8s/kind-config.yaml')
  return image
}

/**
 * One control-plane and two workers, so every NFS number is cross-node,
 * and none of yaac's own kind patches: the installer's `config_path`
 * handling, not kind's config, is what makes the nodes read the
 * registries' hosts. The only mount is the data dir, at its own path —
 * the backing store for both classes and nothing else of the host.
 */
async function ensureCluster(layout: KindByoLayout): Promise<void> {
  const clusters = (await run(layout, 'kind', ['get', 'clusters'])).split('\n').map((l) => l.trim())
  if (clusters.includes(CLUSTER)) {
    for (const node of (await run(layout, 'kind', ['get', 'nodes', '--name', CLUSTER])).split('\n').filter(Boolean)) {
      const running = (await run(layout, 'podman', ['inspect', '--format', '{{.State.Running}}', node])).trim()
      if (running === 'false') await run(layout, 'podman', ['start', node])
    }
    await run(layout, 'kind', ['export', 'kubeconfig', '--name', CLUSTER, '--kubeconfig', layout.kubeconfig])
    return
  }
  const image = await nodeImage()
  const node = (role: string): Record<string, unknown> => ({
    role, image, extraMounts: [{ hostPath: layout.dataDir, containerPath: layout.dataDir }],
  })
  const config = {
    kind: 'Cluster',
    apiVersion: 'kind.x-k8s.io/v1alpha4',
    networking: { disableDefaultCNI: true },
    nodes: [node('control-plane'), node('worker'), node('worker')],
  }
  log(`creating kind cluster ${CLUSTER} (1 control-plane + 2 workers)`)
  await run(layout, 'kind', [
    'create', 'cluster', '--name', CLUSTER, '--kubeconfig', layout.kubeconfig, '--config', '-',
  ], { input: stringify(config), timeout: 600_000 })
}

/**
 * The node containers' pids ceiling: a setting of the podman container
 * this script created, which `--byo` never touches (it execs into no
 * node) — so it is set here, as a cloud node's is by its image.
 */
async function nodeFixups(layout: KindByoLayout): Promise<void> {
  for (const node of (await run(layout, 'kind', ['get', 'nodes', '--name', CLUSTER])).split('\n').filter(Boolean)) {
    await run(layout, 'podman', ['update', '--pids-limit', String(NODE_PIDS_LIMIT), node])
  }
}

/** Calico, pinned as yaac pins it, applied by the cluster's "owner". */
async function ensureCalico(layout: KindByoLayout): Promise<void> {
  const pin = (await fs.readFile(path.join(REPO_ROOT, 'k8s', 'calico', 'calico.yaml.sha256'), 'utf8')).trim().split(/\s+/)[0]
  const manifest = await fetchVerified(
    path.join(layout.clientDir, 'cache', `calico-${CALICO_VERSION}.yaml`), calicoManifestUrl(), pin)
  await sideload(layout, calicoImageRefs(manifest), { pull: true })
  log(`applying Calico ${CALICO_VERSION}`)
  await run(layout, 'kubectl', ['apply', '-f', '-'], { input: manifest, timeout: 120_000 })
  await run(layout, 'kubectl', [
    'rollout', 'status', 'daemonset/calico-node', '-n', 'kube-system', '--timeout=300s',
  ], { timeout: 310_000 })
  await run(layout, 'kubectl', ['wait', '--for=condition=Ready', 'node', '--all', '--timeout=180s'], { timeout: 190_000 })
}

/** Put images on every node from the host engine — kind's podman sideload. */
async function sideload(layout: KindByoLayout, refs: string[], opts: { pull: boolean }): Promise<void> {
  if (opts.pull) {
    for (const ref of refs) {
      await run(layout, 'podman', ['image', 'exists', ref])
        .catch(() => run(layout, 'podman', ['pull', ref], { timeout: 600_000 }))
    }
  }
  const archive = path.join(layout.clientDir, `kind-byo-sideload-${String(process.pid)}.tar`)
  try {
    await run(layout, 'podman', ['save', '-o', archive, ...refs], { timeout: 300_000 })
    await run(layout, 'kind', ['load', 'image-archive', archive, '--name', CLUSTER], { timeout: 300_000 })
  } finally {
    await fs.rm(archive, { force: true })
  }
}

/**
 * The default block class: local-path, as a provider's zonal disk class —
 * node-pinned and `WaitForFirstConsumer`, which is the reason install's
 * binder pod exists. kind installs its own copy of the provisioner and a
 * default class of its own; both go, so the class a byo install sees is
 * one the "owner" chose. The provisioner's one node path is the data dir,
 * and every claim gets a directory of its own at
 * `<dataDir>/volumes/<namespace>/<claim>` — never the data dir's own
 * `server-local/`, which the installing CLI writes its host log into, as
 * a laptop's would be on a real cloud install. The class opts out of the
 * `<namespace>/<claim>` prefix rule the provisioner would otherwise
 * enforce, for the `volumes/` in front.
 */
async function ensureLocalPath(layout: KindByoLayout): Promise<void> {
  const kindDefault = await run(layout, 'kubectl', ['get', 'storageclass', 'standard', '--ignore-not-found', '-o', 'name'])
  if (kindDefault.trim()) {
    log('removing kind\'s own local-path provisioner and its default class')
    await run(layout, 'kubectl', ['delete', 'storageclass', 'standard'])
    await run(layout, 'kubectl', ['delete', 'namespace', 'local-path-storage', '--wait=true'], { timeout: 180_000 })
  }
  const docs = docsOf(await fetchPinned(layout,
    `local-path-provisioner-${LOCAL_PATH_VERSION}/local-path-storage.yaml`,
    `https://raw.githubusercontent.com/rancher/local-path-provisioner/${LOCAL_PATH_VERSION}/deploy/local-path-storage.yaml`,
  )) as Obj[]
  const kept = docs.filter((d) => d.kind !== 'StorageClass').map((d) => {
    if (d.kind !== 'ConfigMap') return d
    const data = { ...(d.data as Record<string, string>) }
    data['config.json'] = JSON.stringify({
      nodePathMap: [{ node: 'DEFAULT_PATH_FOR_NON_LISTED_NODES', paths: [layout.dataDir] }],
    })
    data['helperPod.yaml'] = data['helperPod.yaml'].replace(/image: \S+/, `image: ${PINNED_IMAGES.helper}`)
    return { ...d, data }
  })
  log(`applying local-path-provisioner ${LOCAL_PATH_VERSION}`)
  const pattern = 'volumes/{{ .PVC.Namespace }}/{{ .PVC.Name }}'
  await kubectlApplyDocs(layout, [
    ...kept,
    localPathClass(KIND_BYO_LOCAL_CLASS, layout.dataDir, pattern, true),
    localPathClass(KIND_BYO_RWO_CLASS, layout.dataDir, pattern, false),
  ])
  await run(layout, 'kubectl', [
    'rollout', 'status', 'deployment/local-path-provisioner', '-n', 'local-path-storage', '--timeout=180s',
  ], { timeout: 190_000 })
}

/**
 * A local-path class whose one volume lands at `<nodePath>/<pattern>`.
 * Written the way an operator would: `reclaimPolicy: Delete`, so install's
 * `Retain` patch is load-bearing.
 */
export function localPathClass(name: string, nodePath: string, pattern: string, isDefault: boolean): Obj {
  return {
    apiVersion: 'storage.k8s.io/v1',
    kind: 'StorageClass',
    metadata: {
      name,
      ...(isDefault ? { annotations: { 'storageclass.kubernetes.io/is-default-class': 'true' } } : {}),
    },
    provisioner: 'rancher.io/local-path',
    volumeBindingMode: 'WaitForFirstConsumer',
    reclaimPolicy: 'Delete',
    parameters: { nodePath, pathPattern: pattern, allowUnsafePathPattern: 'true' },
  }
}

/**
 * An NFS class over the ganesha export whose volumes are `subDir` of it:
 * kind-byo's own names the usual per-claim template, and an e2e-byo file's
 * a fixed directory, because that class belongs to one file with one
 * claim. Naive on purpose — `Delete`, no `actimeo`, no `mountPermissions`
 * — so install's `Retain` patch, its coherence option and its binder are
 * each load-bearing.
 */
export function nfsClass(name: string, subDir: string): Obj {
  return {
    apiVersion: 'storage.k8s.io/v1',
    kind: 'StorageClass',
    metadata: { name },
    provisioner: 'nfs.csi.k8s.io',
    parameters: { server: KIND_BYO_NFS_SERVER, share: KIND_BYO_NFS_SHARE, subDir },
    reclaimPolicy: 'Delete',
    volumeBindingMode: 'Immediate',
    mountOptions: ['nfsvers=4.1', 'hard'],
  }
}

/**
 * Every address a node's traffic can arrive at a pod from: its InternalIP,
 * and its Calico tunnel address, which is what a kernel mount from another
 * node's host network is sourced from once it crosses the overlay.
 */
async function nodeAddresses(layout: KindByoLayout): Promise<string[]> {
  const deadline = Date.now() + 120_000
  for (;;) {
    const nodes = (JSON.parse(await run(layout, 'kubectl', ['get', 'nodes', '-o', 'json'])) as {
      items: Array<{
        metadata: { annotations?: Record<string, string> }
        status: { addresses: Array<{ type: string; address: string }> }
      }>
    }).items
    const tunnels = nodes.map((n) => n.metadata.annotations?.['projectcalico.org/IPv4IPIPTunnelAddr']
      ?? n.metadata.annotations?.['projectcalico.org/IPv4VXLANTunnelAddr'])
    if (tunnels.every(Boolean) || Date.now() > deadline) {
      return [...new Set([
        ...nodes.flatMap((n) => n.status.addresses.filter((a) => a.type === 'InternalIP').map((a) => a.address)),
        ...tunnels.filter((t): t is string => !!t),
      ])].sort()
    }
    await new Promise((r) => setTimeout(r, 2_000))
  }
}

/**
 * The ganesha export: NFSv4 only, over the data dir, uids passed through
 * raw (`No_Root_Squash` — the binder's chown is root's), admitting only the
 * node addresses, with the server's own metadata caching off so what the
 * host writes behind its back (the suite's seeding, a hand edit) is seen
 * at once; client-side staleness is what `actimeo=1` bounds and what this
 * cluster measures. `Graceless`, so a restart does not stall every client
 * through a grace period. `Filesystem_Id` pinned rather than detected
 * through the bind mounts.
 */
function ganeshaConfig(clients: string[]): string {
  return `NFS_CORE_PARAM {
  Protocols = 4;
  Enable_NLM = false;
  Enable_RQUOTA = false;
  NFS_Port = 2049;
}
NFSV4 {
  Graceless = true;
  Minor_Versions = 1, 2;
}
MDCACHE {
  Dir_Chunk = 0;
}
EXPORT {
  Export_Id = 1;
  Path = ${KIND_BYO_NFS_SHARE};
  Pseudo = ${KIND_BYO_NFS_SHARE};
  Protocols = 4;
  Transports = TCP;
  Access_Type = None;
  Squash = No_Root_Squash;
  SecType = sys;
  Filesystem_Id = 101.1;
  Attr_Expiration_Time = 0;
  FSAL { Name = VFS; }
  CLIENT {
    Clients = ${clients.join(', ')};
    Access_Type = RW;
  }
}
`
}

async function ensureGanesha(layout: KindByoLayout): Promise<void> {
  const tag = await ganeshaImageTag()
  await run(layout, 'podman', ['image', 'exists', tag]).catch(async () => {
    log(`building ${tag}`)
    await run(layout, 'podman', ['build', '-t', tag, GANESHA_CONTEXT], { timeout: 900_000 })
  })
  // Sideloaded, not pushed: it has to serve before `cluster install`
  // creates the registry that would hold it.
  await sideload(layout, [`localhost/${tag}`], { pull: false })
  const clients = await nodeAddresses(layout)
  const ns = KIND_BYO_NFS_NAMESPACE
  const labels = { app: GANESHA_NAME }
  log(`serving ${layout.dataDir} over NFSv4 to ${clients.join(', ')}`)
  await kubectlApplyDocs(layout, [
    { apiVersion: 'v1', kind: 'Namespace', metadata: { name: ns } },
    {
      apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: GANESHA_NAME, namespace: ns },
      data: { 'ganesha.conf': ganeshaConfig(clients) },
    },
    {
      apiVersion: 'apps/v1', kind: 'Deployment',
      metadata: { name: GANESHA_NAME, namespace: ns, labels },
      spec: {
        replicas: 1,
        strategy: { type: 'Recreate' },
        selector: { matchLabels: labels },
        template: {
          metadata: {
            labels,
            // Re-rolled when the node set (so the export's clients) changes.
            annotations: { 'kind-byo/config': stringHash(ganeshaConfig(clients)) },
          },
          spec: {
            nodeSelector: { 'node-role.kubernetes.io/control-plane': '' },
            tolerations: [{ key: 'node-role.kubernetes.io/control-plane', operator: 'Exists', effect: 'NoSchedule' }],
            containers: [{
              name: 'ganesha',
              image: `localhost/${tag}`,
              imagePullPolicy: 'Never',
              // The handle syscalls FSAL_VFS is built on need
              // CAP_DAC_READ_SEARCH, and it binds 2049.
              securityContext: { privileged: true },
              ports: [{ containerPort: 2049, protocol: 'TCP' }],
              volumeMounts: [
                { name: 'export', mountPath: KIND_BYO_NFS_SHARE },
                { name: 'config', mountPath: '/etc/ganesha', readOnly: true },
              ],
            }],
            volumes: [
              { name: 'export', hostPath: { path: layout.dataDir, type: 'Directory' } },
              { name: 'config', configMap: { name: GANESHA_NAME } },
            ],
          },
        },
      },
    },
    {
      apiVersion: 'v1', kind: 'Service', metadata: { name: GANESHA_NAME, namespace: ns },
      spec: { selector: labels, ports: [{ name: 'nfs', port: 2049, targetPort: 2049, protocol: 'TCP' }] },
    },
    // The second lock: an AUTH_SYS server that does not squash root trusts
    // whatever uid a client claims, so nothing but a node may reach it.
    {
      apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy',
      metadata: { name: `${GANESHA_NAME}-nodes-only`, namespace: ns },
      spec: {
        podSelector: { matchLabels: labels },
        policyTypes: ['Ingress'],
        ingress: [{
          from: clients.map((c) => ({ ipBlock: { cidr: `${c}/32` } })),
          ports: [{ protocol: 'TCP', port: 2049 }],
        }],
      },
    },
  ])
  await run(layout, 'kubectl', [
    'rollout', 'status', `deployment/${GANESHA_NAME}`, '-n', ns, '--timeout=180s',
  ], { timeout: 190_000 })
}

/** csi-driver-nfs, and the one RWX class the install is named. */
async function ensureCsiNfs(layout: KindByoLayout): Promise<void> {
  const docs: unknown[] = []
  for (const file of CSI_NFS_FILES) {
    docs.push(...docsOf(await fetchPinned(layout, `csi-driver-nfs-${CSI_NFS_VERSION}/${file}`,
      `https://raw.githubusercontent.com/kubernetes-csi/csi-driver-nfs/${CSI_NFS_VERSION}/deploy/${CSI_NFS_VERSION}/${file}`)))
  }
  log(`applying csi-driver-nfs ${CSI_NFS_VERSION}`)
  await kubectlApplyDocs(layout, [...docs, nfsClass(KIND_BYO_NFS_CLASS, 'volumes/${pvc.metadata.namespace}/${pvc.metadata.name}')])
  await run(layout, 'kubectl', ['rollout', 'status', 'deployment/csi-nfs-controller', '-n', 'kube-system', '--timeout=300s'], { timeout: 310_000 })
  await run(layout, 'kubectl', ['rollout', 'status', 'daemonset/csi-nfs-node', '-n', 'kube-system', '--timeout=300s'], { timeout: 310_000 })
}

/**
 * The Tailscale operator, from its static manifest at a pinned release,
 * with the OAuth client from the environment (`TS_OAUTH_CLIENT_ID` /
 * `TS_OAUTH_CLIENT_SECRET` — ephemeral and tagged, as the operator's
 * client is by design). Without one it says so, and the install that
 * follows stops at its operator gate.
 *
 * Every proxy it runs defaults (`PROXY_DEFAULT_CLASS`) to a ProxyClass
 * that takes its certificates from Let's Encrypt's staging environment.
 * Production issues at most five certificates a week for one name, and
 * each rebuild of the install's Ingress — a `down`/`up`, the byo suite's
 * namespace delete — is a new tailnet device asking for its name again;
 * staging allows 30,000. That is the one way kind-byo's origin differs
 * from a cloud install's, and it is invisible to yaac: its clients trust
 * the staging roots (`ensureStagingRoots`), nothing in the CLI changes.
 */
async function ensureOperator(layout: KindByoLayout): Promise<void> {
  const id = process.env.TS_OAUTH_CLIENT_ID
  const secret = process.env.TS_OAUTH_CLIENT_SECRET
  if (!id || !secret) {
    log('no TS_OAUTH_CLIENT_ID / TS_OAUTH_CLIENT_SECRET in the environment, so no Tailscale '
      + 'operator: the install stops at its operator gate.')
    return
  }
  const docs = (docsOf(await fetchPinned(layout, `tailscale-operator-${TAILSCALE_OPERATOR_VERSION}/operator.yaml`,
    `https://raw.githubusercontent.com/tailscale/tailscale/${TAILSCALE_OPERATOR_VERSION}/cmd/k8s-operator/deploy/manifests/operator.yaml`,
  )) as Obj[])
    // The OAuth Secret is ours to write; its manifest ships a placeholder.
    .filter((d) => !(d.kind === 'Secret' && d.metadata?.name === 'operator-oauth'))
    .map((d) => (d.kind === 'Deployment' ? pinOperatorImages(d) : d))
  log(`applying the Tailscale operator ${TAILSCALE_OPERATOR_VERSION}`)
  await kubectlApplyDocs(layout, [
    ...docs,
    {
      apiVersion: 'v1', kind: 'Secret', metadata: { name: 'operator-oauth', namespace: 'tailscale' },
      stringData: { client_id: id, client_secret: secret },
    },
  ])
  await run(layout, 'kubectl', [
    'wait', '--for=condition=established', 'crd/proxyclasses.tailscale.com', '--timeout=60s',
  ], { timeout: 70_000 })
  await kubectlApplyDocs(layout, [{
    apiVersion: 'tailscale.com/v1alpha1',
    kind: 'ProxyClass',
    metadata: { name: STAGING_PROXY_CLASS },
    spec: { useLetsEncryptStagingEnvironment: true },
  }])
  await run(layout, 'kubectl', ['rollout', 'status', 'deployment/operator', '-n', 'tailscale', '--timeout=300s'], { timeout: 310_000 })
}

/**
 * Let's Encrypt's staging roots, pinned like every other download, as one
 * PEM bundle a client names in `NODE_EXTRA_CA_CERTS`.
 */
async function ensureStagingRoots(layout: KindByoLayout): Promise<void> {
  const pems: string[] = []
  for (const root of STAGING_ROOTS) {
    pems.push(await fetchPinned(layout, `letsencrypt-staging/${path.basename(root)}`,
      `https://letsencrypt.org/certs/staging/${root}`))
  }
  await fs.writeFile(layout.stagingCa, pems.map((p) => p.trim()).join('\n') + '\n')
}

/** `:stable` → the pinned digest, for the operator and the proxies it runs. */
function pinOperatorImages(deployment: Obj): Obj {
  const text = JSON.stringify(deployment)
    .replaceAll('tailscale/k8s-operator:stable', PINNED_IMAGES.operator)
    .replaceAll('tailscale/tailscale:stable', PINNED_IMAGES.proxy)
    // One operator per tailnet device name; the host's own install may run another.
    .replaceAll('"value":"tailscale-operator"', `"value":"${CLUSTER}-operator"`)
  const pinned = JSON.parse(text) as Obj & {
    spec: { template: { spec: { containers: Array<{ env?: Array<{ name: string; value: string }> }> } } }
  }
  pinned.spec.template.spec.containers[0].env = [
    ...(pinned.spec.template.spec.containers[0].env ?? []),
    { name: 'PROXY_DEFAULT_CLASS', value: STAGING_PROXY_CLASS },
  ]
  return pinned
}

/**
 * The built CLI, run as an operator would run the published one: `--byo`
 * with kind-byo's NFS class and its named block class, and the default
 * class for the rest.
 */
async function installYaac(layout: KindByoLayout): Promise<void> {
  const cli = path.join(REPO_ROOT, 'dist', 'cli.js')
  await fs.access(cli).catch(() => { throw new Error(`no ${cli} — run \`pnpm build\` first`) })
  const args = [
    'cluster', 'install', '--byo', '--rwx-storage-class', KIND_BYO_NFS_CLASS, '--rwo-storage-class', KIND_BYO_RWO_CLASS,
  ]
  log(`yaac ${args.join(' ')}`)
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      stdio: 'inherit',
      env: { ...kubectlEnv(layout), ...installEnv(layout) },
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`yaac cluster install exited ${String(code)}`))
    })
  })
}

/** What a shell driving this install exports. */
function installEnv(layout: KindByoLayout): Record<string, string> {
  return {
    YAAC_DATA_DIR: layout.dataDir,
    KUBECONFIG: layout.kubeconfig,
    // The kind node fixups key on this name; kind-byo's nodes are its own.
    YAAC_KIND_CLUSTER: CLUSTER,
    // Its tailnet origin's certificate is a staging one (ensureOperator).
    NODE_EXTRA_CA_CERTS: layout.stagingCa,
  }
}

/**
 * The `e2e-byo` project's precondition, checked by its global setup before
 * anything is built: kind-byo is up, its NFS server is the image this
 * checkout builds, and this machine's uid is kind-byo's install uid — the
 * suite seeds tier files from the host, and pods at uid 1000 must be able
 * to write them.
 */
export async function requireKindByo(): Promise<void> {
  const layout = kindByoLayout()
  const fix = 'Bring it up (or re-converge it) with `pnpm kind-byo up`.'
  if (process.getuid?.() !== 1000) {
    throw new Error(`e2e-byo needs a host uid of 1000 (this is ${String(process.getuid?.())}): kind-byo's `
      + 'install uid is 1000, as a cloud install\'s is, and the suite writes tier files from the host.')
  }
  for (const file of [layout.kubeconfig, layout.stagingCa]) {
    await fs.access(file).catch(() => {
      throw new Error(`kind-byo is not up (no ${file}). ${fix}`)
    })
  }
  const image = await run(layout, 'kubectl', [
    'get', 'deployment', GANESHA_NAME, '-n', KIND_BYO_NFS_NAMESPACE,
    '-o', 'jsonpath={.spec.template.spec.containers[0].image}',
  ], { timeout: 30_000 }).catch(() => '')
  if (!image) throw new Error(`kind-byo has no NFS server. ${fix}`)
  if (image !== `localhost/${await ganeshaImageTag()}`) {
    throw new Error(`kind-byo's NFS server runs ${image}, not this checkout's ganesha image. ${fix}`)
  }
}

export async function kindByoUp(): Promise<void> {
  const layout = kindByoLayout()
  await preflight(layout)
  await ensureCluster(layout)
  await nodeFixups(layout)
  await ensureCalico(layout)
  await ensureLocalPath(layout)
  await ensureGanesha(layout)
  await ensureCsiNfs(layout)
  await ensureStagingRoots(layout)
  await ensureOperator(layout)
  await installYaac(layout)
  log(`up. Drive it with:\n${envText(layout)}`)
}

/**
 * Delete the cluster, workers drained first. Every NFS mount is `hard`, so
 * a node whose pods still hold one when ganesha's node goes first blocks in
 * the kernel forever — its last unmount waits on a server that no longer
 * exists, and the node container never finishes stopping. Draining evicts
 * those pods while the server still answers, so the kubelet unmounts
 * cleanly; only then is the cluster deleted.
 */
export async function kindByoDown(): Promise<void> {
  const layout = kindByoLayout()
  ensureRootfulPodmanHost()
  const workers = (await run(layout, 'kubectl', [
    'get', 'nodes', '-l', '!node-role.kubernetes.io/control-plane', '-o', 'name',
  ], { timeout: 30_000 }).catch(() => '')).split('\n').filter(Boolean)
  for (const node of workers) {
    log(`draining ${node} while the NFS server still answers`)
    await run(layout, 'kubectl', [
      'drain', node, '--ignore-daemonsets', '--delete-emptydir-data', '--force', '--timeout=300s',
    ], { timeout: 310_000 }).catch((err: unknown) => {
      log(`drain of ${node} did not finish (${err instanceof Error ? err.message.split('\n')[0] : String(err)})`)
    })
  }
  await run(layout, 'kind', ['delete', 'cluster', '--name', CLUSTER, '--kubeconfig', layout.kubeconfig], { timeout: 300_000 })
  log(`deleted ${CLUSTER}; ${layout.dataDir} keeps the install's bytes`)
}

function envText(layout: KindByoLayout): string {
  return Object.entries(installEnv(layout)).map(([k, v]) => `export ${k}=${v}`).join('\n')
}

async function main(): Promise<void> {
  const verb = process.argv[2]
  if (verb === 'up') await kindByoUp()
  else if (verb === 'down') await kindByoDown()
  else if (verb === 'env') console.log(envText(kindByoLayout()))
  else {
    console.error('usage: pnpm kind-byo up|down|env')
    process.exitCode = 2
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  main().catch((err: unknown) => {
    console.error(`[kind-byo] ${err instanceof Error ? err.message : String(err)}`)
    process.exitCode = 1
  })
}
