import fs from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { env } from '#env'
import { clientDataDir, clientLocalPath, hostDataDir, installTmpDir, resetHostDataDir } from '#paths'
import { readJsonFile, writeJsonFile } from '#json-file'
import { readInstallRecord } from '#install-record'
import { SERVER_LOCK_FILENAME, isLockLive, parseServerLock } from '#server-lock-file'
import { rewriteToolRecordPaths } from '#tool-records'
import {
  claudeKeychainService,
  deleteScopedClaudeKeychainItem,
  readScopedClaudeKeychainPayload,
} from '#tool-auth-interactive'

/**
 * Legacy: moving an install out of `~/.yaac`, the data dir host and
 * cluster installs both used before each got its own
 * (docs/legacy-compat-shims.md). A host install moves to `~/.yaac-server`
 * once nothing runs from it; a kind cluster install moves to
 * `~/.yaac-cluster` once its kind cluster is gone. Everything here works on
 * explicit paths, since `yaac cluster …` has already pointed this process
 * at the cluster's data dir.
 */

const legacyDir = (): string => path.join(os.homedir(), '.yaac')
const hostDir = (): string => path.join(os.homedir(), '.yaac-server')
const clusterDir = (): string => path.join(os.homedir(), '.yaac-cluster')

/**
 * Move a host install from `~/.yaac` to `~/.yaac-server`, run by the
 * commands that set up a server. A live server holds its DB in the old dir,
 * and a running containerless workspace holds absolute paths into it and a
 * socket in its tmp dir, so either one defers the move. What the tools
 * recorded about stopped workspaces is repointed first (`prepareProject`),
 * and pointed back if the rename fails. However it ends, the host data dir
 * is resolved again, so a process that lost a race to move it follows the
 * winner rather than recreating `~/.yaac`.
 */
export async function moveLegacyHostDataDir(): Promise<void> {
  try {
    if (await legacyDriver() !== 'containerless') return
    if (await exists(hostDir())) {
      console.error(`[yaac] ${bothExistHint()}`)
      return
    }
    const blocker = await hostMoveBlocker()
    if (blocker === 'workspaces') console.error(`[yaac] ${moveHint(blocker)}`)
    if (blocker !== null) return
    const projects = await projectDirs()
    for (const dir of projects) await prepareProject(dir)
    if (await relocate(hostDir())) return
    for (const dir of projects) await rewriteToolRecordPaths(dir, hostDir(), legacyDir())
  } finally {
    resetHostDataDir()
  }
}

/**
 * Why a host install is still in `~/.yaac` and what moves it, for `yaac
 * server status`; or that it sits beside a `~/.yaac-server` that is served
 * instead. Null when there is no host install in `~/.yaac`.
 */
export async function legacyHostDataDirHint(): Promise<string | null> {
  if (await legacyDriver() !== 'containerless') return null
  if (hostDataDir() === legacyDir()) return moveHint(await hostMoveBlocker())
  return await exists(path.join(legacyDir(), 'server-local')) ? bothExistHint() : null
}

/**
 * Move a kind cluster install from `~/.yaac` to `~/.yaac-cluster`, run by
 * `yaac cluster install` before it creates a cluster. Only while
 * `kindClusterExists` says no: a live cluster's node mounts and bound
 * volumes name the old path. It is asked about the cluster the install
 * recorded (its `kind-<name>` context), which need not be the one
 * `YAAC_KIND_CLUSTER` names now. Then the fresh cluster mounts the new path and
 * binds fresh volumes to the same data. A byo install never moves. Returns
 * whether it moved, so the caller can re-resolve the cluster's data dir.
 */
export async function moveLegacyClusterDataDir(
  kindClusterExists: (name: string) => Promise<boolean>,
): Promise<boolean> {
  if (await legacyDriver() !== 'k8s') return false
  const record = await readInstallRecord(legacyDir())
  if (record?.byo || await exists(clusterDir())) return false
  const name = record?.kubeContext?.startsWith('kind-') ? record.kubeContext.slice('kind-'.length) : env.kindCluster
  if (await kindClusterExists(name).catch(() => true)) return false
  return relocate(clusterDir())
}

/**
 * The driver of the install in `~/.yaac` (`containerless` for one that
 * records none), or undefined when there is nothing there to move: no
 * `~/.yaac`, or a data dir named by the user, which is the install by
 * definition.
 */
async function legacyDriver(): Promise<'containerless' | 'k8s' | undefined> {
  if (env.dataDirOverride || clientDataDir() !== legacyDir() || !await exists(legacyDir())) return undefined
  return (await readInstallRecord(legacyDir()))?.driver ?? 'containerless'
}

/**
 * What keeps the host install in `~/.yaac`. A workspace wins over the
 * server, since a restart clears only the server. The server's own git
 * agent socket counts only while its lock is not live, which catches a
 * server whose lock is torn.
 */
async function hostMoveBlocker(): Promise<'server' | 'workspaces' | null> {
  const lock = await fs.readFile(path.join(legacyDir(), 'server-local', SERVER_LOCK_FILENAME), 'utf8')
    .then(parseServerLock, () => null)
  const serverLive = !!lock && await isLockLive(lock)
  if (await anySocketAnswers(installTmpDir(legacyDir()), serverLive ? ['git-agent.sock'] : [])) return 'workspaces'
  return serverLive ? 'server' : null
}

function bothExistHint(): string {
  return `${legacyDir()} holds a host install that is not served, because ${hostDir()} exists and is used `
    + 'instead. Move one of them aside by hand to choose which one the server uses.'
}

function moveHint(blocker: 'server' | 'workspaces' | null): string {
  const from = `${legacyDir()} moves to ${hostDir()}`
  if (blocker === 'workspaces') {
    return `${legacyDir()} stays in use while workspaces run from it; it moves to ${hostDir()} `
      + 'on the first `yaac server start` or `restart` after they stop'
  }
  if (blocker === 'server') return `${from} on the next \`yaac server restart\``
  return `${from} on the next \`yaac server start\``
}

/** Every project dir of the install in `~/.yaac`. */
async function projectDirs(): Promise<string[]> {
  const root = path.join(legacyDir(), 'global', 'projects')
  const names = await fs.readdir(root).catch(() => [])
  return names.map((name) => path.join(root, name))
}

/**
 * Get a project's tool records ready for the move:
 *
 * - claude on macOS names its Keychain item after a hash of its config dir,
 *   which the move changes. An item there is written to claude's own
 *   credentials file, which claude falls back to and the server harvests
 *   from, then deleted.
 * - claude's history links named after a checkout's old path are removed.
 *   Every launch links the new path.
 * - what pi, opencode and codex recorded is repointed (`rewriteToolRecordPaths`).
 */
async function prepareProject(dir: string): Promise<void> {
  const service = claudeKeychainService(path.join(dir, 'claude'))
  const payload = readScopedClaudeKeychainPayload(service)
  const credentials = payload === null ? null : parseJson(payload)
  if (credentials !== null) {
    await writeJsonFile(path.join(dir, 'claude', '.credentials.json'), credentials)
    deleteScopedClaudeKeychainItem(service)
  }
  const links = path.join(dir, 'claude', 'projects')
  const stale = `${legacyDir()}/`.replace(/[^a-zA-Z0-9]/g, '-')
  for (const entry of await fs.readdir(links, { withFileTypes: true }).catch(() => [])) {
    if (entry.isSymbolicLink() && entry.name.startsWith(stale)) await fs.unlink(path.join(links, entry.name))
  }
  await rewriteToolRecordPaths(dir, legacyDir(), hostDir())
}

/**
 * Rename `~/.yaac` to `to`, then drop the install record `server.json`
 * mirrors for it, or the next read of `~/.yaac`'s record would lift it back
 * and recreate the dir. Returns whether it moved. A failed rename leaves
 * `~/.yaac` in use, with a warning unless another process moved it first.
 */
async function relocate(to: string): Promise<boolean> {
  try {
    await fs.rename(legacyDir(), to)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error(`[yaac] could not move ${legacyDir()} to ${to}, so it stays in use: ${String(err)}`)
    }
    return false
  }
  const file = clientLocalPath('server.json')
  const raw = await readJsonFile(file)
  if (raw !== 'absent' && raw !== null) {
    await writeJsonFile(file, { url: raw.url ?? '', enabled: raw.enabled ?? false, saved: raw.saved ?? [] })
  }
  console.error(`[yaac] moved ${legacyDir()} to ${to}`)
  return true
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

async function exists(p: string): Promise<boolean> {
  return fs.stat(p).then(() => true, () => false)
}

/**
 * Whether any UNIX socket in `dir` accepts a connection: a workspace's
 * tmux server, or the old server's git agent.
 */
async function anySocketAnswers(dir: string, skip: string[]): Promise<boolean> {
  const names = await fs.readdir(dir).catch(() => [])
  const socks = names.filter((n) => n.endsWith('.sock') && !skip.includes(n))
  const answers = await Promise.all(socks.map((n) => connects(path.join(dir, n))))
  return answers.includes(true)
}

function connects(sock: string): Promise<boolean> {
  return new Promise((resolve) => {
    const conn = net.connect(sock)
    conn.once('connect', () => {
      conn.destroy()
      resolve(true)
    })
    conn.once('error', () => resolve(false))
  })
}
