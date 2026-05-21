import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

function findPackageRoot(from: string): string {
  let dir = from
  while (true) {
    if (existsSync(path.join(dir, 'package.json'))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) throw new Error('Could not find package.json')
    dir = parent
  }
}

// tsup sets process.env.YAAC_BUNDLED at build time. In the bundle, static
// assets (dockerfiles/, podman/) are copied into dist/ alongside index.js.
// In dev/test, walk up from the source file to find the repo root.
export const PACKAGE_ROOT = process.env.YAAC_BUNDLED
  ? __dirname
  : findPackageRoot(__dirname)

let dataDir: string | null = null

export function getDataDir(): string {
  if (dataDir) return dataDir
  if (process.env.YAAC_DATA_DIR) return process.env.YAAC_DATA_DIR
  return path.join(os.homedir(), '.yaac')
}

export function setDataDir(dir: string): void {
  dataDir = dir
}

export function getProjectsDir(): string {
  return path.join(getDataDir(), 'projects')
}

/**
 * Path inside the session container where the bind-mounted tmux server
 * socket lives. Pairs with `sessionTmuxDir()` on the host side. Every
 * in-container `tmux` invocation passes `-S ${CONTAINER_TMUX_SOCK}` so
 * the server lands on this shared dir. The socket file itself isn't
 * connectable from the host (virtio-fs/9p doesn't share UNIX socket
 * kernel state) — liveness probes still go through `podman exec` —
 * but the colocated `pane.log` is a regular file and is read directly
 * from the host by the daemon's claude-status path.
 */
export const CONTAINER_TMUX_DIR = '/tmp/yaac-tmux'
export const CONTAINER_TMUX_SOCK = `${CONTAINER_TMUX_DIR}/server`
export const CONTAINER_TMUX_PANE_LOG = `${CONTAINER_TMUX_DIR}/pane.log`

export function projectConfigDir(slug: string): string {
  return path.join(getProjectsDir(), slug, 'config')
}

export function daemonLogPath(): string {
  return path.join(getDataDir(), 'daemon.log')
}

export async function ensureDataDir(): Promise<void> {
  await fs.mkdir(getProjectsDir(), { recursive: true })
}
