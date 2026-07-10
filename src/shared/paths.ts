import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { env } from '@/shared/env'

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

// In the bundle (env.bundled, set by tsup), static assets (dockerfiles/,
// podman/) are copied into dist/ alongside index.js. In dev/test, walk up
// from the source file to find the repo root.
export const PACKAGE_ROOT = env.bundled
  ? __dirname
  : findPackageRoot(__dirname)

/** Expand a leading `~` / `~/` to the current user's home directory. */
export function expandTilde(p: string): string {
  if (p === '~') return os.homedir()
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2))
  return p
}

let dataDir: string | null = null

export function getDataDir(): string {
  if (dataDir) return dataDir
  if (env.dataDirOverride) return env.dataDirOverride
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
 * the server lands on this shared dir. The socket file isn't
 * connectable from the host (virtio-fs/9p doesn't share UNIX socket
 * kernel state) so liveness and pane-content probes both go through
 * `podman exec`.
 */
export const CONTAINER_TMUX_DIR = '/tmp/yaac-tmux'
export const CONTAINER_TMUX_SOCK = `${CONTAINER_TMUX_DIR}/server`

export function projectConfigDir(slug: string): string {
  return path.join(getProjectsDir(), slug, 'config')
}

export function daemonLogPath(): string {
  return path.join(getDataDir(), 'daemon.log')
}

/**
 * Persisted webapp session ids (0600). Lets a daemon restart keep browser
 * sessions valid so users don't re-bootstrap on every rebuild. Sessions
 * are bearer-equivalent, so this file is as sensitive as the lock file.
 */
export function webSessionsPath(): string {
  return path.join(getDataDir(), '.web-sessions.json')
}

/**
 * Durable client tokens (0600). Unlike the lock secret these survive
 * daemon restarts — they are what remote CLIs authenticate with — so the
 * file is exactly as sensitive as the lock file.
 */
export function tokensPath(): string {
  return path.join(getDataDir(), 'tokens.json')
}

export async function ensureDataDir(): Promise<void> {
  await fs.mkdir(getProjectsDir(), { recursive: true })
}
