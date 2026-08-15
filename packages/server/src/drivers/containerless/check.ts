import { MissingToolError, ServerError } from '@yaac/shared/errors'
import { AGENT_INSTALL, installCommandFor } from '@yaac/shared/tool-install'
import { AGENT_TOOLS, type AgentMode, type AgentTool, type CheckResult } from '@yaac/shared/types'
import { WorkspaceExecError } from '#drivers/contract'
import { onPath, runHost } from './host'

/** The adapter binaries `--mode acp` can run. Kept here rather than
 *  imported from `#runtime/agents`, which a driver may not name. */
const ACP_ADAPTER_BINARIES = ['claude-agent-acp'] as const

/** The host binary each tool's ACP adapter installs as — the same table, by
 *  the tool that needs it. */
const ACP_ADAPTERS: Partial<Record<AgentTool, string>> = { claude: 'claude-agent-acp' }

/**
 * `yaac host check`: whether this machine can run worktrees without
 * containers.
 *
 * The parallel of `yaac cluster check`, and the reason the layering doc
 * keeps a door open through the package exports for exactly this — "a
 * host-process driver would ship its own doctor". It answers the same
 * question that one does, against a different substrate: with no image to
 * install anything, every tool a worktree needs has to already be on this
 * host, and the failure mode without this check is a tmux window that opens
 * and immediately exits with nobody watching.
 *
 * Warnings, not failures, for the agent CLIs: which ones a user has is
 * their business, and a host with only one of them runs worktrees for that
 * one perfectly well.
 */

/** What a worktree cannot run without at all. */
const REQUIRED: Array<{ binary: string; why: string; fix: string }> = [
  {
    binary: 'tmux',
    why: 'supervises every worktree session and outlives the server',
    fix: 'Install tmux (apt install tmux / brew install tmux).',
  },
  {
    binary: 'git',
    why: 'creates and reads every worktree checkout',
    fix: 'Install git.',
  },
]

/** What degrades a feature rather than breaking the mode. */
const OPTIONAL: Array<{ binary: string; why: string; fix: string }> = [
  {
    binary: 'lsof',
    why: 'detects the ports a worktree is listening on',
    fix: 'Install lsof to get clickable port links; worktrees run fine without it.',
  },
  {
    binary: 'socat',
    why: 'carries the ACP chat transport to an agent',
    fix: 'Install socat (apt install socat / brew install socat) to use --mode acp, '
      + 'which is refused without it; tui-mode worktrees do not need it.',
  },
]

/**
 * See `WorktreeDriver.assertCanLaunch` — this driver's answer.
 *
 * Under the pod driver every tool ships in the image, so what a worktree can
 * run is a build-time fact. Here it has to be installed like anything else,
 * and the failure without this check is silent both ways: a `tui` agent that
 * is not on PATH makes tmux respawn a command that exits 127, closing the
 * window — and `respawn-window` reports success — while `acp` has acpd exec
 * nothing and end the same way. Either leaves a worktree that vanishes
 * seconds after a create that already said it worked. So the create asks
 * first.
 *
 * WHICH binary has to be there differs by mode, and only by mode: `tui` runs
 * the tool itself, while `acp` runs the tool's adapter — which bundles its
 * own SDK rather than shelling out to the tool, so an acp worktree needs the
 * adapter and not the CLI. `acp` needs `socat` besides, because the chat
 * transport dials acpd's UNIX socket by spawning one on this host: without
 * it the worktree comes up and its pane never attaches, which reads as an
 * agent that hangs rather than a tool that is missing — a worse failure than
 * the one this whole check exists to replace, and the reason it is refused
 * here rather than warned about in `yaac host check` alone.
 *
 * The probe is `onPath`, which resolves against the environment this server
 * was started from — the same one `launchWorkspace` hands the workspace's
 * tmux server, so what this sees is exactly what the respawned command will.
 * A binary reachable only through an interactive shell's rc files is missed
 * by both, consistently, which is the failure worth reporting.
 *
 * With `installMissing`, a missing binary is installed rather than refused
 * (see `installBinary`); the caller's `onProgress` narrates it.
 */
export async function assertHostCanLaunch(opts: {
  tool: AgentTool
  mode: AgentMode
  installMissing?: boolean
  onProgress?: (message: string) => void
}): Promise<void> {
  const { tool, mode } = opts
  if (mode === 'acp') {
    const adapter = ACP_ADAPTERS[tool]
    if (adapter === undefined) {
      // Create rejects this combination before it ever reaches a runtime;
      // reachable only from a caller that skipped it.
      throw new ServerError('VALIDATION', `${tool} has no ACP adapter; use --mode tui`)
    }
    await requireBinary(adapter, `--mode acp runs ${adapter}`, opts)
    await requireBinary('socat', "the chat transport dials acpd's socket with it", {
      ...opts,
      manual: 'apt install socat / brew install socat',
      alternative: 'create the worktree with --mode tui',
    })
    return
  }
  await requireBinary(tool, `a tui worktree runs ${tool}`, opts)
}

/**
 * `binary` resolves on PATH — installing it first when asked to, and
 * refusing with what to run when not.
 *
 * The refusal names the install command because a message that says only
 * what is wrong is barely better than the spawn failure it replaces, and
 * because it is the whole of the recovery on a client that has no button
 * (the CLI, and a webapp row reloaded after the closure that could retry it
 * is gone).
 */
async function requireBinary(
  binary: string,
  why: string,
  opts: {
    installMissing?: boolean
    onProgress?: (message: string) => void
    /** How to install a binary the npm table does not cover, since a reader
     *  told only that something is missing is barely better off. */
    manual?: string
    /** What to do INSTEAD, for a reader who would rather not install
     *  anything. Defaults to the agent CLIs' answer. */
    alternative?: string
  },
): Promise<void> {
  if (await onPath(binary)) return
  const install = installCommandFor(binary)
  if (opts.installMissing === true && install !== undefined) {
    await installBinary(binary, install, opts.onProgress)
    return
  }
  const alternative = opts.alternative ?? 'pick a tool this host has'
  throw new MissingToolError(
    `"${binary}" is not on this host's PATH — ${why}, and this server runs `
    + 'agents as host processes with no image to supply one.'
    // No `--install-missing` offer without a table entry: yaac runs npm, and
    // the package manager that carries socat wants a root it does not have.
    + (install === undefined
      ? ` Install it${opts.manual === undefined ? '' : ` (${opts.manual})`} and retry, `
        + `or ${alternative}.`
      : ` Install it (${install}) and retry, retry with --install-missing to `
        + `let yaac run that command, or ${alternative}.`),
    install !== undefined,
  )
}

/**
 * Run an install command from the shared table and confirm it landed.
 *
 * The re-probe is the point. `npm -g` fails in ways that are invisible to
 * its exit code's absence — a prefix the user cannot write, a bin dir that
 * is not on this server's PATH — and without checking, an "install" would
 * hand back a worktree that dies exactly as it would have before, having
 * spent a minute to do it. Reporting the installer's own output is what
 * turns EACCES into something a reader can act on.
 *
 * Concurrent creates asking for the same binary share one install: two
 * `npm -g` runs into one prefix race each other's file writes, and the
 * second has nothing to add.
 */
const installsInFlight = new Map<string, Promise<void>>()

async function installBinary(
  binary: string,
  command: string,
  onProgress?: (message: string) => void,
): Promise<void> {
  onProgress?.(`Installing ${binary} (${command})…`)
  const existing = installsInFlight.get(binary)
  // A shared install still has to satisfy THIS caller, so its rejection
  // propagates here too rather than falling through to a second attempt.
  if (existing !== undefined) {
    await existing
    return
  }
  const run = (async () => {
    let output = ''
    try {
      // Ten minutes: `npm -g` on a cold cache is slow, and the failure this
      // whole path exists to prevent is worse than a long wait. The command
      // is a fixed table entry, never anything a caller supplied, so there
      // is nothing here to escape.
      const res = await runHost(['sh', '-c', command], { timeoutMs: 600_000 })
      output = `${res.stdout}\n${res.stderr}`
    } catch (err) {
      // Installable: the command exists and yaac ran it. What failed is the
      // run (a prefix it cannot write, a cold registry), which is a thing a
      // user can fix and then retry into.
      throw new MissingToolError(
        `installing ${binary} failed (${command})${installerDetail(err)}`,
        true,
      )
    }
    if (!(await onPath(binary))) {
      // Installable too, and for the same reason: what is wrong is where the
      // command put things, not whether one exists.
      throw new MissingToolError(
        `${command} reported success but "${binary}" is still not on this `
        + "server's PATH — its bin directory may not be on the PATH this "
        + `server was started with${tailDetail(output)}`,
        true,
      )
    }
  })()
  installsInFlight.set(binary, run)
  try {
    await run
  } finally {
    installsInFlight.delete(binary)
  }
}

/** The installer's own words, which is where "EACCES, needs a writable
 *  prefix" actually lives. A timeout or spawn failure has no output to
 *  quote, so it degrades to the error's message. */
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
 * The tail is where the explanation lives ("do not have the permissions to
 * access this file"), but the machine-readable line — `npm error code
 * EACCES` — is printed near the TOP of the block and scrolls off a
 * tail-only window. Both halves are worth keeping: one tells a person what
 * happened, the other is what anyone automating against this would match.
 * So the code lines are lifted out and shown above a tail that no longer
 * repeats them.
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

  // tmux's control mode is what the status watcher attaches with, and its
  // `-C` behavior is only dependable from 3.0 on. A host with an ancient
  // tmux gets a worktree whose agent status never updates.
  const version = await tmuxVersion()
  if (version !== null) {
    const major = Number(/^(\d+)/.exec(version)?.[1] ?? '0')
    const ok = major >= 3
    results.push({
      name: 'tmux version',
      status: ok ? 'pass' : 'warn',
      detail: `tmux ${version}`,
      ...(ok ? {} : { fix: 'yaac drives tmux control mode; upgrade to tmux 3.0 or newer.' }),
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

  const agents: string[] = []
  for (const tool of AGENT_TOOLS) {
    if (await onPath(tool)) agents.push(tool)
  }
  // The adapters are what `--mode acp` runs, and they are separate packages
  // from the agents themselves. Reported so a user who wants a chat pane
  // learns it here rather than from a worktree that vanishes.
  const adapters: string[] = []
  for (const adapter of ACP_ADAPTER_BINARIES) {
    if (await onPath(adapter)) adapters.push(adapter)
  }
  results.push({
    name: 'ACP adapters',
    status: adapters.length > 0 ? 'pass' : 'warn',
    detail: adapters.length > 0 ? adapters.join(', ') : 'none found on PATH',
    ...(adapters.length > 0 ? {} : {
      fix: 'Install an ACP adapter to create worktrees with --mode acp '
        + `(${ACP_ADAPTER_BINARIES.map((a) => installCommandFor(a) ?? a).join('; ')}); `
        + 'tui-mode worktrees do not need one.',
    }),
  })
  results.push({
    name: 'agent CLIs',
    status: agents.length > 0 ? 'pass' : 'warn',
    detail: agents.length > 0 ? agents.join(', ') : 'none found on PATH',
    ...(agents.length > 0 ? {} : {
      fix: 'Install at least one agent CLI — a worktree runs whichever tool '
        + `it was created with (${AGENT_TOOLS.map((t) => AGENT_INSTALL[t]).join('; ')}).`,
    }),
  })

  // Not a check so much as the thing a reader most needs to be told: this
  // mode has no sandbox, and the agents run as this user.
  results.push({
    name: 'isolation',
    status: 'warn',
    detail: 'none — agents run as this user with full access to this machine',
    fix: 'Worktrees are not sandboxed in containerless mode. New worktrees '
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
