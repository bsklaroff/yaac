import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { resolveCommandPath, resolveToolCliPath } from '@/daemon/cli-resolve'
import { createCliSessionRegistry, outputTail, type CliSession } from '@/daemon/cli-session'
import { testEnv } from '@/shared/env'
import type { ToolInstallView } from '@/shared/types'

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
 * Session lifecycle mirrors tool-login's via the shared cli-session
 * registry: one per tool, polled by the webapp, lingering after finishing so
 * polling sees the terminal state. Success is exit 0 *plus* the CLI actually
 * resolving afterwards — an installer that "succeeds" into a directory the
 * sign-in flow can't see is still a failure.
 */

type InstallSession = CliSession<ToolInstallView>

const registry = createCliSessionRegistry<InstallSession>({ noun: 'install session' })

/** Drop every session (test isolation). */
export function clearAllToolInstallsForTests(): void {
  registry.clearAllForTests()
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
export function startToolInstall(tool: 'claude' | 'codex'): ToolInstallView {
  const existing = registry.liveForTool(tool)
  if (existing) cancelToolInstall(existing.view.id)

  const s = registry.create(
    { id: crypto.randomUUID(), tool, status: 'running' },
    'Install timed out after 15 minutes.',
    {},
  )

  const argv = installArgv(tool)
  if (!argv) {
    registry.finish(s, 'error', 'Neither npm nor Homebrew was found — install Codex manually: npm install -g @openai/codex')
    return getToolInstall(s.view.id)
  }
  const child = spawn(argv[0], argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] })
  s.proc = { kill: () => child.kill() }
  child.stdout.on('data', (d: Buffer) => { registry.ingest(s, d.toString('utf8')) })
  child.stderr.on('data', (d: Buffer) => { registry.ingest(s, d.toString('utf8')) })
  child.on('error', (err) => registry.finish(s, 'error', err.message))
  child.on('close', (code) => {
    if (s.view.status !== 'running') return
    if (code !== 0) {
      registry.finish(s, 'error', outputTail(s.buf) || `Installer exited with code ${String(code)}.`)
      return
    }
    // Exit 0 alone isn't "installed" — the sign-in flow must be able to find
    // the binary on the daemon's $PATH.
    if (resolveToolCliPath(tool) === null) {
      registry.finish(s, 'error', 'The installer finished but the CLI still cannot be found on this machine.')
      return
    }
    registry.finish(s, 'success')
  })
  return getToolInstall(s.view.id)
}

/** Poll an install's state (output included so the user can watch progress). */
export function getToolInstall(id: string): ToolInstallView {
  return registry.getView(id)
}

/** Kill an install flow and forget it. Unknown ids are a no-op (already gone). */
export function cancelToolInstall(id: string): void {
  registry.cancel(id)
}
