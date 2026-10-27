import type { FileHandle } from 'node:fs/promises'
import path from 'node:path'
import {
  PACKAGE_ROOT,
  clientLocalPath,
  clientLocalRoot,
  ensureClientLocalRoot,
  ensureDataDir,
  getProjectsDir,
  nodeLocalPath,
  nodeLocalProjectPath,
  nodeLocalRoot,
  projectConfigDir,
  serverLocalPath,
  serverLocalRoot,
  setDataDir,
  globalPath,
  globalProjectPath,
  globalRoot,
} from '#paths'

// The install root, for callers that need the install's identity (the
// cluster label hash) rather than a place to store files; storage picks a
// tier instead.
// eslint-disable-next-line @typescript-eslint/no-restricted-imports
export { getDataDir } from '#paths'
export {
  PACKAGE_ROOT,
  clientLocalPath,
  clientLocalRoot,
  ensureClientLocalRoot,
  ensureDataDir,
  getProjectsDir,
  nodeLocalPath,
  nodeLocalProjectPath,
  nodeLocalRoot,
  projectConfigDir,
  serverLocalPath,
  serverLocalRoot,
  setDataDir,
  globalPath,
  globalProjectPath,
  globalRoot,
}

/*
 * Each helper below is tagged with its storage tier (GLOBAL, NODE-LOCAL,
 * SERVER-LOCAL or CLIENT-LOCAL; defined in paths.ts). The k8s driver picks
 * a path's mount source from its tier (docs/server-in-cluster.md, "Storage
 * claims"). A new helper chooses its tier by building on
 * `globalProjectPath`, `nodeLocalProjectPath`, `serverLocalPath` or
 * `clientLocalPath`.
 */

export const DOCKERFILES_DIR = path.join(PACKAGE_ROOT, 'dockerfiles')
export const PROXY_DIR = path.join(PACKAGE_ROOT, 'k8s', 'proxy')
/** Build context of the per-node network daemon (see k8s/netd/netd.ts). */
export const NETD_DIR = path.join(PACKAGE_ROOT, 'k8s', 'netd')
/** Pin for the Calico install manifest: version and checksum only. */
export const CALICO_DIR = path.join(PACKAGE_ROOT, 'k8s', 'calico')
/** Pin for the Tailscale operator's static manifest: checksum only. */
export const TAILSCALE_OPERATOR_DIR = path.join(PACKAGE_ROOT, 'k8s', 'tailscale-operator')

/**
 * CLIENT-LOCAL. Cache of a verified upstream manifest (Calico, the
 * Tailscale operator), named with its version. Only the CLI (`yaac
 * cluster install`) reads it.
 */
export function pinnedManifestCachePath(fileName: string): string {
  return clientLocalPath('cache', fileName)
}

/**
 * SERVER-LOCAL. The key the server encrypts stored secrets with, generated
 * on first use when neither `YAAC_SECRETS` nor `YAAC_SECRET` is set.
 * Losing it makes every encrypted row unreadable, so back it up with the
 * data dir (README, "Secrets at rest").
 */
export function secretKeyPath(): string {
  return serverLocalPath('secret.key')
}

/**
 * GLOBAL: the project's state tree, holding everything a workspace pod
 * mounts plus the project's metadata.
 */
export function projectDir(projectId: string): string {
  return globalProjectPath(projectId)
}

/**
 * NODE-LOCAL. Parent of a project's image store generations: the read-only
 * image store every nested-container workspace mounts at
 * `/var/lib/shared-images` (docs/nested-containers.md). It caches the
 * project registry, so a node without one mounts nothing.
 *
 * Outside the project tree because a root pod writes it, so the server's
 * user could not delete it when removing the project; a node-side pod
 * removes it instead.
 */
export function imageStoreDir(projectId: string): string {
  return nodeLocalPath('shared-images', projectId)
}

/**
 * SERVER-LOCAL: a yaac-hosted project's remote, a bare repository only the
 * server opens (docs/hosted-projects.md). Outside the GLOBAL tree so no
 * workspace pod can mount it; workspaces push through the server.
 */
export function hostedRepoDir(projectId: string): string {
  return serverLocalPath('hosted-repos', `${projectId}.git`)
}

/** GLOBAL: the project's main clone. Its `.git` is mounted read-only into
 *  every workspace pod, whose checkout borrows its objects. */
export function repoDir(projectId: string): string {
  return globalProjectPath(projectId, 'repo')
}

/**
 * GLOBAL: mounted at `/home/yaac/.claude` in every workspace of the project
 * and set as `CLAUDE_CONFIG_DIR`, so claude's `.claude.json` lives inside
 * it. Its `projects/` (except the shared auto-memory) and `file-history/`
 * are per-workspace, mounted over it from {@link agentHistoryDir}, and in a
 * pod so is `sessions/`, from {@link workspaceStateDir}.
 */
export function claudeDir(projectId: string): string {
  return globalProjectPath(projectId, 'claude')
}

/**
 * GLOBAL. The project's `.credentials.json`, seen in the workspace at
 * `/home/yaac/.claude/.credentials.json`. Holds placeholder tokens so
 * Claude Code finds a credentials file with no real secrets in it.
 */
export function projectClaudeCredentialsFile(projectId: string): string {
  return path.join(claudeDir(projectId), '.credentials.json')
}

/** GLOBAL: mounted at `/home/yaac/.codex`. Its `sessions/` is the workspace's
 *  own history, mounted over it (`agentHistoryDir`). */
export function codexDir(projectId: string): string {
  return globalProjectPath(projectId, 'codex')
}

/**
 * GLOBAL. One workspace's ACP conversation logs: the raw `session/update`
 * stream acpd records, one file per conversation, and in `images/` the
 * images it keeps out of them; mounted at `/home/yaac/.yaac-acp`. Kept
 * outside any tool's home because it belongs to the protocol, not a tool,
 * and outside {@link workspaceStateDir} so a stopped workspace's
 * conversation stays readable.
 */
export function acpLogDir(projectId: string, workspaceId: string): string {
  return globalProjectPath(projectId, 'acp', workspaceId)
}

/**
 * NODE-LOCAL. The project's package-manager caches, mounted at
 * `/home/yaac/.cached-packages`. Node-local because a network filesystem
 * makes every link and stat a round trip. On a host it also holds the
 * project's pnpm store (docs/containerless-driver.md,
 * docs/workspace-storage.md).
 */
export function cachedPackagesDir(projectId: string): string {
  return nodeLocalProjectPath(projectId, '.cached-packages')
}

/**
 * GLOBAL. Directory backing a `cacheVolumes` entry. It persists across
 * workspaces so the next one starts with a warm cache on any node.
 */
export function cacheVolumeDir(projectId: string, key: string): string {
  return globalProjectPath(projectId, 'cache-volumes', key)
}

/**
 * GLOBAL. The project's codex `auth.json`, seen in the workspace at
 * `/home/yaac/.codex/auth.json`. Holds placeholder tokens so Codex finds a
 * valid bundle without seeing the real ones.
 */
export function projectCodexAuthFile(projectId: string): string {
  return path.join(codexDir(projectId), 'auth.json')
}

/**
 * GLOBAL. The project's shared opencode config, mounted at
 * `/home/yaac/.config/opencode/`, so settings like model selection persist
 * across workspaces. Each workspace's data stays separate
 * ({@link opencodeCheckpointDir}).
 */
export function opencodeConfigDir(projectId: string): string {
  return globalProjectPath(projectId, 'opencode-config')
}

/**
 * GLOBAL. The durable copy of a workspace's opencode data directory,
 * including its SQLite database. A k8s pod runs on a node-local copy
 * ({@link opencodeDataDir}), restores from here at start, and copies back
 * on a timer and at `preStop`; a containerless workspace uses this
 * directory directly. One database per workspace avoids opencode's
 * concurrent-write issues (sst/opencode#5241). Renaming this path requires
 * migrating every stopped opencode workspace's history.
 */
export function opencodeCheckpointDir(projectId: string, workspaceId: string): string {
  return globalProjectPath(projectId, 'opencode-data', workspaceId)
}

/**
 * NODE-LOCAL. The working copy of {@link opencodeCheckpointDir} a k8s pod
 * runs opencode against, mounted at `CONTAINER_OPENCODE_DATA`. It exists
 * only while the pod runs; a clean stop empties it and the node-local
 * sweep removes what an unclean stop leaves. Node-local because SQLite WAL
 * does not work on a network filesystem (see also
 * anomalyco/opencode#14970). Unused under containerless.
 */
export function opencodeDataDir(projectId: string, workspaceId: string): string {
  return nodeLocalProjectPath(projectId, 'opencode-data', workspaceId)
}

/**
 * GLOBAL. The project's pi home, mounted at `/home/yaac/.pi/`, so settings
 * and extensions are shared by all its workspaces. Session logs go to
 * each workspace's own {@link agentHistoryDir}.
 */
export function piDir(projectId: string): string {
  return globalProjectPath(projectId, 'pi')
}

/**
 * GLOBAL. One workspace's agent conversation history, kept out of the
 * project's shared tool homes so other workspaces cannot delete it
 * (docs/workspace-storage.md). One subdirectory per
 * {@link AGENT_HISTORY_PARTS} entry, mounted over the tool homes in a pod
 * and linked into them on a host. Survives stops; deleted with the
 * workspace.
 */
export function agentHistoryDir(projectId: string, workspaceId: string, part?: AgentHistoryPart): string {
  return globalProjectPath(projectId, 'history', workspaceId, ...(part === undefined ? [] : [part]))
}

export const AGENT_HISTORY_PARTS = ['claude', 'claude-file-history', 'codex', 'codex-sqlite', 'pi'] as const
export type AgentHistoryPart = typeof AGENT_HISTORY_PARTS[number]

/** GLOBAL — see {@link workspaceDir}. */
export function workspacesDir(projectId: string): string {
  return globalProjectPath(projectId, 'workspaces')
}

/**
 * GLOBAL. The workspace's checkout, mounted at `/workspace`. A pod mounts
 * it through the `yaac-checkouts` claim, which caches file attributes
 * longer than the rest of the tier (docs/nfs-checkout-performance.md).
 */
export function workspaceDir(projectId: string, workspaceId: string): string {
  return path.join(workspacesDir(projectId), workspaceId)
}

/**
 * GLOBAL. Per-workspace server-written files other than the checkout (e.g.
 * staged builtin skills and workspace bin scripts), mounted into the pod.
 * Removed by workspace cleanup and the orphan-workspace GC.
 */
export function workspaceStateDir(projectId: string, workspaceId: string): string {
  return globalProjectPath(projectId, 'sessions', workspaceId)
}

/**
 * GLOBAL. Images pasted into the workspace's terminal panes. They are
 * deleted with the state dir when the workspace stops, which is fine
 * because the agent reads an image as soon as its path is pasted.
 */
export function workspaceAttachmentsDir(projectId: string, workspaceId: string): string {
  return path.join(workspaceStateDir(projectId, workspaceId), 'attachments')
}

/**
 * The directory claude files a conversation under for a cwd: every
 * non-alphanumeric character replaced with `-` (`/workspace` becomes
 * `-workspace`), and past 200 characters truncated and suffixed with a hash
 * of the whole path. Matches claude 2.1.310's project-dir function (string
 * hash `(h << 5) - h + c | 0`); a test pins it.
 */
export function claudeProjectDirName(cwd: string): string {
  const munged = cwd.replace(/[^a-zA-Z0-9]/g, '-')
  if (munged.length <= 200) return munged
  let hash = 0
  for (let i = 0; i < cwd.length; i++) hash = ((hash << 5) - hash + cwd.charCodeAt(i)) | 0
  return `${munged.slice(0, 200)}-${Math.abs(hash).toString(36)}`
}

/**
 * The cwd claude runs in inside a pod, and so the directory a workspace's
 * history keeps every conversation in.
 */
export const CLAUDE_POD_CWD = claudeProjectDirName('/workspace')

/** The project's shared auto-memory dir in the shared `projects/`, named as
 *  claude would for a `/repo` cwd. It is mounted (or linked) over each
 *  workspace's own `memory` folder, since claude keys memory on the
 *  checkout's git root. */
export const CLAUDE_POD_REPO = claudeProjectDirName('/repo')

/**
 * The thread id from a codex rollout's filename,
 * `rollout-<YYYY-MM-DDTHH-MM-SS>-<thread id>.jsonl` (also `.jsonl.zst`;
 * codex-cli 0.164.0). Undefined for other files.
 */
export function codexRolloutThreadId(fileName: string): string | undefined {
  return /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-(.+?)\.jsonl(\.zst)?$/.exec(fileName)?.[1]
}

/** How much of a rollout's head to read for its first line (`session_meta`
 *  holds ~20 KB of base instructions in 0.164.0). */
const ROLLOUT_META_BYTES = 256 * 1024

/**
 * The thread a codex rollout descends from, or undefined for a root (or a
 * rollout `open` cannot open). A `spawn_agent` child names its parent as
 * `parent_thread_id` in its `session_meta` source (found wherever it nests,
 * since only the field name is pinned); a `/fork` names its origin as
 * `forked_from_id`. Only the first line has these, and a child may never
 * fire a hook, so this is the only link to its parent.
 */
export async function codexRolloutParent(open: () => Promise<FileHandle | null>): Promise<string | undefined> {
  let handle: FileHandle | null = null
  try {
    handle = await open()
    if (handle === null) return undefined
    const buf = Buffer.alloc(ROLLOUT_META_BYTES)
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0)
    const text = buf.subarray(0, bytesRead).toString('utf8')
    const eol = text.indexOf('\n')
    const entry = JSON.parse(eol < 0 ? text : text.slice(0, eol)) as {
      type?: unknown
      payload?: { forked_from_id?: unknown; source?: unknown }
    }
    if (entry.type !== 'session_meta') return undefined
    const parent = spawnParent(entry.payload?.source) ?? entry.payload?.forked_from_id
    return typeof parent === 'string' && parent !== '' ? parent : undefined
  } catch {
    return undefined
  } finally {
    await handle?.close()
  }
}

function spawnParent(source: unknown): unknown {
  if (source === null || typeof source !== 'object') return undefined
  const own = (source as { parent_thread_id?: unknown }).parent_thread_id
  if (own !== undefined) return own
  for (const value of Object.values(source)) {
    const found = spawnParent(value)
    if (found !== undefined) return found
  }
  return undefined
}
