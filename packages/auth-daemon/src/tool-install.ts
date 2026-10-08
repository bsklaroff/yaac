import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { resolveToolCliPath } from '#cli-resolve'
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
 *  - codex: the `install.sh` asset of the pinned release, run only if it
 *    matches the SHA-256 pinned beside the version. It installs the native
 *    binary into `~/.local/bin`. Neither installer needs Node on the machine.
 *
 * Success requires exit 0 and the CLI then resolving (#cli-resolve), since
 * the sign-in flow must be able to find it.
 */

type InstallSession = CliSession<ToolInstallView>

const registry = createCliSessionRegistry<InstallSession>({ noun: 'install session' })

/** Kill every installer subprocess and forget its session (auth-daemon
 *  shutdown, test isolation). */
export function killAllToolInstalls(): void {
  registry.killAll()
}

interface Installer {
  argv: string[]
  env?: NodeJS.ProcessEnv
  /** Removes what preparing it left on disk. */
  cleanup: () => Promise<void>
}

/** The command that installs a tool's CLI. */
async function prepareInstaller(tool: 'claude' | 'codex', signal: AbortSignal): Promise<Installer> {
  const none = (): Promise<void> => Promise.resolve()
  const hook = testEnv.toolInstallCliHook(tool)
  if (hook) return { argv: hook, cleanup: none }
  if (tool === 'claude') {
    const script = `set -o pipefail; curl -fsSL https://claude.ai/install.sh | bash -s ${AGENT_CLIS.claude.version}`
    return { argv: ['/bin/bash', '-c', script], cleanup: none }
  }
  const { version, installScriptSha256 } = AGENT_CLIS.codex
  const url = `https://github.com/openai/codex/releases/download/rust-v${version}/install.sh`
  const res = await fetch(url, { signal })
  if (!res.ok) throw new Error(`Could not download the Codex installer from ${url} (HTTP ${res.status}).`)
  const script = Buffer.from(await res.arrayBuffer())
  if (crypto.createHash('sha256').update(script).digest('hex') !== installScriptSha256) {
    throw new Error(`The Codex installer at ${url} does not match its pinned SHA-256, so it was not run.`)
  }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-codex-install-'))
  await fs.writeFile(path.join(dir, 'install.sh'), script, { mode: 0o700 })
  return {
    argv: ['/bin/bash', path.join(dir, 'install.sh'), '--release', version],
    // eslint-disable-next-line no-process-env -- env forwarded wholesale to the installer
    env: { ...process.env, CODEX_NON_INTERACTIVE: '1' },
    cleanup: () => fs.rm(dir, { recursive: true, force: true }),
  }
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
  // Until the installer is spawned, killing the session aborts preparing it.
  const abort = new AbortController()
  s.proc = { kill: () => abort.abort() }
  prepareInstaller(tool, abort.signal)
    .then((installer) => {
      if (abort.signal.aborted) void installer.cleanup()
      else runInstaller(s, tool, installer)
    })
    .catch((err: unknown) => {
      if (!abort.signal.aborted) registry.finish(s, 'error', err instanceof Error ? err.message : String(err))
    })
  return getToolInstall(s.view.id)
}

function runInstaller(s: InstallSession, tool: 'claude' | 'codex', { argv, env, cleanup }: Installer): void {
  const child = spawn(argv[0], argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'], env })
  s.proc = { kill: () => child.kill() }
  child.stdout.on('data', (d: Buffer) => { registry.ingest(s, d.toString('utf8')) })
  child.stderr.on('data', (d: Buffer) => { registry.ingest(s, d.toString('utf8')) })
  child.on('error', (err) => {
    void cleanup()
    registry.finish(s, 'error', err.message)
  })
  child.on('close', (code) => {
    void cleanup()
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
}

/** Poll an install's state (output included so the user can watch progress). */
export function getToolInstall(id: string): ToolInstallView {
  return registry.getView(id)
}

/** Kill an install flow and forget it. Unknown ids are a no-op (already gone). */
export function cancelToolInstall(id: string): void {
  registry.cancel(id)
}
