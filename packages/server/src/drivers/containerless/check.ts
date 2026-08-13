import { AGENT_TOOLS, type CheckResult } from '@yaac/shared/types'
import { onPath, runHost } from './host'

/** The adapter binaries `--mode acp` can run. Kept here rather than
 *  imported from `#runtime/agents`, which a driver may not name. */
const ACP_ADAPTER_BINARIES = ['claude-agent-acp'] as const

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
    fix: 'Install socat to use --mode acp; tui-mode worktrees do not need it.',
  },
]

/**
 * Whether an agent's ACP adapter is runnable on this host.
 *
 * Under the pod driver the adapter ships in the image, so its presence is a
 * build-time fact. Here it has to be installed like every other tool, and
 * without it acpd execs nothing: it exits 127, tmux closes the window, and
 * the worktree ends seconds after a create that reported success. So the
 * create asks first.
 */
export async function acpAdapterRunnable(adapter: string): Promise<boolean> {
  return await onPath(adapter)
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
      fix: 'Install an ACP adapter (e.g. claude-agent-acp) to create worktrees '
        + 'with --mode acp; tui-mode worktrees do not need one.',
    }),
  })
  results.push({
    name: 'agent CLIs',
    status: agents.length > 0 ? 'pass' : 'warn',
    detail: agents.length > 0 ? agents.join(', ') : 'none found on PATH',
    ...(agents.length > 0 ? {} : {
      fix: 'Install at least one agent CLI (claude, codex, opencode, pi) — '
        + 'a worktree runs whichever tool it was created with.',
    }),
  })

  // Not a check so much as the thing a reader most needs to be told: this
  // mode has no sandbox, and the agents run as this user.
  results.push({
    name: 'isolation',
    status: 'warn',
    detail: 'none — agents run as this user with full access to this machine',
    fix: 'Worktrees are not sandboxed in containerless mode. Auto-approve is '
      + 'off by default per worktree ("yolo mode" opts in).',
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
