/**
 * netd, the per-node yaac network daemon. It redirects workspace egress
 * into the yaac proxy: nat DNAT rules at each pod's host-side veth, plus
 * the co-located Envoy's listeners and clusters.
 *
 * netd does not decide what is allowed; NetworkPolicy (enforced by
 * Calico) does, and netd's rules only add a path to the proxy. A pod netd
 * has not yet programmed has its egress dropped by policy, never let out.
 * See docs/workspace-egress.md.
 *
 * Each reconcile pass recomputes everything from pods, Services and the
 * node's routes, and writes only what changed. Two ordering rules:
 *  - Envoy config is written and acknowledged (envoy-admin.ts) before any
 *    iptables rule points at it.
 *  - The periodic 30s pass ignores the memo of what netd last wrote and
 *    re-applies, to repair an externally flushed chain or deleted jump.
 */

import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { CoreV1Api } from '@kubernetes/client-node'
import {
  PODS_PATH,
  clusterInformerFactory,
  loadInClusterConfig,
  mapPod,
  mapService,
  namespacedServicesPath,
  startResourceWatch,
} from 'yaac-netd/k8s-watch'
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
/** Envoy's admin unix socket (see renderBootstrap). */
export const ENVOY_ADMIN_PATH = path.join(ENVOY_DIR, 'admin.sock')
/** The chosen listener slot, surviving a netd container restart. */
export const TRIO_STATE_PATH = path.join(ENVOY_DIR, 'trio.slot')
const STATE_DIR = ENVOY_DIR
/**
 * Readiness marker, written after a successful reconcile and removed when
 * one fails. The DaemonSet's readiness probe reads it, so Ready means the
 * redirect is programmed and Envoy is serving it.
 */
export const READY_PATH = path.join(STATE_DIR, '.ready')

/** How long a pass waits for Envoy to acknowledge a config it just wrote. */
const LISTENER_GATE_ATTEMPTS = 60
const LISTENER_GATE_POLL_MS = 250
/** Delay before retrying a failed pass. */
const RETRY_DELAY_MS = 2_000

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]
  const n = raw ? Number(raw) : Number.NaN
  return Number.isInteger(n) && n > 0 ? n : fallback
}

/**
 * Runtime config. The server passes the proxy ports, listener range and
 * pod CIDRs as env (from proxy-constants.ts and cluster-cidrs.ts); the
 * node identity comes from the downward API.
 */
export interface NetdConfig {
  installNamespace: string
  nodeName: string
  nodeIp: string
  /** Every CIDR the cluster allocates pod IPs from. */
  podCidrs: string[]
  /** Interface-name prefix of workload veths (see routes.ts). */
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
  // Without pod CIDRs the chain would redirect pod-to-pod 443/80 traffic
  // into the proxy, so refuse to start.
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

/** Write a file atomically so Envoy never reads a half-written document. */
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
  /** version_info of the LDS document last written. */
  ldsVersion?: string
}

export interface ReconcileOptions {
  /**
   * Re-apply the iptables chain even when the rendering is unchanged, to
   * repair changes netd did not make.
   */
  resync?: boolean
}

/**
 * One reconcile pass. Returns a description of what changed (empty when
 * nothing did), for the caller to log.
 */
export async function reconcileOnce(
  deps: ReconcileDeps,
  memo: ReconcileMemo,
  options: ReconcileOptions = {},
): Promise<string[]> {
  const { config } = deps
  const pods = deps.pods()
  const services = deps.services()

  const outerProxy = services.find(
    (s) => s.namespace === config.installNamespace && s.name === 'yaac-proxy',
  )
  const selected = selectTargets({
    pods,
    installNamespace: config.installNamespace,
    outerProxyClusterIp: outerProxy?.clusterIp ?? null,
  })
  const targets = distinctTargets(selected)
  const chains = groupChains(selected)
  const trio = await deps.trio()

  // Envoy before iptables, so no rule points at a missing listener.
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

  // Checked every pass, so an Envoy that restarted or lost its listeners
  // is noticed.
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
  // Every pass: a deleted jump would not show up in the rendering.
  await deps.ensureJump()
  return changed
}

/**
 * Run netd until signalled. Watches trigger a debounced reconcile; a 30s
 * tick runs a resync pass to catch route changes (not watched) and
 * external edits to the nat table.
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
  // netd writes the bootstrap so the Envoy image stays stock.
  await writeAtomic(BOOTSTRAP_PATH, JSON.stringify(renderBootstrap({
    ldsPath: LDS_PATH, cdsPath: CDS_PATH, adminPath: ENVOY_ADMIN_PATH,
  }), null, 2))
  // Envoy needs its xDS files to exist at boot.
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

  // Requests during a running pass coalesce into one follow-up, which
  // keeps any resync request.
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
      // Usually another install's Envoy holds the trio; pick a new one.
      if (err instanceof ListenerRejectedError) {
        log('[netd] re-probing for a free listener trio')
        await allocator.reset().catch(() => { /* best-effort */ })
        memo.lds = undefined
      }
      // The memo may not match what the kernel holds; re-apply next pass.
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

  // `deps` refers to these watches but is not called until reconcile()
  // below.
  const podWatch = startResourceWatch<NetdPod>({
    path: PODS_PATH,
    listFn: () => coreApi.listPodForAllNamespaces(),
    map: mapPod,
    onChange,
    log,
    makeInformerFn,
  })
  // Only netd's own namespace, where the proxy's ClusterIP lives.
  const serviceWatch = startResourceWatch<NetdService>({
    path: namespacedServicesPath(config.installNamespace),
    listFn: () => coreApi.listNamespacedService({ namespace: config.installNamespace }),
    map: mapService,
    onChange,
    log,
    makeInformerFn,
  })
  podWatch.start()
  serviceWatch.start()
  setInterval(() => { void reconcile({ resync: true }) }, 30_000)
  await reconcile()
  await new Promise(() => { /* run until signalled */ })
}

export async function main(): Promise<void> {
  await runHostMode()
}

// Run only when executed directly, not when imported by tests.
if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  main().catch((err: unknown) => {
    console.error(`[netd] fatal: ${String(err)}`)
    process.exit(1)
  })
}
