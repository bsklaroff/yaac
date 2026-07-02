/**
 * `pnpm watch` — dev loop for working on yaac itself (including inside
 * a yaac-in-yaac session). package.json runs this under `tsx watch`,
 * which reruns it whenever a build input changes; each run does
 * `pnpm build` then `yaac daemon restart` so the running daemon always
 * matches the CLI's buildId. A failed build skips the restart and the
 * watcher waits for the next change. Ctrl-C stops the watcher but
 * leaves the daemon running.
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
  await run(process.execPath, [path.join(repoRoot, 'dist', 'cli.js'), 'daemon', 'restart'])
  console.error('[watch] build ok, daemon restarted — watching for changes')
} catch (err) {
  console.error(`[watch] ${err instanceof Error ? err.message : String(err)} — waiting for the next change`)
}
