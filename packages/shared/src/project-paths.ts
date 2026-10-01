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
 * is two claims"). A new helper chooses its tier by building on
 * `globalProjectPath`, `nodeLocalProjectPath`, `serverLocalPath` or
 * `clientLocalPath`.
 */

export const DOCKERFILES_DIR = path.join(PACKAGE_ROOT, 'dockerfiles')
export const PROXY_DIR = path.join(PACKAGE_ROOT, 'k8s', 'proxy')
/** Build context of the per-node network daemon (see k8s/netd/netd.ts). */
export const NETD_DIR = path.join(PACKAGE_ROOT, 'k8s', 'netd')
/** Pin for the Calico install manifest: version and checksum only. */
export const CALICO_DIR = path.join(PACKAGE_ROOT, 'k8s', 'calico')

/**
 * CLIENT-LOCAL. Cache of the verified Calico manifest, keyed by version.
 * Only the CLI (`yaac cluster install`) reads it.
 */
export function calicoManifestCachePath(version: string): string {
  return clientLocalPath('cache', `calico-${version}.yaml`)
}

/**
 * SERVER-LOCAL. Directory of real credential files, one per service. Only
 * the server reads or writes them; runtimes are handed the contents
 * (`syncCredentials`) and nothing mounts the directory.
 */
export function credentialsDir(): string {
  return serverLocalPath('.credentials')
}

/** SERVER-LOCAL — see {@link credentialsDir}. */
export function claudeCredentialsPath(): string {
  return path.join(credentialsDir(), 'claude.json')
}

/** SERVER-LOCAL — see {@link credentialsDir}. */
export function codexCredentialsPath(): string {
  return path.join(credentialsDir(), 'codex.json')
}

/** SERVER-LOCAL — see {@link credentialsDir}. */
export function opencodeCredentialsPath(): string {
  return path.join(credentialsDir(), 'opencode.json')
}

/** SERVER-LOCAL — see {@link credentialsDir}. */
export function piCredentialsPath(): string {
  return path.join(credentialsDir(), 'pi.json')
}

/**
 * SERVER-LOCAL. The key the server encrypts stored secrets with, generated
 * on first use when neither `YAAC_SECRETS` nor `YAAC_SECRET` is set. Kept
 * out of {@link credentialsDir}, whose contents are handed to runtimes.
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
export function projectDir(slug: string): string {
  return globalProjectPath(slug)
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

/** GLOBAL: the project's main clone. Its `.git` is mounted read-only into
 *  every workspace pod, whose checkout borrows its objects. */
export function repoDir(slug: string): string {
  return globalProjectPath(slug, 'repo')
}

/**
 * GLOBAL: mounted at `/home/yaac/.claude` in every workspace of the project
 * and set as `CLAUDE_CONFIG_DIR`, so claude's `.claude.json` lives inside
 * it. Its `projects/` (except the shared auto-memory) and `file-history/`
 * are per-workspace, mounted over it from {@link agentHistoryDir}.
 */
export function claudeDir(slug: string): string {
  return globalProjectPath(slug, 'claude')
}

/**
 * GLOBAL. The project's `.credentials.json`, seen in the workspace at
 * `/home/yaac/.claude/.credentials.json`. Holds placeholder tokens so
 * Claude Code finds a credentials file with no real secrets in it.
 */
export function projectClaudeCredentialsFile(slug: string): string {
  return path.join(claudeDir(slug), '.credentials.json')
}

/** GLOBAL: mounted at `/home/yaac/.codex`. Its `sessions/` is the workspace's
 *  own history, mounted over it (`agentHistoryDir`). */
export function codexDir(slug: string): string {
  return globalProjectPath(slug, 'codex')
}

/**
 * GLOBAL. One workspace's ACP conversation logs: the raw `session/update`
 * stream acpd records, one file per conversation, mounted at
 * `/home/yaac/.yaac-acp`. Kept outside any tool's home because it belongs
 * to the protocol, not a tool, and outside {@link workspaceStateDir} so a
 * stopped workspace's conversation stays readable.
 */
export function acpLogDir(slug: string, workspaceId: string): string {
  return globalProjectPath(slug, 'acp', workspaceId)
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
export function cacheVolumeDir(slug: string, key: string): string {
  return globalProjectPath(slug, 'cache-volumes', key)
}

/**
 * GLOBAL. The project's codex `auth.json`, seen in the workspace at
 * `/home/yaac/.codex/auth.json`. Holds placeholder tokens so Codex finds a
 * valid bundle without seeing the real ones.
 */
export function projectCodexAuthFile(slug: string): string {
  return path.join(codexDir(slug), 'auth.json')
}

/**
 * GLOBAL. The project's shared opencode config, mounted at
 * `/home/yaac/.config/opencode/`, so settings like model selection persist
 * across workspaces. Each workspace's data stays separate
 * ({@link opencodeCheckpointDir}).
 */
export function opencodeConfigDir(slug: string): string {
  return globalProjectPath(slug, 'opencode-config')
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
export function opencodeCheckpointDir(slug: string, workspaceId: string): string {
  return globalProjectPath(slug, 'opencode-data', workspaceId)
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
export function piDir(slug: string): string {
  return globalProjectPath(slug, 'pi')
}

/**
 * GLOBAL. One workspace's agent conversation history, kept out of the
 * project's shared tool homes so other workspaces cannot delete it
 * (docs/workspace-storage.md). One subdirectory per
 * {@link AGENT_HISTORY_PARTS} entry, mounted over the tool homes in a pod
 * and linked into them on a host. Survives stops; deleted with the
 * workspace.
 */
export function agentHistoryDir(slug: string, workspaceId: string, part?: AgentHistoryPart): string {
  return globalProjectPath(slug, 'history', workspaceId, ...(part === undefined ? [] : [part]))
}

export const AGENT_HISTORY_PARTS = ['claude', 'claude-file-history', 'codex', 'codex-sqlite', 'pi'] as const
export type AgentHistoryPart = typeof AGENT_HISTORY_PARTS[number]

/** GLOBAL — see {@link workspaceDir}. */
export function workspacesDir(slug: string): string {
  return globalProjectPath(slug, 'workspaces')
}

/**
 * GLOBAL. The workspace's checkout, mounted at `/workspace`. It would be
 * faster node-local, but the server creates it (a clone borrowing
 * `repo/.git`'s objects) from its own filesystem.
 */
export function workspaceDir(slug: string, workspaceId: string): string {
  return path.join(workspacesDir(slug), workspaceId)
}

/**
 * GLOBAL. Per-workspace server-written files other than the checkout (e.g.
 * staged builtin skills and workspace bin scripts), mounted into the pod.
 * Removed by workspace cleanup and the orphan-workspace GC.
 */
export function workspaceStateDir(slug: string, workspaceId: string): string {
  return globalProjectPath(slug, 'sessions', workspaceId)
}

/**
 * GLOBAL. Images pasted into the workspace's terminal panes. They are
 * deleted with the state dir when the workspace stops, which is fine
 * because the agent reads an image as soon as its path is pasted.
 */
export function workspaceAttachmentsDir(slug: string, workspaceId: string): string {
  return path.join(workspaceStateDir(slug, workspaceId), 'attachments')
}


