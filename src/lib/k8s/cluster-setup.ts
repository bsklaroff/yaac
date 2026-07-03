import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline/promises'
import { spawn } from 'node:child_process'
import { parse as parseToml } from 'smol-toml'
import { execFileAsync } from '@/lib/k8s/kubectl'
import { ensureLocalRegistry, registryHost, REGISTRY_CONTAINER_NAME } from '@/lib/k8s/registry'
import {
  formatCheckResult,
  NODE_MIN_FREE_KBYTES,
  NODE_PIDS_LIMIT,
  NODE_SYSFS_MOUNTPOINT,
  NODE_TASKSMAX_CONF,
  runClusterCheck,
  type CheckResult,
} from '@/lib/k8s/cluster-check'
import { PACKAGE_ROOT } from '@/shared/paths'
import { env } from '@/shared/env'

/**
 * `yaac cluster setup` — the port of the retired scripts/setup-kind-cluster.sh
 * plus the macOS podman-machine bootstrap the README used to describe by
 * hand. Brew (or any package manager) can only install binaries; everything
 * per-user and stateful — the rootful libkrun machine, the registry
 * container, the kind cluster, Cilium, the node fixups — happens here,
 * idempotently and with actionable error messages.
 *
 * Full mode recreates the cluster from scratch (delete + create). `--repair`
 * re-applies only the node fixups that vanish on a node/VM restart (sysfs
 * unmask, DefaultTasksMax, vm sysctls, pids-limit, registry wiring) without
 * touching the cluster itself.
 */

/** Cilium version installed into the cluster (chart/agent). */
export const CILIUM_VERSION = '1.19.4'
/** Pinned cilium CLI release fetched when no `cilium` is on PATH. */
export const CILIUM_CLI_VERSION = 'v0.19.4'

/**
 * The pre-podman-6 README had users wrap krunkit in a shell script (moving
 * the real binary here) to inject `--timesync`. podman 6 passes the flag
 * itself, so the wrapper would duplicate it and break machine start.
 */
export const LEGACY_KRUNKIT_WRAPPER = '/opt/homebrew/bin/krunkit-real'

/** A setup step failed in a way the user must resolve; message is the fix. */
export class ClusterSetupError extends Error {}

export interface ClusterSetupOptions {
  /** Re-apply node fixups on the existing cluster instead of recreating it. */
  repair?: boolean
}

export interface ClusterSetupDeps {
  /** execFile-style runner, injectable for tests. */
  run: typeof execFileAsync
  /**
   * Runner for long, chatty subprocesses (kind create, cilium install,
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
  check: () => Promise<{ ok: boolean; results: CheckResult[] }>
  platform: NodeJS.Platform
  homedir: () => string
  totalmem: () => number
  cpuCount: () => number
  readTextFile: (p: string) => Promise<string | null>
  writeTextFile: (p: string, content: string) => Promise<void>
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
    if (opts.input !== undefined) child.stdin?.end(opts.input)
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${file} ${args.join(' ')} exited with code ${code}`))
    })
  })
}

async function confirmDefault(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase()
    return answer === 'y' || answer === 'yes'
  } finally {
    rl.close()
  }
}

const defaultDeps: ClusterSetupDeps = {
  run: execFileAsync,
  runStreaming: runStreamingDefault,
  log: (m) => { console.log(m) },
  confirm: confirmDefault,
  ensureRegistry: ensureLocalRegistry,
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
}

/**
 * Environment for every `kind` invocation: yaac runs kind's nodes under
 * podman (KIND_EXPERIMENTAL_PROVIDER is kind's own knob for that) so the
 * nodes and the registry share one engine, one network, one lifecycle.
 */
function kindEnv(): NodeJS.ProcessEnv {
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
  deps: ClusterSetupDeps = defaultDeps,
): Promise<boolean> {
  if (env.nested) {
    throw new ClusterSetupError(
      'yaac cluster setup cannot run inside a nested yaac session — the '
      + 'cluster is external infrastructure managed by the outer yaac.',
    )
  }

  const cluster = env.kindCluster
  const versions = await requireBinaries(deps)

  if (deps.platform === 'darwin') await ensurePodmanMachineSetup(deps)

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
    await deps.ensureRegistry()
    for (const node of nodes) await applyNodeFixups(deps, node)
    await connectRegistryToKindNetwork(deps)
  } else {
    await deps.ensureRegistry()
    await recreateKindCluster(deps, cluster)
    await installCilium(deps, cluster)
    const nodes = await kindNodes(deps, cluster)
    for (const node of nodes) await applyNodeFixups(deps, node)
    await connectRegistryToKindNetwork(deps)
  }

  deps.log('\nVerifying with cluster check...')
  const { ok, results } = await deps.check()
  for (const r of results) deps.log(formatCheckResult(r))
  deps.log(ok
    ? '\nCluster is ready for yaac sessions.'
    : '\nCluster is not ready — fix the failures above and re-run `yaac cluster setup`.')
  return ok
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
 * Delete + recreate the kind cluster from the bundled k8s/kind-config.yaml
 * ($HOME substituted — kind does not expand environment variables). No
 * --wait: the config disables the default CNI, so nodes cannot go Ready
 * until Cilium is installed.
 */
async function recreateKindCluster(deps: ClusterSetupDeps, cluster: string): Promise<void> {
  const configPath = path.join(PACKAGE_ROOT, 'k8s', 'kind-config.yaml')
  const raw = await deps.readTextFile(configPath)
  if (raw === null) {
    throw new ClusterSetupError(`Bundled kind config not found at ${configPath} — broken install?`)
  }
  const config = raw.replaceAll('$HOME', deps.homedir())

  deps.log(`Recreating kind cluster "${cluster}" (this deletes any existing "${cluster}" cluster)...`)
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
 * Resolve a cilium CLI, preferring one on PATH (the brew formula installs
 * cilium-cli) and otherwise fetching the pinned release once into
 * ~/.cache/yaac/bin — the same download-and-pin convention ensureHelm uses.
 */
export async function ensureCiliumCli(deps: ClusterSetupDeps = defaultDeps): Promise<string> {
  try {
    await deps.run('sh', ['-c', 'command -v cilium'])
    return 'cilium'
  } catch { /* not on PATH — fall back to the pinned cache */ }

  const binDir = path.join(deps.homedir(), '.cache', 'yaac', 'bin')
  const bin = path.join(binDir, `cilium-${CILIUM_CLI_VERSION}`)
  if (await deps.fileExists(bin)) return bin

  const plat = deps.platform === 'darwin' ? 'darwin' : 'linux'
  const arch = process.arch === 'arm64' ? 'arm64' : 'amd64'
  const url = `https://github.com/cilium/cilium-cli/releases/download/${CILIUM_CLI_VERSION}/cilium-${plat}-${arch}.tar.gz`
  deps.log(`Downloading pinned cilium CLI ${CILIUM_CLI_VERSION}...`)
  await deps.run('sh', [
    '-c',
    `mkdir -p '${binDir}' && curl -fsSL '${url}' | tar -xz -C '${binDir}' cilium `
    + `&& mv '${binDir}/cilium' '${bin}' && chmod +x '${bin}'`,
  ], { timeout: 120_000 })
  return bin
}

/**
 * Install Cilium (pinned) as the CNI. kindnet's NetworkPolicy engine fails
 * OPEN, and session egress lockdown needs fail CLOSED — Cilium's CNI ADD
 * does not return until the pod's eBPF policy programs are attached.
 * envoyConfig.enabled installs the CiliumEnvoyConfig CRDs the cluster-level
 * egress redirect (bootstrap.ts buildEgressRedirectCecManifest) requires.
 */
async function installCilium(deps: ClusterSetupDeps, cluster: string): Promise<void> {
  const cli = await ensureCiliumCli(deps)
  const context = `kind-${cluster}`
  deps.log(`Installing Cilium ${CILIUM_VERSION} (envoyConfig enabled)...`)
  try {
    await deps.runStreaming(cli, [
      'install', '--context', context,
      '--version', CILIUM_VERSION,
      '--set', 'ipam.mode=kubernetes',
      '--set', 'envoyConfig.enabled=true',
    ])
    await deps.runStreaming(cli, ['status', '--context', context, '--wait', '--wait-duration', '5m'])
  } catch (err) {
    throw new ClusterSetupError(
      `Cilium install did not complete (${err instanceof Error ? err.message : String(err)}). `
      + `Re-run \`yaac cluster setup\`, or inspect with \`${cli === 'cilium' ? 'cilium' : cli} status --context ${context}\`.`,
    )
  }
  await deps.run('kubectl', [
    '--context', context,
    'wait', '--for=condition=Ready', 'node', '--all', '--timeout=120s',
  ])
}

/**
 * The per-node fixups: containerd
 * registry hosts.toml, the unmasked sysfs mount for userns pods
 * (kind#3436), DefaultTasksMax + VM memory sysctls (subagent fan-out and
 * virtiofs allocations die without them), and the node container's own PID
 * ceiling. All of these live in node/VM state that resets on restart —
 * `yaac cluster setup --repair` re-applies them, and `yaac cluster check`
 * warns when they are missing.
 */
async function applyNodeFixups(deps: ClusterSetupDeps, node: string): Promise<void> {
  deps.log(`Applying node fixups to ${node}...`)
  const port = registryHost().split(':')[1] ?? '5001'
  const registryDir = `/etc/containerd/certs.d/localhost:${port}`
  await deps.run('podman', ['exec', node, 'sh', '-c',
    `mkdir -p '${registryDir}' && printf '[host."http://${REGISTRY_CONTAINER_NAME}:5000"]\\n' > '${registryDir}/hosts.toml'`,
  ])
  // Idempotent (unlike the shell script, which only ran on fresh nodes):
  // re-mounting sysfs on an already-fixed node would stack mounts.
  await deps.run('podman', ['exec', node, 'sh', '-c',
    `mkdir -p ${NODE_SYSFS_MOUNTPOINT} && { mountpoint -q ${NODE_SYSFS_MOUNTPOINT} || mount -t sysfs none ${NODE_SYSFS_MOUNTPOINT}; }`,
  ])
  await deps.run('podman', ['exec', node, 'sh', '-c',
    'mkdir -p /etc/systemd/system.conf.d\n'
    + `printf '[Manager]\\nDefaultTasksMax=infinity\\n' > ${NODE_TASKSMAX_CONF}\n`
    + 'systemctl daemon-reexec\n'
    + `echo ${NODE_MIN_FREE_KBYTES} > /proc/sys/vm/min_free_kbytes\n`
    + 'echo 40 > /proc/sys/vm/compaction_proactiveness\n',
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
 *   - provider = libkrun (idmapped-mount virtiofs for userns session pods;
 *     applehv/vz do not have it) — written as a containers.conf.d drop-in;
 *   - rootful (kind's podman provider requires it);
 *   - a leftover krunkit `--timesync` wrapper from the podman-5 README
 *     instructions would duplicate the flag podman 6 passes itself and
 *     break machine start → detect and instruct removal;
 *   - a machine provisioned under podman 5.x lacks the 6.0 machine image's
 *     guest wiring (vsock qemu-guest-agent for timesync) and trips podman's
 *     config-version gate on start → prompt for the destructive rm+re-init.
 */
export async function ensurePodmanMachineSetup(deps: ClusterSetupDeps): Promise<void> {
  if (await deps.fileExists(LEGACY_KRUNKIT_WRAPPER)) {
    throw new ClusterSetupError(
      `Found ${LEGACY_KRUNKIT_WRAPPER} — the manual krunkit --timesync wrapper `
      + 'from the pre-podman-6 README. podman 6 passes --timesync itself, so '
      + 'the wrapper duplicates the flag and breaks machine start. Remove it:\n'
      + `  mv ${LEGACY_KRUNKIT_WRAPPER} /opt/homebrew/bin/krunkit`,
    )
  }

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
      + '(userns session pods need its idmapped-mount virtiofs)...')
    await deps.writeTextFile(
      providerDropinPath(deps),
      '# Written by `yaac cluster setup`: session pods run in user namespaces,\n'
      + '# which need idmapped-mount support on the VM\'s file sharing — libkrun\'s\n'
      + '# virtiofs has it, applehv/vz do not.\n'
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
