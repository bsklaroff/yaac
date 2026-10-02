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
import { setTimeout as sleep } from 'node:timers/promises'
import {
  inClusterClient,
  watchPods,
  watchServices,
  type NetdPod,
} from 'yaac-netd/k8s-watch'
import {
  applyRestore,
  defaultRunner,
  detectBackend,
  ensurePreroutingJump,
  readIpRoutes,
  teardownChain,
} from 'yaac-netd/iptables'
import { normalizeVethPrefix, parsePodVeths } from 'yaac-netd/routes'
import { DEFAULT_LISTENER_RANGE, type ListenerRange, type ListenerTrio, trioPorts } from 'yaac-netd/ports'
import { createTrioAllocator, fileTrioStore, probeTrioFree } from 'yaac-netd/listeners'
import { redirectChainName, renderNatRestore, renderRedirectRules } from 'yaac-netd/rules'
import {
  renderBootstrap,
  renderCds,
  renderLds,
  type EnvoyResource,
  type TransparentPorts,
} from 'yaac-netd/envoy-config'
import {
  CONFIG_DUMP_PATH,
  ListenerRejectedError,
  adminGet,
  waitForListeners,
  type ExpectedListeners,
} from 'yaac-netd/envoy-admin'

const log = (message: string): void => { console.log(message) }

/** Envoy config directory, shared with the Envoy container (emptyDir). */
const ENVOY_DIR = process.env.NETD_ENVOY_DIR ?? '/etc/yaac-envoy'
export const LDS_PATH = path.join(ENVOY_DIR, 'lds.yaml')
export const CDS_PATH = path.join(ENVOY_DIR, 'cds.yaml')
const BOOTSTRAP_PATH = path.join(ENVOY_DIR, 'bootstrap.yaml')
/** Envoy's admin unix socket (see renderBootstrap). */
const ENVOY_ADMIN_PATH = path.join(ENVOY_DIR, 'admin.sock')
/** The chosen listener slot, surviving a netd container restart. */
const TRIO_STATE_PATH = path.join(ENVOY_DIR, 'trio.slot')
/**
 * Readiness marker, written after a successful reconcile and removed when
 * one fails. The DaemonSet's readiness probe reads it, so Ready means the
 * redirect is programmed and Envoy is serving it.
 */
const READY_PATH = path.join(ENVOY_DIR, '.ready')

/** How long a pass waits for Envoy to acknowledge a config it just wrote. */
const LISTENER_GATE_ATTEMPTS = 60
const LISTENER_GATE_POLL_MS = 250
/** How long a pass waits to coalesce a burst of watch events. */
const DEBOUNCE_MS = 200
/** Delay before retrying a failed pass. */
const RETRY_DELAY_MS = 2_000
const RESYNC_INTERVAL_MS = 30_000

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

/**
 * An xDS DiscoveryResponse. Its version is a hash of the resources, so an
 * unchanged rendering keeps its version and the listener gate can wait for
 * the exact document netd wrote.
 */
function discoveryResponse(resources: EnvoyResource[]): { key: string; version: string; text: string } {
  const key = JSON.stringify(resources)
  const version = crypto.createHash('sha256').update(key).digest('hex').slice(0, 16)
  return { key, version, text: JSON.stringify({ version_info: version, resources }, null, 2) }
}

export interface ReconcileDeps {
  config: NetdConfig
  /** This install's own nat chain (see redirectChainName). */
  chain: string
  /** This install's workspace pods. */
  pods: () => NetdPod[]
  /** The proxy Service's ClusterIP, or null when it is not up yet. */
  proxyIp: () => string | null
  routes: () => Promise<string>
  /** This install's listener trio, probed and persisted on first call. */
  trio: () => Promise<ListenerTrio>
  /** Block until Envoy serves this exact config; throw if it never will. */
  confirmListeners: (expected: ExpectedListeners) => Promise<void>
  applyChain: (document: string) => Promise<void>
  ensureJump: () => Promise<void>
  writeEnvoy: (file: string, content: string) => Promise<void>
}

/** The last-applied renderings, so an unchanged pass writes nothing. */
export interface ReconcileMemo {
  chain?: string
  lds?: string
  cds?: string
}

/**
 * One reconcile pass. `resync` re-applies the iptables chain even when the
 * rendering is unchanged, to repair changes netd did not make. Returns a
 * description of what changed (empty when nothing did), for the caller to
 * log.
 */
export async function reconcileOnce(
  deps: ReconcileDeps,
  memo: ReconcileMemo,
  resync = false,
): Promise<string[]> {
  const { config } = deps
  const proxyIp = deps.proxyIp()
  // Nothing is redirected until the proxy is there to receive it. Sorted
  // so the rendered output is stable between passes.
  const pods = proxyIp ? [...deps.pods()].sort((a, b) => a.name.localeCompare(b.name)) : []
  const trio = await deps.trio()

  // Envoy before iptables, so no rule points at a missing listener.
  const changed: string[] = []
  const cds = discoveryResponse(renderCds({
    installNamespace: config.installNamespace, proxyIp, transparentPorts: config.transparentPorts,
  }))
  if (memo.cds !== cds.key) {
    await deps.writeEnvoy(CDS_PATH, cds.text)
    memo.cds = cds.key
    changed.push(`cds(proxy ${proxyIp ?? 'absent'})`)
  }
  const listeners = renderLds({
    installNamespace: config.installNamespace, trio, podIps: pods.map((p) => p.podIp),
  })
  const lds = discoveryResponse(listeners)
  if (memo.lds !== lds.key) {
    await deps.writeEnvoy(LDS_PATH, lds.text)
    memo.lds = lds.key
    changed.push(`lds(${pods.length} pods on ${trioPorts(trio).join('/')})`)
  }

  // Checked every pass, so an Envoy that restarted or lost its listeners
  // is noticed.
  await deps.confirmListeners({
    names: listeners.map((l) => l.name),
    version: lds.version,
    ports: trioPorts(trio),
  })

  const vethByPodIp = parsePodVeths(await deps.routes(), config.vethPrefix)
  const rules = renderRedirectRules({
    pods,
    vethByPodIp,
    trio,
    nodeIp: config.nodeIp,
    podCidrs: config.podCidrs,
    sshSentinelIp: config.sshSentinelIp,
    sshSentinelPort: config.sshSentinelPort,
  })
  const document = renderNatRestore(deps.chain, rules)
  if (resync || memo.chain !== document) {
    await deps.applyChain(document)
    memo.chain = document
    changed.push(`rules(${rules.length} for ${pods.length} pods)`)
  }
  // Every pass: a deleted jump would not show up in the rendering.
  await deps.ensureJump()
  return changed
}

/**
 * Run netd until signalled. Passes run one at a time: watch events, the
 * 30s resync tick (which catches route changes, not watched, and external
 * edits to the nat table) and a failed pass's retry each mark the state
 * dirty, and the loop coalesces whatever arrived into the next pass.
 */
async function run(): Promise<void> {
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

  let dirty = true
  let resync = false
  let wake = (): void => { /* replaced while the loop waits */ }
  const request = (): void => { dirty = true; wake() }

  const client = inClusterClient(config.installNamespace)
  const pods = watchPods(client, request)
  const services = watchServices(client, request)
  const memo: ReconcileMemo = {}
  const deps: ReconcileDeps = {
    config,
    chain,
    pods,
    proxyIp: () => services().find((s) => s.name === 'yaac-proxy')?.clusterIp ?? null,
    routes: () => readIpRoutes(),
    trio: () => allocator.resolve(),
    confirmListeners: (expected) => waitForListeners({
      expected,
      dump: () => adminGet(ENVOY_ADMIN_PATH, CONFIG_DUMP_PATH),
      sleep,
      attempts: LISTENER_GATE_ATTEMPTS,
      pollMs: LISTENER_GATE_POLL_MS,
    }),
    applyChain: (doc) => applyRestore(backend, doc),
    ensureJump: () => ensurePreroutingJump(backend, chain),
    writeEnvoy: writeAtomic,
  }

  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.on(sig, () => {
      log('[netd] shutting down — removing redirect rules')
      void teardownChain(backend, chain, defaultRunner).finally(() => process.exit(0))
    })
  }
  setInterval(() => { resync = true; request() }, RESYNC_INTERVAL_MS)

  for (;;) {
    if (!dirty) await new Promise<void>((resolve) => { wake = resolve })
    await sleep(DEBOUNCE_MS)
    dirty = false
    const resyncPass = resync
    resync = false
    try {
      const changed = await reconcileOnce(deps, memo, resyncPass)
      if (changed.length > 0) log(`[netd] applied ${changed.join(' ')}`)
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
      // Retry sooner than the resync tick: a failed pass means no egress.
      dirty = true
      await sleep(RETRY_DELAY_MS)
    }
  }
}

// Run only when executed directly, not when imported by tests.
if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  run().catch((err: unknown) => {
    console.error(`[netd] fatal: ${String(err)}`)
    process.exit(1)
  })
}
