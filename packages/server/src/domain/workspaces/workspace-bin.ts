/**
 * In-workspace helper commands: the `workspace-bin/*` scripts shipped with
 * yaac (setup hook, yaac-mama, PR-watch and agent reporter hooks).
 *
 * Like the builtin skills (#domain/skills), they are copied per workspace
 * into a staging dir (`stageWorkspaceBin`) and each is mounted read-only at
 * `/usr/local/bin/<name>`, so they match the installed yaac version and the
 * workspace cannot modify them. Containerless symlinks them into the
 * workspace's bin dir instead, so callers refer to them by bare name.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { PACKAGE_ROOT } from '@yaac/shared/project-paths'
import type { WorkspaceMount } from '#drivers/contract'

/**
 * The in-workspace setup script (git identity, tmux, streamd). Required: a
 * create fails if it did not stage. The other scripts are optional.
 */
export const WORKSPACE_INIT_SCRIPT = 'yaac-workspace-init'

/** The opencode checkpoint script: the pod's `preStop` hook (with `stop`)
 *  and the timer the init script starts. */
export const OPENCODE_CHECKPOINT_SCRIPT = 'yaac-opencode-checkpoint'

let sourceDirOverride: string | null = null

/**
 * `workspace-bin/` under the package root (the build copies it into `dist/`).
 * Overridable in tests via `setWorkspaceBinDir`.
 */
export function workspaceBinDir(): string {
  return sourceDirOverride ?? path.join(PACKAGE_ROOT, 'workspace-bin')
}

/** Point staging at a different workspace-bin dir (tests). Pass null to
 *  restore the packaged default. */
export function setWorkspaceBinDir(dir: string | null): void {
  sourceDirOverride = dir
}

/**
 * Copy every regular file from `srcDir` into a fresh `destDir`, make each
 * executable, and return the sorted names. A missing source dir gives [].
 */
export async function stageWorkspaceBin(srcDir: string, destDir: string): Promise<string[]> {
  await fs.rm(destDir, { recursive: true, force: true })
  const entries = await fs.readdir(srcDir, { withFileTypes: true }).catch(() => null)
  if (!entries) return []
  await fs.mkdir(destDir, { recursive: true })
  const names: string[] = []
  for (const e of entries) {
    if (!e.isFile() || e.name.startsWith('.')) continue
    const dest = path.join(destDir, e.name)
    await fs.copyFile(path.join(srcDir, e.name), dest)
    // Bind mounts keep host mode bits.
    await fs.chmod(dest, 0o755)
    names.push(e.name)
  }
  return names.sort()
}

/** Read-only mounts placing each staged script at `/usr/local/bin/<name>`. */
export function workspaceBinMounts(stagingDir: string, names: string[]): WorkspaceMount[] {
  return names.map((name) => ({
    source: { kind: 'hostPath', path: path.join(stagingDir, name), type: 'File' },
    mountPath: `/usr/local/bin/${name}`,
    readOnly: true,
  }))
}
