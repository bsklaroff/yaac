/**
 * `pnpm watch`: the dev loop for working on yaac itself. package.json runs
 * this under `tsx watch`, which reruns it when a build input changes. Each
 * run does `pnpm build:watch`, then `yaac server start`, falling back to
 * `yaac server restart` when start refuses because the live server has an
 * older buildId. The buildId is a content hash of dist/'s code, so an
 * unchanged build leaves the server running. `build:watch` skips the
 * frontend build when its inputs are unchanged
 * (scripts/build-frontend-if-changed.ts). A failed build skips the restart
 * and waits for the next change. Ctrl-C stops the watcher but not the
 * server.
 *
 * tsx kills only this wrapper on rerun, so the build runs in its own
 * process group and the signal handler kills the whole group. Otherwise a
 * save mid-build could leave an orphaned tsup/vite writing into dist/.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const repoRoot = path.resolve(path.dirname(__filename), '..')

let current: ChildProcess | null = null

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    const pid = current?.pid
    if (pid !== undefined) {
      try {
        process.kill(-pid, 'SIGTERM')
      } catch {
        // group already gone
      }
    }
    process.exit(0)
  })
}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    // pnpm sets verify_deps_before_run=false for script children, which
    // would stop the nested build from auto-installing after package.json
    // changes. Restoring `install` lets a stale node_modules heal itself;
    // no install lifecycle script here runs pnpm, so it cannot recurse.
    const child = spawn(cmd, args, {
      cwd: repoRoot,
      stdio: 'inherit',
      detached: true,
      env: { ...process.env, pnpm_config_verify_deps_before_run: 'install' },
    })
    current = child
    child.once('error', (err) => {
      current = null
      reject(err)
    })
    child.once('exit', (code) => {
      current = null
      if (code === 0) resolve()
      else reject(new Error(`${cmd} ${args.join(' ')} exited with code ${String(code)}`))
    })
  })
}

try {
  await run('pnpm', ['build:watch'])
  const cli = path.join(repoRoot, 'dist', 'cli.js')
  try {
    await run(process.execPath, [cli, 'server', 'start'])
  } catch {
    // start refuses when the live server is on an older buildId.
    await run(process.execPath, [cli, 'server', 'restart'])
  }
  console.error('[watch] build ok, server in sync — watching for changes')
} catch (err) {
  console.error(`[watch] ${err instanceof Error ? err.message : String(err)} — waiting for the next change`)
}
