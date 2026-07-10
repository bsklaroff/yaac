import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { env } from '#env'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/**
 * Walk up from `from` to the monorepo root, identified by the
 * pnpm-workspace.yaml marker. Used in dev/test to locate repo-root assets
 * (dockerfiles/, k8s/) regardless of which workspace package the calling
 * source file lives in — a per-package package.json would stop the walk too
 * early.
 */
export function findRepoRoot(from: string): string {
  let dir = from
  while (true) {
    if (existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) throw new Error('Could not find pnpm-workspace.yaml')
    dir = parent
  }
}

// In the bundle (env.bundled, set by tsup), static assets (dockerfiles/,
// k8s/) are copied into dist/ alongside cli.js. In dev/test, walk up from the
// source file to the monorepo root.
export const PACKAGE_ROOT = env.bundled
  ? __dirname
  : findRepoRoot(__dirname)

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

export function serverLogPath(): string {
  return path.join(getDataDir(), 'server.log')
}

/**
 * Persisted webapp session ids (0600). Lets a server restart keep browser
 * sessions valid so users don't re-bootstrap on every rebuild. Sessions
 * are bearer-equivalent, so this file is as sensitive as the lock file.
 */
export function webSessionsPath(): string {
  return path.join(getDataDir(), '.web-sessions.json')
}

/**
 * Durable client tokens (0600). Unlike the lock secret these survive
 * server restarts — they are what remote CLIs authenticate with — so the
 * file is exactly as sensitive as the lock file.
 */
export function tokensPath(): string {
  return path.join(getDataDir(), 'tokens.json')
}

export async function ensureDataDir(): Promise<void> {
  await fs.mkdir(getProjectsDir(), { recursive: true })
}
