import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { globalTrashDir, serverLocalTrashDir } from '@yaac/shared/project-paths'
import { serverLog } from './log'

/*
 * Deleting a large directory without making its caller wait. The directory
 * is renamed into its tier's trash, which is instant even on NFS, and a
 * separate `rm -rf` process empties the trash. Removing it in-process
 * (`fs.rm`) would occupy libuv's small thread pool for as long as the disk
 * takes, starving every other file operation the server makes, the lock
 * lease's renewal among them.
 */

let emptying: Promise<void> | undefined
let again = false

/**
 * Rename `dir` into `trash`, which must be on the same filesystem, and start
 * emptying the trash. A missing `dir` is already gone.
 */
export async function moveToTrash(dir: string, trash: string): Promise<void> {
  await fs.mkdir(trash, { recursive: true })
  try {
    await fs.rename(dir, path.join(trash, `${path.basename(dir)}-${crypto.randomUUID()}`))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
    throw err
  }
  void emptyTrash()
}

/**
 * Remove everything in both tiers' trash with one `rm -rf` process at a
 * time, including what a crash left there. A call while one is running
 * makes that run go round again, so what was trashed meanwhile goes too.
 * Never rejects; a failure is logged and the next call retries.
 */
export function emptyTrash(): Promise<void> {
  if (emptying) {
    again = true
    return emptying
  }
  emptying = (async () => {
    try {
      do {
        again = false
        const entries = (await Promise.all([globalTrashDir(), serverLocalTrashDir()].map(async (trash) =>
          (await fs.readdir(trash).catch(() => [])).map((name) => path.join(trash, name))))).flat()
        if (entries.length > 0) await removeTree(entries)
      } while (again)
    } catch (err) {
      serverLog(`[server] emptying the trash: ${String(err)}`)
    } finally {
      emptying = undefined
    }
  })()
  return emptying
}

function removeTree(paths: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const rm = spawn('rm', ['-rf', '--', ...paths], { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    rm.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    rm.on('error', reject)
    rm.on('close', (code) => code === 0 ? resolve() : reject(new Error(`rm exited ${code}: ${stderr.trim()}`)))
  })
}
