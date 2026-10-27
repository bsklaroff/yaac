import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createReadStream } from 'node:fs'
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
 *  - claude: the pinned release binary, run only if it matches the SHA-256
 *    pinned for this platform. Its own `install` downloads the version
 *    again into `~/.local/share/claude/versions` and links it into
 *    `~/.local/bin`, so that copy is checked against the same pin, and
 *    deleted if it does not match.
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
  /** Rejects if what the installer left behind is not the pinned build. */
  verify?: () => Promise<void>
}

async function fileSha256(file: string): Promise<string> {
  const hash = crypto.createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

/**
 * Download `url` into a fresh temp dir as `name`, refusing it unless its
 * SHA-256 is `sha256`. Returns the file and what removes the dir.
 */
async function fetchPinned(
  url: string,
  sha256: string,
  name: string,
  signal: AbortSignal,
): Promise<{ file: string; cleanup: () => Promise<void> }> {
  const res = await fetch(url, { signal })
  if (!res.ok || !res.body) throw new Error(`Could not download ${url} (HTTP ${res.status}).`)
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-tool-install-'))
  const file = path.join(dir, name)
  const cleanup = (): Promise<void> => fs.rm(dir, { recursive: true, force: true })
  const hash = crypto.createHash('sha256')
  try {
    const out = await fs.open(file, 'w', 0o700)
    try {
      for await (const chunk of res.body) {
        hash.update(chunk)
        await out.write(chunk)
      }
    } finally {
      await out.close()
    }
    if (hash.digest('hex') !== sha256) {
      throw new Error(`The download from ${url} does not match its pinned SHA-256, so it was not run.`)
    }
  } catch (err) {
    await cleanup()
    throw err
  }
  return { file, cleanup }
}

/** claude's name for this machine's release build (`linux-x64-musl`). */
function claudePlatform(): string {
  const platform = `${process.platform}-${process.arch}`
  if (process.platform !== 'linux') return platform
  const { header } = process.report.getReport() as { header: { glibcVersionRuntime?: string } }
  return header.glibcVersionRuntime ? platform : `${platform}-musl`
}

/** The command that installs a tool's CLI. */
async function prepareInstaller(tool: 'claude' | 'codex', signal: AbortSignal): Promise<Installer> {
  const hook = testEnv.toolInstallCliHook(tool)
  if (hook) return { argv: hook, cleanup: () => Promise.resolve() }
  if (tool === 'claude') {
    const { version, binarySha256 } = AGENT_CLIS.claude
    const platform = claudePlatform()
    const sha256 = binarySha256[platform]
    if (!sha256) throw new Error(`Claude Code ${version} has no pinned build for ${platform}.`)
    const url = `https://downloads.claude.ai/claude-code-releases/${version}/${platform}/claude`
    const { file, cleanup } = await fetchPinned(url, sha256, 'claude', signal)
    const installed = path.join(os.homedir(), '.local', 'share', 'claude', 'versions', version)
    const verify = async (): Promise<void> => {
      if (await fileSha256(installed) === sha256) return
      await fs.rm(installed, { force: true })
      throw new Error(`The Claude Code ${version} that its installer downloaded to ${installed} `
        + 'does not match its pinned SHA-256, so it was deleted.')
    }
    return { argv: [file, 'install', version], cleanup, verify }
  }
  const { version, installScriptSha256 } = AGENT_CLIS.codex
  const url = `https://github.com/openai/codex/releases/download/rust-v${version}/install.sh`
  const { file, cleanup } = await fetchPinned(url, installScriptSha256, 'install.sh', signal)
  return {
    argv: ['/bin/bash', file, '--release', version],
    // eslint-disable-next-line no-process-env -- env forwarded wholesale to the installer
    env: { ...process.env, CODEX_NON_INTERACTIVE: '1' },
    cleanup,
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

function runInstaller(s: InstallSession, tool: 'claude' | 'codex', { argv, env, cleanup, verify }: Installer): void {
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
    void (verify?.() ?? Promise.resolve()).then(() => {
      if (s.view.status !== 'running') return
      if (resolveToolCliPath(tool) === null) {
        registry.finish(s, 'error', 'The installer finished but the CLI still cannot be found on this machine.')
        return
      }
      registry.finish(s, 'success')
    }, (err: unknown) => {
      if (s.view.status === 'running') registry.finish(s, 'error', err instanceof Error ? err.message : String(err))
    })
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
