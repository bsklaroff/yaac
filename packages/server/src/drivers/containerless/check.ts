import { createHash, randomBytes } from 'node:crypto'
import { createReadStream } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { ServerError } from '@yaac/shared/errors'
import { PACKAGE_ROOT } from '@yaac/shared/paths'
import { AGENT_PACKAGES, agentPackagePrefix, type AgentPackage } from '@yaac/shared/tool-install'
import {
  ACP_ADAPTERS,
  type AgentMode,
  type AgentTool,
  type CheckResult,
} from '@yaac/shared/types'
import { WorkspaceExecError } from '#drivers/contract'
import { serverLog } from '#lib/log'
import { onPath, runHost } from './host'
import { userEnvironment } from './launch'
import { overriddenToolHomeVars } from './tool-homes'

/**
 * `yaac host check` and the per-create launch check: whether this machine can
 * run workspaces without containers (the counterpart of `yaac cluster
 * check`). With no image, the system tools must already be on the host;
 * yaac installs the agents itself, with npm (omp with curl).
 */

/** Install hint for node 22+ with npm (the pinned agents require both). */
const NODE_INSTALL = 'node 22 or newer, with npm: brew install node, or nodejs.org — '
  + "Debian and Ubuntu's apt nodejs is older and has no npm"

/** What a workspace cannot run without at all. */
const REQUIRED: Array<{ binary: string; why: string; fix: string }> = [
  {
    binary: 'tmux',
    why: 'supervises every workspace session and outlives the server',
    fix: 'Install tmux (apt install tmux / brew install tmux).',
  },
  {
    binary: 'git',
    why: 'creates and reads every workspace checkout',
    fix: 'Install git (apt install git / brew install git).',
  },
  {
    binary: 'node',
    why: 'runs acpd, the npm that installs every agent but omp, and the agents that are node scripts',
    fix: `Install ${NODE_INSTALL}. A yaac started by a bundled interpreter (the `
      + 'desktop app stages one) is the usual reason this is missing.',
  },
]

/**
 * The oldest tmux release yaac works on, as [major, minor]. Webapp terminals
 * size each window with `refresh-client -C @<window>:<cols>x<rows>`, which
 * 3.2 rejects, so no terminal attaches there. The status watcher's format
 * subscriptions and client flags need 3.2. `yaac host check` reports an
 * older tmux and a create refuses one. The "Host requirements" section of
 * docs/containerless-driver.md states the same floor.
 */
const MIN_TMUX = [3, 3] as const

/** What degrades a feature rather than breaking the mode. */
const OPTIONAL: Array<{ binary: string; why: string; fix: string }> = [
  {
    binary: 'lsof',
    why: 'detects the ports a workspace is listening on',
    fix: 'Install lsof to have listening ports suggested for forwarding; workspaces run fine without it.',
  },
  {
    binary: 'socat',
    why: 'carries the ACP chat transport to an agent',
    fix: 'Install socat (apt install socat / brew install socat) to use --mode acp, '
      + 'which is refused without it; tui-mode workspaces do not need it.',
  },
  {
    binary: 'curl',
    why: 'yaac-mama, the in-session helper, reaches this server with it, and yaac downloads omp with it',
    fix: 'Install curl (apt install curl) so a session can run yaac-mama and yaac can install omp; '
      + 'everything else works without it.',
  },
]

/**
 * This driver's `WorkspaceDriver.assertCanLaunch`. Without it, a missing tool
 * makes the agent window exit instantly after a create reported success.
 *
 * Every launch needs tmux, git and node on PATH (node runs npm, acpd, codex
 * and pi), and a tmux no older than `MIN_TMUX`: on an older one the create
 * would succeed and its webapp terminal stay blank. `acp` also needs socat, which the chat transport uses to reach
 * acpd's socket; without it the pane just hangs. The agent CLI (or ACP
 * adapter, plus the CLI it drives) is installed on first use
 * (`ensureAgentBinary`). `onPath` uses the same environment the workspace's
 * tmux gets.
 */
export async function assertHostCanLaunch(opts: {
  tool: AgentTool
  mode: AgentMode
  onProgress?: (message: string) => void
}): Promise<void> {
  const { tool, mode, onProgress } = opts
  // In dependency order, so a host missing several is fixed bottom-up.
  await requireBinary('tmux', 'every workspace here is a tmux session on this host',
    'apt install tmux / brew install tmux', null)
  const tmux = await checkTmuxVersion()
  if (tmux !== null && tmux.fix !== null) {
    throw new ServerError('MISSING_TOOL', `This host's tmux is ${tmux.version}. ${tmux.fix}`)
  }
  await requireBinary('git', "it makes and reads the workspace's checkout",
    'apt install git / brew install git', null)
  await requireBinary('node', 'npm installs every agent but omp under it, and acpd, codex and pi run under it',
    NODE_INSTALL, null)
  if (mode === 'acp') {
    // Before installing anything, so the refusal is immediate.
    await requireBinary('socat', "the chat transport dials acpd's socket with it",
      'apt install socat / brew install socat', 'create the workspace with --mode tui')
  }
  if (mode === 'acp') {
    const adapter = ACP_ADAPTERS[tool]
    await ensureAgentBinary(adapter.binary, onProgress)
    // Some adapters drive the CLI (codex-acp, pi-acp) and need it too.
    if (adapter.needsCli && adapter.binary !== tool) await ensureAgentBinary(tool, onProgress)
    return
  }
  await ensureAgentBinary(tool, onProgress)
}

/**
 * Refuse the create, with install instructions, unless `binary` is on PATH.
 * `alternative` is what to do instead, or `null` if nothing else works.
 */
async function requireBinary(
  binary: string,
  why: string,
  install: string,
  alternative: string | null,
): Promise<void> {
  if (await onPath(binary)) return
  throw new ServerError(
    'MISSING_TOOL',
    `"${binary}" is not on this host's PATH — ${why}, and this server runs `
    + `agents as host processes with no image to supply one. Install it (${install}) `
    + `and retry${alternative === null ? '' : `, or ${alternative}`}.`,
  )
}

/** Whether `binary` is in its pinned package's install. */
async function agentBinaryInstalled(binary: string): Promise<boolean> {
  const bin = path.join(agentPackagePrefix(AGENT_PACKAGES[binary]), 'bin', binary)
  return fs.access(bin, fs.constants.X_OK).then(() => true, () => false)
}

/** In-flight installs by prefix, so concurrent creates share one. */
const installsInFlight = new Map<string, Promise<void>>()

/** npm on a cold cache is slow. */
const INSTALL_TIMEOUT_MS = 600_000

/** Marks a staging prefix, beside the prefix it will become. */
const STAGING_INFIX = '.partial-'

/**
 * Remove staging prefixes older than the install timeout, left by a server
 * that stopped mid-install or a timed-out install whose child kept writing.
 * Any live install is younger than the timeout.
 */
async function sweepAbandonedStaging(dir: string): Promise<void> {
  const cutoff = Date.now() - INSTALL_TIMEOUT_MS
  for (const name of await fs.readdir(dir)) {
    if (!name.includes(STAGING_INFIX)) continue
    const entry = path.join(dir, name)
    const stat = await fs.stat(entry).catch(() => null)
    if (stat !== null && stat.mtimeMs < cutoff) {
      await fs.rm(entry, { recursive: true, force: true }).catch(() => { /* a later sweep retries */ })
    }
  }
}

/**
 * Install the pinned package that ships `binary`, unless already installed.
 * npm (or the release download) installs into a staging prefix that is
 * renamed into place only once any patch is applied, as the image does, and
 * the binary exists, since the prefix's existence means "installed". If
 * another server wins the rename race, its identical copy is kept.
 */
async function ensureAgentBinary(
  binary: string,
  onProgress?: (message: string) => void,
): Promise<void> {
  if (await agentBinaryInstalled(binary)) return
  const pkg = AGENT_PACKAGES[binary]
  const prefix = agentPackagePrefix(pkg)
  const spec = `${pkg.package}@${pkg.version}`
  onProgress?.(`Installing ${spec} (first use on this host)…`)
  const existing = installsInFlight.get(prefix)
  // A shared install's failure propagates to this caller too.
  if (existing !== undefined) {
    await existing
    return
  }
  const run = (async () => {
    const installer = pkg.release === undefined ? 'npm' : 'curl'
    if (!(await onPath(installer))) {
      throw new ServerError(
        'MISSING_TOOL',
        `yaac installs ${spec} with ${installer}, and "${installer}" is not on this host's PATH. `
        + `Install ${installer === 'npm' ? NODE_INSTALL : 'curl'}, and retry.`,
      )
    }
    const staging = `${prefix}${STAGING_INFIX}${randomBytes(4).toString('hex')}`
    const pkgDir = pkg.release === undefined
      ? path.join(staging, 'lib', 'node_modules', pkg.package)
      : path.join(staging, 'lib', binary)
    const discard = (): Promise<void> => fs.rm(staging, { recursive: true, force: true })
    const requireInstalled = async (): Promise<void> => {
      if (await fs.access(path.join(staging, 'bin', binary)).then(() => true, () => false)) return
      await discard()
      throw new ServerError('MISSING_TOOL', `installing ${spec} left no "${binary}" binary behind`)
    }
    await fs.mkdir(path.dirname(prefix), { recursive: true })
    await sweepAbandonedStaging(path.dirname(prefix))
    try {
      if (pkg.release !== undefined) await downloadRelease(pkg.release, path.join(pkgDir, binary))
      else {
        // `--engine-strict`: npm otherwise only warns about a too-old node.
        // Runs in the user's environment, like a workspace, since this is
        // third-party code.
        await runHost([
          'npm', 'install', '--global', '--engine-strict', '--prefix', staging,
          ...(pkg.runScripts ? [] : ['--ignore-scripts']),
          spec,
        ], { timeoutMs: INSTALL_TIMEOUT_MS, env: userEnvironment() })
      }
    } catch (err) {
      await discard()
      throw new ServerError('MISSING_TOOL', `installing ${spec} failed${installerDetail(err)}`)
    }
    // A release's `bin/` is the patch's to write.
    if (pkg.release === undefined) await requireInstalled()
    if (pkg.patch !== undefined) {
      const script = path.join(PACKAGE_ROOT, 'dockerfiles', 'agent-patches', pkg.patch.script)
      try {
        // omp's patch runs the downloaded binary, third-party code like npm's.
        await runHost(['node', script, path.join(pkgDir, pkg.patch.entry)], { timeoutMs: 60_000, env: userEnvironment() })
      } catch (err) {
        await discard()
        throw new ServerError('MISSING_TOOL', `patching ${spec} failed${installerDetail(err)}`)
      }
    }
    if (pkg.release !== undefined) await requireInstalled()
    // A failed rename usually means another install won the race.
    await fs.rename(staging, prefix).catch(discard)
    if (!(await agentBinaryInstalled(binary))) {
      throw new ServerError('MISSING_TOOL', `could not move ${spec} into ${prefix}`)
    }
  })()
  installsInFlight.set(prefix, run)
  try {
    await run
  } finally {
    installsInFlight.delete(prefix)
  }
}

/**
 * Download this host's asset of `release` to `file`, checked against its
 * pinned SHA-256. curl runs in the user's environment, like npm, so a proxy
 * the user set applies.
 */
async function downloadRelease(release: NonNullable<AgentPackage['release']>, file: string): Promise<void> {
  const platform = `${process.platform}${hostIsMusl() ? '-musl' : ''}-${process.arch}`
  const pinned = release.sha256[platform]
  if (pinned === undefined) throw new Error(`no release binary is pinned for ${platform}`)
  await runHost(['curl', '-fsSL', '--create-dirs', '-o', file, `${release.urlBase}${platform}`],
    { timeoutMs: INSTALL_TIMEOUT_MS, env: userEnvironment() })
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer)
  const actual = hash.digest('hex')
  if (actual !== pinned) throw new Error(`the download's SHA-256 is ${actual}, not the pinned ${pinned}`)
  await fs.chmod(file, 0o755)
}

/**
 * Whether this host's libc is musl: a Linux whose runtime reports no glibc.
 * A glibc host can have musl's loader installed too, so its files decide
 * nothing. The report would otherwise resolve the name of every socket's
 * peer, synchronously, in this long-lived server (`excludeNetwork`, which
 * node before 22.13 ignores).
 */
function hostIsMusl(): boolean {
  if (process.platform !== 'linux') return false
  const report = process.report as typeof process.report & { excludeNetwork: boolean }
  const excludeNetwork = report.excludeNetwork
  report.excludeNetwork = true
  try {
    return (report.getReport() as { header: { glibcVersionRuntime?: string } }).header.glibcVersionRuntime === undefined
  } finally {
    report.excludeNetwork = excludeNetwork
  }
}

/**
 * Install the pinned version of every agent package this host has an older
 * version of, one at a time. Pins move with yaac releases, so without this
 * the first create after each upgrade waits on npm for the agent it uses.
 * Only packages already used here are installed. A failure is logged and
 * left for the next create that needs the package, which retries it and
 * reports the error.
 */
export async function upgradeUsedAgents(): Promise<void> {
  for (const [binary, pkg] of Object.entries(AGENT_PACKAGES)) {
    const prefix = agentPackagePrefix(pkg)
    // Prefixes are named `<package with + for />@<version>`.
    const stem = `${pkg.package.replace('/', '+')}@`
    const names = await fs.readdir(path.dirname(prefix)).catch((): string[] => [])
    const usedBefore = names.some((name) => name.startsWith(stem) && !name.includes(STAGING_INFIX))
    if (!usedBefore || names.includes(path.basename(prefix))) continue
    await ensureAgentBinary(binary).catch((err: unknown) => {
      serverLog(`[server] containerless: upgrading ${pkg.package} to ${pkg.version} failed: ${String(err)}`)
    })
  }
}

/** The installer's output for the error message, or the error's message
 *  when there is none (timeout, spawn failure). */
function installerDetail(err: unknown): string {
  if (err instanceof WorkspaceExecError) {
    return tailDetail(`${err.stdout}\n${err.stderr}`) || `: exit ${err.code}`
  }
  return `: ${err instanceof Error ? err.message : String(err)}`
}

/**
 * The useful part of npm's output: any `npm error code X` lines (printed
 * near the top) followed by the last 10 other lines.
 */
function tailDetail(output: string): string {
  const lines = output.split('\n').map((l) => l.trimEnd()).filter(Boolean)
  const isCode = (l: string): boolean => /^npm (error|ERR!)\s+code\s+\S+$/.test(l)
  const codes = lines.filter(isCode)
  const tail = lines.filter((l) => !isCode(l)).slice(-10)
  const kept = [...codes, ...tail]
  return kept.length === 0 ? '' : `:\n${kept.join('\n')}`
}

/** Every check, in the order they print. */
export async function runHostCheck(): Promise<CheckResult[]> {
  const results: CheckResult[] = []

  for (const { binary, why, fix } of REQUIRED) {
    const present = await onPath(binary)
    results.push({
      name: binary,
      status: present ? 'pass' : 'fail',
      detail: present ? `on PATH — ${why}` : `not on PATH — ${why}`,
      ...(present ? {} : { fix }),
    })
  }

  const tmux = await checkTmuxVersion()
  if (tmux !== null) {
    results.push({
      name: 'tmux version',
      status: tmux.fix === null ? 'pass' : 'fail',
      detail: `tmux ${tmux.version}`,
      ...(tmux.fix === null ? {} : { fix: tmux.fix }),
    })
  }

  for (const { binary, why, fix } of OPTIONAL) {
    const present = await onPath(binary)
    results.push({
      name: binary,
      status: present ? 'pass' : 'warn',
      detail: present ? `on PATH — ${why}` : `not on PATH — ${why}`,
      ...(present ? {} : { fix }),
    })
  }

  // yaac installs the agents with npm (omp with curl); list those already installed.
  const installed: string[] = []
  for (const [binary, { version }] of Object.entries(AGENT_PACKAGES)) {
    if (await agentBinaryInstalled(binary)) installed.push(`${binary} ${version}`)
  }
  const complete = installed.length === Object.keys(AGENT_PACKAGES).length
  const npm = complete || await onPath('npm')
  results.push({
    name: 'agent tools',
    status: npm ? 'pass' : 'warn',
    detail: (installed.length > 0 ? `installed: ${installed.join(', ')}` : 'none installed yet')
      + (complete ? '' : ' — yaac installs each at its pinned version the first time a workspace needs it'),
    ...(npm ? {} : {
      fix: 'Install node (apt install nodejs / brew install node): yaac installs '
        + 'every agent CLI and ACP adapter but omp with npm.',
    }),
  })

  // Tool-home variables set on the host are silently ignored in workspaces
  // (`overriddenToolHomeVars`), so say so here.
  const overridden = overriddenToolHomeVars()
  results.push({
    name: 'tool home overrides',
    status: overridden.length === 0 ? 'pass' : 'warn',
    detail: overridden.length === 0
      ? 'none set — agents resolve their config from this project\'s own dirs'
      : `${overridden.join(', ')} set here, not used inside workspaces`,
    ...(overridden.length === 0 ? {} : {
      fix: 'A workspace reads its tool config from this project\'s dirs, and gh '
        + 'from its own, so these are cleared rather than followed. Otherwise an '
        + 'agent would read your own config and credentials and write its '
        + 'transcripts where yaac does not look. Nothing to fix unless you meant '
        + 'a workspace to use them; per-workspace values go in the project config.',
    }),
  })

  results.push({
    name: 'isolation',
    status: 'warn',
    detail: 'none — agents run as this user with full access to this machine',
    fix: 'Workspaces are not sandboxed in containerless mode. New workspaces '
      + 'default to accept-edits permissions; --permission-mode picks another.',
  })

  return results
}

/**
 * The host's tmux version, with how to fix it when it is older than
 * `MIN_TMUX`; null when `tmux -V` reports none. A version with no `X.Y` in
 * it (a `master` build) is taken as new enough.
 */
async function checkTmuxVersion(): Promise<{ version: string; fix: string | null } | null> {
  let version: string | undefined
  try {
    const { stdout } = await runHost(['tmux', '-V'], { timeoutMs: 5_000 })
    version = /tmux\s+(\S+)/.exec(stdout.trim())?.[1]
  } catch {
    return null
  }
  if (version === undefined) return null
  const m = /(\d+)\.(\d+)/.exec(version)
  const [major, minor] = MIN_TMUX
  const ok = !m || Number(m[1]) > major || (Number(m[1]) === major && Number(m[2]) >= minor)
  return {
    version,
    fix: ok ? null : `yaac's terminals need tmux ${major}.${minor} or newer; upgrade tmux. Where the `
      + 'distribution\'s own is older (Ubuntu 22.04 has 3.2a), build it from source or use Homebrew.',
  }
}
