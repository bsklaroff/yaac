import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { resolveCommandPath, resolveToolCliPath } from '@/daemon/cli-resolve'
import { outputTail, presentableOutput, stripAnsi } from '@/daemon/tool-login'
import { DaemonError } from '@/daemon/errors'
import { testEnv } from '@/shared/env'
import type { AgentTool, ToolInstallView } from '@/shared/types'

/**
 * Web-driven CLI install: when a sign-in fails because the vendor CLI is not
 * installed (ToolLoginView.cliMissing), the webapp offers an "Install …"
 * button that runs the vendor's install here in the daemon:
 *
 *  - claude: the official standalone installer (`curl | bash`, lands in
 *    `~/.local/bin`).
 *  - codex: `npm install -g @openai/codex` (OpenAI's recommended path),
 *    falling back to `brew install codex` when npm isn't around.
 *
 * Sessions mirror tool-login's shape: one per tool, polled by the webapp,
 * lingering after finishing so polling sees the terminal state. Success is
 * exit 0 *plus* the CLI actually resolving afterwards — an installer that
 * "succeeds" into a directory the sign-in flow can't see is still a failure.
 */

export type { ToolInstallView }

/** How long an install may run before it is killed. */
const INSTALL_TIMEOUT_MS = 15 * 60 * 1000
/** How long a finished install stays pollable before it is dropped. */
const LINGER_MS = 5 * 60 * 1000

interface InstallSession {
  view: ToolInstallView
  /** Accumulated ANSI-stripped installer output. */
  buf: string
  proc: { kill: () => void } | null
  timer: ReturnType<typeof setTimeout>
}

const sessions = new Map<string, InstallSession>()

/** Drop every session (test isolation). */
export function clearAllToolInstallsForTests(): void {
  for (const s of sessions.values()) {
    clearTimeout(s.timer)
    s.proc?.kill()
  }
  sessions.clear()
}

function liveSessionForTool(tool: AgentTool): InstallSession | undefined {
  for (const s of sessions.values()) {
    if (s.view.tool === tool && s.proc) return s
  }
  return undefined
}

function finish(s: InstallSession, status: 'success' | 'error', error?: string): void {
  s.proc?.kill()
  s.proc = null
  s.view.status = status
  s.view.error = error
  clearTimeout(s.timer)
  s.timer = setTimeout(() => { sessions.delete(s.view.id) }, LINGER_MS)
  s.timer.unref?.()
}

/** The argv that installs a tool's CLI, or null when no installer can run. */
function installArgv(tool: 'claude' | 'codex'): string[] | null {
  const hook = testEnv.toolInstallCliHook(tool)
  if (hook) return hook
  if (tool === 'claude') {
    return ['/bin/bash', '-c', 'set -o pipefail; curl -fsSL https://claude.ai/install.sh | bash']
  }
  const npm = resolveCommandPath('npm')
  if (npm) return [npm, 'install', '-g', '@openai/codex']
  const brew = resolveCommandPath('brew')
  if (brew) return [brew, 'install', 'codex']
  return null
}

/**
 * Start (or restart) the install flow for a tool. Any still-running install
 * for the same tool is cancelled first — the webapp drives one at a time.
 */
export function startToolInstall(tool: AgentTool): ToolInstallView {
  if (tool !== 'claude' && tool !== 'codex') {
    throw new DaemonError('VALIDATION', 'Web install exists for claude and codex only.')
  }
  const existing = liveSessionForTool(tool)
  if (existing) cancelToolInstall(existing.view.id)

  const s: InstallSession = {
    view: { id: crypto.randomUUID(), tool, status: 'running' },
    buf: '',
    proc: null,
    timer: setTimeout(() => {
      finish(s, 'error', 'Install timed out after 15 minutes.')
    }, INSTALL_TIMEOUT_MS),
  }
  s.timer.unref?.()
  sessions.set(s.view.id, s)

  const argv = installArgv(tool)
  if (!argv) {
    finish(s, 'error', 'Neither npm nor Homebrew was found — install Codex manually: npm install -g @openai/codex')
    return getToolInstall(s.view.id)
  }
  const child = spawn(argv[0], argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] })
  s.proc = { kill: () => child.kill() }
  child.stdout.on('data', (d: Buffer) => { s.buf += stripAnsi(d.toString('utf8')) })
  child.stderr.on('data', (d: Buffer) => { s.buf += stripAnsi(d.toString('utf8')) })
  child.on('error', (err) => finish(s, 'error', err.message))
  child.on('close', (code) => {
    if (s.view.status !== 'running') return
    if (code !== 0) {
      finish(s, 'error', outputTail(s.buf) || `Installer exited with code ${String(code)}.`)
      return
    }
    // Exit 0 alone isn't "installed" — the sign-in flow must be able to find
    // the binary on the daemon's $PATH.
    if (resolveToolCliPath(tool) === null) {
      finish(s, 'error', 'The installer finished but the CLI still cannot be found on this machine.')
      return
    }
    finish(s, 'success')
  })
  return getToolInstall(s.view.id)
}

/** Poll an install's state (output included so the user can watch progress). */
export function getToolInstall(id: string): ToolInstallView {
  const s = sessions.get(id)
  if (!s) throw new DaemonError('NOT_FOUND', `No install session "${id}".`)
  return { ...s.view, output: presentableOutput(s.buf) }
}

/** Kill an install flow and forget it. Unknown ids are a no-op (already gone). */
export function cancelToolInstall(id: string): void {
  const s = sessions.get(id)
  if (!s) return
  clearTimeout(s.timer)
  s.proc?.kill()
  s.proc = null
  sessions.delete(id)
}
