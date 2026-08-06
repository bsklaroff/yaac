import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline/promises'
import { spawn } from 'node:child_process'
import { parse as parseToml } from 'smol-toml'
import { ensurePriorityClasses, execFileAsync, k8sNamespace } from '#platform/k8s'
import { ensureLocalRegistry, registryHost, REGISTRY_CONTAINER_NAME } from '#platform/container'
import { ensureRegistryClusterService } from './registry-service'
import { GVISOR_INSTALLER_APP_NAME, ensureGvisorRuntime } from './gvisor-installer'
import { ensureNetd } from './netd'
import { ensureBuilderRoleGuard } from './proxy-apply'
import { resetClusterCidrCache } from './cluster-cidrs'
import {
  formatCheckResult,
  NODE_INOTIFY_MAX_USER_INSTANCES,
  NODE_INOTIFY_MAX_USER_WATCHES,
  NODE_KUBELET_FLAGS_ENV,
  NODE_KUBELET_HOUSEKEEPING_INTERVAL,
  NODE_MIN_FREE_KBYTES,
  NODE_PIDS_LIMIT,
  NODE_TASKSMAX_CONF,
  runClusterCheck,
} from './check'
import type { CheckResult } from '@yaac/shared/types'
import { ensureRootfulPodmanHost, ROOTFUL_PODMAN_SOCKET } from '#platform/container'
import { PACKAGE_ROOT } from '@yaac/shared/paths'
import { CALICO_DIR, calicoManifestCachePath } from '@yaac/shared/project-paths'
import { env } from '@yaac/shared/env'

/**
 * `yaac cluster setup` — the port of the retired scripts/setup-kind-cluster.sh
 * plus the macOS podman-machine bootstrap the README used to describe by
 * hand. Brew (or any package manager) can only install binaries; everything
 * per-user and stateful — the rootful libkrun machine, the registry
 * container, the kind cluster, Calico, the node fixups — happens here,
 * idempotently and with actionable error messages.
 *
 * Full mode recreates the cluster from scratch (delete + create), with
 * `--nodes N` choosing the topology: one control-plane node by default,
 * plus N-1 workers when asked for. Every per-node step below (fixups,
 * hosts.toml, the runsc install) already runs over the enumerated node
 * set, so multi-node is a config-rendering change here. `--repair`
 * re-applies only the node fixups that vanish on a node/VM restart
 * (DefaultTasksMax, vm sysctls, pids-limit, registry wiring) without
 * touching the cluster itself. Both modes also converge the in-cluster
 * layers an upgrade can change — the gVisor runtime (installer DaemonSet +
 * RuntimeClasses), the PriorityClasses, netd — which is how an existing
 * cluster picks them up on a yaac upgrade.
 *
 * The gVisor install is NOT a node fixup any more: a DaemonSet reinstalls
 * it on every node that appears, so a restarted (or replaced) node repairs
 * itself with nothing to run. What `--repair` still owns is the state that
 * lives in the kind node CONTAINER — sysctls, TasksMax, the pids limit, the
 * registry wiring — which has no node-side agent to re-apply it.
 */

/**
 * Calico version installed as the CNI + policy engine.
 *
 * The manifest itself is not vendored — it is 350 KB of upstream YAML, and
 * carrying it in the repo (and in the npm artifact) buys nothing that the
 * pin does not: k8s/calico/ holds the SHA-256 of the release manifest, and
 * setup fetches the bytes on demand and refuses anything that does not
 * match. A version bump is then a two-line change (this const + the
 * checksum), and the install is exactly as reproducible as a vendored copy.
 */
export const CALICO_VERSION = '3.32.1'

/** Committed integrity pin for the fetched manifest (bare hex sha256). */
const CALICO_SHA256_FILE = path.join(CALICO_DIR, 'calico.yaml.sha256')

/**
 * Upstream release manifest for a Calico version — the classic
 * KDD/iptables install, at the tag rather than a moving branch.
 */
export function calicoManifestUrl(version: string = CALICO_VERSION): string {
  return `https://raw.githubusercontent.com/projectcalico/calico/v${version}/manifests/calico.yaml`
}

function sha256Hex(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * The pinned Calico manifest, from the per-version cache when it is there
 * and verified, else downloaded once and cached.
 *
 * The checksum is the whole trust story: the cache is inside the data dir
 * (writable, long-lived) and the download crosses the network, so both are
 * verified against the committed hash on every use and a mismatch is fatal
 * rather than "install it anyway". Fetching costs nothing in practice —
 * setup already reaches the network for Calico's ~235 MB of images, the
 * kind node image and the gVisor release — and the cache means a cluster
 * recreate does not refetch.
 */
export async function ensureCalicoManifest(deps: ClusterSetupDeps): Promise<string> {
  const pin = await deps.readTextFile(CALICO_SHA256_FILE)
  const expected = pin?.trim().split(/\s+/)[0]
  if (!expected) {
    throw new ClusterSetupError(
      `Calico manifest checksum not found at ${CALICO_SHA256_FILE} — broken install?`,
    )
  }
  const cache = calicoManifestCachePath(CALICO_VERSION)
  const cached = await deps.readTextFile(cache)
  if (cached !== null && sha256Hex(cached) === expected) return cached

  const url = calicoManifestUrl()
  deps.log(`Fetching Calico ${CALICO_VERSION} manifest (one-time — cached at ${cache})...`)
  let raw: string
  try {
    raw = await deps.fetchText(url)
  } catch (err) {
    throw new ClusterSetupError(
      `Could not download the Calico manifest from ${url} `
      + `(${err instanceof Error ? err.message.split('\n')[0] : String(err)}). `
      + `Check network access, or drop a verified copy at ${cache} and re-run.`,
    )
  }
  const actual = sha256Hex(raw)
  if (actual !== expected) {
    throw new ClusterSetupError(
      `The Calico manifest at ${url} does not match the pinned checksum `
      + `(expected ${expected}, got ${actual}) — not installing it.`,
    )
  }
  await deps.writeTextFile(cache, raw)
  return raw
}

/** A setup step failed in a way the user must resolve; message is the fix. */
export class ClusterSetupError extends Error {}

export interface ClusterSetupOptions {
  /** Re-apply node fixups on the existing cluster instead of recreating it. */
  repair?: boolean
  /**
   * kind nodes to create: one control-plane plus `nodes - 1` workers.
   * Undefined (the default) means one node. Create-time only — the node
   * count of an existing cluster is not something `--repair` can change.
   *
   * A string is accepted so the CLI can hand the raw `--nodes` text
   * through: converting first would turn `--nodes three` into `NaN` and the
   * error could no longer quote what was actually typed.
   */
  nodes?: number | string
}

/**
 * Node-count ceiling for `--nodes`. Every kind node is a full node
 * container (kubelet, containerd, calico-node, netd, a runsc install) on
 * ONE host, so this is a rehearsal knob, not a capacity knob: 2–3 is what
 * shakes out scheduling assumptions, and anything past this is a way to
 * wedge a laptop rather than a supported topology.
 */
export const MAX_KIND_NODES = 5

export interface ClusterSetupDeps {
  /** execFile-style runner, injectable for tests. */
  run: typeof execFileAsync
  /**
   * Runner for long, chatty subprocesses (kind create, calico apply,
   * podman machine init): inherits stdout/stderr so the user sees live
   * progress, optionally piping `input` to stdin.
   */
  runStreaming: (
    file: string,
    args: string[],
    opts?: { env?: NodeJS.ProcessEnv; input?: string },
  ) => Promise<void>
  log: (message: string) => void
  /** Interactive yes/no gate for destructive steps; false when not a TTY. */
  confirm: (question: string) => Promise<boolean>
  ensureRegistry: () => Promise<void>
  /** Writes the in-cluster registry Service + EndpointSlice for builder
   *  pods plus the builder-role admission guard; injectable so unit tests
   *  never touch podman or the cluster. */
  exposeRegistry: () => Promise<string>
  /** Builds/pushes the netd + Envoy images and applies the DaemonSet.
   *  Injectable for the same reason as exposeRegistry. */
  ensureNetd: () => Promise<void>
  /** Applies the gVisor installer DaemonSet + the RuntimeClasses.
   *  Injectable for the same reason as the two above. */
  ensureGvisorRuntime: () => Promise<void>
  /** Installs the infra/session PriorityClasses. Injectable for the same
   *  reason as the two above. */
  ensurePriorityClasses: () => Promise<void>
  check: () => Promise<{ ok: boolean; results: CheckResult[] }>
  platform: NodeJS.Platform
  homedir: () => string
  totalmem: () => number
  cpuCount: () => number
  readTextFile: (p: string) => Promise<string | null>
  writeTextFile: (p: string, content: string) => Promise<void>
  /** HTTP GET of a text asset (the Calico manifest), injectable for tests. */
  fetchText: (url: string) => Promise<string>
  fileExists: (p: string) => Promise<boolean>
  listDir: (p: string) => Promise<string[]>
}

function runStreamingDefault(
  file: string,
  args: string[],
  opts: { env?: NodeJS.ProcessEnv; input?: string } = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      env: opts.env,
      stdio: [opts.input !== undefined ? 'pipe' : 'ignore', 'inherit', 'inherit'],
    })
    if (opts.input !== undefined) {
      // Same reason as execFileWithInput in platform/k8s/kubectl.ts: an
      // unhandled stdin 'error' (EPIPE, when the child is gone before it
      // reads) is an uncaught exception, and the close/error handlers below
      // already reject with something a caller can act on.
      child.stdin?.on('error', () => { /* reported via the handlers below */ })
      child.stdin?.end(opts.input)
    }
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${file} ${args.join(' ')} exited with code ${code}`))
    })
  })
}

export async function confirmDefault(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase()
    return answer === 'y' || answer === 'yes'
  } finally {
    rl.close()
  }
}

/**
 * The host/TTY wiring every setup runs on unless the caller substitutes its
 * own. Built on call, not at module scope: this module is reachable from the
 * feature barrel, and a module-scope object would make merely importing the
 * barrel bind podman, the registry, and the check suite.
 */
function defaultDeps(): ClusterSetupDeps {
  return {
    run: execFileAsync,
    runStreaming: runStreamingDefault,
    log: (m) => { console.log(m) },
    confirm: confirmDefault,
    ensureRegistry: ensureLocalRegistry,
    exposeRegistry: async () => {
      const host = await ensureRegistryClusterService()
      await ensureBuilderRoleGuard()
      return host
    },
    ensureNetd,
    ensureGvisorRuntime: () => ensureGvisorRuntime(),
    ensurePriorityClasses,
    check: () => runClusterCheck(),
    platform: process.platform,
    homedir: () => os.homedir(),
    totalmem: () => os.totalmem(),
    cpuCount: () => os.cpus().length,
    readTextFile: (p) => fs.readFile(p, 'utf8').catch(() => null),
    writeTextFile: async (p, content) => {
      await fs.mkdir(path.dirname(p), { recursive: true })
      await fs.writeFile(p, content)
    },
    fileExists: (p) => fs.access(p).then(() => true).catch(() => false),
    listDir: (p) => fs.readdir(p).catch(() => [] as string[]),
    fetchText: async (url) => {
      // Node's fetch rather than curl: this runs on the host (unlike the
      // gVisor fetch, which happens inside the node), and setup should not
      // grow a host binary dependency for one GET.
      const res = await fetch(url, { signal: AbortSignal.timeout(120_000) })
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`)
      return res.text()
    },
  }
}

/**
 * Environment for every `kind` invocation: yaac runs kind's nodes under
 * podman (KIND_EXPERIMENTAL_PROVIDER is kind's own knob for that) so the
 * nodes and the registry share one engine, one network, one lifecycle.
 */
export function kindEnv(): NodeJS.ProcessEnv {
  // eslint-disable-next-line no-process-env -- forward the full host env to the kind subprocess, adding its provider knob
  return { ...process.env, KIND_EXPERIMENTAL_PROVIDER: 'podman' }
}

/**
 * Run the full setup (or a `--repair` fixup pass) and finish with a cluster
 * check. Returns the check's overall verdict; throws ClusterSetupError with
 * a user-actionable message when a step cannot proceed.
 */
export async function runClusterSetup(
  opts: ClusterSetupOptions = {},
  deps: ClusterSetupDeps = defaultDeps(),
): Promise<boolean> {
  if (env.nested) {
    throw new ClusterSetupError(
      'yaac cluster setup cannot run inside a nested yaac session — the '
      + 'cluster is external infrastructure managed by the outer yaac.',
    )
  }

  const nodeCount = resolveNodeCount(opts)

  const cluster = env.kindCluster
  const versions = await requireBinaries(deps)

  if (deps.platform === 'darwin') await ensurePodmanMachineSetup(deps)
  else await ensureRootfulPodmanReachable(deps)

  await preflightKindProvider(deps, versions)

  if (opts.repair) {
    const nodes = await kindNodes(deps, cluster)
    if (nodes.length === 0) {
      throw new ClusterSetupError(
        `kind cluster "${cluster}" not found — run \`yaac cluster setup\` `
        + '(without --repair) to create it.',
      )
    }
    deps.log(`Re-applying node fixups on kind cluster "${cluster}"...`)
    // A repair pass is what you run after the node's address moved under it
    // (a podman machine restart is the usual cause), so anything this process
    // cached about "the node" is exactly what must not be reused below.
    resetClusterCidrCache()
    await deps.ensureRegistry()
    for (const node of nodes) await applyNodeFixups(deps, node)
    await installPriorityClasses(deps)
    await connectRegistryToKindNetwork(deps)
    await exposeRegistryInCluster(deps)
    await installGvisorRuntime(deps)
    await deployNetd(deps)
  } else {
    await deps.ensureRegistry()
    await recreateKindCluster(deps, cluster, nodeCount)
    // The node `/32`s and pod CIDRs of the cluster that just went away say
    // nothing about the one that replaced it. A process that outlives the
    // recreate would otherwise render every policy below for the dead
    // cluster — stale node addresses fail closed, and a stale pod-CIDR
    // list makes netd's leading RETURNs miss, DNAT'ing pod-to-pod as world.
    resetClusterCidrCache()
    await installCalico(deps, cluster)
    const nodes = await kindNodes(deps, cluster)
    for (const node of nodes) await applyNodeFixups(deps, node)
    await installPriorityClasses(deps)
    await connectRegistryToKindNetwork(deps)
    await exposeRegistryInCluster(deps)
    await installGvisorRuntime(deps)
    await deployNetd(deps)
  }

  deps.log('\nVerifying with cluster check...')
  const { ok, results } = await deps.check()
  for (const r of results) deps.log(formatCheckResult(r))
  deps.log(ok
    ? '\nCluster is ready for yaac sessions.'
    : '\nCluster is not ready — fix the failures above and re-run `yaac cluster setup`.')
  return ok
}

/**
 * Validate `--nodes` and return the node count to build. Runs before any
 * binary probe or podman call so a bad value costs nothing, and rejects
 * the combination that cannot mean anything: a node count is decided when
 * the cluster is created, so `--repair --nodes N` is a request `--repair`
 * has no way to honor (it fixes up the nodes that exist).
 */
function resolveNodeCount(opts: ClusterSetupOptions): number {
  if (opts.nodes === undefined) return 1
  const count = typeof opts.nodes === 'string' ? Number(opts.nodes) : opts.nodes
  if (!Number.isInteger(count) || count < 1 || count > MAX_KIND_NODES) {
    throw new ClusterSetupError(
      `--nodes must be an integer between 1 and ${MAX_KIND_NODES} (got `
      + `"${String(opts.nodes)}"). Every node is a full node container on this one `
      + 'host; 2–3 is the multi-node rehearsal topology.',
    )
  }
  if (opts.repair) {
    throw new ClusterSetupError(
      '--nodes cannot be combined with --repair: the node count is fixed when '
      + 'the cluster is created, and --repair fixes up the nodes that exist. '
      + `Recreate the cluster instead:\n  yaac cluster setup --nodes ${count}`,
    )
  }
  return count
}

/** The `nodes:` list, which the bundled config keeps last (see its header). */
const KIND_NODES_SECTION = /^nodes:\n([\s\S]+)$/m

/**
 * The kind config to feed `kind create cluster`: `$HOME` substituted (kind
 * expands no environment variables), and the node list grown to `nodes`
 * entries.
 *
 * Workers are COPIES of the bundled control-plane entry with the role
 * swapped, which is the whole trick behind the multi-node rehearsal: the
 * copy carries the `$HOME → $HOME` extraMount, and since every kind node
 * container shares this one host's filesystem, hostPath keeps resolving to
 * the same bytes on whichever node a session lands. Everything else in the
 * file is cluster-scoped (containerd registry patch, kubelet swap patch,
 * disableDefaultCNI), and kind applies those to every node itself.
 */
export function renderKindConfig(
  raw: string,
  opts: { homedir: string; nodes: number },
): string {
  const substituted = raw.replaceAll('$HOME', opts.homedir)
  if (opts.nodes <= 1) return substituted

  const template = KIND_NODES_SECTION.exec(substituted)?.[1]
  const entries = template?.match(/^- /gm) ?? []
  if (!template || entries.length !== 1 || !/^- role: control-plane$/m.test(template)) {
    throw new ClusterSetupError(
      'The bundled kind config no longer ends in a single control-plane node '
      + 'entry, so --nodes cannot render worker copies of it. Restore the '
      + '`nodes:` list as the last section of k8s/kind-config.yaml (one entry, '
      + '`- role: control-plane`, carrying the $HOME extraMount).',
    )
  }
  const worker = `${template.replace(/^- role: control-plane$/m, '- role: worker').trimEnd()}\n`
  return `${substituted.trimEnd()}\n${worker.repeat(opts.nodes - 1)}`
}

interface BinaryVersions {
  podman: string
  kind: string
}

/**
 * All three setup-time binaries up front, reported together so a fresh
 * machine gets one complete shopping list instead of failing serially.
 */
async function requireBinaries(deps: ClusterSetupDeps): Promise<BinaryVersions> {
  const missing: string[] = []
  let podman = ''
  let kind = ''
  try {
    podman = (await deps.run('podman', ['--version'])).stdout.trim()
  } catch {
    missing.push('podman — yaac builds session images with it and hosts the kind node on it.\n'
      + '  Install: brew install podman (macOS) / sudo apt install podman (Debian/Ubuntu)')
  }
  try {
    kind = (await deps.run('kind', ['version'])).stdout.trim()
  } catch {
    missing.push('kind — creates the local kubernetes cluster.\n'
      + '  Install: brew install bsklaroff/yaac/yaac-kind\n'
      + '  (with podman 6.x, plain kind <= v0.32.0 is broken — see kind#4201)')
  }
  try {
    await deps.run('kubectl', ['version', '--client', '--output', 'json'])
  } catch {
    missing.push('kubectl — all cluster access goes through it.\n'
      + '  Install: https://kubernetes.io/docs/tasks/tools/')
  }
  if (missing.length > 0) {
    throw new ClusterSetupError(`Missing required tools:\n\n${missing.join('\n')}`)
  }
  return { podman, kind }
}

/**
 * The known kind/podman version skew: podman 6.0 changed the container
 * label format from a map to a slice, which breaks how kind <= v0.32.0
 * enumerates its node containers (`kind get clusters` exits 125 —
 * kind#4201, fixed by the unreleased kind#4203). Returns the fix message
 * when the pair is provably broken, null when it is fine or unknowable
 * (any v0.33 pre-release may or may not include the fix — the pinned
 * yaac-kind build itself reports `v0.33.0-alpha+<sha>` — so those are
 * left to the functional preflight).
 */
export function diagnoseKindPodmanSkew(podmanVersionOut: string, kindVersionOut: string): string | null {
  const podmanMajor = podmanMajorVersion(podmanVersionOut)
  const kindMatch = /v(\d+)\.(\d+)\.(\d+)(\S*)/.exec(kindVersionOut)
  if (!Number.isInteger(podmanMajor) || podmanMajor < 6 || !kindMatch) return null

  const [, majRaw, minRaw, , rest] = kindMatch
  const major = Number(majRaw)
  const minor = Number(minRaw)
  // Builds from kind main after the v0.32.0 tag report `v0.33.0-alpha`
  // (optionally with `.N+<commit>` stamped in); the version alone cannot
  // say whether they carry the fix, so leave them to the functional probe.
  if (rest.includes('+') || (minor === 33 && rest.startsWith('-alpha'))) return null
  const broken = major === 0 && minor <= 32
  if (!broken) return null

  return (
    `podman ${podmanMajor}.x cannot drive this kind build (${kindVersionOut.split('\n')[0]}): `
    + 'podman 6.0 changed the container label format, which breaks cluster '
    + 'enumeration in kind <= v0.32.0 (kind#4201; fixed by kind#4203, '
    + 'unreleased). Install the pinned build:\n'
    + '  brew install bsklaroff/yaac/yaac-kind\n'
    + 'or build kind from main:\n'
    + '  go install sigs.k8s.io/kind@main\n'
    + '(note `@latest` resolves to the broken v0.32.0 tag)'
  )
}

function podmanMajorVersion(podmanVersionOut: string): number {
  return Number(/(\d+)\.\d+/.exec(podmanVersionOut)?.[1] ?? Number.NaN)
}

/** True when the versions leave the kind#4201 skew possible but unprovable. */
function kindPodmanSkewPossible(podmanVersionOut: string, kindVersionOut: string): boolean {
  return podmanMajorVersion(podmanVersionOut) >= 6 && /v0\.33\.\d+-alpha/.test(kindVersionOut)
}

/**
 * The Linux counterpart to `ensurePodmanMachineSetup`: yaac runs kind on the
 * rootful podman engine (the calico-node DaemonSet needs the host netfilter
 * and routing access rootless podman does not delegate — see
 * docs/cluster-setup.md#linux-rootful-podman). `ensureRootfulPodmanHost` points
 * our env at the rootful socket; here we verify it actually answers, so `kind
 * create` fails with an actionable message instead of a bare connection error.
 * Unlike macOS, yaac can't provision the socket (it's root-owned and
 * systemd-activated), so this only checks and instructs.
 */
async function ensureRootfulPodmanReachable(deps: ClusterSetupDeps): Promise<void> {
  ensureRootfulPodmanHost()
  try {
    await deps.run('podman', ['info', '--format', 'json'])
  } catch {
    throw new ClusterSetupError(
      'Rootful podman is not reachable. yaac runs kind on the rootful podman '
      + 'engine on Linux (the calico-node DaemonSet needs the host netfilter '
      + 'and routing access that rootless podman does not delegate). Enable the '
      + 'socket and grant your user access:\n'
      + '  sudo systemctl enable --now podman.socket\n'
      + '  sudo setfacl -m u:$USER:x /run/podman\n'
      + `  sudo setfacl -m u:$USER:rw ${ROOTFUL_PODMAN_SOCKET}`,
    )
  }
}

/**
 * Functional preflight for the kind/podman pair: `kind get clusters` is
 * exactly the call the skew breaks (exit 125), and on a healthy pair it is
 * a harmless read. Diagnose the known skew explicitly instead of letting
 * cluster creation die with a bare exit code.
 */
async function preflightKindProvider(deps: ClusterSetupDeps, versions: BinaryVersions): Promise<void> {
  const skew = diagnoseKindPodmanSkew(versions.podman, versions.kind)
  if (skew) throw new ClusterSetupError(skew)
  try {
    await deps.run('kind', ['get', 'clusters'], { env: kindEnv() })
  } catch (err) {
    const stderr = ((err as { stderr?: string })?.stderr ?? '').trim()
      || (err instanceof Error ? err.message : String(err))
    throw new ClusterSetupError(
      `\`kind get clusters\` failed under the podman provider:\n  ${stderr.split('\n')[0]}\n`
      + 'Check that podman is running (`podman info`).'
      + (kindPodmanSkewPossible(versions.podman, versions.kind)
        ? '\n\nIf podman itself is healthy: this kind pre-release build may '
          + 'predate the kind#4203 fix for podman 6.x label parsing '
          + '(kind#4201). Install the pinned build, which is stamped past '
          + 'the fix:\n  brew install bsklaroff/yaac/yaac-kind'
        : ''),
    )
  }
}

/** Node names of the kind cluster; [] when the cluster does not exist. */
async function kindNodes(deps: ClusterSetupDeps, cluster: string): Promise<string[]> {
  try {
    const { stdout } = await deps.run('kind', ['get', 'nodes', '--name', cluster], { env: kindEnv() })
    return stdout.trim().split('\n').map((l) => l.trim()).filter(Boolean)
  } catch {
    return []
  }
}

/**
 * Delete + recreate the kind cluster from the bundled k8s/kind-config.yaml,
 * rendered for the requested node count (see renderKindConfig). No --wait:
 * the config disables the default CNI, so nodes cannot go Ready until
 * Calico is installed.
 */
async function recreateKindCluster(
  deps: ClusterSetupDeps,
  cluster: string,
  nodes: number,
): Promise<void> {
  const configPath = path.join(PACKAGE_ROOT, 'k8s', 'kind-config.yaml')
  const raw = await deps.readTextFile(configPath)
  if (raw === null) {
    throw new ClusterSetupError(`Bundled kind config not found at ${configPath} — broken install?`)
  }
  const config = renderKindConfig(raw, { homedir: deps.homedir(), nodes })

  const topology = nodes === 1
    ? 'single node'
    : `${nodes} nodes: 1 control-plane + ${nodes - 1} worker${nodes > 2 ? 's' : ''}`
  deps.log(
    `Recreating kind cluster "${cluster}" (${topology}; this deletes any `
    + `existing "${cluster}" cluster)...`,
  )
  await deps.run('kind', ['delete', 'cluster', '--name', cluster], { env: kindEnv() })
    .catch(() => { /* no existing cluster */ })
  try {
    await deps.runStreaming('kind', ['create', 'cluster', '--name', cluster, '--config', '-'], {
      env: kindEnv(),
      input: config,
    })
  } catch (err) {
    throw new ClusterSetupError(
      `kind could not create the cluster (${err instanceof Error ? err.message : String(err)}).\n`
      + 'On macOS the machine must be rootful (`podman machine set --rootful`) — '
      + 'setup normally ensures this; check `podman machine inspect`.',
    )
  }
}

/**
 * Install Calico (pinned by checksum) as the CNI and policy engine. kindnet's
 * NetworkPolicy engine fails OPEN — a new pod's first packets flow before
 * its IP reaches the engine's nftables set — and session egress lockdown
 * needs fail CLOSED. Calico's Felix gives that off the shelf: until it has
 * programmed a workload's endpoint, traffic on that veth falls through the
 * dispatch chain's "Unknown interface" DROP.
 *
 * Applied straight from the release manifest (no CLI to install, no chart
 * to template): it is the classic KDD/iptables manifest, deliberately not
 * the Tigera operator — yaac needs no operator-managed lifecycle, and the
 * plain manifest keeps the installed object set auditable. Policy is
 * enforced from plain `networking.k8s.io/v1` NetworkPolicy only; yaac
 * installs no Calico CRs, which is what keeps the managed-cloud ports
 * cheap (their provider-managed Calicos do not support Calico CRDs).
 */
async function installCalico(deps: ClusterSetupDeps, cluster: string): Promise<void> {
  const raw = await ensureCalicoManifest(deps)
  await sideloadCalicoImages(deps, cluster, raw)
  const context = `kind-${cluster}`
  deps.log(`Installing Calico ${CALICO_VERSION} (CNI + NetworkPolicy)...`)
  try {
    await deps.runStreaming('kubectl', ['--context', context, 'apply', '-f', '-'], { input: raw })
    // The DaemonSet going Available is what makes the node Ready (the CNI
    // config only lands once calico-node has started), so wait on it first
    // and let the node wait be the cheap confirmation.
    await deps.run('kubectl', [
      '--context', context,
      'rollout', 'status', 'daemonset/calico-node', '-n', 'kube-system', '--timeout=300s',
    ], { timeout: 310_000 })
  } catch (err) {
    throw new ClusterSetupError(
      `Calico install did not complete (${err instanceof Error ? err.message : String(err)}). `
      + `Re-run \`yaac cluster setup\`, or inspect with \`kubectl --context ${context} -n kube-system get pods -l k8s-app=calico-node\`.`,
    )
  }
  await deps.run('kubectl', [
    '--context', context,
    'wait', '--for=condition=Ready', 'node', '--all', '--timeout=120s',
  ])
}

/**
 * Image references in the Calico manifest. Parsed rather than hard-coded
 * so a version bump stays a two-line change: repin, and the sideload
 * follows whatever the new manifest names.
 */
export function calicoImageRefs(manifestYaml: string): string[] {
  const refs = manifestYaml.match(/^\s*image:\s*(\S+)\s*$/gm) ?? []
  return [...new Set(refs.map((line) => line.replace(/^\s*image:\s*/, '').trim()))].sort()
}

/**
 * Put Calico's images on the node before applying the manifest.
 *
 * Without this, cluster setup spends over a minute waiting on the node to
 * pull ~235 MB from quay.io — and pays it again on every recreate, since
 * the node's image store dies with the node. calico-node's init
 * containers pull serially (cni, then node), so the waits compound.
 *
 * Pulling to the HOST engine instead makes that cost one-time: the host
 * store survives cluster recreation, so later setups only stream the
 * layers into the node, which is roughly ten times faster than fetching
 * them again. Every image is `imagePullPolicy: IfNotPresent`, so a
 * preloaded one is used as-is and no pull happens at all.
 *
 * Fails soft: on any error the manifest still applies and the node falls
 * back to pulling for itself — slower, but not broken.
 */
async function sideloadCalicoImages(
  deps: ClusterSetupDeps,
  cluster: string,
  manifestYaml: string,
): Promise<void> {
  const refs = calicoImageRefs(manifestYaml)
  if (refs.length === 0) return
  try {
    const missing: string[] = []
    for (const ref of refs) {
      try {
        await deps.run('podman', ['image', 'exists', ref])
      } catch {
        missing.push(ref)
      }
    }
    if (missing.length > 0) {
      deps.log(`Fetching Calico images (${missing.length}, one-time — cached for later setups)...`)
      for (const ref of missing) {
        await deps.run('podman', ['pull', ref], { timeout: 600_000 })
      }
    }
    // `kind load docker-image` is the obvious call and does not work
    // under the podman provider; saving an archive ourselves and loading
    // that does. The tar is large but short-lived.
    const archive = path.join(os.tmpdir(), `yaac-calico-${process.pid}.tar`)
    try {
      deps.log('Loading Calico images onto the node...')
      await deps.run('podman', ['save', '-o', archive, ...refs], { timeout: 300_000 })
      await deps.run('kind', ['load', 'image-archive', archive, '--name', cluster], {
        env: kindEnv(), timeout: 300_000,
      })
    } finally {
      await fs.rm(archive, { force: true }).catch(() => { /* best-effort */ })
    }
  } catch (err) {
    deps.log(
      'note: could not preload Calico images '
      + `(${err instanceof Error ? err.message.split('\n')[0] : String(err)}) — `
      + 'the node will pull them itself, which is slower.',
    )
  }
}

/**
 * The per-node fixups: containerd registry hosts.toml, DefaultTasksMax + VM
 * memory sysctls (subagent fan-out and virtiofs allocations die without
 * them), the kubelet housekeeping interval (see
 * NODE_KUBELET_HOUSEKEEPING_INTERVAL — default-interval cAdvisor stats
 * burned whole cores against gVisor sandboxes), and the node container's
 * own PID ceiling. Most of these live in node/VM state that resets on
 * restart — `yaac cluster setup --repair` re-applies them, and `yaac
 * cluster check` warns when they are missing.
 */
async function applyNodeFixups(deps: ClusterSetupDeps, node: string): Promise<void> {
  deps.log(`Applying node fixups to ${node}...`)
  const port = registryHost().split(':')[1] ?? '5001'
  const registryDir = `/etc/containerd/certs.d/localhost:${port}`
  await deps.run('podman', ['exec', node, 'sh', '-c',
    `mkdir -p '${registryDir}' && printf '[host."http://${REGISTRY_CONTAINER_NAME}:5000"]\\n' > '${registryDir}/hosts.toml'`,
  ])
  await deps.run('podman', ['exec', node, 'sh', '-c',
    'mkdir -p /etc/systemd/system.conf.d\n'
    + `printf '[Manager]\\nDefaultTasksMax=infinity\\n' > ${NODE_TASKSMAX_CONF}\n`
    + 'systemctl daemon-reexec\n'
    + `echo ${NODE_MIN_FREE_KBYTES} > /proc/sys/vm/min_free_kbytes\n`
    + 'echo 40 > /proc/sys/vm/compaction_proactiveness\n'
    // Host-global (see the constants' doc): every node container draws on
    // the one root-uid inotify pool, so a multi-node cluster starves
    // netd's Envoy at the stock ceiling. Writing it per node is
    // idempotent — each write sets the same host value.
    + `echo ${NODE_INOTIFY_MAX_USER_INSTANCES} > /proc/sys/fs/inotify/max_user_instances\n`
    + `echo ${NODE_INOTIFY_MAX_USER_WATCHES} > /proc/sys/fs/inotify/max_user_watches\n`,
  ])
  // kubelet housekeeping interval: prepend the flag to the kubeadm-written
  // flags env (idempotent — skipped when the exact flag is already there;
  // any stale different-value copy is stripped first) and restart kubelet
  // only when the file actually changed. The file lives in the node
  // container's filesystem, so unlike the sysctls above it survives node
  // restarts.
  const hkFlag = `--housekeeping-interval=${NODE_KUBELET_HOUSEKEEPING_INTERVAL}`
  await deps.run('podman', ['exec', node, 'sh', '-c',
    `if ! grep -q -- '${hkFlag}' ${NODE_KUBELET_FLAGS_ENV}; then `
    + `sed -i -e 's/ *--housekeeping-interval=[^ "]*//g' `
    + `-e 's/^KUBELET_KUBEADM_ARGS="/KUBELET_KUBEADM_ARGS="${hkFlag} /' ${NODE_KUBELET_FLAGS_ENV}`
    + ' && systemctl restart kubelet; fi',
  ])
  await deps.run('podman', ['update', '--pids-limit', String(NODE_PIDS_LIMIT), node])
}

/**
 * Put the registry container on the kind network so nodes reach it by
 * name. Fails soft (a log line): "already connected" is the common case on
 * re-runs, and a registry hosted by another engine cannot be connected at
 * all — recreate it under podman in that case.
 */
async function connectRegistryToKindNetwork(deps: ClusterSetupDeps): Promise<void> {
  try {
    await deps.run('podman', ['network', 'connect', 'kind', REGISTRY_CONTAINER_NAME])
  } catch (err) {
    const stderr = ((err as { stderr?: string })?.stderr ?? '').toLowerCase()
    if (!stderr.includes('already')) {
      deps.log(
        `note: could not connect ${REGISTRY_CONTAINER_NAME} to the kind network `
        + '— if the registry runs under another engine, recreate it under podman '
        + 'and re-run `yaac cluster setup --repair`.',
      )
    }
  }
}

/**
 * Write the in-cluster registry Service + EndpointSlice (used by builder
 * pods to pull parents / push products) and the builder-role admission
 * guard. Fails soft like the network connect above: the builder engine
 * re-ensures both lazily before every untrusted build and throws loudly
 * there.
 */
async function exposeRegistryInCluster(deps: ClusterSetupDeps): Promise<void> {
  try {
    const host = await deps.exposeRegistry()
    deps.log(`Registry exposed to builder pods as ${host}.`)
  } catch (err) {
    deps.log(
      'note: could not write the in-cluster registry Service '
      + `(${err instanceof Error ? err.message.split('\n')[0] : String(err)}) — `
      + 'trust-split image builds will retry this on first use.',
    )
  }
}

/**
 * Install the infra/session PriorityClasses. Runs in `--repair` too: like
 * the gVisor RuntimeClasses, these are cluster-scoped objects the manifest
 * builders name, so this is how a cluster created by an older yaac gets
 * them on upgrade (the server re-ensures them at boot as well).
 *
 * Deliberately NOT fail-soft: a pod naming a class the apiserver doesn't
 * have is rejected, and a Job whose pod is rejected hangs rather than
 * failing, so finishing setup without them would trade a clear error here
 * for a mystifying one at the next session create.
 */
async function installPriorityClasses(deps: ClusterSetupDeps): Promise<void> {
  deps.log('Installing the yaac PriorityClasses (infra > sessions)...')
  await deps.ensurePriorityClasses()
}

/**
 * Apply the gVisor installer DaemonSet and, once it has converged, the
 * RuntimeClasses — so a freshly-set-up cluster can run sandboxed pods
 * before any session exists, and so `check`'s gvisor gate has something to
 * verify. Runs in `--repair` too: it is how a cluster created by an older
 * yaac picks up a runsc version bump.
 *
 * Deliberately NOT fail-soft, unlike netd below. Nothing else installs the
 * runtime (there is no lazy re-ensure on the session-create path), and
 * every session pod names a RuntimeClass whose nodeSelector only matches an
 * installed node — so finishing setup with this broken would trade a clear
 * error here for every session sitting Pending later.
 */
async function installGvisorRuntime(deps: ClusterSetupDeps): Promise<void> {
  deps.log('Installing the gVisor runtime (installer DaemonSet + RuntimeClasses)...')
  try {
    await deps.ensureGvisorRuntime()
  } catch (err) {
    throw new ClusterSetupError(
      'Could not install the gVisor runtime '
      + `(${err instanceof Error ? err.message.split('\n')[0] : String(err)}).\n`
      + `Inspect the installer with: kubectl -n ${k8sNamespace()} logs -l app=${GVISOR_INSTALLER_APP_NAME}\n`
      + 'Session pods cannot run until it lands runsc on a node and labels it.',
    )
  }
}

/**
 * Build/push the netd + Envoy images and apply the DaemonSet, so a
 * freshly-set-up cluster can redirect session egress before any session
 * exists — and so `check`'s datapath gate has something to verify.
 *
 * Runs in `--repair` too: like the gVisor install, this is how an existing
 * cluster picks netd up on a yaac upgrade.
 *
 * Fails soft. The server re-ensures netd on every proxy bootstrap
 * (ensureProxyResources), so a transient registry or build hiccup here
 * self-heals on first session create rather than aborting the whole setup;
 * the cluster check that follows reports it either way.
 */
async function deployNetd(deps: ClusterSetupDeps): Promise<void> {
  deps.log('Deploying the netd egress redirect (DaemonSet)...')
  try {
    await deps.ensureNetd()
  } catch (err) {
    deps.log(
      'note: could not deploy yaac-netd '
      + `(${err instanceof Error ? err.message.split('\n')[0] : String(err)}) — `
      + 'the server retries this when it next brings up the proxy.',
    )
  }
}

// ---------------------------------------------------------------------------
// macOS podman-machine bootstrap
// ---------------------------------------------------------------------------

/**
 * Effective `[machine] provider` after applying containers.conf sources in
 * order (base file first, then conf.d drop-ins alphabetically — later
 * sources override). Unparseable sources are skipped, matching podman's
 * be-liberal reading enough for this one key.
 */
export function effectiveMachineProvider(sources: string[]): string | undefined {
  let provider: string | undefined
  for (const src of sources) {
    try {
      const parsed = parseToml(src) as { machine?: { provider?: unknown } }
      const p = parsed.machine?.provider
      if (typeof p === 'string') provider = p
    } catch { /* not valid TOML — ignore this source */ }
  }
  return provider
}

/**
 * True when `podman machine start` failed because the machine was
 * provisioned by an older podman (config-version gate): the fix is a
 * destructive rm + re-init, which the caller prompts for. Heuristic on
 * podman's wording, matched loosely across versions.
 */
export function isLegacyMachineError(stderr: string): boolean {
  return /older version|previous version|incompatible|machine reset|must be recreated|needs to be recreated/i
    .test(stderr)
}

/**
 * VM sizing for `podman machine init`. The README's canonical numbers are
 * 8 cpus / 32 GiB; scale down for smaller hosts (half the host RAM, capped
 * at the canonical values, floored at something sessions can survive on).
 */
export function defaultMachineResources(
  totalmemBytes: number,
  cpuCount: number,
): { cpus: number; memoryMib: number } {
  const halfMemMib = Math.floor(totalmemBytes / 2 / (1024 * 1024))
  return {
    cpus: Math.max(2, Math.min(8, cpuCount)),
    memoryMib: Math.max(4096, Math.min(32768, halfMemMib)),
  }
}

interface MachineListEntry {
  Name: string
  Running?: boolean
  Default?: boolean
  VMType?: string
}

async function listMachines(deps: ClusterSetupDeps): Promise<MachineListEntry[]> {
  const { stdout } = await deps.run('podman', ['machine', 'list', '--format', 'json'])
  const parsed = JSON.parse(stdout || '[]') as MachineListEntry[] | null
  return parsed ?? []
}

async function machineRootful(deps: ClusterSetupDeps, name: string): Promise<boolean> {
  const { stdout } = await deps.run('podman', ['machine', 'inspect', name])
  const parsed = JSON.parse(stdout) as Array<{ Rootful?: boolean }>
  return parsed[0]?.Rootful === true
}

function providerDropinPath(deps: ClusterSetupDeps): string {
  return path.join(
    deps.homedir(), '.config', 'containers', 'containers.conf.d',
    '99-yaac-machine-provider.conf',
  )
}

async function initMachine(deps: ClusterSetupDeps): Promise<void> {
  const { cpus, memoryMib } = defaultMachineResources(deps.totalmem(), deps.cpuCount())
  deps.log(`Initializing a rootful podman machine (libkrun, ${cpus} cpus, ${memoryMib} MiB)...`)
  try {
    await deps.runStreaming('podman', [
      'machine', 'init', '--rootful', '--cpus', String(cpus), '--memory', String(memoryMib),
    ])
  } catch (err) {
    throw new ClusterSetupError(
      `podman machine init failed (${err instanceof Error ? err.message : String(err)}).\n`
      + 'Is krunkit installed? brew install libkrun/krun/krunkit',
    )
  }
}

/**
 * Drive the macOS machine into the state yaac needs — the two non-default
 * settings the README used to describe by hand, plus migration traps from
 * pre-brew installs:
 *   - provider = libkrun (virtiofs that reports real file ownership, which
 *     gVisor session pods need: the runsc gofer does hostPath I/O as node
 *     root while the sentry enforces DAC on the ownership the gofer sees.
 *     applehv/vz virtiofs reports the accessing process as every file's
 *     owner — the root gofer sees root-owned files, so non-root session
 *     uids can never write hostPath mounts) — written as a
 *     containers.conf.d drop-in;
 *   - rootful (kind's podman provider requires it);
 *   - a machine provisioned under podman 5.x lacks the 6.0 machine image's
 *     guest wiring (vsock qemu-guest-agent for timesync) and trips podman's
 *     config-version gate on start → prompt for the destructive rm+re-init.
 */
export async function ensurePodmanMachineSetup(deps: ClusterSetupDeps): Promise<void> {
  // Provider: base containers.conf, then conf.d drop-ins (later wins).
  const confDir = path.join(deps.homedir(), '.config', 'containers')
  const sources: string[] = []
  const base = await deps.readTextFile(path.join(confDir, 'containers.conf'))
  if (base !== null) sources.push(base)
  const dropinDir = path.join(confDir, 'containers.conf.d')
  for (const f of (await deps.listDir(dropinDir)).filter((f) => f.endsWith('.conf')).sort()) {
    const content = await deps.readTextFile(path.join(dropinDir, f))
    if (content !== null) sources.push(content)
  }
  if (effectiveMachineProvider(sources) !== 'libkrun') {
    deps.log('Setting the podman machine provider to libkrun '
      + '(gVisor session pods need its ownership-preserving virtiofs)...')
    await deps.writeTextFile(
      providerDropinPath(deps),
      '# Written by `yaac cluster setup`: gVisor session pods need the VM\'s\n'
      + '# file sharing to report real file ownership — the runsc gofer does\n'
      + '# hostPath I/O as root while the sentry enforces permissions on the\n'
      + '# ownership the gofer sees. libkrun\'s virtiofs passes ownership\n'
      + '# through; applehv/vz virtiofs reports the accessing process as every\n'
      + '# file\'s owner, so the root gofer sees root-owned files and non-root\n'
      + '# session uids cannot write hostPath mounts.\n'
      + '[machine]\nprovider = "libkrun"\n',
    )
  }

  const machines = await listMachines(deps).catch(() => [] as MachineListEntry[])
  const machine = machines.find((m) => m.Default) ?? machines[0]

  if (machine && machine.VMType !== undefined && machine.VMType !== 'libkrun') {
    const replace = await deps.confirm(
      `Podman machine "${machine.Name}" uses the ${machine.VMType} provider; yaac `
      + 'needs libkrun. Remove and recreate it? (destroys the machine and its image store)',
    )
    if (!replace) {
      throw new ClusterSetupError(
        `Cannot proceed with a ${machine.VMType} podman machine. Recreate it under `
        + `libkrun when ready:\n  podman machine rm -f ${machine.Name}\n  yaac cluster setup`,
      )
    }
    await deps.run('podman', ['machine', 'rm', '-f', machine.Name])
    await initMachine(deps)
  } else if (!machine) {
    await initMachine(deps)
  } else if (!(await machineRootful(deps, machine.Name))) {
    deps.log(`Making podman machine "${machine.Name}" rootful (kind requires it)...`)
    if (machine.Running) await deps.run('podman', ['machine', 'stop', machine.Name])
    await deps.run('podman', ['machine', 'set', '--rootful', machine.Name])
  }

  await startMachine(deps)
}

async function startMachine(deps: ClusterSetupDeps): Promise<void> {
  const machines = await listMachines(deps).catch(() => [] as MachineListEntry[])
  const machine = machines.find((m) => m.Default) ?? machines[0]
  if (!machine || machine.Running) return

  deps.log('Starting the podman machine...')
  try {
    await deps.run('podman', ['machine', 'start'], { timeout: 300_000 })
  } catch (err) {
    const stderr = ((err as { stderr?: string })?.stderr ?? '')
      + (err instanceof Error ? err.message : '')
    if (!isLegacyMachineError(stderr)) {
      throw new ClusterSetupError(
        `podman machine start failed:\n  ${stderr.trim().split('\n')[0]}`,
      )
    }
    // Machine provisioned by an older podman: the 6.0 machine image ships
    // the timesync guest wiring, so recreation is required (not just nice).
    const recreate = await deps.confirm(
      `Podman machine "${machine.Name}" was created by an older podman and must be `
      + 'recreated. Remove and re-init it? (destroys the machine and its image store)',
    )
    if (!recreate) {
      throw new ClusterSetupError(
        'The podman machine must be recreated for this podman version. When ready:\n'
        + `  podman machine rm -f ${machine.Name}\n  yaac cluster setup`,
      )
    }
    await deps.run('podman', ['machine', 'rm', '-f', machine.Name])
    await initMachine(deps)
    await deps.run('podman', ['machine', 'start'], { timeout: 300_000 })
  }
}
