import {
  ensureBuilderRoleGuard,
  ensureMainRegistry,
  ensureNetd,
  ensureNpmCache,
  resetClusterCidrCache,
} from '#drivers/k8s/cluster'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline/promises'
import { spawn } from 'node:child_process'
import { isIPv4 } from 'node:net'
import { parse as parseToml } from 'smol-toml'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import {
  LABEL_INSTALL_ID,
  SERVER_APP_NAME,
  ensurePriorityClasses,
  execFileAsync,
  isAbsent,
  k8sErrorSummary,
  k8sNamespace,
  listObjects,
  nodeLocalNodePath,
  processIdentity,
  readObject,
} from '#drivers/k8s/substrate'
import { registryHost } from '#drivers/k8s/container'
import { GVISOR_INSTALLER_APP_NAME, ensureGvisorRuntime } from './gvisor-installer'
import { buildBuiltinImages } from './builtin-images'
import { ClusterInstallError, YAAC_CLUSTER_INSTALL, resolveNodeCount, tailnetServeHost } from './arg-guards'
import { assessCniAdoption, gatherCniFacts } from './cni-adopt'
import { ensurePinnedManifest } from './pinned-manifest'
import { readServerConfig, recordInstall, type InstallRecord } from '@yaac/shared/server-config'
import {
  hostNodeArchitecture,
  nodeArchitectureProblems,
  nodeOsProblems,
  type PlatformNode,
} from './byo-gates'
import { clusterRefusal, currentCluster, type CurrentCluster } from './cluster-identity'
import { isNfsFamily } from './storage'
import {
  NODE_KUBELET_FLAGS_ENV,
  NODE_KUBELET_HOUSEKEEPING_INTERVAL,
  NODE_PIDS_LIMIT,
} from './check'
import { ensureRootfulPodmanHost, ROOTFUL_PODMAN_SOCKET } from '#drivers/k8s/container'
import { SERVER_FRONT_PORT } from '#drivers/k8s/substrate'
import { BYO_INSTALL_IDENTITY, deployServerWorkload } from './server-deploy'
import { TAILNET_HOSTNAME, kindFronting, serveFronting, tailnetFronting } from './server-fronting'
import { ensureTailnetOperator, verifyTailnetOperator } from './tailscale-operator'
// The data dir identifies the install.
// eslint-disable-next-line @typescript-eslint/no-restricted-imports
import { PACKAGE_ROOT, getDataDir, nodeLocalRoot } from '@yaac/shared/paths'
import { CALICO_DIR } from '@yaac/shared/project-paths'
import { resolveServerPort } from '@yaac/shared/server-port'
import { env } from '@yaac/shared/env'

/**
 * `yaac cluster install`: one idempotent command that brings this machine
 * and its cluster up to the installed yaac version. It sets up the rootful
 * libkrun podman machine (macOS), the kind cluster, Calico, the kind node
 * fixups, every built-in image and the in-cluster layers.
 *
 * Safe to run at any time; an upgrade is `npm update` then this. An
 * existing cluster is updated in place, never recreated. The only
 * destructive step is recreating a macOS podman machine that has the wrong
 * provider or is too old, and that asks for confirmation (No without a TTY).
 *
 * `--nodes N` sets the node count of a cluster this run creates (one
 * control-plane plus N-1 workers). On an existing cluster it is ignored
 * with a note.
 *
 * `--byo` installs into the cluster the kubeconfig points at instead of
 * creating one. It installs no CNI, checks up front everything that would
 * otherwise fail silently (node pool, CNI, Tailscale operator, storage
 * classes, install identity), then applies the same in-cluster layers and
 * deploys the server behind the tailnet, without exec'ing into a node.
 *
 * Every run re-applies the kind node fixups (podman and kubelet settings
 * no in-cluster agent can set) and the in-cluster layers (gVisor runtime,
 * PriorityClasses, netd, images), which is how an existing cluster picks up
 * an upgrade. Node sysctls are applied by the gVisor installer DaemonSet
 * instead (substrate/node-tuning.ts).
 */

/**
 * Calico version installed as the CNI and policy engine. The manifest is
 * not vendored: k8s/calico/ holds its SHA-256, and install downloads it and
 * refuses a mismatch. A version bump changes this and the checksum.
 */
export const CALICO_VERSION = '3.32.1'

/** Upstream release manifest (the KDD/iptables install) for a version tag. */
export function calicoManifestUrl(version: string = CALICO_VERSION): string {
  return `https://raw.githubusercontent.com/projectcalico/calico/v${version}/manifests/calico.yaml`
}

export interface ClusterInstallOptions {
  /**
   * Bring your own cluster: install into the cluster the current kubeconfig
   * points at instead of creating one (docs/cluster-setup.md "Bring your own
   * cluster"). Implies the tailnet fronting.
   */
  byo?: boolean
  /** `--byo`: the NFS-family class the shared `yaac-global` claim uses. */
  rwxStorageClass?: string
  /** `--byo`: the class `yaac-server-local` uses; default: the cluster's default. */
  rwoStorageClass?: string
  /**
   * Serve tailnet users instead of only this machine. `true` publishes the
   * server through the Tailscale Kubernetes operator, which install sets up
   * on kind (tailscale-operator.ts); implied by `--byo`. A hostname
   * publishes a kind install through this machine's own `tailscale serve`
   * at that MagicDNS name instead.
   */
  tailnet?: boolean | string
  /**
   * With the tailnet fronting: the tailnet login that claims a `local`
   * install's projects and settings as it switches to `tailnet`
   * (docs/remote-hosting.md "Access modes").
   */
  owner?: string
  /**
   * kind nodes to create: one control-plane plus `nodes - 1` workers
   * (default one). Only applies when creating a cluster. A string is
   * accepted so the error can quote the raw `--nodes` text.
   */
  nodes?: number | string
}

export interface ClusterInstallDeps {
  /** execFile-style runner, injectable for tests. */
  run: typeof execFileAsync
  /**
   * Runner for long subprocesses (kind create, calico apply, podman machine
   * init) that shows their output live; optionally pipes `input` to stdin.
   */
  runStreaming: (
    file: string,
    args: string[],
    opts?: { env?: NodeJS.ProcessEnv; input?: string },
  ) => Promise<void>
  log: (message: string) => void
  /** Interactive yes/no gate for destructive steps; false when not a TTY. */
  confirm: (question: string) => Promise<boolean>
  platform: NodeJS.Platform
  homedir: () => string
  totalmem: () => number
  cpuCount: () => number
  readTextFile: (p: string) => Promise<string | null>
  writeTextFile: (p: string, content: string) => Promise<void>
  /** HTTP GET of a text asset (the Calico manifest), injectable for tests. */
  fetchText: (url: string) => Promise<string>
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
      // An unhandled EPIPE on stdin would crash the process; the handlers
      // below already report the failure (see execFileWithInput).
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

/** The real host processes and filesystem. */
function defaultDeps(): ClusterInstallDeps {
  return {
    run: execFileAsync,
    runStreaming: runStreamingDefault,
    log: (m) => { console.log(m) },
    confirm: confirmDefault,
    platform: process.platform,
    homedir: () => os.homedir(),
    totalmem: () => os.totalmem(),
    cpuCount: () => os.cpus().length,
    readTextFile: (p) => fs.readFile(p, 'utf8').catch(() => null),
    writeTextFile: async (p, content) => {
      await fs.mkdir(path.dirname(p), { recursive: true })
      await fs.writeFile(p, content)
    },
    listDir: (p) => fs.readdir(p).catch(() => [] as string[]),
    fetchText: async (url) => {
      const res = await fetch(url, { signal: AbortSignal.timeout(120_000) })
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`)
      return res.text()
    },
  }
}

/** Environment for every `kind` invocation: run kind's nodes on podman. */
export function kindEnv(): NodeJS.ProcessEnv {
  // eslint-disable-next-line no-process-env -- forward the full host env to the kind subprocess, adding its provider knob
  return { ...process.env, KIND_EXPERIMENTAL_PROVIDER: 'podman' }
}

/**
 * Set up the machine and cluster. Throws ClusterInstallError with an
 * actionable message when a step cannot proceed. The caller then runs
 * `runClusterCheck` for the verdict.
 *
 * Each run gets a cluster (creating one only if none exists), re-applies
 * node state a restart drops, and applies the in-cluster layers and their
 * images. For `--byo`, the check's `egress` probe is the only proof that
 * NetworkPolicy is enforced.
 */
export async function runClusterInstall(
  opts: ClusterInstallOptions = {},
  deps: ClusterInstallDeps = defaultDeps(),
): Promise<void> {

  const nodeCount = resolveNodeCount(opts)
  const recorded = await readServerConfig()
  refuseByoSwitch(recorded, opts)
  // Created by the first run and reused, so a run that failed halfway
  // recognizes the objects it made.
  const installId = recorded?.installId ?? crypto.randomUUID()

  const cluster = env.kindCluster
  // A byo install creates no cluster, so it does not need kind.
  const kindVersion = await requireBinaries(deps, { requireKind: !opts.byo })

  // Run the byo checks before changing anything on the cluster or host.
  const byoStorage = opts.byo ? await verifyByoCluster(deps, opts, installId) : undefined

  if (deps.platform === 'darwin') await ensurePodmanMachineSetup(deps)
  else await ensureRootfulPodmanReachable(deps)

  if (opts.byo) {
    // Drop cached facts about another cluster. No node fixups: those are
    // kind node-container settings.
    resetClusterCidrCache()
  } else {
    await preflightKindProvider(deps, kindVersion)
    if ((await kindNodes(deps, cluster)).length === 0) {
      await createKindCluster(deps, cluster, nodeCount)
      // Cached node and pod CIDRs belong to whatever cluster this process
      // saw before. Stale pod CIDRs would make netd treat pod-to-pod
      // traffic as internet egress.
      resetClusterCidrCache()
      await installCalico(deps, cluster)
      for (const node of await kindNodes(deps, cluster)) await applyKindNodeFixups(deps, node)
    } else {
      if (opts.nodes !== undefined) {
        deps.log(
          `note: kind cluster "${cluster}" already exists, so --nodes is ignored — a `
          + 'node count is fixed when the cluster is created. To change it: `yaac '
          + 'cluster delete`, then install again (this loses running workspaces).',
        )
      }
      deps.log(`Converging the existing kind cluster "${cluster}"...`)
      // A podman machine restart may have moved the node's address, so
      // drop cached CIDRs. Fixups are re-applied every run.
      resetClusterCidrCache()
      for (const node of await kindNodes(deps, cluster)) {
        await startStoppedKindNode(deps, node)
        await applyKindNodeFixups(deps, node)
      }
      await waitForApiServer(deps, cluster)
    }
    // Layers go to the kubeconfig's current context, so it must be this
    // machine's kind cluster.
    const current = await verifyKindContext(deps, cluster)
    await recordInstall({
      driver: 'k8s', installId, clusterUid: current.uid, kubeContext: current.context, byo: undefined,
    })
  }
  // Before any layer is applied.
  if (opts.tailnet === true && !opts.byo) await ensureTailnetOperator(deps)

  // A pod naming a missing PriorityClass is rejected and its Job hangs.
  deps.log('Installing the yaac PriorityClasses (infra > sessions)...')
  await ensurePriorityClasses()
  // Forced, to rewrite node wiring a restart or new cluster lacks.
  deps.log('Deploying the in-cluster image registry...')
  await ensureMainRegistry({ force: true })
  deps.log(`Registry serving as ${registryHost()}.`)
  // Reserves the `yaac.role=builder` label for sandboxed builder pods.
  await ensureBuilderRoleGuard()
  // After the registry (images are pushed there) and before the gVisor
  // installer and netd, which pull from it.
  await buildBuiltinImages({ log: deps.log })
  await installGvisorRuntime(deps)
  deps.log('Deploying the netd egress redirect (DaemonSet)...')
  await ensureNetd()
  await deployNpmCache(deps)
  // Last: the server depends on every layer above.
  await deployServer(deps, opts, installId, byoStorage)
}

interface KindNode {
  role?: string
  extraMounts?: Array<{ hostPath: string; containerPath: string }>
  [key: string]: unknown
}

/**
 * The config for `kind create cluster`: `$HOME` substituted (kind expands no
 * env vars), the node-local extraMount and server port mapping added, and
 * worker nodes appended.
 *
 * Each node gets two extraMounts. `$HOME → $HOME` lets the static PVs
 * behind the storage claims resolve on the node (docs/server-in-cluster.md
 * "Storage claims"). The second binds `<dataDir>/node-local` to
 * `/var/lib/yaac/node/<hash>`, so node-local data (pnpm and image stores,
 * working copies) lives on host disk and survives a cluster delete.
 *
 * Workers are copies of the control-plane entry with the role swapped, so
 * they carry the same mounts. All nodes share the host filesystem, so the
 * paths resolve to the same bytes on every node. The server's host port
 * mapping goes on the control plane only, since workers copying it would
 * compete for one host port.
 */
function renderKindConfig(
  raw: string,
  opts: {
    homedir: string
    nodes: number
    serverHostPort: number
    nodeLocalHostPath: string
    nodeLocalNodePath: string
  },
): string {
  const config = parseYaml(raw.replaceAll('$HOME', opts.homedir)) as { nodes?: KindNode[] }
  const [node, ...rest] = config.nodes ?? []
  if (!node || rest.length > 0 || node.role !== 'control-plane') {
    throw new ClusterInstallError(
      'The bundled kind config no longer holds a single control-plane node '
      + 'entry, so --nodes cannot render worker copies of it. Restore the '
      + '`nodes:` list of k8s/kind-config.yaml to one `- role: control-plane` '
      + 'entry carrying the $HOME extraMount.',
    )
  }
  const extraMounts = [
    ...(node.extraMounts ?? []),
    { hostPath: opts.nodeLocalHostPath, containerPath: opts.nodeLocalNodePath },
  ]
  config.nodes = [
    {
      ...node,
      extraMounts,
      extraPortMappings: [{
        containerPort: SERVER_FRONT_PORT,
        hostPort: opts.serverHostPort,
        listenAddress: '127.0.0.1',
        protocol: 'TCP',
      }],
    },
    ...Array.from({ length: Math.max(0, opts.nodes - 1) }, () => ({ ...node, role: 'worker', extraMounts })),
  ]
  return stringifyYaml(config, { indentSeq: false, lineWidth: 0, aliasDuplicateObjects: false })
}

/**
 * Check for every required binary and report all missing ones at once.
 * Returns `kind version`'s output. kind is optional under `--byo`; podman
 * is always needed to build images. On macOS one formula, yaac-cluster,
 * installs all of them, so the report names it instead of each tool.
 */
async function requireBinaries(
  deps: ClusterInstallDeps,
  opts: { requireKind: boolean } = { requireKind: true },
): Promise<string> {
  const mac = deps.platform === 'darwin'
  const missing: string[] = []
  let kind = ''
  try {
    await deps.run('podman', ['--version'])
  } catch {
    missing.push('podman — yaac builds session images with it and hosts the kind node on it.'
      + (mac ? '' : '\n  Install: sudo apt install podman (Debian/Ubuntu)'))
  }
  try {
    kind = (await deps.run('kind', ['version'])).stdout.trim()
  } catch {
    if (opts.requireKind) {
      missing.push('kind — creates the local kubernetes cluster (v0.33.0 or newer).'
        + (mac ? '' : '\n  Install: go install sigs.k8s.io/kind@latest'))
    }
  }
  try {
    await deps.run('kubectl', ['version', '--client', '--output', 'json'])
  } catch {
    missing.push('kubectl — yaac streams into pods (exec, port-forward) through it.'
      + (mac ? '' : '\n  Install: https://kubernetes.io/docs/tasks/tools/'))
  }
  if (missing.length > 0) {
    throw new ClusterInstallError(`Missing required tools:\n\n${missing.join('\n')}`
      + (mac ? `\n\nInstall them all with:\n${YAAC_CLUSTER_INSTALL}` : ''))
  }
  return kind
}

/**
 * kind must be v0.33.0 or newer: k8s/kind-config.yaml pins a node image
 * built for that release, and podman 6 breaks node enumeration in older
 * kind (kind#4201). Returns a fix message for an older kind, else null
 * (including for unparseable output).
 */
function diagnoseOldKind(kindVersionOut: string): string | null {
  const match = /v(\d+)\.(\d+)\.\d+/.exec(kindVersionOut)
  if (!match || Number(match[1]) !== 0 || Number(match[2]) > 32) return null
  return (
    `kind v0.33.0 or newer is required (found ${kindVersionOut.split('\n')[0]}): `
    + 'the pinned node image is built for it, and podman 6.x breaks cluster '
    + 'enumeration in older releases (kind#4201). Upgrade:\n'
    + '  brew upgrade kind (macOS) / go install sigs.k8s.io/kind@latest'
  )
}

/**
 * Linux counterpart to `ensurePodmanMachineSetup`: point at the rootful
 * podman socket (calico-node needs host netfilter and routing access; see
 * docs/cluster-setup.md "Linux: rootful podman") and check that it answers.
 * yaac cannot enable the root-owned socket itself, so it only instructs.
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
 * Check that kind works with podman before creating anything: `kind get
 * clusters` is the call kind#4201 breaks.
 */
async function preflightKindProvider(deps: ClusterInstallDeps, kindVersion: string): Promise<void> {
  const old = diagnoseOldKind(kindVersion)
  if (old) throw new ClusterInstallError(old)
  try {
    await deps.run('kind', ['get', 'clusters'], { env: kindEnv() })
  } catch (err) {
    const stderr = ((err as { stderr?: string })?.stderr ?? '').trim()
      || (err instanceof Error ? err.message : String(err))
    throw new ClusterInstallError(
      `\`kind get clusters\` failed under the podman provider:\n  ${stderr.split('\n')[0]}\n`
      + 'Check that podman is running (`podman info`), and that kind is a '
      + 'v0.33.0+ release rather than a pre-release build (kind#4201).',
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
 * Start a stopped kind node container. kind nodes have no restart policy,
 * so they are Exited after a host reboot but still listed.
 */
async function startStoppedKindNode(deps: ClusterInstallDeps, node: string): Promise<void> {
  const { stdout } = await deps.run('podman', ['inspect', '--format', '{{.State.Running}}', node])
  if (stdout.trim() !== 'false') return
  deps.log(`Starting the stopped kind node ${node}...`)
  await deps.run('podman', ['start', node])
}

const API_SERVER_TIMEOUT_MS = 120_000

/**
 * Wait until the API server answers /readyz. After a node start it takes a
 * few seconds to come up. This and the Calico steps run kubectl against the
 * kind context by name, since install has not yet checked that it is the
 * current context the API client uses (`verifyKindContext`).
 */
async function waitForApiServer(deps: ClusterInstallDeps, cluster: string): Promise<void> {
  const context = `kind-${cluster}`
  const deadline = Date.now() + API_SERVER_TIMEOUT_MS
  for (;;) {
    try {
      await deps.run('kubectl', ['--context', context, 'get', '--raw', '/readyz'], { timeout: 10_000 })
      return
    } catch (err) {
      if (Date.now() >= deadline) {
        throw new ClusterInstallError(
          `The API server of kind cluster "${cluster}" did not become ready `
          + `(${err instanceof Error ? err.message : String(err)}). `
          + `Inspect with \`podman logs ${cluster}-control-plane\`.`,
        )
      }
    }
    await new Promise((r) => setTimeout(r, 2_000))
  }
}

/**
 * Create the kind cluster from k8s/kind-config.yaml (see renderKindConfig).
 * No `--wait`: the default CNI is disabled, so nodes cannot go Ready until
 * Calico is installed.
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
  // podman refuses a missing bind source, or creates it as root.
  await fs.mkdir(nodeLocalRoot(), { recursive: true })
  const config = renderKindConfig(raw, {
    homedir: deps.homedir(),
    nodes,
    // kind sets port mappings only at cluster creation.
    serverHostPort: resolveServerPort(),
    nodeLocalHostPath: nodeLocalRoot(),
    nodeLocalNodePath: nodeLocalNodePath(),
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
 * Install Calico as the CNI and policy engine. kindnet's NetworkPolicy
 * fails open (a new pod's first packets flow before policy applies);
 * Calico drops traffic on a veth until it has programmed the endpoint.
 *
 * Uses the plain release manifest rather than the Tigera operator, and yaac
 * uses only standard NetworkPolicy (no Calico CRs), so provider-managed
 * Calico installs work too.
 */
async function installCalico(deps: ClusterInstallDeps, cluster: string): Promise<void> {
  const raw = await ensurePinnedManifest(deps, {
    what: 'Calico',
    url: calicoManifestUrl(),
    pinFile: path.join(CALICO_DIR, 'calico.yaml.sha256'),
    cacheName: `calico-${CALICO_VERSION}.yaml`,
  })
  await sideloadCalicoImages(deps, cluster, raw)
  const context = `kind-${cluster}`
  deps.log(`Installing Calico ${CALICO_VERSION} (CNI + NetworkPolicy)...`)
  try {
    // Calico's release manifest is upstream multi-document YAML (CRDs and
    // all), applied as published, which is what `kubectl apply` is for.
    await deps.runStreaming('kubectl', ['--context', context, 'apply', '-f', '-'], { input: raw })
    // Nodes go Ready only once calico-node has started, so wait on it first.
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
 * `--byo` CNI check: verify what `installCalico` would otherwise guarantee
 * (details in cni-adopt.ts). Refuses rather than warns, since each problem
 * (eBPF dataplane, replaced kube-proxy, missing pod CIDRs) fails silently
 * as missing egress. Whether NetworkPolicy is enforced is left to the
 * final check's `egress` probe.
 */
async function verifyAdoptedCni(deps: ClusterInstallDeps): Promise<void> {
  deps.log('Verifying the CNI this cluster already runs...')
  const facts = await gatherCniFacts()
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
 * Every `--byo` check, before anything is applied or built: nodes, CNI,
 * Tailscale operator, storage classes, install identity, cluster and
 * environment. Each refuses on failure. Then records the install and
 * returns the storage classes for the claims.
 */
async function verifyByoCluster(
  deps: ClusterInstallDeps,
  opts: ClusterInstallOptions,
  installId: string,
): Promise<{ rwx: string; rwo: string }> {
  deps.log('Verifying the cluster the kubeconfig points at (--byo)...')
  const nodes = await readForByo(() => listObjects<PlatformNode>('v1', 'Node'), 'the cluster\'s nodes') ?? []
  refuseIfAny('This cluster\'s nodes cannot run what yaac installs',
    nodeArchitectureProblems(nodes, hostNodeArchitecture()))
  refuseIfAny('This cluster\'s nodes cannot take the gVisor runtime', nodeOsProblems(nodes))
  deps.log(`  ${String(nodes.length)} node(s): ${hostNodeArchitecture()}, containerd on a mutable OS.`)
  await verifyAdoptedCni(deps)
  await verifyTailnetOperator(deps, '--byo')
  const storage = await verifyStorageClasses(deps, opts)
  await verifyInstallIdentity(installId)
  const current = await currentCluster(deps.run)
  const refusal = clusterRefusal((await readServerConfig()) ?? {}, current)
  if (refusal) throw new ClusterInstallError(refusal)
  if (!current.uid) {
    throw new ClusterInstallError(
      'Whether this cluster can take a byo install could not be evaluated: its kube-system '
      + `namespace, which identifies the cluster, could not be read (${current.unreadable ?? 'no answer'}).\n`
      + '    Fix the cluster access (kubeconfig, kubectl, apiserver) and re-run.',
    )
  }
  if (env.useTor) {
    throw new ClusterInstallError(
      'YAAC_USE_TOR names a Tor listener on this machine, which a pod in a cluster yaac did '
      + 'not create cannot reach. Unset it for a --byo install.',
    )
  }
  await recordInstall({
    driver: 'k8s', installId, clusterUid: current.uid, kubeContext: current.context, byo: true,
  })
  return storage
}

function refuseIfAny(heading: string, problems: string[]): void {
  if (problems.length === 0) return
  throw new ClusterInstallError(`${heading}:\n\n${problems.map((p) => `  - ${p}`).join('\n\n')}`)
}

/**
 * A cluster read for the byo gates: null when the object is absent; throws
 * a refusal naming `what` when the read itself failed.
 */
async function readForByo<T>(read: () => Promise<T | null>, what: string): Promise<T | null> {
  try {
    return await read()
  } catch (err) {
    if (isAbsent(err)) return null
    throw new ClusterInstallError(
      `Whether this cluster can take a byo install could not be evaluated: reading ${what} `
      + `failed (${k8sErrorSummary(err)}).\n`
      + '    Fix the cluster access (kubeconfig, apiserver) and re-run.',
    )
  }
}

interface RawStorageClass {
  metadata?: { name?: string; annotations?: Record<string, string> }
  provisioner?: string
  parameters?: Record<string, string>
}

/**
 * Check the byo storage classes: the RWX class exists and is NFS-family,
 * the RWO class (if named) exists, and there is a default class, which the
 * registry and npm cache use (and the RWO claim when none is named).
 */
async function verifyStorageClasses(
  deps: ClusterInstallDeps,
  opts: ClusterInstallOptions,
): Promise<{ rwx: string; rwo: string }> {
  const classes = await readForByo(
    () => listObjects<RawStorageClass>('storage.k8s.io/v1', 'StorageClass'), 'the StorageClasses',
  ) ?? []
  const named = new Map(classes.map((c) => [c.metadata?.name ?? '', c]))
  const known = [...named.keys()].sort().join(', ') || 'none'
  const isDefault = (c: RawStorageClass): boolean =>
    c.metadata?.annotations?.['storageclass.kubernetes.io/is-default-class'] === 'true'
  const problems: string[] = []
  const rwxName = opts.rwxStorageClass ?? ''
  const rwx = named.get(rwxName)
  if (!rwx) {
    problems.push(`--rwx-storage-class: there is no StorageClass "${rwxName}" (this cluster has: ${known}).`)
  } else if (!isNfsFamily(rwx.provisioner ?? '', rwx.parameters)) {
    problems.push(`--rwx-storage-class: "${rwxName}" provisions through ${rwx.provisioner ?? 'nothing'}, `
      + 'which is not NFS-family. The shared claim needs csi-driver-nfs (nfs.csi.k8s.io), EFS '
      + '(efs.csi.aws.com) or Azure Files with protocol: nfs (file.csi.azure.com).')
  }
  if (opts.rwoStorageClass !== undefined && !named.has(opts.rwoStorageClass)) {
    problems.push(`--rwo-storage-class: there is no StorageClass "${opts.rwoStorageClass}" (this cluster has: ${known}).`)
  }
  const fallback = classes.find(isDefault)?.metadata?.name
  if (!fallback) {
    problems.push('the cluster has no default StorageClass: the image registry and the npm cache '
      + 'provision their volumes through it. Mark a block class default '
      + '(`storageclass.kubernetes.io/is-default-class: "true"`).')
  }
  refuseIfAny('The storage classes cannot back this install', problems)
  const rwo = opts.rwoStorageClass ?? fallback!
  deps.log(`  storage: yaac-global through ${rwxName}, yaac-server-local through ${rwo}.`)
  return { rwx: rwxName, rwo }
}

interface RawServerDeployment {
  metadata?: { labels?: Record<string, string> }
  spec?: { template?: { spec?: { containers?: Array<{ name?: string; env?: Array<{ name?: string; value?: string }> }> } } }
}

/**
 * One install per data dir and per namespace. Refuses a data dir recorded
 * as containerless, and a namespace whose server Deployment carries
 * another install's id (installing over it would take over its storage).
 */
async function verifyInstallIdentity(installId: string): Promise<void> {
  if ((await readServerConfig())?.driver === 'containerless') {
    throw new ClusterInstallError(
      `The data dir ${getDataDir()} is a containerless install, and one data dir is one install. `
      + 'Point YAAC_DATA_DIR at a data dir of its own for this cluster.',
    )
  }
  const dep = await readForByo(() => readObject<RawServerDeployment>({
    apiVersion: 'apps/v1', kind: 'Deployment', name: SERVER_APP_NAME, namespace: k8sNamespace(),
  }), `the ${SERVER_APP_NAME} Deployment`)
  const owner = dep?.metadata?.labels?.[LABEL_INSTALL_ID]
  if (dep && owner !== installId) {
    const dataDir = dep.spec?.template?.spec?.containers
      ?.find((c) => c.name === 'server')?.env?.find((e) => e.name === 'YAAC_DATA_DIR')?.value
    throw new ClusterInstallError(
      `Namespace ${k8sNamespace()} already runs the yaac server of another install (install id `
      + `${owner ?? 'unset'}${dataDir ? `, installed from the data dir ${dataDir}` : ''}; `
      + `this data dir's is ${installId}). Installing over it would take over its storage. Run `
      + 'install from that install\'s data dir (its server.json names that id), or set '
      + 'YAAC_K8S_NAMESPACE to a namespace of this install\'s own.',
    )
  }
}

/**
 * A data dir stays a kind install or a byo install for its whole life.
 * Refuse a run whose `--byo` flag does not match the recorded install.
 */
function refuseByoSwitch(recorded: InstallRecord | null, opts: ClusterInstallOptions): void {
  if (recorded?.driver !== 'k8s' || !!opts.byo === !!recorded.byo) return
  throw new ClusterInstallError(recorded.byo
    ? 'This data dir is a --byo install. Re-run with --byo and the storage classes it was '
      + 'installed with (--rwx-storage-class, and --rwo-storage-class if it named one).'
    : 'This data dir is a kind install, so --byo cannot install from it. Point YAAC_DATA_DIR at a '
      + 'data dir of its own for the byo cluster.')
}

/**
 * Check that the kubeconfig's current context is this machine's kind
 * cluster, by name and by API server address. Both are kubeconfig
 * questions, which kubectl answers as the API client resolves them. The
 * cluster uid is not compared, since a recreated kind cluster is still the
 * same install. Returns the cluster.
 */
async function verifyKindContext(deps: ClusterInstallDeps, cluster: string): Promise<CurrentCluster> {
  const expected = `kind-${cluster}`
  const current = await currentCluster(deps.run)
  const server = async (read: () => Promise<{ stdout: string }>): Promise<string | undefined> =>
    /server:\s*(\S+)/.exec((await read().catch(() => ({ stdout: '' }))).stdout)?.[1]
  const kindServer = await server(() => deps.run('kind', ['get', 'kubeconfig', '--name', cluster], { env: kindEnv() }))
  const currentServer = await server(() => deps.run('kubectl', ['config', 'view', '--minify']))
  if (current.context !== expected || !kindServer || kindServer !== currentServer) {
    throw new ClusterInstallError(
      `kubectl's current context is ${current.context ? `"${current.context}"` : 'unset'}`
      + `${current.context === expected ? `, which does not point at the kind cluster "${cluster}" (${kindServer ?? 'unknown'})` : ''}`
      + ': every layer would go to the wrong cluster. Point kubectl at this machine\'s kind cluster:\n'
      + `  kind export kubeconfig --name ${cluster}`,
    )
  }
  return current
}

/** Image references in the Calico manifest. */
export function calicoImageRefs(manifestYaml: string): string[] {
  const refs = manifestYaml.match(/^\s*image:\s*(\S+)\s*$/gm) ?? []
  return [...new Set(refs.map((line) => line.replace(/^\s*image:\s*/, '').trim()))].sort()
}

/**
 * Load Calico's images (~235 MB) onto the node from the host podman store
 * before applying the manifest. The host store survives cluster recreation,
 * so the download happens once. On any error the node pulls the images
 * itself, which is slower.
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
    // `kind load docker-image` does not work with podman; an archive does.
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
 * Settings specific to kind node containers, which the installer DaemonSet
 * cannot apply:
 *
 *  - the kubelet housekeeping interval (NODE_KUBELET_HOUSEKEEPING_INTERVAL),
 *    written into kubeadm's flags file;
 *  - the node container's pids limit, which only podman can raise.
 */
async function applyKindNodeFixups(deps: ClusterInstallDeps, node: string): Promise<void> {
  deps.log(`Applying kind node fixups to ${node}...`)
  // Replace any old value and restart kubelet, only if the flag is missing.
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
 * Apply the gVisor installer DaemonSet and then the RuntimeClasses.
 * Failure is fatal: nothing else installs the runtime, and without it every
 * workspace pod stays Pending.
 */
async function installGvisorRuntime(deps: ClusterInstallDeps): Promise<void> {
  deps.log('Installing the gVisor runtime (installer DaemonSet + RuntimeClasses)...')
  try {
    await ensureGvisorRuntime()
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
 * Build, deploy and publish the server. Failure is fatal. This step also
 * writes the `server.json` that clients on this machine use to find the
 * server.
 */
async function deployServer(
  deps: ClusterInstallDeps,
  opts: ClusterInstallOptions,
  installId: string,
  byoStorage: { rwx: string; rwo: string } | undefined,
): Promise<void> {
  if (byoStorage) {
    const origin = await deployServerWorkload({
      fronting: tailnetFronting({ hostname: TAILNET_HOSTNAME }),
      identity: BYO_INSTALL_IDENTITY,
      installId,
      owner: opts.owner,
      storage: { kind: 'classes', ...byoStorage },
      log: deps.log,
    })
    deps.log(`The yaac server is serving at ${origin}`)
    return
  }
  const torHostAddr = env.useTor ? await hostAddrOnKindNetwork(deps) : undefined
  if (env.useTor && torHostAddr === undefined) {
    deps.log(
      "note: YAAC_USE_TOR is set but the host's address on the kind network could "
      + 'not be determined, so the server pod keeps the configured SOCKS URL. If '
      + 'that is a loopback address, Tor must be made to listen on the kind bridge '
      + "instead — a pod's loopback is its own.",
    )
  }
  const serveHost = tailnetServeHost(opts)
  const fronting = serveHost !== undefined
    ? serveFronting({ hostname: serveHost })
    : opts.tailnet ? tailnetFronting({ hostname: TAILNET_HOSTNAME }) : kindFronting()
  // Run as the host's uid on kind, since the claims are hostPaths into this
  // machine's data dir (docs/server-in-cluster.md).
  const identity = processIdentity()
  const origin = await deployServerWorkload({
    fronting, identity, installId, storage: { kind: 'static' }, torHostAddr, owner: opts.owner, log: deps.log,
  })
  deps.log(`The yaac server is serving at ${origin}`)
}

/**
 * The host's IPv4 address on the kind network, where a pod can reach a
 * host listener. `undefined` when it cannot be read. A dual-stack network
 * has one gateway per family, so pick the IPv4 one.
 */
async function hostAddrOnKindNetwork(deps: ClusterInstallDeps): Promise<string | undefined> {
  try {
    const { stdout } = await deps.run('podman', [
      'network', 'inspect', 'kind', '--format', '{{range .Subnets}}{{.Gateway}} {{end}}',
    ])
    return stdout.trim().split(/\s+/).find(isIPv4)
  } catch {
    return undefined
  }
}

/**
 * Deploy the npm cache. Failure only logs: workspaces fall back to npmjs,
 * which is slower, and `cluster check` reports it.
 */
async function deployNpmCache(deps: ClusterInstallDeps): Promise<void> {
  deps.log('Deploying the npm cache (Verdaccio)...')
  try {
    await ensureNpmCache()
  } catch (err) {
    deps.log(
      'note: could not deploy the npm cache '
      + `(${err instanceof Error ? err.message.split('\n')[0] : String(err)}) — `
      + 'workspaces install from npmjs until a re-run of `yaac cluster install` succeeds.',
    )
  }
}

// ---------------------------------------------------------------------------
// macOS podman-machine bootstrap
// ---------------------------------------------------------------------------

/**
 * Effective `[machine] provider` from containers.conf sources in order
 * (base file, then conf.d drop-ins alphabetically; later wins).
 * Unparseable sources are skipped.
 */
function effectiveMachineProvider(sources: string[]): string | undefined {
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
 * VM size for `podman machine init`: up to 8 cpus and 32 GiB, using half
 * the host RAM on smaller hosts, with a 2 cpu / 4 GiB floor.
 */
function defaultMachineResources(
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
      + `Is yaac's patched krunkit installed? It comes with:\n${YAAC_CLUSTER_INSTALL}`,
    )
  }
}

/**
 * Set up the macOS podman machine:
 *   - provider libkrun, via a containers.conf.d drop-in. Its virtiofs
 *     reports real file ownership; with applehv/vz, gVisor's root gofer
 *     sees every file as root-owned and non-root workspaces cannot write
 *     hostPath mounts;
 *   - rootful (kind's podman provider requires it).
 */
async function ensurePodmanMachineSetup(deps: ClusterInstallDeps): Promise<void> {
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
      + 'it the image store, the kind cluster inside it, and any running workspaces)',
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
    // An upgrade that dropped yaac's krunkit leaves a libkrun machine that
    // can no longer start, so name the formula that brings it back.
    throw new ClusterInstallError(
      `podman machine start failed:\n  ${stderr.trim().split('\n')[0]}\n`
      + `Is yaac's patched krunkit installed? It comes with:\n${YAAC_CLUSTER_INSTALL}`,
    )
  }
}
