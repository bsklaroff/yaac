import { randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { ServerError } from '@yaac/shared/errors'
import { AGENT_PACKAGES, agentPackagePrefix } from '@yaac/shared/tool-install'
import {
  ACP_ADAPTERS,
  type AgentMode,
  type AgentTool,
  type CheckResult,
} from '@yaac/shared/types'
import { WorkspaceExecError } from '#drivers/contract'
import { onPath, runHost } from './host'
import { userEnvironment } from './launch'
import { overriddenToolHomeVars } from './tool-homes'

/**
 * `yaac host check`: whether this machine can run workspaces without
 * containers.
 *
 * The parallel of `yaac cluster check`, and the reason the layering doc
 * keeps a door open through the package exports for exactly this — "a
 * host-process driver would ship its own doctor". It answers the same
 * question that one does, against a different substrate: with no image to
 * install anything, the system tools a workspace needs have to already be on
 * this host, and the failure mode without this check is a tmux window that
 * opens and immediately exits with nobody watching. The agents themselves
 * are yaac's to install, so for them it asks only for the npm that does it.
 */

/**
 * How to get a node this driver can use: 22 or newer, because the pinned
 * agents declare it (`engines`), and with npm, which installs them. A Debian
 * or Ubuntu `apt install nodejs` gives neither.
 */
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
    why: 'runs acpd, the npm that installs each agent, and the agents that are node scripts',
    fix: `Install ${NODE_INSTALL}. A yaac started by a bundled interpreter (the `
      + 'desktop app stages one) is the usual reason this is missing.',
  },
]

/** What degrades a feature rather than breaking the mode. */
const OPTIONAL: Array<{ binary: string; why: string; fix: string }> = [
  {
    binary: 'lsof',
    why: 'detects the ports a workspace is listening on',
    fix: 'Install lsof to get clickable port links; workspaces run fine without it.',
  },
  {
    binary: 'socat',
    why: 'carries the ACP chat transport to an agent',
    fix: 'Install socat (apt install socat / brew install socat) to use --mode acp, '
      + 'which is refused without it; tui-mode workspaces do not need it.',
  },
  {
    binary: 'curl',
    why: 'yaac-mama, the in-session helper, reaches this server with it',
    fix: 'Install curl (apt install curl) so a session can run yaac-mama; '
      + 'everything else works without it.',
  },
]

/**
 * See `WorkspaceDriver.assertCanLaunch` — this driver's answer.
 *
 * Under the pod driver every tool ships in the image, so what a workspace can
 * run is a build-time fact. Here the host supplies the system tools and yaac
 * supplies the agents: each agent CLI and ACP adapter is yaac's own install
 * of its pinned package (`ensureAgentBinary`), made the first time a create
 * needs it. The failure without this check is silent both ways: a launch
 * command that execs nothing makes tmux respawn a command that exits 127,
 * closing the window — and `respawn-window` reports success — while `acp` has
 * acpd exec nothing and end the same way. Either leaves a workspace that
 * vanishes seconds after a create that already said it worked. So the create
 * asks first.
 *
 * `tmux` and `git` come first and are asked of every launch, because the
 * failure they cause is the same one arriving later and dirtier: the launch
 * spawns them directly, so a host without either dies inside
 * `launchWorkspace` — after the workspace home, its mounts and its state dir
 * were created — with a bare spawn ENOENT under a create that has already
 * reported progress. Asked here, that is a clean refusal before anything is
 * provisioned.
 *
 * `node` is asked of every launch too: npm installs the agents under it,
 * codex and pi are node scripts, and under `acp` the window's command is
 * literally `node <acpdEntry>` — a server started by an interpreter that is
 * not itself on PATH (a bundled one, as the desktop app stages) runs a window
 * that execs nothing.
 *
 * The rest differs by mode, and only by mode: `tui` runs the tool itself,
 * while `acp` runs the tool's adapter and needs `socat` besides, because the
 * chat transport dials acpd's UNIX socket by spawning one on this host:
 * without it the workspace comes up and its pane never attaches, which reads
 * as an agent that hangs rather than a tool that is missing — a worse failure
 * than the one this whole check exists to replace, and the reason it is
 * refused here rather than warned about in `yaac host check` alone.
 *
 * The probe is `onPath`, which resolves against the environment this server
 * was started from — the same one `launchWorkspace` hands the workspace's
 * tmux server, so what this sees is exactly what the respawned command will.
 */
export async function assertHostCanLaunch(opts: {
  tool: AgentTool
  mode: AgentMode
  onProgress?: (message: string) => void
}): Promise<void> {
  const { tool, mode, onProgress } = opts
  // In dependency order, so a host missing several is fixed from the bottom
  // up: no tmux means no session at all, and no git means no checkout to put
  // one in. Neither has an alternative because there is none — a workspace
  // on this substrate IS a tmux server over a git checkout.
  await requireBinary('tmux', 'every workspace here is a tmux session on this host',
    'apt install tmux / brew install tmux', null)
  await requireBinary('git', "it makes and reads the workspace's checkout",
    'apt install git / brew install git', null)
  await requireBinary('node', 'npm installs the agents under it, and acpd, codex and pi run under it',
    NODE_INSTALL, null)
  if (mode === 'acp') {
    // Before anything is installed, so a host that cannot run acp at all is
    // told so without first waiting on a download.
    await requireBinary('socat', "the chat transport dials acpd's socket with it",
      'apt install socat / brew install socat', 'create the workspace with --mode tui')
    const adapter = ACP_ADAPTERS[tool]
    await ensureAgentBinary(adapter.binary, onProgress)
    // An adapter that is a front end rather than an implementation needs the
    // tool beside it: codex-acp drives `codex app-server` and pi-acp drives
    // `pi --mode rpc`, so a host with the adapter and no CLI fails at the
    // first prompt instead of at the launch. claude's adapter bundles its own
    // SDK and needs nothing, and opencode IS its own adapter.
    if (adapter.needsCli && adapter.binary !== tool) await ensureAgentBinary(tool, onProgress)
    return
  }
  await ensureAgentBinary(tool, onProgress)
}

/**
 * `binary` resolves on PATH, or the create is refused with how to install
 * it — a message that says only what is wrong is barely better than the
 * spawn failure it replaces. `alternative` is what to do INSTEAD, or `null`
 * where nothing else will do, since inventing an alternative to tmux would
 * only mislead.
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

/**
 * Install the pinned package that ships `binary`, unless yaac already has.
 *
 * Into a staging prefix that is renamed into place only once the binary is
 * there, because the prefix's existence is what every later create reads as
 * "installed": an `npm` killed halfway (a server restart, the timeout) must
 * leave nothing that passes for an install. npm links a prefix's bin entries
 * relatively, so the rename leaves them resolving.
 *
 * Concurrent creates asking for the same package share one install: a
 * second npm into the same staging dir would race its file writes, and the
 * second has nothing to add. Another server sharing the data dir can still
 * race this one — whichever rename lands second finds the prefix taken and
 * drops its own copy, which was the same package.
 */
const installsInFlight = new Map<string, Promise<void>>()

/** Ten minutes: npm on a cold cache is slow, and the failure this whole path
 *  exists to prevent is worse than a long wait. */
const INSTALL_TIMEOUT_MS = 600_000

/** What marks a staging prefix, beside the prefix it will become. */
const STAGING_INFIX = '.partial-'

/**
 * Remove staging prefixes no install can still be writing: one older than
 * the install timeout was either discarded by its own install or abandoned
 * by a server that stopped mid-install (npm is not detached, so it can
 * outlive that server and finish into a staging dir nothing will rename),
 * and a timed-out install's postinstall grandchild can still be writing when
 * its `discard` runs. Each one is a whole package tree, claude's a large one.
 *
 * Safe against a second server sharing the data dir, because an install it
 * has running is younger than the timeout by construction.
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
  // A shared install still has to satisfy THIS caller, so its rejection
  // propagates here too rather than falling through to a second attempt.
  if (existing !== undefined) {
    await existing
    return
  }
  const run = (async () => {
    if (!(await onPath('npm'))) {
      throw new ServerError(
        'MISSING_TOOL',
        `yaac installs ${spec} with npm, and "npm" is not on this host's PATH. `
        + `Install ${NODE_INSTALL}, and retry.`,
      )
    }
    const staging = `${prefix}${STAGING_INFIX}${randomBytes(4).toString('hex')}`
    const discard = (): Promise<void> => fs.rm(staging, { recursive: true, force: true })
    await fs.mkdir(path.dirname(prefix), { recursive: true })
    await sweepAbandonedStaging(path.dirname(prefix))
    try {
      // `--engine-strict` because npm only WARNS about a node older than a
      // package's `engines` and installs anyway, and an install on a node the
      // agent cannot run under would then read as installed for good.
      //
      // The environment is the server's without its own wiring, as a
      // workspace's is: npm and the packages' install scripts are third-party
      // code run as the user.
      await runHost([
        'npm', 'install', '--global', '--engine-strict', '--prefix', staging,
        ...(pkg.runScripts ? [] : ['--ignore-scripts']),
        spec,
      ], { timeoutMs: INSTALL_TIMEOUT_MS, env: userEnvironment() })
    } catch (err) {
      await discard()
      // What failed is the run (a cold registry, no network), which is a
      // thing a user can fix and then retry into.
      throw new ServerError('MISSING_TOOL', `installing ${spec} failed${installerDetail(err)}`)
    }
    if (!(await fs.access(path.join(staging, 'bin', binary)).then(() => true, () => false))) {
      await discard()
      throw new ServerError('MISSING_TOOL', `installing ${spec} left no "${binary}" binary behind`)
    }
    // A rename that fails because the prefix is taken lost a race to an
    // identical install; any other failure leaves nothing installed.
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

/** The installer's own words, which is where "EAI_AGAIN, no network"
 *  actually lives. A timeout or spawn failure has no output to quote, so it
 *  degrades to the error's message. */
function installerDetail(err: unknown): string {
  if (err instanceof WorkspaceExecError) {
    return tailDetail(`${err.stdout}\n${err.stderr}`) || `: exit ${err.code}`
  }
  return `: ${err instanceof Error ? err.message : String(err)}`
}

/**
 * The interesting part of installer output, prefixed for an error message.
 * Bounded because npm's full log runs to pages.
 *
 * The tail is where the explanation lives, but the machine-readable line —
 * `npm error code EAI_AGAIN` — is printed near the TOP of the block and
 * scrolls off a tail-only window. Both halves are worth keeping: one tells a
 * person what happened, the other is what anyone automating against this
 * would match. So the code lines are lifted out and shown above a tail that
 * no longer repeats them.
 */
function tailDetail(output: string): string {
  const lines = output.split('\n').map((l) => l.trimEnd()).filter(Boolean)
  // `npm error code EACCES`, `npm ERR! code EACCES` — the one line worth
  // pulling forward from anywhere in the block.
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

  // Every webapp terminal sets its window to `window-size latest`, which
  // tmux only has from 3.1: below that the set fails and no agent or window
  // terminal opens at all. (The status watcher's control mode needs 3.0.)
  const version = await tmuxVersion()
  if (version !== null) {
    // A dev build reports `next-3.6` or `master`: newer than any floor.
    const m = /(\d+)\.(\d+)/.exec(version)
    const ok = !m || Number(m[1]) > 3 || (Number(m[1]) === 3 && Number(m[2]) >= 1)
    results.push({
      name: 'tmux version',
      status: ok ? 'pass' : 'fail',
      detail: `tmux ${version}`,
      ...(ok ? {} : { fix: 'yaac\'s terminals need tmux 3.1 or newer; upgrade tmux.' }),
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

  // The agents are yaac's to install, so what a host needs for them is npm;
  // listing what is already installed says which creates will not wait on
  // one.
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
        + 'each agent CLI and ACP adapter with npm.',
    }),
  })

  // A host that re-points its own tool homes. Workspaces ignore these (see
  // `overriddenToolHomeVars`), which is the right answer and an invisible
  // one: nothing inside a workspace looks different, so a user whose shell
  // has said for years that opencode lives elsewhere would have no way to
  // learn that yaac disagrees. Ahead of the create rather than only during
  // it, since this is a property of the host and `host check` is where a
  // reader comes to find those.
  const overridden = overriddenToolHomeVars()
  results.push({
    name: 'tool home overrides',
    status: overridden.length === 0 ? 'pass' : 'warn',
    detail: overridden.length === 0
      ? 'none set — agents resolve their config from this project\'s own dirs'
      : `${overridden.join(', ')} set here, not used inside workspaces`,
    ...(overridden.length === 0 ? {} : {
      fix: 'A workspace reads its tool config from this project\'s dirs — named '
        + 'outright where a tool has a home variable, and reached through its '
        + 'private HOME where none exists — so these are cleared rather than '
        + 'followed. Otherwise an agent would read your own config and '
        + 'credentials and write its transcripts where yaac does not look. '
        + 'Nothing to fix unless you meant a workspace to use them; per-workspace '
        + 'values go in the project config.',
    }),
  })

  // Not a check so much as the thing a reader most needs to be told: this
  // mode has no sandbox, and the agents run as this user.
  results.push({
    name: 'isolation',
    status: 'warn',
    detail: 'none — agents run as this user with full access to this machine',
    fix: 'Workspaces are not sandboxed in containerless mode. New workspaces '
      + 'default to accept-edits permissions; --permission-mode picks another.',
  })

  return results
}

async function tmuxVersion(): Promise<string | null> {
  try {
    const { stdout } = await runHost(['tmux', '-V'], { timeoutMs: 5_000 })
    return /tmux\s+(\S+)/.exec(stdout.trim())?.[1] ?? null
  } catch {
    return null
  }
}
