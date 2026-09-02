import {
  cniVethPrefix,
  ensureBuilderRoleGuard,
  ensureMainRegistry,
  ensureNetd,
  resetClusterCidrCache,
} from '#drivers/k8s/cluster'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline/promises'
import { spawn } from 'node:child_process'
import { parse as parseToml } from 'smol-toml'
import { ensurePriorityClasses, execFileAsync, k8sNamespace } from '#drivers/k8s/substrate'
import { registryHost } from '#drivers/k8s/container'
import { GVISOR_INSTALLER_APP_NAME, ensureGvisorRuntime } from './gvisor-installer'
import { buildBuiltinImages } from './builtin-images'
import { ClusterInstallError, MAX_KIND_NODES, resolveNodeCount } from './arg-guards'
import {
  assessCniAdoption,
  assessVethSource,
  gatherCniFacts,
  probeWorkloadVeths,
} from './cni-adopt'
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
import { ensureRootfulPodmanHost, ROOTFUL_PODMAN_SOCKET } from '#drivers/k8s/container'
import { SERVER_NODE_PORT } from '#drivers/k8s/substrate'
import { deployServerWorkload } from './server-deploy'
import { PACKAGE_ROOT } from '@yaac/shared/paths'
import { CALICO_DIR, calicoManifestCachePath } from '@yaac/shared/project-paths'
import { resolveServerPort } from '@yaac/shared/server-port'
import { env } from '@yaac/shared/env'
import { getGitUserConfig } from '@yaac/shared/git'

/**
 * `yaac cluster install` — ONE idempotent verb that converges this machine
 * and its cluster to the yaac version that is installed. Brew (or any
 * package manager) can only install binaries; everything per-user and
 * stateful — the rootful libkrun machine, the kind cluster, Calico, the
 * node fixups, every built-in image, the in-cluster layers — happens here,
 * with actionable error messages.
 *
 * It is safe to run at any time, and it is what an upgrade runs: `npm
 * update` then `yaac cluster install`. A cluster that already exists is
 * converged, never recreated, so teardown normally only happens through an
 * explicit `yaac cluster delete` — the one command whose job is to lose
 * running worktrees. The single exception is the macOS machine bootstrap
 * below, which cannot converge a machine on the wrong provider or from a
 * podman too old to start it: those are `podman machine rm -f`, and both
 * are gated behind an interactive confirm that defaults to No and refuses
 * outright when there is no TTY.
 *
 * `--nodes N` chooses the topology of a cluster this run CREATES: one
 * control-plane node by default, plus N-1 workers when asked for. Every
 * per-node step below (fixups, hosts.toml, the runsc install) already runs
 * over the enumerated node set, so multi-node is a config-rendering change
 * here. Against a cluster that already exists the flag is a no-op with a
 * note — the node count is fixed when the cluster is created.
 *
 * `--adopt-cni` is the one mode that does not assume yaac owns the
 * cluster: it skips both the kind create and the Calico install, verifies
 * the CNI the cluster already runs (cni-adopt.ts), and then applies the
 * same in-cluster layers every other run converges.
 *
 * Two kinds of state need re-applying on an existing cluster, and both are
 * unconditional here. The node fixups (sysctls, TasksMax, the pids limit)
 * live in the kind node CONTAINER and vanish on a node or VM restart, with
 * no node-side agent to restore them. The in-cluster layers — the gVisor
 * runtime, the PriorityClasses, netd, the images — change with the yaac
 * version, and re-applying them is how an existing cluster picks up an
 * upgrade. The gVisor install is NOT a node fixup: a DaemonSet reinstalls
 * it on every node that appears, so a replaced node repairs itself.
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
export async function ensureCalicoManifest(deps: ClusterInstallDeps): Promise<string> {
  const pin = await deps.readTextFile(CALICO_SHA256_FILE)
  const expected = pin?.trim().split(/\s+/)[0]
  if (!expected) {
    throw new ClusterInstallError(
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
    throw new ClusterInstallError(
      `Could not download the Calico manifest from ${url} `
      + `(${err instanceof Error ? err.message.split('\n')[0] : String(err)}). `
      + `Check network access, or drop a verified copy at ${cache} and re-run.`,
    )
  }
  const actual = sha256Hex(raw)
  if (actual !== expected) {
    throw new ClusterInstallError(
      `The Calico manifest at ${url} does not match the pinned checksum `
      + `(expected ${expected}, got ${actual}) — not installing it.`,
    )
  }
  await deps.writeTextFile(cache, raw)
  return raw
}

// Both live in arg-guards.ts (which costs nothing to import) so the CLI can
// reject a bad flag without loading this module. Re-exported here because
// this is where consumers of `runClusterInstall` expect to find them.
export { ClusterInstallError, MAX_KIND_NODES }

export interface ClusterInstallOptions {
  /**
   * Bring-your-own-CNI: install into the cluster the current kubeconfig
   * points at, adopting the Calico it already runs instead of creating a
   * cluster and installing one. Runs the verification gate in cni-adopt.ts
   * in place of `installCalico`, and refuses the configurations that would
   * otherwise fail silently.
   */
  adoptCni?: boolean
  /**
   * kind nodes to create: one control-plane plus `nodes - 1` workers.
   * Undefined (the default) means one node. Create-time only — an existing
   * cluster's node count is fixed, and install never recreates one.
   *
   * A string is accepted so the CLI can hand the raw `--nodes` text
   * through: converting first would turn `--nodes three` into `NaN` and the
   * error could no longer quote what was actually typed.
   */
  nodes?: number | string
}

export interface ClusterInstallDeps {
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
  /** Stands the in-cluster registry up (Deployment + Service + the node
   *  containerd hosts.toml) and returns its cluster host; injectable so
   *  unit tests never touch the cluster. */
  ensureRegistry: () => Promise<string>
  /** Applies the builder-role admission guard, which gates the sandboxed
   *  builder pods. Injectable for the same reason as ensureRegistry. */
  ensureBuilderGuard: () => Promise<void>
  /** Applies the netd DaemonSet (its images come from buildImages).
   *  Injectable for the same reason as ensureRegistry. */
  ensureNetd: () => Promise<void>
  /** Builds and pushes every yaac-shipped image, and mirrors the pinned
   *  upstreams. The one step that needs a container engine — everything
   *  else here is kubectl and kind. Injectable for the same reason as
   *  ensureRegistry. */
  buildImages: (log: (message: string) => void) => Promise<void>
  /** Applies the gVisor installer DaemonSet + the RuntimeClasses.
   *  Injectable for the same reason as the two above. */
  ensureGvisorRuntime: () => Promise<void>
  /** Installs the infra/worktree PriorityClasses. Injectable for the same
   *  reason as the two above. */
  ensurePriorityClasses: () => Promise<void>
  /** Builds, applies and publishes the server Deployment, returning the
   *  origin it is reachable at (docs/server-in-cluster.md). Injectable for
   *  the same reason as the steps above — it is the one that needs both a
   *  container engine and a rolled-out workload. */
  deployServer: typeof deployServerWorkload
  /** The host's global git identity, `null` when unconfigured. Injectable
   *  so unit tests are not judged by the machine's git config. */
  gitUser: () => Promise<{ name: string; email: string } | null>
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
      // Same reason as execFileWithInput in drivers/k8s/substrate/kubectl.ts: an
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
 * The host/TTY wiring every install runs on unless the caller substitutes
 * its own. Built on call, not at module scope: this module is reachable
 * from the feature barrel, and a module-scope object would make merely
 * importing the barrel bind podman, the registry, and the check suite.
 */
function defaultDeps(): ClusterInstallDeps {
  return {
    run: execFileAsync,
    runStreaming: runStreamingDefault,
    log: (m) => { console.log(m) },
    confirm: confirmDefault,
    ensureRegistry: async () => {
      // Forced: install exists to re-write wiring a node or VM restart may
      // have dropped, and a fresh run has just created the cluster under
      // it.
      await ensureMainRegistry({ force: true })
      return registryHost()
    },
    ensureBuilderGuard: ensureBuilderRoleGuard,
    ensureNetd,
    buildImages: (log) => buildBuiltinImages({ log }),
    ensureGvisorRuntime: () => ensureGvisorRuntime(),
    ensurePriorityClasses,
    deployServer: deployServerWorkload,
    gitUser: getGitUserConfig,
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
      // gVisor fetch, which happens inside the node), and install should
      // not grow a host binary dependency for one GET.
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
 * Converge the machine and the cluster, then finish with a cluster check.
 * Returns the check's overall verdict; throws ClusterInstallError with a
 * user-actionable message when a step cannot proceed.
 *
 * The three phases are the same every run: get a cluster (create one only
 * if there is none), re-apply the node state that a restart drops, and
 * converge the in-cluster layers plus the images they name. Only the first
 * differs between a fresh machine and an upgrade, which is why there is one
 * verb rather than a mode flag.
 *
 * The finishing check is load-bearing for adoption specifically: its
 * `egress` gate is the positive NetworkPolicy probe the CNI verification
 * deliberately does not try to infer, so a `false` return there means "the
 * adopted policy engine is not enforcing" and the CLI exits non-zero.
 */
export async function runClusterInstall(
  opts: ClusterInstallOptions = {},
  deps: ClusterInstallDeps = defaultDeps(),
): Promise<boolean> {

  const nodeCount = resolveNodeCount(opts)

  const cluster = env.kindCluster
  // Adopt mode creates no cluster, so kind is not part of its shopping
  // list — the target may be any cluster the kubeconfig points at.
  const versions = await requireBinaries(deps, { requireKind: !opts.adoptCni })

  if (deps.platform === 'darwin') await ensurePodmanMachineSetup(deps)
  else await ensureRootfulPodmanReachable(deps)

  if (!opts.adoptCni) await preflightKindProvider(deps, versions)

  if (opts.adoptCni) {
    // The gate runs FIRST, before anything is applied: an adoption that
    // cannot work must cost the user nothing but the diagnosis.
    await verifyAdoptedCni(deps)
    // Whatever this process cached about "the cluster" was learned from a
    // different one — adopt mode is normally the first thing a fresh
    // install runs against a cluster it has never seen.
    resetClusterCidrCache()
    // Node fixups are kind-node-container state (sysctls, TasksMax, pids
    // limit). An adopted cluster may still BE a kind cluster — that is the
    // cheapest way to rehearse this path — so apply them where the nodes
    // are podman containers and say so where they are not.
    const nodes = await kindNodes(deps, cluster)
    if (nodes.length > 0) for (const node of nodes) await applyNodeFixups(deps, node)
    else {
      deps.log(
        `note: no kind cluster "${cluster}" on this host, so the node fixups are `
        + 'skipped — they are kind-node-container state and do not apply to nodes yaac '
        + 'has no shell on.',
      )
    }
  } else if ((await kindNodes(deps, cluster)).length === 0) {
    await createKindCluster(deps, cluster, nodeCount)
    // The node `/32`s and pod CIDRs of whatever cluster this process last
    // looked at say nothing about the one just created. Rendering a policy
    // for the wrong one fails closed on node addresses, and a stale
    // pod-CIDR list makes netd's leading RETURNs miss, DNAT'ing pod-to-pod
    // as world.
    resetClusterCidrCache()
    await installCalico(deps, cluster)
    for (const node of await kindNodes(deps, cluster)) await applyNodeFixups(deps, node)
  } else {
    if (opts.nodes !== undefined) {
      deps.log(
        `note: kind cluster "${cluster}" already exists, so --nodes is ignored — a `
        + 'node count is fixed when the cluster is created. To change it: `yaac '
        + 'cluster delete`, then install again (this loses running worktrees).',
      )
    }
    deps.log(`Converging the existing kind cluster "${cluster}"...`)
    // Re-applied every run because they live in node/VM state a restart
    // drops (a podman machine restart is the usual cause) — which is also
    // why anything this process cached about "the node" must not be reused
    // below: the node's address may have moved under it.
    resetClusterCidrCache()
    for (const node of await kindNodes(deps, cluster)) await applyNodeFixups(deps, node)
  }

  await installPriorityClasses(deps)
  await installRegistry(deps)
  await installBuilderGuard(deps)
  // After the registry, which is where every image lands, and before the
  // two layers that name one: the gVisor installer pod and netd both pull
  // from it and neither builds anything itself.
  await buildImages(deps)
  await installGvisorRuntime(deps)
  await deployNetd(deps)
  // Last, and only under adoption, because it needs netd on a node: netd is
  // hostNetwork and ships iproute2, so it is the node's own view of the
  // routing table.
  if (opts.adoptCni) await verifyAdoptedVethSource(deps)
  // Last of the workload steps: the server depends on every layer above it
  // (its images come from the registry, its dials go through the proxy and
  // netd), and it is the one that starts DOING things with them.
  //
  // Not under adoption. The server is published through a kind
  // `extraPortMapping` written at cluster-create time, which a cluster yaac
  // did not create does not have — so the Deployment would come up, the
  // published origin would never answer, and install would fail after 60s
  // prescribing `yaac cluster delete` on someone else's cluster. What it
  // would leave behind is worse than the failure: a NodePort Service
  // publishing a credential-optional API on every address the nodes have,
  // walled only by an ingress policy whose pod-CIDR exclusion was
  // snapshotted at install time and goes stale as the cluster's IPAM grows.
  //
  // Which leaves adoption with NO server it can run, now that a host
  // process is the containerless driver by construction and not a k8s one
  // (docs/server-in-cluster.md). That is a real gap, not a nuance, so this
  // says the whole of it — including what `yaac server start` will do here
  // instead — rather than leaving the operator to find out by watching
  // their adopted cluster sit idle. Closing it is the bring-your-own-cluster
  // install mode (docs/plans/server-in-cluster.md, "Out of scope"), which is
  // where ingress and TLS for the server are designed.
  if (opts.adoptCni) {
    deps.log(
      'note: no server was deployed. `--adopt-cni` means yaac did not create '
      + 'this cluster, so it has no kind port mapping to publish a server '
      + 'through — and a server outside the cluster is the CONTAINERLESS '
      + 'driver, which runs worktrees as tmux sessions on this host rather '
      + 'than on the cluster you just installed into. So `yaac server start` '
      + 'here gives you a containerless install, not this cluster. Until the '
      + 'bring-your-own-cluster mode exists, what this command installed is '
      + 'the in-cluster layers and nothing that drives them.',
    )
  } else {
    await deployServer(deps)
  }

  deps.log('\nVerifying with cluster check...')
  const { ok, results } = await deps.check()
  for (const r of results) deps.log(formatCheckResult(r))
  if (ok) {
    // Under adoption the checks pass and the cluster still cannot run a
    // session, because nothing drives it (see the note above). Saying
    // "ready for yaac sessions" there would be the one lie this command
    // tells.
    deps.log(opts.adoptCni
      ? '\nThe in-cluster layers are installed and healthy. No yaac server '
        + 'runs against this cluster — see the note above.'
      : '\nCluster is ready for yaac sessions.')
    return true
  }
  deps.log('\nCluster is not ready — fix the failures above and re-run `yaac cluster install`.')
  // Every mode installs BEFORE it verifies, so a failed check leaves the
  // in-cluster layers in place and a usable-looking cluster behind. The
  // exit code is the only artifact of the failure, and nothing re-checks
  // between explicit `cluster check` runs — so say plainly what that
  // means rather than leaving it to be inferred from a red line.
  //
  // The `egress` gate is the one where it really bites: it is the positive
  // NetworkPolicy probe, and a cluster that fails it runs worktrees whose
  // egress lockdown is ADVISORY — they still work, and the proxy allowlist
  // silently covers only what the redirect steers (443/80/the sentinel).
  // That is a containment weakening with no symptom, which is exactly the
  // class of failure this whole gate exists to make loud.
  if (results.some((r) => r.name === 'egress' && r.status === 'fail')) {
    deps.log(
      '\nThe egress gate FAILED, and the install is already in place. Do not start '
      + 'sessions until a re-run passes: this cluster is not enforcing the session '
      + 'NetworkPolicy, so their egress lockdown is advisory and the proxy allowlist '
      + 'covers only the ports the redirect steers.',
    )
  }
  return false
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
 * the same bytes on whichever node a worktree lands. Everything else in the
 * file is cluster-scoped (containerd registry patch, kubelet swap patch,
 * disableDefaultCNI), and kind applies those to every node itself.
 */
export function renderKindConfig(
  raw: string,
  opts: { homedir: string; nodes: number; serverHostPort: number },
): string {
  const substituted = raw.replaceAll('$HOME', opts.homedir)
  // The server's published loopback endpoint. HOST-scoped, so it belongs to
  // exactly one node — the control-plane entry the bundled file holds — and
  // must not ride the worker copies below, where N nodes would race for one
  // host port and kind would refuse the cluster.
  const published = `${substituted.trimEnd()}\n`
    + '  extraPortMappings:\n'
    + `  - containerPort: ${String(SERVER_NODE_PORT)}\n`
    + `    hostPort: ${String(opts.serverHostPort)}\n`
    + '    listenAddress: "127.0.0.1"\n'
    + '    protocol: TCP\n'
  if (opts.nodes <= 1) return published

  const template = KIND_NODES_SECTION.exec(substituted)?.[1]
  const entries = template?.match(/^- /gm) ?? []
  if (!template || entries.length !== 1 || !/^- role: control-plane$/m.test(template)) {
    throw new ClusterInstallError(
      'The bundled kind config no longer ends in a single control-plane node '
      + 'entry, so --nodes cannot render worker copies of it. Restore the '
      + '`nodes:` list as the last section of k8s/kind-config.yaml (one entry, '
      + '`- role: control-plane`, carrying the $HOME extraMount).',
    )
  }
  const worker = `${template.replace(/^- role: control-plane$/m, '- role: worker').trimEnd()}\n`
  return `${published}${worker.repeat(opts.nodes - 1)}`
}

interface BinaryVersions {
  podman: string
  kind: string
}

/**
 * All the setup-time binaries up front, reported together so a fresh
 * machine gets one complete shopping list instead of failing serially.
 *
 * `requireKind` is false in adopt mode: nothing is created there, and the
 * adopted cluster need not be a kind one at all. podman stays required
 * either way — it is the image build engine.
 */
async function requireBinaries(
  deps: ClusterInstallDeps,
  opts: { requireKind: boolean } = { requireKind: true },
): Promise<BinaryVersions> {
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
    if (opts.requireKind) {
      missing.push('kind — creates the local kubernetes cluster.\n'
        + '  Install: brew install bsklaroff/yaac/yaac-kind\n'
        + '  (with podman 6.x, plain kind <= v0.32.0 is broken — see kind#4201)')
    }
  }
  try {
    await deps.run('kubectl', ['version', '--client', '--output', 'json'])
  } catch {
    missing.push('kubectl — all cluster access goes through it.\n'
      + '  Install: https://kubernetes.io/docs/tasks/tools/')
  }
  if (missing.length > 0) {
    throw new ClusterInstallError(`Missing required tools:\n\n${missing.join('\n')}`)
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
async function ensureRootfulPodmanReachable(deps: ClusterInstallDeps): Promise<void> {
  ensureRootfulPodmanHost()
  try {
    await deps.run('podman', ['info', '--format', 'json'])
  } catch {
    throw new ClusterInstallError(
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
async function preflightKindProvider(deps: ClusterInstallDeps, versions: BinaryVersions): Promise<void> {
  const skew = diagnoseKindPodmanSkew(versions.podman, versions.kind)
  if (skew) throw new ClusterInstallError(skew)
  try {
    await deps.run('kind', ['get', 'clusters'], { env: kindEnv() })
  } catch (err) {
    const stderr = ((err as { stderr?: string })?.stderr ?? '').trim()
      || (err instanceof Error ? err.message : String(err))
    throw new ClusterInstallError(
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
async function kindNodes(deps: ClusterInstallDeps, cluster: string): Promise<string[]> {
  try {
    const { stdout } = await deps.run('kind', ['get', 'nodes', '--name', cluster], { env: kindEnv() })
    return stdout.trim().split('\n').map((l) => l.trim()).filter(Boolean)
  } catch {
    return []
  }
}

/**
 * Create the kind cluster from the bundled k8s/kind-config.yaml, rendered
 * for the requested node count (see renderKindConfig). No --wait: the
 * config disables the default CNI, so nodes cannot go Ready until Calico
 * is installed.
 *
 * Only ever called when there is no cluster: install has no destructive
 * path, so nothing here deletes.
 */
async function createKindCluster(
  deps: ClusterInstallDeps,
  cluster: string,
  nodes: number,
): Promise<void> {
  const configPath = path.join(PACKAGE_ROOT, 'k8s', 'kind-config.yaml')
  const raw = await deps.readTextFile(configPath)
  if (raw === null) {
    throw new ClusterInstallError(`Bundled kind config not found at ${configPath} — broken install?`)
  }
  const config = renderKindConfig(raw, {
    homedir: deps.homedir(),
    nodes,
    // The host end of the server's NodePort, reserved here because kind
    // writes port mappings only when a cluster is CREATED — which is why an
    // older cluster cannot be converged into publishing one.
    serverHostPort: resolveServerPort(),
  })

  const topology = nodes === 1
    ? 'single node'
    : `${nodes} nodes: 1 control-plane + ${nodes - 1} worker${nodes > 2 ? 's' : ''}`
  deps.log(`Creating kind cluster "${cluster}" (${topology})...`)
  try {
    await deps.runStreaming('kind', ['create', 'cluster', '--name', cluster, '--config', '-'], {
      env: kindEnv(),
      input: config,
    })
  } catch (err) {
    throw new ClusterInstallError(
      `kind could not create the cluster (${err instanceof Error ? err.message : String(err)}).\n`
      + 'On macOS the machine must be rootful (`podman machine set --rootful`) — '
      + 'install normally ensures this; check `podman machine inspect`.',
    )
  }
}

/**
 * Install Calico (pinned by checksum) as the CNI and policy engine. kindnet's
 * NetworkPolicy engine fails OPEN — a new pod's first packets flow before
 * its IP reaches the engine's nftables set — and worktree egress lockdown
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
async function installCalico(deps: ClusterInstallDeps, cluster: string): Promise<void> {
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
    throw new ClusterInstallError(
      `Calico install did not complete (${err instanceof Error ? err.message : String(err)}). `
      + `Re-run \`yaac cluster install\`, or inspect with \`kubectl --context ${context} -n kube-system get pods -l k8s-app=calico-node\`.`,
    )
  }
  await deps.run('kubectl', [
    '--context', context,
    'wait', '--for=condition=Ready', 'node', '--all', '--timeout=120s',
  ])
}

/**
 * The bring-your-own-CNI gate: everything `installCalico` would otherwise
 * have guaranteed by construction, verified against the cluster instead.
 *
 * Refuses rather than warns, because every one of these fails SILENTLY.
 * Calico in its eBPF dataplane, a replaced kube-proxy, an empty pod-CIDR
 * exclusion set — none of them stops a worktree from starting; they show up
 * as "worktrees have no egress" or, worse, as a redirect chain that counts
 * packets and never fires. The full reasoning per check is in cni-adopt.ts.
 *
 * The NetworkPolicy half is deliberately not decided here: "Calico is
 * installed" does not mean policy is enforced (policy-only Calico over a
 * foreign IPAM is a supported topology and a misconfigured one looks
 * identical until a worktree escapes), so it is left to the `egress` gate of
 * the cluster check that finishes every setup — a positive probe from a
 * worktree-labeled pod, whose failure makes this command exit non-zero.
 */
async function verifyAdoptedCni(deps: ClusterInstallDeps): Promise<void> {
  deps.log('Verifying the CNI this cluster already runs (--adopt-cni)...')
  const facts = await gatherCniFacts(deps.run)
  const { refusals, warnings, notes } = assessCniAdoption(facts)
  for (const note of notes) deps.log(`  recorded: ${note}`)
  for (const warning of warnings) deps.log(`  ! ${warning}`)
  if (refusals.length > 0) {
    throw new ClusterInstallError(
      `Cannot adopt this cluster's CNI:\n\n${refusals.map((r) => `  - ${r}`).join('\n\n')}`,
    )
  }
  deps.log('  CNI accepted: Calico in the iptables dataplane, kube-proxy owning ClusterIP DNAT.')
}

/**
 * The other half of the gate, which needs a node: netd's pod → veth source
 * must actually exist for the configured prefix. `cali*` is correct only
 * where Calico does the IPAM — policy-only Calico over the AWS VPC CNI
 * gives `eni*` — and a prefix that matches nothing renders a redirect chain
 * with no per-pod rules in it, which is indistinguishable from a healthy
 * netd until a worktree tries to reach the internet.
 *
 * Fail-soft on an unreachable netd (the cluster check's datapath gate owns
 * that verdict), fail-hard on a node that has the routes but not under this
 * prefix — that is the misconfiguration this exists to catch.
 */
async function verifyAdoptedVethSource(deps: ClusterInstallDeps): Promise<void> {
  const prefix = cniVethPrefix()
  const { status, detail, fix } = assessVethSource(
    await probeWorkloadVeths(deps.run, prefix), prefix,
  )
  if (status === 'fail') {
    throw new ClusterInstallError(
      `Cannot adopt this cluster's CNI:\n\n  - ${detail}${fix ? `\n\n    ${fix}` : ''}`,
    )
  }
  if (status === 'warn') deps.log(`  ! ${detail}`)
  else deps.log(`  recorded: pod → veth source: ${detail}`)
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
 * Without this, the install spends over a minute waiting on the node to
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
  deps: ClusterInstallDeps,
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
 * The per-node fixups: DefaultTasksMax + VM memory sysctls (subagent
 * fan-out and virtiofs allocations die without them), the kubelet
 * housekeeping interval (see NODE_KUBELET_HOUSEKEEPING_INTERVAL —
 * default-interval cAdvisor stats burned whole cores against gVisor
 * sandboxes), and the node container's own PID ceiling. Most of these live
 * in node/VM state that resets on restart — `yaac cluster install`
 * re-applies them, and `yaac cluster check` warns when they are missing.
 *
 * No registry wiring here: both the main and the per-project registries are
 * in-cluster workloads whose containerd `hosts.toml` is written by one-shot
 * pods that hostPath-mount the node's `certs.d` directory, so nothing about
 * the image path assumes the node is a container on this host's engine.
 */
async function applyNodeFixups(deps: ClusterInstallDeps, node: string): Promise<void> {
  deps.log(`Applying node fixups to ${node}...`)
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
 * Stand the in-cluster registry up. Runs AFTER the cluster exists and the
 * PriorityClasses are installed, and before anything pushes an image — it is a Deployment now, not a host
 * container, and its pod names the infra class.
 *
 * Deliberately NOT fail-soft: the registry is the only image bus, so
 * without it no worktree image can be pushed, no node can pull one, and no
 * builder pod can fetch a parent. Finishing an install without it would trade a
 * clear error here for an opaque ImagePullBackOff at the first worktree
 * create.
 */
async function installRegistry(deps: ClusterInstallDeps): Promise<void> {
  deps.log('Deploying the in-cluster image registry...')
  const host = await deps.ensureRegistry()
  deps.log(`Registry serving as ${host}.`)
}

/**
 * Build and push every yaac-shipped image, and mirror the pinned upstreams
 * (builtin-images.ts). The only step that needs a container engine, and the
 * reason install still requires podman while the server no longer does.
 *
 * Deliberately NOT fail-soft, and deliberately BEFORE the layers that name
 * these images: nothing else builds them, so a run that skipped this would
 * leave a cluster whose first worktree create fails on a registry lookup —
 * pointing back at the command that just declined to do the work.
 */
async function buildImages(deps: ClusterInstallDeps): Promise<void> {
  await deps.buildImages(deps.log)
}

/**
 * Apply the builder-role admission guard, which reserves the
 * `yaac.role=builder` label the sandboxed builders carry. Fails soft: the
 * builder engine re-ensures it lazily before every untrusted build and
 * throws loudly there.
 */
async function installBuilderGuard(deps: ClusterInstallDeps): Promise<void> {
  try {
    await deps.ensureBuilderGuard()
  } catch (err) {
    deps.log(
      'note: could not apply the builder-role admission guard '
      + `(${err instanceof Error ? err.message.split('\n')[0] : String(err)}) — `
      + 'trust-split image builds will retry this on first use.',
    )
  }
}

/**
 * Install the infra/worktree PriorityClasses. Re-applied every run: like
 * the gVisor RuntimeClasses, these are cluster-scoped objects the manifest
 * builders name, so this is how a cluster created by an older yaac gets
 * them on upgrade (the server re-ensures them at boot as well).
 *
 * Deliberately NOT fail-soft: a pod naming a class the apiserver doesn't
 * have is rejected, and a Job whose pod is rejected hangs rather than
 * failing, so finishing an install without them would trade a clear error here
 * for a mystifying one at the next worktree create.
 */
async function installPriorityClasses(deps: ClusterInstallDeps): Promise<void> {
  deps.log('Installing the yaac PriorityClasses (infra > sessions)...')
  await deps.ensurePriorityClasses()
}

/**
 * Apply the gVisor installer DaemonSet and, once it has converged, the
 * RuntimeClasses — so a freshly-set-up cluster can run sandboxed pods
 * before any worktree exists, and so `check`'s gvisor gate has something to
 * verify. Re-applied every run: it is how a cluster created by an older
 * yaac picks up a runsc version bump.
 *
 * Deliberately NOT fail-soft, unlike netd below. Nothing else installs the
 * runtime (there is no lazy re-ensure on the worktree-create path), and
 * every worktree pod names a RuntimeClass whose nodeSelector only matches an
 * installed node — so finishing an install with this broken would trade a clear
 * error here for every worktree sitting Pending later.
 */
async function installGvisorRuntime(deps: ClusterInstallDeps): Promise<void> {
  deps.log('Installing the gVisor runtime (installer DaemonSet + RuntimeClasses)...')
  try {
    await deps.ensureGvisorRuntime()
  } catch (err) {
    throw new ClusterInstallError(
      'Could not install the gVisor runtime '
      + `(${err instanceof Error ? err.message.split('\n')[0] : String(err)}).\n`
      + `Inspect the installer with: kubectl -n ${k8sNamespace()} logs -l app=${GVISOR_INSTALLER_APP_NAME}\n`
      + 'Session pods cannot run until it lands runsc on a node and labels it.',
    )
  }
}

/**
 * Build/push the netd + Envoy images and apply the DaemonSet, so a
 * freshly-set-up cluster can redirect worktree egress before any worktree
 * exists — and so `check`'s datapath gate has something to verify.
 *
 * Re-applied every run: like the gVisor install, this is how an existing
 * cluster picks netd up on a yaac upgrade.
 *
 * Fails soft. The server re-ensures netd on every proxy bootstrap
 * (ensureProxyResources), so a transient registry or build hiccup here
 * self-heals on first worktree create rather than aborting the whole setup;
 * the cluster check that follows reports it either way.
 */
/**
 * Build, deploy and publish the server itself.
 *
 * Unlike the layers above it, a failure here is fatal: netd can be retried
 * by the server, but nothing retries the server. This is also where the
 * install stops being about a cluster and starts being about an install —
 * the step it delegates to records the driver this data dir now runs and
 * writes the `server.json` every client on this machine resolves through,
 * so `yaac worktree list` talks to the pod without being told to.
 */
async function deployServer(deps: ClusterInstallDeps): Promise<void> {
  const torHostAddr = env.useTor ? await hostAddrOnKindNetwork(deps) : undefined
  if (env.useTor && torHostAddr === undefined) {
    deps.log(
      "note: YAAC_USE_TOR is set but the host's address on the kind network could "
      + 'not be determined, so the server pod keeps the configured SOCKS URL. If '
      + 'that is a loopback address, Tor must be made to listen on the kind bridge '
      + "instead — a pod's loopback is its own.",
    )
  }
  // The pod cannot read a git config off the host, so the identity worktrees
  // created from the webapp commit under has to be resolved here and stated
  // in the Deployment. Missing is not fatal — every other install step, and
  // CLI-created worktrees (which send their own identity), work without it.
  const gitUser = await deps.gitUser() ?? undefined
  if (!gitUser) {
    deps.log(
      'note: no global git user.name / user.email on this machine, so the '
      + 'server pod gets no git identity and creating a worktree from the '
      + 'webapp will fail. Set them (`git config --global user.name ...`) and '
      + 're-run `yaac cluster install`.',
    )
  }
  const origin = await deps.deployServer({ torHostAddr, gitUser, log: deps.log })
  deps.log(`The yaac server is serving at ${origin}`)
}

/**
 * The host's address on the kind network — where a pod reaches a listener
 * bound on the host. `undefined` when it cannot be read, which is a
 * degraded Tor setup rather than a failed install.
 */
async function hostAddrOnKindNetwork(deps: ClusterInstallDeps): Promise<string | undefined> {
  try {
    const { stdout } = await deps.run('podman', [
      'network', 'inspect', 'kind', '--format', '{{range .Subnets}}{{.Gateway}}{{end}}',
    ])
    const addr = stdout.trim()
    return addr === '' ? undefined : addr
  } catch {
    return undefined
  }
}

async function deployNetd(deps: ClusterInstallDeps): Promise<void> {
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
 * at the canonical values, floored at something worktrees can survive on).
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

async function listMachines(deps: ClusterInstallDeps): Promise<MachineListEntry[]> {
  const { stdout } = await deps.run('podman', ['machine', 'list', '--format', 'json'])
  const parsed = JSON.parse(stdout || '[]') as MachineListEntry[] | null
  return parsed ?? []
}

async function machineRootful(deps: ClusterInstallDeps, name: string): Promise<boolean> {
  const { stdout } = await deps.run('podman', ['machine', 'inspect', name])
  const parsed = JSON.parse(stdout) as Array<{ Rootful?: boolean }>
  return parsed[0]?.Rootful === true
}

function providerDropinPath(deps: ClusterInstallDeps): string {
  return path.join(
    deps.homedir(), '.config', 'containers', 'containers.conf.d',
    '99-yaac-machine-provider.conf',
  )
}

async function initMachine(deps: ClusterInstallDeps): Promise<void> {
  const { cpus, memoryMib } = defaultMachineResources(deps.totalmem(), deps.cpuCount())
  deps.log(`Initializing a rootful podman machine (libkrun, ${cpus} cpus, ${memoryMib} MiB)...`)
  try {
    await deps.runStreaming('podman', [
      'machine', 'init', '--rootful', '--cpus', String(cpus), '--memory', String(memoryMib),
    ])
  } catch (err) {
    throw new ClusterInstallError(
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
 *     gVisor worktree pods need: the runsc gofer does hostPath I/O as node
 *     root while the sentry enforces DAC on the ownership the gofer sees.
 *     applehv/vz virtiofs reports the accessing process as every file's
 *     owner — the root gofer sees root-owned files, so non-root worktree
 *     uids can never write hostPath mounts) — written as a
 *     containers.conf.d drop-in;
 *   - rootful (kind's podman provider requires it);
 *   - a machine provisioned under podman 5.x lacks the 6.0 machine image's
 *     guest wiring (vsock qemu-guest-agent for timesync) and trips podman's
 *     config-version gate on start → prompt for the destructive rm+re-init.
 */
export async function ensurePodmanMachineSetup(deps: ClusterInstallDeps): Promise<void> {
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
      '# Written by `yaac cluster install`: gVisor session pods need the VM\'s\n'
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
      + 'needs libkrun. Remove and recreate it? (destroys the machine, and with '
      + 'it the image store, the kind cluster inside it, and any running worktrees)',
    )
    if (!replace) {
      throw new ClusterInstallError(
        `Cannot proceed with a ${machine.VMType} podman machine. Recreate it under `
        + `libkrun when ready:\n  podman machine rm -f ${machine.Name}\n  yaac cluster install`,
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

async function startMachine(deps: ClusterInstallDeps): Promise<void> {
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
      throw new ClusterInstallError(
        `podman machine start failed:\n  ${stderr.trim().split('\n')[0]}`,
      )
    }
    // Machine provisioned by an older podman: the 6.0 machine image ships
    // the timesync guest wiring, so recreation is required (not just nice).
    const recreate = await deps.confirm(
      `Podman machine "${machine.Name}" was created by an older podman and must be `
      + 'recreated. Remove and re-init it? (destroys the machine, and with it the '
      + 'image store, the kind cluster inside it, and any running worktrees)',
    )
    if (!recreate) {
      throw new ClusterInstallError(
        'The podman machine must be recreated for this podman version. When ready:\n'
        + `  podman machine rm -f ${machine.Name}\n  yaac cluster install`,
      )
    }
    await deps.run('podman', ['machine', 'rm', '-f', machine.Name])
    await initMachine(deps)
    await deps.run('podman', ['machine', 'start'], { timeout: 300_000 })
  }
}
