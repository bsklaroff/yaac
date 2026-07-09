import fs from 'node:fs/promises'
import path from 'node:path'

/**
 * Local fast-fail on --add-dir/--add-dir-rw paths so the user gets an
 * immediate error instead of a round-trip to the daemon (which re-validates
 * both checks). Prints the error and returns false on the first invalid
 * path; callers set the exit code.
 */
export async function validateAddDirs(options: {
  addDir?: string[]
  addDirRw?: string[]
}): Promise<boolean> {
  for (const dirPath of [...(options.addDir ?? []), ...(options.addDirRw ?? [])]) {
    if (!path.isAbsolute(dirPath)) {
      console.error(`--add-dir path must be absolute: "${dirPath}"`)
      return false
    }
    try {
      await fs.access(dirPath)
    } catch {
      console.error(`--add-dir path not found: "${dirPath}"`)
      return false
    }
  }
  return true
}
