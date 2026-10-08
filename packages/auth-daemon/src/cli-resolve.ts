import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * Finds vendor CLIs (`claude`, `codex`). The process's PATH is fixed at
 * launch, so a CLI installed later is found only if it lands in a directory
 * already on that PATH, or in the installers' `~/.local/bin`.
 */

/** The first `dirs` entry holding an executable file `name`, as a full path. */
export function findExecutable(name: string, dirs: string[]): string | null {
  for (const dir of dirs) {
    if (!dir) continue
    const candidate = path.join(dir, name)
    try {
      fs.accessSync(candidate, fs.constants.X_OK)
      if (fs.statSync(candidate).isFile()) return candidate
    } catch {
      // not here
    }
  }
  return null
}

/**
 * Locate a vendor login CLI: on $PATH, else in `~/.local/bin`, where both
 * vendors' installers put it but which a login PATH often lacks. Null means
 * it is not installed.
 */
export function resolveToolCliPath(tool: 'claude' | 'codex'): string | null {
  // eslint-disable-next-line no-process-env -- $PATH lookup, not yaac config
  const pathDirs = (process.env.PATH ?? '').split(path.delimiter)
  return findExecutable(tool, [...pathDirs, path.join(os.homedir(), '.local', 'bin')])
}
