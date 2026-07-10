import fs from 'node:fs'
import path from 'node:path'

/**
 * Locating vendor CLIs (`claude` / `codex`) on the server host — a plain
 * $PATH lookup, like the shell would do. Note the server's PATH is frozen at
 * launch, so a CLI installed mid-session is only found if it lands in a
 * directory that was already on the PATH.
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
      // not here — keep looking
    }
  }
  return null
}

/** Locate a command through $PATH. */
export function resolveCommandPath(name: string): string | null {
  // eslint-disable-next-line no-process-env -- $PATH lookup, not yaac config
  const pathDirs = (process.env.PATH ?? '').split(path.delimiter)
  return findExecutable(name, pathDirs)
}

/** Locate a vendor login CLI. Null means it is not installed. */
export function resolveToolCliPath(tool: 'claude' | 'codex'): string | null {
  return resolveCommandPath(tool)
}
