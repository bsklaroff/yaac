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

/**
 * The data dir this install resolves to from the AMBIENT environment alone,
 * ignoring any {@link setDataDir} override.
 *
 * Nothing in the product should want this — use {@link getDataDir}, which
 * honors the override. It exists for callers that run BEFORE a data dir is
 * chosen and whose job is to choose where one goes: the test harness picks
 * its scratch base from here, then creates each test's data dir under it.
 * Asking `getDataDir()` there would be circular.
 */
export function ambientDataDir(): string {
  if (env.dataDirOverride) return env.dataDirOverride
  return path.join(os.homedir(), '.yaac')
}

/**
 * The one physical directory this yaac install owns. It is the INSTALL
 * IDENTITY (1:1 with the server lock — hashed into the cluster label and
 * the web-session cookie name) and, today, the single filesystem every
 * storage tier below resolves into.
 *
 * Do not build storage paths on it directly: pick a tier
 * (`sharedRoot` / `nodeLocalRoot` / `serverLocalRoot`) so the path
 * declares who has to be able to see it.
 */
export function getDataDir(): string {
  if (dataDir) return dataDir
  return ambientDataDir()
}

export function setDataDir(dir: string): void {
  dataDir = dir
}

/*
 * ── Storage tiers ──────────────────────────────────────────────────────
 *
 * Every yaac path hangs off one of three roots, chosen by ONE question:
 * who has to be able to read these bytes?
 *
 *  - SHARED (`sharedRoot`)       the server AND session pods — which on a
 *                                multi-node cluster may land on any node.
 *                                Becomes an RWX volume (PVC + subPath):
 *                                docs/plans/stock-k8s-multi-node.md §2.
 *  - NODE-LOCAL (`nodeLocalRoot`) one pod, or one node's scratch. Nobody
 *                                off that node ever reads it, so it never
 *                                has to travel: emptyDir or node disk.
 *  - SERVER-LOCAL (`serverLocalRoot`) only the server process itself.
 *                                Becomes the server's own RWO volume (§1)
 *                                — the pglite DB must never sit on a
 *                                network filesystem.
 *
 * All three resolve to `getDataDir()` today. The current single-node
 * backend has exactly one filesystem, so every path is byte-identical to
 * what it was before the split: the tier is a declaration of a visibility
 * requirement, not (yet) a different directory. Splitting them is the
 * volume-source work in §2, not something a caller opts into.
 *
 * The classification of every existing path lives in project-paths.ts.
 */

/** Root of the SHARED tier — see the tier legend above. */
export function sharedRoot(): string {
  return getDataDir()
}

/** Root of the NODE-LOCAL tier — see the tier legend above. */
export function nodeLocalRoot(): string {
  return getDataDir()
}

/** Root of the SERVER-LOCAL tier — see the tier legend above. */
export function serverLocalRoot(): string {
  return getDataDir()
}

/** A SHARED path outside the project tree: `<sharedRoot>/<…rest>`. */
export function sharedPath(...rest: string[]): string {
  return path.join(sharedRoot(), ...rest)
}

/** A SHARED per-project path: `<sharedRoot>/projects/<slug>/<…rest>`. */
export function sharedProjectPath(slug: string, ...rest: string[]): string {
  return path.join(getProjectsDir(), slug, ...rest)
}

/** A NODE-LOCAL per-project path: `<nodeLocalRoot>/projects/<slug>/<…rest>`. */
export function nodeLocalProjectPath(slug: string, ...rest: string[]): string {
  return path.join(nodeLocalRoot(), 'projects', slug, ...rest)
}

/** A SERVER-LOCAL path: `<serverLocalRoot>/<…rest>`. */
export function serverLocalPath(...rest: string[]): string {
  return path.join(serverLocalRoot(), ...rest)
}

/**
 * SHARED: the per-project state tree. Enumerating it lists the install's
 * projects (`list.ts`, the orphan GC, tool-auth's placeholder sweep).
 */
export function getProjectsDir(): string {
  return path.join(sharedRoot(), 'projects')
}

/**
 * NODE-LOCAL twin of {@link getProjectsDir}. Same directory today; once
 * the tiers split, a sweep that must see every project has to enumerate
 * BOTH (see `projectsRoots`).
 */
export function getNodeLocalProjectsDir(): string {
  return path.join(nodeLocalRoot(), 'projects')
}

/**
 * Path inside the session container where the tmux server socket lives.
 * Backed by a pod-local emptyDir (see the session Job's mount list): a UNIX
 * socket only rendezvouses within the kernel that bound it, and every
 * consumer — attach, the `tmux -C` status stream, the liveness and
 * pane-content probes — reaches tmux through `kubectl exec` in the pod, so
 * nothing off the pod ever opens this dir. Every in-container `tmux`
 * invocation passes `-S ${CONTAINER_TMUX_SOCK}` so they all land on the
 * same server.
 */
export const CONTAINER_TMUX_DIR = '/tmp/yaac-tmux'
export const CONTAINER_TMUX_SOCK = `${CONTAINER_TMUX_DIR}/server`

/**
 * Where acpd puts one UNIX socket per ACP conversation, named for the tmux
 * window that supervises it (`claude`, `claude-2`, …) — the same handle the
 * status store keys that conversation by.
 *
 * Pod-local on purpose, unlike the tmux dir: nothing on the host connects to
 * it. The server reaches it the way it reaches everything else in a session
 * pod, over a streamd `ctrl` stream (`socat - UNIX-CONNECT:<path>`), so the
 * socket needs no host mount and no port — which also keeps it out of the
 * auto-forward port scan a TCP listener would land in.
 */
export const CONTAINER_ACP_DIR = '/tmp/yaac-acp'

export function containerAcpSock(handle: string): string {
  return `${CONTAINER_ACP_DIR}/${handle}.sock`
}

/**
 * Where a worktree's ACP conversation logs are mounted in its session — the
 * host side is `acpLogDir()`. Unlike the socket dir above this one IS
 * host-mounted, because the log is what the server reads to rebuild a
 * conversation, including for a worktree whose pod is long gone.
 */
export const CONTAINER_ACP_LOG_DIR = '/home/yaac/.yaac-acp'

export function containerAcpLog(name: string): string {
  return `${CONTAINER_ACP_LOG_DIR}/${name}.jsonl`
}

/**
 * SHARED: per-project config (yaac-config.json, the project Dockerfile and
 * its build context). Only the server reads it today, but it sits inside
 * the project tree and moves with it.
 */
export function projectConfigDir(slug: string): string {
  return sharedProjectPath(slug, 'config')
}

/** SERVER-LOCAL: the server's own log file. */
export function serverLogPath(): string {
  return serverLocalPath('server.log')
}

/**
 * Create the shared project tree. Node-local per-project dirs are created
 * lazily by whoever mounts them (session-create's `mkdir -p`s), so there
 * is nothing to pre-create on that root.
 */
export async function ensureDataDir(): Promise<void> {
  await fs.mkdir(getProjectsDir(), { recursive: true })
}
