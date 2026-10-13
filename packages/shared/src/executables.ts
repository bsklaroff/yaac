import fs from 'node:fs'
import path from 'node:path'

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

/** The directories of this process's `$PATH`, in order. */
export function pathDirs(): string[] {
  // eslint-disable-next-line no-process-env -- $PATH lookup, not yaac config
  return (process.env.PATH ?? '').split(path.delimiter)
}
