import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { env } from '#env'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/**
 * Walk up from `from` to the monorepo root (the dir holding
 * pnpm-workspace.yaml). Used in dev/test to find repo-root assets such as
 * dockerfiles/ and k8s/.
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

// Root of the static assets (dockerfiles/, k8s/): dist/ in the bundle, the
// monorepo root in dev/test.
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
 * The data dir from the environment alone, ignoring any {@link setDataDir}
 * override. For the test harness, which places each test's data dir under
 * it; everything else uses {@link getDataDir}.
 */
export function ambientDataDir(): string {
  if (env.dataDirOverride) return env.dataDirOverride
  return path.join(os.homedir(), '.yaac')
}

/**
 * The install's data dir. It identifies the install (it is hashed into the
 * cluster label) and, on a host, holds the three tier folders below. In the
 * server pod the tiers are separate mounts and nothing exists at this path.
 * Build storage paths on a tier root, not on this.
 */
export function getDataDir(): string {
  if (dataDir) return dataDir
  return ambientDataDir()
}

export function setDataDir(dir: string): void {
  dataDir = dir
}

/*
 * Storage tiers. Every yaac path lives under one of four roots, chosen by
 * who needs to read it:
 *
 *  - GLOBAL: the server and workspace pods on any node. `<dataDir>/global`
 *    on a host; the RWX claim `yaac-global` in the cluster.
 *  - NODE-LOCAL: one node only (rebuildable caches, working copies of a
 *    GLOBAL checkpoint). `<dataDir>/node-local` on a host; a node hostPath
 *    in the cluster.
 *  - SERVER-LOCAL: the server process only (DB, lock, log, credentials,
 *    secret key). `<dataDir>/server-local` on a host; the RWO claim
 *    `yaac-server-local` in the cluster. No workspace pod mounts it.
 *  - CLIENT-LOCAL: processes on the user's machine only (CLI, auth daemon,
 *    desktop app, `yaac cluster install`). A sibling of the data dir, so a
 *    pod mounting the data dir can never see it.
 *
 * The server Deployment points the first three at its mounts via
 * `YAAC_GLOBAL_ROOT` / `YAAC_SERVER_LOCAL_ROOT` / `YAAC_NODE_LOCAL_ROOT`
 * (docs/server-in-cluster.md, "Storage is two claims"). project-paths.ts
 * assigns each path its tier.
 */

/** Root of the GLOBAL tier — see the tier legend above. */
export function globalRoot(): string {
  return env.globalRootOverride ?? path.join(getDataDir(), 'global')
}

/** Root of the NODE-LOCAL tier — see the tier legend above. */
export function nodeLocalRoot(): string {
  return env.nodeLocalRootOverride ?? path.join(getDataDir(), 'node-local')
}

/** Root of the SERVER-LOCAL tier — see the tier legend above. */
export function serverLocalRoot(): string {
  return env.serverLocalRootOverride ?? path.join(getDataDir(), 'server-local')
}

/** A GLOBAL path outside the project tree: `<globalRoot>/<…rest>`. */
export function globalPath(...rest: string[]): string {
  return path.join(globalRoot(), ...rest)
}

/** A GLOBAL per-project path: `<globalRoot>/projects/<id>/<…rest>`. */
export function globalProjectPath(projectId: string, ...rest: string[]): string {
  return path.join(getProjectsDir(), projectId, ...rest)
}

/** A NODE-LOCAL path outside the project tree: `<nodeLocalRoot>/<…rest>`. */
export function nodeLocalPath(...rest: string[]): string {
  return path.join(nodeLocalRoot(), ...rest)
}

/**
 * A NODE-LOCAL per-project path: `<nodeLocalRoot>/projects/<id>/<…rest>`.
 * A node may miss the project's removal; ids are never reused, so no later
 * project inherits its files. The node-local sweep removes ids of deleted
 * projects.
 */
export function nodeLocalProjectPath(projectId: string, ...rest: string[]): string {
  return path.join(nodeLocalRoot(), 'projects', projectId, ...rest)
}

/** A SERVER-LOCAL path: `<serverLocalRoot>/<…rest>`. */
export function serverLocalPath(...rest: string[]): string {
  return path.join(serverLocalRoot(), ...rest)
}

/**
 * A short directory under the OS temp dir for UNIX sockets, keyed by a hash
 * of the data dir so installs on one host never collide. Socket paths are
 * limited to about 104 bytes on macOS, too short for a data-dir path.
 */
export function installTmpDir(): string {
  const key = crypto.createHash('sha256').update(getDataDir()).digest('hex').slice(0, 8)
  return path.join(os.tmpdir(), `yaac-${key}`)
}

/**
 * Root of the CLIENT-LOCAL tier: `<dataDir>-client` (e.g. `~/.yaac-client`).
 * Deriving it from the data dir means each install, and each test's data
 * dir, gets its own without another environment variable.
 */
export function clientLocalRoot(): string {
  return `${getDataDir()}-client`
}

/** A CLIENT-LOCAL path: `<clientLocalRoot>/<…rest>`. */
export function clientLocalPath(...rest: string[]): string {
  return path.join(clientLocalRoot(), ...rest)
}

/** Create the client-local root. Callers write into it directly. */
export async function ensureClientLocalRoot(): Promise<void> {
  await fs.mkdir(clientLocalRoot(), { recursive: true })
}

/** GLOBAL: parent of every project's state tree. */
export function getProjectsDir(): string {
  return path.join(globalRoot(), 'projects')
}

/**
 * Where the tmux server socket lives inside a workspace pod, on a pod-local
 * emptyDir since every tmux client runs inside the pod. Every in-pod `tmux`
 * call passes `-S ${CONTAINER_TMUX_SOCK}` so all reach the same server.
 */
export const CONTAINER_TMUX_DIR = '/tmp/yaac-tmux'
export const CONTAINER_TMUX_SOCK = `${CONTAINER_TMUX_DIR}/server`

/**
 * Where acpd puts one UNIX socket per ACP conversation, named for its tmux
 * window (`claude`, `claude-2`, …), which is also the status store's key.
 * The server connects over a streamd `ctrl` stream
 * (`socat - UNIX-CONNECT:<path>`), so it needs no host mount and no TCP
 * port for auto-forward to pick up.
 */
export const CONTAINER_ACP_DIR = '/tmp/yaac-acp'

/**
 * opencode's data directory inside a workspace: the node-local working copy
 * in a pod, `opencodeCheckpointDir` itself under containerless.
 */
export const CONTAINER_OPENCODE_DATA = '/home/yaac/.local/share/opencode'

/**
 * In-pod path of the GLOBAL opencode checkpoint (`opencodeCheckpointDir`),
 * which `yaac-opencode-checkpoint` copies the working copy into on a timer
 * and at `preStop`, and `yaac-workspace-init` restores from at start.
 */
export const CONTAINER_OPENCODE_CHECKPOINT = '/home/yaac/.yaac/opencode-checkpoint'

/**
 * Where a workspace's ACP conversation logs (`acpLogDir()`) are mounted.
 * The server reads them to rebuild a conversation, even after the pod is
 * gone.
 */
export const CONTAINER_ACP_LOG_DIR = '/home/yaac/.yaac-acp'

/** Read-only mount of pasted images (`workspaceAttachmentsDir()`). */
export const CONTAINER_ATTACHMENTS_DIR = '/home/yaac/.yaac-attachments'

/**
 * GLOBAL: per-project config (yaac-config.json, the project Dockerfile and
 * its build context).
 */
export function projectConfigDir(projectId: string): string {
  return globalProjectPath(projectId, 'config')
}

/** SERVER-LOCAL: the server's own log file. */
export function serverLogPath(): string {
  return serverLocalPath('server.log')
}

/**
 * Create the global project tree and the server-local root. The node-local
 * root is created by the driver (a pod's init container under k8s, lazily
 * under containerless).
 */
export async function ensureDataDir(): Promise<void> {
  await fs.mkdir(getProjectsDir(), { recursive: true })
  await fs.mkdir(serverLocalRoot(), { recursive: true })
}
