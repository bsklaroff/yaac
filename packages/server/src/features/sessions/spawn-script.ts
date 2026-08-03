/**
 * In-session helper commands — `session-bin/*` scripts shipped inside the
 * yaac package (currently just `yaac-spawn`) that yaac installs into every
 * session container on PATH.
 *
 * Delivery mirrors the builtin-skills tier (features/skills): at
 * session create the packaged scripts are copied into a staging dir under
 * the session dir (`stageSessionBin`, chmod 0755) and each is File-mounted
 * read-only at `/usr/local/bin/<name>` — on PATH in effectively every
 * image, read-only so a session can't tamper with the host copy, and
 * copied fresh per session so it tracks the installed yaac version. The
 * staging dir is removed with the session dir on cleanup.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { PACKAGE_ROOT } from '@yaac/shared/project-paths'
import { type HostPathMount } from '#platform/k8s'

/**
 * The one session-bin script session pods cannot function without: the
 * postStart hook that performs the in-pod setup (git identity, tmux
 * server, streamd). The other scripts are optional helpers — a stripped
 * build missing them just lacks conveniences — but a create must fail
 * loudly when this one didn't stage.
 */
export const SESSION_INIT_SCRIPT = 'yaac-session-init'

let sourceDirOverride: string | null = null

/**
 * Directory holding yaac's shipped in-session scripts — `session-bin/` under
 * the package root (copied into `dist/` by the build, so this resolves in
 * dev/test and in the published CLI). Overridable in tests via
 * `setSessionBinDir`.
 */
export function sessionBinDir(): string {
  return sourceDirOverride ?? path.join(PACKAGE_ROOT, 'session-bin')
}

/** Point staging at a different session-bin dir (tests). Pass null to
 *  restore the packaged default. */
export function setSessionBinDir(dir: string | null): void {
  sourceDirOverride = dir
}

/**
 * Copy every regular file from `srcDir` into `destDir` (replacing any prior
 * staging), mark each executable, and return the staged names sorted. A
 * missing or unreadable source dir (a stripped build) → [] — sessions then
 * simply lack the helper commands, never a failed create.
 */
export async function stageSessionBin(srcDir: string, destDir: string): Promise<string[]> {
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

/** Read-only File mounts placing each staged script at `/usr/local/bin/<name>`. */
export function sessionBinMounts(stagingDir: string, names: string[]): HostPathMount[] {
  return names.map((name) => ({
    hostPath: path.join(stagingDir, name),
    mountPath: `/usr/local/bin/${name}`,
    readOnly: true,
    type: 'File' as const,
  }))
}
