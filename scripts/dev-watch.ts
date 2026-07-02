/**
 * `pnpm watch` — dev loop for working on yaac itself (including inside
 * a yaac-in-yaac session). package.json runs this under `tsx watch`,
 * which reruns it whenever a build input changes; each run does
 * `pnpm build` then `yaac daemon start`, falling back to `yaac daemon
 * restart` when start refuses (live daemon on an older buildId), so
 * the running daemon always matches the CLI's buildId. The build is
 * deterministic (buildId is a content hash of dist/), so the initial
 * run after `yaac daemon start` in initCommands leaves the daemon
 * untouched instead of bouncing it. A failed build skips the
 * (re)start and the watcher waits for the next change. Ctrl-C stops
 * the watcher but leaves the daemon running.
 *
 * tsx kills only this wrapper on rerun, so the build is spawned in its
 * own process group and the signal handler forwards the kill to the
 * whole group — a save landing mid-build can't leave an orphaned
 * tsup/vite racing the next build into dist/.
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
    // detached: own process group, so the signal handler above can kill
    // the full tree (pnpm -> sh -> tsup/vite) with one group signal.
    const child = spawn(cmd, args, { cwd: repoRoot, stdio: 'inherit', detached: true })
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
  await run('pnpm', ['build'])
  const cli = path.join(repoRoot, 'dist', 'cli.js')
  try {
    await run(process.execPath, [cli, 'daemon', 'start'])
  } catch {
    // start throws when a live daemon is on an older buildId — bounce it.
    await run(process.execPath, [cli, 'daemon', 'restart'])
  }
  console.error('[watch] build ok, daemon in sync — watching for changes')
} catch (err) {
  console.error(`[watch] ${err instanceof Error ? err.message : String(err)} — waiting for the next change`)
}
