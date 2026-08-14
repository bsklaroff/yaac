/**
 * In-worktree helper commands — every `worktree-bin/*` script shipped inside
 * the yaac package, which yaac installs into every worktree on PATH: the
 * setup hook, the yaac-mama and PR-watch helpers, and the agent-session discovery
 * hook the tools run on SessionStart.
 *
 * Delivery mirrors the builtin-skills tier (features/skills): at
 * worktree create the packaged scripts are copied into a staging dir under
 * the worktree dir (`stageWorktreeBin`, chmod 0755) and each is File-mounted
 * read-only at `/usr/local/bin/<name>` — on PATH in effectively every
 * image, read-only so a worktree can't tamper with the host copy, and
 * copied fresh per worktree so it tracks the installed yaac version. The
 * staging dir is removed with the worktree dir on cleanup.
 *
 * A driver without mounts realizes the same thing its own way (containerless
 * symlinks them into the workspace's bin dir), so a caller registering one of
 * these names it by bare name and lets PATH resolve it.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { PACKAGE_ROOT } from '@yaac/shared/project-paths'
import type { WorkspaceMount } from '#drivers/contract'

/**
 * The one worktree-bin script worktree pods cannot function without: the
 * postStart hook that performs the in-pod setup (git identity, tmux
 * server, streamd). The other scripts are optional helpers — a stripped
 * build missing them just lacks conveniences — but a create must fail
 * loudly when this one didn't stage.
 */
export const WORKTREE_INIT_SCRIPT = 'yaac-worktree-init'

let sourceDirOverride: string | null = null

/**
 * Directory holding yaac's shipped in-worktree scripts — `worktree-bin/` under
 * the package root (copied into `dist/` by the build, so this resolves in
 * dev/test and in the published CLI). Overridable in tests via
 * `setWorktreeBinDir`.
 */
export function worktreeBinDir(): string {
  return sourceDirOverride ?? path.join(PACKAGE_ROOT, 'worktree-bin')
}

/** Point staging at a different worktree-bin dir (tests). Pass null to
 *  restore the packaged default. */
export function setWorktreeBinDir(dir: string | null): void {
  sourceDirOverride = dir
}

/**
 * Copy every regular file from `srcDir` into `destDir` (replacing any prior
 * staging), mark each executable, and return the staged names sorted. A
 * missing or unreadable source dir (a stripped build) → [] — worktrees then
 * simply lack the helper commands, never a failed create.
 */
export async function stageWorktreeBin(srcDir: string, destDir: string): Promise<string[]> {
  await fs.rm(destDir, { recursive: true, force: true })
  const entries = await fs.readdir(srcDir, { withFileTypes: true }).catch(() => null)
  if (!entries) return []
  await fs.mkdir(destDir, { recursive: true })
  const names: string[] = []
  for (const e of entries) {
    if (!e.isFile() || e.name.startsWith('.')) continue
    const dest = path.join(destDir, e.name)
    await fs.copyFile(path.join(srcDir, e.name), dest)
    // hostPath bind mounts preserve host mode bits, so the exec bit set here
    // is what makes the script runnable in the pod.
    await fs.chmod(dest, 0o755)
    names.push(e.name)
  }
  return names.sort()
}

/** Read-only File mounts placing each staged script at `/usr/local/bin/<name>`.
 *  The staging dir is SHARED (under `worktreeStateDir`) — the server writes it and
 *  the pod reads it — so it takes the shared tier's source. */
export function worktreeBinMounts(stagingDir: string, names: string[]): WorkspaceMount[] {
  return names.map((name) => ({
    source: { kind: 'hostPath', path: path.join(stagingDir, name), type: 'File' },
    mountPath: `/usr/local/bin/${name}`,
    readOnly: true,
  }))
}
