import os from 'node:os'
import path from 'node:path'
import { findExecutable, pathDirs } from '@yaac/shared/executables'

/**
 * Locate a vendor login CLI (`claude`, `codex`): on $PATH, else in
 * `~/.local/bin`, where both vendors' installers put it but which a login
 * PATH often lacks. Null means it is not installed. The process's PATH is
 * fixed at launch, so a CLI installed later is found only if it lands in a
 * directory already on that PATH, or in `~/.local/bin`.
 */
export function resolveToolCliPath(tool: 'claude' | 'codex'): string | null {
  return findExecutable(tool, [...pathDirs(), path.join(os.homedir(), '.local', 'bin')])
}
