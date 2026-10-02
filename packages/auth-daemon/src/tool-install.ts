import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { resolveCommandPath, resolveToolCliPath } from '#cli-resolve'
import { createCliSessionRegistry, outputTail, type CliSession } from '#cli-session'
import { testEnv } from '@yaac/shared/env'
import { AGENT_CLIS, type ToolInstallView } from '@yaac/shared/types'

/**
 * Web-driven CLI install. When a sign-in fails because the vendor CLI is
 * missing (ToolLoginView.cliMissing), the webapp offers an "Install" button
 * that runs the vendor's installer on this machine, at the version pinned in
 * `AGENT_CLIS`:
 *
 *  - claude: the official standalone installer (`curl | bash`, into
 *    `~/.local/bin`).
 *  - codex: `npm install -g @openai/codex@<version>`. There is no Homebrew
 *    fallback because a formula cannot be pinned to a version.
 *
 * Success requires exit 0 and the CLI then resolving on $PATH, since the
 * sign-in flow must be able to find it.
 */

type InstallSession = CliSession<ToolInstallView>

const registry = createCliSessionRegistry<InstallSession>({ noun: 'install session' })

/** Kill every installer subprocess and forget its session (auth-daemon
 *  shutdown, test isolation). */
export function killAllToolInstalls(): void {
  registry.killAll()
}

/** The argv that installs a tool's CLI, or null when no installer can run. */
function installArgv(tool: 'claude' | 'codex'): string[] | null {
  const hook = testEnv.toolInstallCliHook(tool)
  if (hook) return hook
  const { package: pkg, version } = AGENT_CLIS[tool]
  if (tool === 'claude') {
    return ['/bin/bash', '-c', `set -o pipefail; curl -fsSL https://claude.ai/install.sh | bash -s ${version}`]
  }
  const npm = resolveCommandPath('npm')
  return npm ? [npm, 'install', '-g', `${pkg}@${version}`] : null
}

/**
 * Start (or restart) the install flow for a tool, cancelling any install
 * still running for it. The relay passes the server-minted `id`; tests may
 * omit it.
 */
export function startToolInstall(tool: 'claude' | 'codex', id?: string): ToolInstallView {
  const existing = registry.liveForTool(tool)
  if (existing) cancelToolInstall(existing.view.id)

  const s = registry.create(
    { id: id ?? crypto.randomUUID(), tool, status: 'running' },
    'Install timed out after 15 minutes.',
    {},
  )

  const argv = installArgv(tool)
  if (!argv) {
    const { package: pkg, version } = AGENT_CLIS.codex
    registry.finish(s, 'error', `npm was not found — install Codex manually: npm install -g ${pkg}@${version}`)
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
