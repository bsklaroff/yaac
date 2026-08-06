/**
 * netd — the per-node yaac network daemon.
 *
 * One job: steer session egress into the yaac MITM proxy. It programs the
 * per-pod redirect (nat DNAT at the host-side veth) and renders the
 * co-located Envoy's listeners/clusters. It does NOT decide what is
 * allowed: every allow/deny is a plain Kubernetes NetworkPolicy enforced
 * by Calico's Felix, so the deny path is audited upstream code and netd's
 * own rules can only ever ADD reachability toward the proxy.
 *
 * That split is what makes netd safe to be late, wrong, or absent. A pod
 * whose redirect has not been programmed keeps `dst = world:443`, which
 * matches no rule in its NetworkPolicy (whose only world-ward allow is the
 * node's listener ports) and is dropped. netd being late means no egress,
 * never open egress.
 *
 * Full design and rationale: docs/session-egress.md.
 *
 * Reconcile is a pure function of cluster state: pods + Services + the
 * server's redirect claims + the node's Calico routes → desired chain +
 * Envoy documents. Every pass recomputes everything and writes only on
 * change, so there is no incremental state to drift and GC is implicit — a
 * deleted pod simply stops appearing in the rendering.
 *
 * The same binary runs in two modes (netdMode). `host` is the above.
 * `claim` runs INSIDE a nested install's vcluster and only publishes what
 * that install wants redirected, for the host to validate and program —
 * an inner yaac owns its redirect decision without owning a node's
 * netfilter (claims.ts, docs/nested-containers.md).
 *
 * Two ordering rules the pass must never break, both learned the hard way:
 *
 *  - Envoy first, and ACKNOWLEDGED. A rule that names a port Envoy has not
 *    bound black-holes the flows it captures, so the pass waits on the
 *    admin socket for the exact config version it wrote before it touches
 *    netfilter (see envoy-admin.ts).
 *  - The periodic pass distrusts the memo. The memo exists to keep a
 *    steady state silent, but it describes what netd LAST WROTE, not what
 *    the kernel currently holds — so the 30s tick discards it and
 *    re-asserts, which is what heals an externally flushed chain or a
 *    deleted PREROUTING jump.
 */

import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { CoreV1Api } from '@kubernetes/client-node'
import {
  PODS_PATH,
  clusterInformerFactory,
  loadInClusterConfig,
  mapConfigMap,
  mapPod,
  mapService,
  namespacedConfigMapsPath,
  namespacedPodsPath,
  namespacedServicesPath,
  startResourceWatch,
} from 'yaac-netd/k8s-watch'
import {
  CLAIMS_CONFIGMAP_NAME,
  CLAIM_KEY,
  INNER_CLAIM_CONFIGMAP_NAME,
  NETD_APP_NAME,
  parseClaimsConfigMap,
  renderInnerClaimDocument,
  type NetdConfigMap,
} from 'yaac-netd/claims'
import {
  applyRestore,
  defaultRunner,
  detectBackend,
  ensurePreroutingJump,
  readIpRoutes,
  teardownChain,
  type IptablesBackend,
} from 'yaac-netd/iptables'
import { normalizeVethPrefix, parsePodVeths } from 'yaac-netd/routes'
import {
  distinctTargets,
  selectClaimProxyPodIp,
  selectTargets,
  type NetdPod,
  type NetdService,
} from 'yaac-netd/targets'
import { DEFAULT_LISTENER_RANGE, type ListenerRange, type ListenerTrio, trioPorts } from 'yaac-netd/ports'
import { createTrioAllocator, fileTrioStore, probeTrioFree } from 'yaac-netd/listeners'
import { redirectChainName, renderNatRestore, renderRedirectRules } from 'yaac-netd/rules'
import {
  groupChains,
  ldsListenerNames,
  renderBootstrap,
  renderCds,
  renderLds,
  type TransparentPorts,
} from 'yaac-netd/envoy-config'
import {
  CONFIG_DUMP_PATH,
  ListenerRejectedError,
  adminGet,
  waitForListeners,
} from 'yaac-netd/envoy-admin'

const log = (message: string): void => { console.log(message) }

/** Envoy config directory, shared with the Envoy container (emptyDir). */
const ENVOY_DIR = process.env.NETD_ENVOY_DIR ?? '/etc/yaac-envoy'
export const LDS_PATH = path.join(ENVOY_DIR, 'lds.yaml')
export const CDS_PATH = path.join(ENVOY_DIR, 'cds.yaml')
export const BOOTSTRAP_PATH = path.join(ENVOY_DIR, 'bootstrap.yaml')
/** Envoy's admin UNIX socket — see renderBootstrap for why not a port. */
export const ENVOY_ADMIN_PATH = path.join(ENVOY_DIR, 'admin.sock')
/** The chosen listener slot, surviving a netd container restart. */
export const TRIO_STATE_PATH = path.join(ENVOY_DIR, 'trio.slot')
/**
 * Where the readiness marker lives. Host mode keeps it beside the Envoy
 * config it also owns; claim mode has no Envoy, so its DaemonSet points
 * this at a plain emptyDir.
 */
const STATE_DIR = process.env.NETD_STATE_DIR ?? ENVOY_DIR
/**
 * Readiness marker, written after a reconcile that actually reached the
 * dataplane and removed the moment one fails. The DaemonSet's readiness
 * probe reads it, so "netd is Ready" means "the redirect is programmed and
 * Envoy is serving it" rather than merely "the process is alive" — without
 * it a netd whose every reconcile errors still reports Ready, and `cluster
 * check`'s datapath gate passes on a cluster with no working egress. In
 * claim mode it means "my claim is published", which is the same promise at
 * the inner install's own layer.
 */
export const READY_PATH = path.join(STATE_DIR, '.ready')

/**
 * Which half of the split netd is running (see claims.ts):
 *
 *  - `host` (default): program this node's redirect. Needs the node, its
 *    netfilter, and a co-located Envoy.
 *  - `claim`: publish what THIS install wants redirected, for the host to
 *    validate and program. Runs inside a vcluster as an ordinary sandboxed
 *    pod — no hostNetwork, no capabilities, no Envoy.
 */
export type NetdMode = 'host' | 'claim'

export function netdMode(): NetdMode {
  return process.env.NETD_MODE === 'claim' ? 'claim' : 'host'
}

/** How long a pass waits for Envoy to acknowledge a config it just wrote. */
const LISTENER_GATE_ATTEMPTS = 60
const LISTENER_GATE_POLL_MS = 250
/** Delay before retrying a failed pass, so a broken Envoy is re-checked. */
const RETRY_DELAY_MS = 2_000

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]
  const n = raw ? Number(raw) : Number.NaN
  return Number.isInteger(n) && n > 0 ? n : fallback
}

/**
 * Runtime config. The proxy-side constants, the listener range and the
 * cluster's pod CIDRs are all passed as env by the server (from
 * proxy-constants.ts and cluster-cidrs.ts) exactly like the proxy's own,
 * so each has a single definition; the node identity comes from the
 * downward API.
 */
export interface NetdConfig {
  installNamespace: string
  nodeName: string
  nodeIp: string
  /** Every CIDR the cluster allocates pod IPs from. */
  podCidrs: string[]
  /**
   * Interface-name prefix this cluster's CNI gives every workload veth —
   * `cali` wherever Calico does the IPAM, something else on an adopted CNI
   * (see routes.ts). Configuration rather than a constant, but never
   * "match anything".
   */
  vethPrefix: string
  sshSentinelIp: string
  sshSentinelPort: number
  transparentPorts: TransparentPorts
  listenerRange: ListenerRange
}

export function loadConfig(): NetdConfig {
  const required = (name: string): string => {
    const value = process.env[name]
    if (!value) throw new Error(`netd: ${name} is required`)
    return value
  }
  // Refusing to start beats starting with an empty exclusion list: with no
  // pod CIDR to return on, the chain would DNAT pod-to-pod 443/80 into the
  // proxy. Refusing costs egress; guessing corrupts in-cluster traffic.
  const podCidrs = required('CLUSTER_POD_CIDRS').split(',').map((c) => c.trim()).filter(Boolean)
  if (podCidrs.length === 0) throw new Error('netd: CLUSTER_POD_CIDRS is empty')
  return {
    installNamespace: required('YAAC_NAMESPACE'),
    nodeName: required('NODE_NAME'),
    nodeIp: required('NODE_IP'),
    podCidrs,
    vethPrefix: normalizeVethPrefix(process.env.NETD_VETH_PREFIX),
    sshSentinelIp: process.env.SSH_TUNNEL_SENTINEL ?? '198.18.0.2',
    sshSentinelPort: envInt('TUNNEL_INGRESS_PORT', 10259),
    transparentPorts: {
      https: envInt('TRANSPARENT_HTTPS_PORT', 10256),
      http: envInt('TRANSPARENT_HTTP_PORT', 10257),
      tunnel: envInt('TRANSPARENT_TUNNEL_PORT', 10258),
    },
    listenerRange: {
      base: envInt('NETD_LISTENER_PORT_BASE', DEFAULT_LISTENER_RANGE.base),
      slots: envInt('NETD_LISTENER_SLOTS', DEFAULT_LISTENER_RANGE.slots),
    },
  }
}

/** Write a file atomically — Envoy watches these and must never read a
 *  half-written document. */
async function writeAtomic(file: string, content: string): Promise<void> {
  const tmp = `${file}.tmp`
  await fs.writeFile(tmp, content)
  await fs.rename(tmp, file)
}

function sha(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16)
}

export interface ConfirmListenersInput {
  names: string[]
  version: string
  ports: number[]
}

export interface ReconcileDeps {
  config: NetdConfig
  backend: IptablesBackend
  /** This install's own nat chain (see redirectChainName). */
  chain: string
  pods: () => NetdPod[]
  services: () => NetdService[]
  /** ConfigMaps in netd's OWN namespace — the server's redirect claims. */
  configMaps: () => NetdConfigMap[]
  routes: () => Promise<string>
  /** This install's listener trio, probed and persisted on first call. */
  trio: () => Promise<ListenerTrio>
  /** Block until Envoy serves this exact config; throw if it never will. */
  confirmListeners: (input: ConfirmListenersInput) => Promise<void>
  applyChain: (document: string) => Promise<void>
  ensureJump: () => Promise<void>
  writeEnvoy: (file: string, content: string) => Promise<void>
  log: (message: string) => void
}

/** The last-applied renderings, so an unchanged pass writes nothing. */
export interface ReconcileMemo {
  chain?: string
  lds?: string
  cds?: string
  /** version_info of the LDS document last written — what the gate awaits. */
  ldsVersion?: string
}

export interface ReconcileOptions {
  /**
   * Re-assert the dataplane even when the rendering is unchanged. The
   * memo says what netd wrote, not what the kernel kept; only a pass that
   * ignores it can heal drift netd never observed.
   */
  resync?: boolean
}

/**
 * One reconcile pass. Returns what changed, which the caller logs — a
 * quiet steady state is the point, so passes that write nothing say
 * nothing.
 */
export async function reconcileOnce(
  deps: ReconcileDeps,
  memo: ReconcileMemo,
  options: ReconcileOptions = {},
): Promise<string[]> {
  const { config } = deps
  const pods = deps.pods()
  const services = deps.services()

  // The outer proxy's ClusterIP — the destination every session pod's
  // egress is redirected to, and the fallback for vcluster-synced pods.
  const outerProxy = services.find(
    (s) => s.namespace === config.installNamespace && s.name === 'yaac-proxy',
  )
  // The server-authored claims document (see claims.ts). Absent means no
  // install has claimed anything, which leaves every synced pod on rule 3.
  const claimsCm = deps.configMaps().find(
    (cm) => cm.namespace === config.installNamespace && cm.name === CLAIMS_CONFIGMAP_NAME,
  )
  const selected = selectTargets({
    pods,
    installNamespace: config.installNamespace,
    outerProxyClusterIp: outerProxy?.clusterIp ?? null,
    claims: parseClaimsConfigMap(claimsCm?.data),
    podCidrs: config.podCidrs,
  })
  const targets = distinctTargets(selected)
  const chains = groupChains(selected)
  const trio = await deps.trio()

  // Envoy first: a listener must exist before any rule points a packet at
  // it, or the redirected connection is refused. The reverse order would
  // black-hole the first flows of a newly-targeted pod.
  const ldsDoc = JSON.stringify(renderLds({
    installNamespace: config.installNamespace, trio, chains, versionInfo: 'pending',
  }))
  const cdsDoc = JSON.stringify(renderCds({
    targets, transparentPorts: config.transparentPorts, versionInfo: 'pending',
  }))
  const changed: string[] = []
  if (memo.cds !== cdsDoc) {
    await deps.writeEnvoy(CDS_PATH, JSON.stringify(renderCds({
      targets, transparentPorts: config.transparentPorts, versionInfo: sha(cdsDoc),
    }), null, 2))
    memo.cds = cdsDoc
    changed.push(`cds(${targets.length} targets)`)
  }
  if (memo.lds !== ldsDoc) {
    memo.ldsVersion = sha(ldsDoc)
    await deps.writeEnvoy(LDS_PATH, JSON.stringify(renderLds({
      installNamespace: config.installNamespace, trio, chains, versionInfo: memo.ldsVersion,
    }), null, 2))
    memo.lds = ldsDoc
    changed.push(`lds(${chains.length} chains on ${trioPorts(trio).join('/')})`)
  }

  // Checked on EVERY pass, not just after a write: this is also what
  // notices an Envoy that died or dropped its listeners, and it costs one
  // request on a unix socket.
  await deps.confirmListeners({
    names: ldsListenerNames({ installNamespace: config.installNamespace, chains }),
    version: memo.ldsVersion ?? '',
    ports: trioPorts(trio),
  })

  const vethByPodIp = parsePodVeths(await deps.routes(), config.vethPrefix)
  const rules = renderRedirectRules({
    selected,
    vethByPodIp,
    trio,
    nodeIp: config.nodeIp,
    podCidrs: config.podCidrs,
    sshSentinelIp: config.sshSentinelIp,
    sshSentinelPort: config.sshSentinelPort,
  })
  const document = renderNatRestore(deps.chain, rules)
  if (options.resync) memo.chain = undefined
  if (memo.chain !== document) {
    await deps.applyChain(document)
    memo.chain = document
    changed.push(`rules(${rules.length} for ${selected.length} pods)`)
  }
  // Re-asserted every pass, not only after a chain write: the chain must
  // exist before PREROUTING can reference it, and a jump deleted out from
  // under netd is invisible in the rendering, so nothing else would ever
  // notice it was gone. `-C` first makes this a no-op in the steady state.
  await deps.ensureJump()
  return changed
}

/** Claim-mode config: no node, no CIDRs, no ports — just an identity. */
export interface NetdClaimConfig {
  /** This (inner) install's namespace inside its own cluster. */
  installNamespace: string
  /** This install's data-dir hash — the claim's `install` field. */
  installHash: string
}

export function loadClaimConfig(): NetdClaimConfig {
  const required = (name: string): string => {
    const value = process.env[name]
    if (!value) throw new Error(`netd: ${name} is required`)
    return value
  }
  return {
    installNamespace: required('YAAC_NAMESPACE'),
    installHash: required('YAAC_DATA_DIR_HASH'),
  }
}

export interface ClaimReconcileDeps {
  config: NetdClaimConfig
  /** Pods in this install's own namespace. */
  pods: () => NetdPod[]
  /** Write the claim document into this install's claim ConfigMap. */
  publish: (document: string) => Promise<void>
  log: (message: string) => void
}

/** The last-published document, so an unchanged pass writes nothing. */
export interface ClaimMemo {
  document?: string
}

/**
 * One claim-mode pass: compute what this install wants redirected and
 * publish it.
 *
 * The selection is `selectTargets` — the same rule 1 a top-level netd runs
 * over the same labels — so an inner install's notion of "which pods get
 * redirected" cannot drift from the host's. Rules 2 and 3 are inert here:
 * no pod inside a vcluster carries the syncer's `managed-by` label (it is
 * stamped on the HOST copy), so there is nothing for them to match, and the
 * claims/podCidrs inputs they consume are left empty.
 *
 * An install with no proxy pod up, or no session pods, publishes the empty
 * document — an explicit retraction, which drops its pods back to the outer
 * proxy on the host's next pass rather than leaving them aimed at an address
 * that no longer serves.
 */
export async function publishClaimOnce(
  deps: ClaimReconcileDeps,
  memo: ClaimMemo,
): Promise<string[]> {
  const pods = deps.pods()
  const proxyPodIp = selectClaimProxyPodIp(pods, deps.config.installNamespace)
  const sources = proxyPodIp === null ? [] : selectTargets({
    pods,
    installNamespace: deps.config.installNamespace,
    outerProxyClusterIp: proxyPodIp,
  }).map((selected) => selected.pod.podIp)
  const document = proxyPodIp === null || sources.length === 0
    ? ''
    : renderInnerClaimDocument({ install: deps.config.installHash, proxyPodIp, sources })
  if (memo.document === document) return []
  await deps.publish(document)
  memo.document = document
  return [document === ''
    ? 'claim(retracted)'
    : `claim(${sources.length} pods -> ${proxyPodIp})`]
}

/**
 * Upsert this install's claim ConfigMap. Read-then-write rather than a
 * patch: the document is a single key netd owns outright, and an
 * unconditional replace cannot lose a concurrent edit that matters (a
 * second writer of this object would be a second netd for the same
 * install, which the DaemonSet does not create).
 */
async function publishClaimConfigMap(
  api: CoreV1Api,
  namespace: string,
  document: string,
): Promise<void> {
  const body = {
    metadata: {
      name: INNER_CLAIM_CONFIGMAP_NAME,
      namespace,
      // Cosmetic (triage): the server picks the synced copy out by name,
      // not by label. What makes the syncer copy this object to the host at
      // all is the claim-mode pod referencing it as a volume.
      labels: { app: NETD_APP_NAME },
    },
    data: { [CLAIM_KEY]: document },
  }
  const existing = await api
    .readNamespacedConfigMap({ name: INNER_CLAIM_CONFIGMAP_NAME, namespace })
    .catch(() => null)
  if (!existing) {
    await api.createNamespacedConfigMap({ namespace, body })
    return
  }
  await api.replaceNamespacedConfigMap({ name: INNER_CLAIM_CONFIGMAP_NAME, namespace, body })
}

/**
 * Run claim-mode netd until signalled. Same debounced-watch shape as host
 * mode, minus everything that touches a node.
 */
export async function runClaimMode(): Promise<void> {
  const config = loadClaimConfig()
  log(`[netd] mode=claim ns=${config.installNamespace} install=${config.installHash}`)
  await fs.mkdir(STATE_DIR, { recursive: true })
  await fs.rm(READY_PATH, { force: true })

  const kubeConfig = loadInClusterConfig()
  const coreApi = kubeConfig.makeApiClient(CoreV1Api)
  const makeInformerFn = clusterInformerFactory(kubeConfig)
  const memo: ClaimMemo = {}
  const deps: ClaimReconcileDeps = {
    config,
    pods: () => podWatch.list(),
    publish: (document) => publishClaimConfigMap(coreApi, config.installNamespace, document),
    log,
  }

  let running = false
  let pending = false
  let retryTimer: NodeJS.Timeout | null = null
  const reconcile = async (): Promise<void> => {
    if (running) {
      pending = true
      return
    }
    running = true
    try {
      const changed = await publishClaimOnce(deps, memo)
      if (changed.length > 0) log(`[netd] published ${changed.join(' ')}`)
      if (retryTimer) { clearTimeout(retryTimer); retryTimer = null }
      await fs.writeFile(READY_PATH, 'ok')
    } catch (err) {
      log(`[netd] claim publish failed: ${String(err)}`)
      // The memo describes what netd published, not what the apiserver
      // kept — a failed write must not be remembered as done.
      memo.document = undefined
      await fs.rm(READY_PATH, { force: true }).catch(() => { /* best-effort */ })
      if (!retryTimer) {
        retryTimer = setTimeout(() => { retryTimer = null; void reconcile() }, RETRY_DELAY_MS)
      }
    } finally {
      running = false
      if (pending) {
        pending = false
        void reconcile()
      }
    }
  }

  let debounce: NodeJS.Timeout | null = null
  const onChange = (): void => {
    if (debounce) clearTimeout(debounce)
    debounce = setTimeout(() => { debounce = null; void reconcile() }, 200)
  }

  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    // Nothing to tear down: the claim outlives this pod by design, and the
    // host drops it the moment the proxy pod it names goes away.
    process.on(sig, () => { process.exit(0) })
  }

  const podWatch = startResourceWatch<NetdPod>({
    path: namespacedPodsPath(config.installNamespace),
    listFn: () => coreApi.listNamespacedPod({ namespace: config.installNamespace }),
    map: mapPod,
    onChange,
    log,
    makeInformerFn,
  })
  podWatch.start()
  // Re-publish periodically as well: the memo would otherwise hide a claim
  // an outside actor deleted from the apiserver.
  setInterval(() => { memo.document = undefined; void reconcile() }, 30_000)
  await reconcile()
  await new Promise(() => { /* run until signalled */ })
}

/**
 * Run netd until the process is signalled. Watches drive a debounced
 * reconcile; a periodic tick re-runs it in resync mode, which is what
 * repairs drift netd cannot observe — the node's routes (not watched),
 * and any external flush of the nat table.
 */
export async function runHostMode(): Promise<void> {
  const config = loadConfig()
  const backend = await detectBackend()
  const chain = redirectChainName(config.installNamespace)
  log(`[netd] node=${config.nodeName} ip=${config.nodeIp} ns=${config.installNamespace} `
    + `iptables=${backend} chain=${chain} veth=${config.vethPrefix}* `
    + `podCidrs=${config.podCidrs.join(',')}`)

  await fs.mkdir(ENVOY_DIR, { recursive: true })
  // Never inherit a previous container's marker.
  await fs.rm(READY_PATH, { force: true })
  // The bootstrap is static, but netd owns it so the whole Envoy surface
  // is versioned with netd rather than baked into the image.
  await writeAtomic(BOOTSTRAP_PATH, JSON.stringify(renderBootstrap({
    ldsPath: LDS_PATH, cdsPath: CDS_PATH, adminPath: ENVOY_ADMIN_PATH,
  }), null, 2))
  // Empty documents up front so Envoy can start before the first watch
  // has seeded (its file xDS sources must resolve at boot).
  const empty = JSON.stringify({ version_info: 'empty', resources: [] }, null, 2)
  for (const file of [LDS_PATH, CDS_PATH]) {
    await fs.access(file).catch(() => writeAtomic(file, empty))
  }

  const allocator = createTrioAllocator({
    installNamespace: config.installNamespace,
    range: config.listenerRange,
    store: fileTrioStore(TRIO_STATE_PATH),
    isFree: probeTrioFree,
    log,
  })

  // One kubeconfig for both watches: its tokenFile auth provider re-reads
  // the projected ServiceAccount token, so a netd outliving a token
  // rotation keeps watching instead of 401ing quietly forever.
  const kubeConfig = loadInClusterConfig()
  const coreApi = kubeConfig.makeApiClient(CoreV1Api)
  const makeInformerFn = clusterInformerFactory(kubeConfig)
  const memo: ReconcileMemo = {}
  const deps: ReconcileDeps = {
    config,
    backend,
    chain,
    pods: () => podWatch.list(),
    services: () => serviceWatch.list(),
    configMaps: () => claimWatch.list(),
    routes: () => readIpRoutes(),
    trio: () => allocator.resolve(),
    confirmListeners: (expected) => waitForListeners({
      expected,
      dump: () => adminGet(ENVOY_ADMIN_PATH, CONFIG_DUMP_PATH),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      attempts: LISTENER_GATE_ATTEMPTS,
      pollMs: LISTENER_GATE_POLL_MS,
    }),
    applyChain: (doc) => applyRestore(backend, doc),
    ensureJump: () => ensurePreroutingJump(backend, chain),
    writeEnvoy: writeAtomic,
    log,
  }

  // A pass requested while one is running is coalesced into a single
  // follow-up, keeping any resync request: dropping it would mean a tick
  // that arrived mid-pass never healed anything.
  let pending: ReconcileOptions | null = null
  let running = false
  let retryTimer: NodeJS.Timeout | null = null
  const reconcile = async (options: ReconcileOptions = {}): Promise<void> => {
    if (running) {
      pending = { resync: (pending?.resync ?? false) || (options.resync ?? false) }
      return
    }
    running = true
    try {
      const changed = await reconcileOnce(deps, memo, options)
      if (changed.length > 0) log(`[netd] applied ${changed.join(' ')}`)
      if (retryTimer) { clearTimeout(retryTimer); retryTimer = null }
      await fs.writeFile(READY_PATH, 'ok')
    } catch (err) {
      log(`[netd] reconcile failed: ${String(err)}`)
      // Envoy refused the trio outright — almost always a coexisting
      // install's Envoy already holding it. Drop the persisted slot so the
      // next pass probes for a free one instead of retrying forever.
      if (err instanceof ListenerRejectedError) {
        log('[netd] re-probing for a free listener trio')
        await allocator.reset().catch(() => { /* best-effort */ })
        memo.lds = undefined
      }
      // Force the next pass to re-apply: the memo may claim state the
      // dataplane does not actually have.
      memo.chain = undefined
      await fs.rm(READY_PATH, { force: true }).catch(() => { /* best-effort */ })
      // Retry sooner than the 30s tick: a failed pass means no egress.
      if (!retryTimer) {
        retryTimer = setTimeout(() => { retryTimer = null; void reconcile() }, RETRY_DELAY_MS)
      }
    } finally {
      running = false
      if (pending) {
        const next = pending
        pending = null
        void reconcile(next)
      }
    }
  }

  let debounce: NodeJS.Timeout | null = null
  const onChange = (): void => {
    if (debounce) clearTimeout(debounce)
    debounce = setTimeout(() => { debounce = null; void reconcile() }, 200)
  }

  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.on(sig, () => {
      log('[netd] shutting down — removing redirect rules')
      void teardownChain(backend, chain, defaultRunner).finally(() => process.exit(0))
    })
  }

  // Constructed after `onChange` exists; `deps` closes over them and is
  // not called until the first reconcile below.
  const podWatch = startResourceWatch<NetdPod>({
    path: PODS_PATH,
    listFn: () => coreApi.listPodForAllNamespaces(),
    map: mapPod,
    onChange,
    log,
    makeInformerFn,
  })
  // Services and claims come from netd's OWN namespace only: the outer
  // proxy's ClusterIP and the server-authored claims document both live
  // there, and nothing else may influence the selection. That scoping is
  // what keeps netd's cluster-wide read down to pods.
  const serviceWatch = startResourceWatch<NetdService>({
    path: namespacedServicesPath(config.installNamespace),
    listFn: () => coreApi.listNamespacedService({ namespace: config.installNamespace }),
    map: mapService,
    onChange,
    log,
    makeInformerFn,
  })
  const claimWatch = startResourceWatch<NetdConfigMap>({
    path: namespacedConfigMapsPath(config.installNamespace),
    listFn: () => coreApi.listNamespacedConfigMap({ namespace: config.installNamespace }),
    map: mapConfigMap,
    onChange,
    log,
    makeInformerFn,
  })
  podWatch.start()
  serviceWatch.start()
  claimWatch.start()
  setInterval(() => { void reconcile({ resync: true }) }, 30_000)
  await reconcile()
  await new Promise(() => { /* run until signalled */ })
}

/** Run whichever half of netd this pod is (see netdMode). */
export async function main(): Promise<void> {
  if (netdMode() === 'claim') {
    await runClaimMode()
    return
  }
  await runHostMode()
}

// Entry point when run directly (the container's command), not when a
// test imports the pure helpers above.
if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  main().catch((err: unknown) => {
    console.error(`[netd] fatal: ${String(err)}`)
    process.exit(1)
  })
}
