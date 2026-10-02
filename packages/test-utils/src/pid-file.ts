import fs from 'node:fs/promises'
import path from 'node:path'

/**
 * Claim `file` for this process by writing its pid there, atomically across
 * processes. A claim whose process is gone is taken over. False when a live
 * process (this one included) holds it, or its claim is still being
 * written.
 */
export async function claimPidFile(file: string): Promise<boolean> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  for (;;) {
    try {
      await fs.writeFile(file, String(process.pid), { flag: 'wx' })
      return true
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    }
    const holder = Number.parseInt(await fs.readFile(file, 'utf8').catch(() => ''), 10)
    if (Number.isNaN(holder) || holder === process.pid || pidAlive(holder)) return false
    await fs.unlink(file).catch(() => { /* another process took it over first */ })
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
