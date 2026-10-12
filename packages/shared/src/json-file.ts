import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

/**
 * Small JSON files the client tier and the install record keep: read
 * tolerantly, and written so a crash or a concurrent writer never leaves a
 * torn file behind.
 */

/** The parsed object, `'absent'` when there is no file, null when it is not a JSON object. */
export async function readJsonFile(file: string): Promise<Record<string, unknown> | 'absent' | null> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(file, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : null
  }
}

/**
 * Write at 0600 through a synced temp file, then rename it over `file`, or
 * with `exclusive` link it into place only if `file` does not exist yet.
 * Returns false when `exclusive` found a file there.
 */
export async function writeJsonFile(file: string, value: unknown, opts: { exclusive?: boolean } = {}): Promise<boolean> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  // Unique per call: two writers in one process must not share a temp file.
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`
  try {
    const handle = await fs.open(tmp, 'w', 0o600)
    try {
      await handle.writeFile(JSON.stringify(value, null, 2))
      await handle.sync()
    } finally {
      await handle.close()
    }
    if (!opts.exclusive) {
      await fs.rename(tmp, file)
      return true
    }
    try {
      await fs.link(tmp, file)
      return true
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false
      throw err
    }
  } finally {
    // Gone after a rename; anything else is a leftover.
    await fs.rm(tmp, { force: true })
  }
}
