import path from 'node:path'
import {
  PACKAGE_ROOT,
  ensureDataDir,
  getNodeLocalProjectsDir,
  getProjectsDir,
  nodeLocalPath,
  nodeLocalProjectPath,
  nodeLocalRoot,
  projectConfigDir,
  serverLocalPath,
  serverLocalRoot,
  setDataDir,
  sharedPath,
  sharedProjectPath,
  sharedRoot,
} from '#paths'

// The install root itself. Re-exported for the few callers that need the
// identity of the install rather than a place to put bytes (the cluster
// label hash, the web-session cookie hash) — everything that stores
// something picks a tier instead, which is why nothing in THIS file
// imports it.
// eslint-disable-next-line @typescript-eslint/no-restricted-imports
export { getDataDir } from '#paths'
export {
  PACKAGE_ROOT,
  ensureDataDir,
  getNodeLocalProjectsDir,
  getProjectsDir,
  nodeLocalPath,
  nodeLocalProjectPath,
  nodeLocalRoot,
  projectConfigDir,
  serverLocalPath,
  serverLocalRoot,
  setDataDir,
  sharedPath,
  sharedProjectPath,
  sharedRoot,
}

/*
 * ── Where each path lives ──────────────────────────────────────────────
 *
 * Every helper below is tagged with its storage tier — SHARED must be
 * visible from every node, NODE-LOCAL never has to leave the node it was
 * written on, SERVER-LOCAL is touched only by the server process (the
 * legend is in paths.ts). Those tags are the classification's single
 * source: the plan that consumes it (docs/plans/multi-node-storage-plan.md)
 * points here rather than restating a table that would drift.
 *
 * All three roots resolve to the same directory today, so this file is a
 * declaration of visibility requirements; the mount machinery that makes
 * them different volumes is docs/plans/stock-k8s-multi-node.md §2.
 *
 * A new helper picks a tier by calling `sharedProjectPath` /
 * `nodeLocalProjectPath` / `serverLocalPath` (or a helper built on one).
 * There is deliberately no un-tiered way to reach the data dir here.
 */

export const DOCKERFILES_DIR = path.join(PACKAGE_ROOT, 'dockerfiles')
export const PROXY_DIR = path.join(PACKAGE_ROOT, 'k8s', 'proxy')
/** Build context of the per-node network daemon (see k8s/netd/netd.ts). */
export const NETD_DIR = path.join(PACKAGE_ROOT, 'k8s', 'netd')
/** Pin for the Calico install manifest: version + checksum, no manifest
 *  bytes (see features/cluster/setup.ts). */
export const CALICO_DIR = path.join(PACKAGE_ROOT, 'k8s', 'calico')

/**
 * SERVER-LOCAL. Where a verified Calico install manifest is cached: the
 * server downloads it and feeds it to the apiserver, so no pod ever reads
 * the file. Under the data dir, not the install: it is downloaded content
 * keyed by version, so it survives yaac upgrades and is dropped by
 * removing the data dir.
 */
export function calicoManifestCachePath(version: string): string {
  return serverLocalPath('cache', `calico-${version}.yaml`)
}

/**
 * SHARED, reluctantly. Top-level directory for all host-side credential
 * files. Split into per-service files and bind-mounted RW into the proxy
 * sidecar so that credential updates (via `yaac auth update`) propagate to
 * every running container without needing to restart worktrees.
 *
 * The server is the only writer, which would make this server-local — but
 * the proxy pod mounts it, and on a multi-node cluster that pod is not on
 * the server's node, so the bytes have to be reachable from anywhere.
 * Handing the proxy its credentials over the API (or a Secret) instead
 * would move this to SERVER-LOCAL, where secrets belong.
 */
export function credentialsDir(): string {
  return sharedPath('.credentials')
}

/**
 * Host directory backing the proxy's `/data` (CA key/cert, tor state).
 * Persisting it across pod replacements keeps the MITM CA stable, so
 * worktree pods' mounted CA stays valid through proxy image upgrades.
 *
 * SHARED tier: the proxy pod mounts it and the server reads what the proxy
 * writes there (blocked-hosts, git-auth-failures), so both sides need the
 * same bytes wherever the proxy is scheduled.
 */
export function proxyDataHostDir(): string {
  return sharedPath('run', 'proxy-data')
}

/** SHARED — see {@link credentialsDir}. */
export function githubCredentialsPath(): string {
  return path.join(credentialsDir(), 'github.json')
}

/** SHARED — see {@link credentialsDir}. */
export function claudeCredentialsPath(): string {
  return path.join(credentialsDir(), 'claude.json')
}

/** SHARED — see {@link credentialsDir}. */
export function codexCredentialsPath(): string {
  return path.join(credentialsDir(), 'codex.json')
}

/** SHARED — see {@link credentialsDir}. */
export function opencodeCredentialsPath(): string {
  return path.join(credentialsDir(), 'opencode.json')
}

/** SHARED — see {@link credentialsDir}. */
export function piCredentialsPath(): string {
  return path.join(credentialsDir(), 'pi.json')
}

/**
 * SHARED — see {@link credentialsDir}. File holding envSecretProxy values
 * (env var name -> secret), written by the server before each worktree
 * registration. Injection rules sent to the proxy reference these entries
 * by key (`secretRef`) instead of embedding the value, which keeps
 * registrations secret-free so the proxy can persist them across pod
 * replacements.
 */
export function proxySecretsCredentialsPath(): string {
  return path.join(credentialsDir(), 'proxy-secrets.json')
}

/**
 * SHARED: the project's state tree — everything a worktree pod mounts
 * hangs off it, plus the project metadata the server keeps beside it.
 * The node-local counterpart is {@link nodeLocalProjectPath}; the two are
 * the same directory today.
 */
export function projectDir(slug: string): string {
  return sharedProjectPath(slug)
}

/**
 * NODE-LOCAL. Parent of a project's node-local image store generations —
 * the read-only containers/storage lower that every nested worktree of the
 * project mounts at `/var/lib/shared-images` (docs/nested-containers.md).
 * Per node because a store is a cache of the project registry, not a
 * second source of truth: a cold node simply mounts nothing.
 *
 * DELIBERATELY OUTSIDE the project tree, unlike every other per-project
 * path. Its contents are written by a root-running node-side pod, so they
 * are root-owned and unreadable to the server's own uid — and
 * {@link projectRoots}, which project removal `rm -rf`s as the server user,
 * would fail on them. The store's own removal goes through a node-side pod
 * instead (the same shape the registry's `certs.d` cleanup uses).
 */
export function imageStoreDir(slug: string): string {
  return nodeLocalPath('shared-images', slug)
}

/** SHARED: the bare git repo. `repo/.git` is mounted into every worktree. */
export function repoDir(slug: string): string {
  return sharedProjectPath(slug, 'repo')
}

/**
 * SHARED: mounted at `/home/yaac/.claude` in every worktree of the project,
 * and named by `CLAUDE_CONFIG_DIR` — so claude's global config is the
 * `.claude.json` INSIDE this directory, carried by this mount.
 */
export function claudeDir(slug: string): string {
  return sharedProjectPath(slug, 'claude')
}

/**
 * SHARED, and legacy only: where claude's global config lived before
 * worktrees named `CLAUDE_CONFIG_DIR`, when it resolved beside the home dir
 * rather than inside the claude home and needed a `File` mount of its own.
 * Nothing mounts or writes it now; its one caller is the adoption that
 * carries a pre-move install's state forward, and it goes with that
 * (`adoptLegacyClaudeJson`, docs/legacy-compat-shims.md).
 */
export function claudeJsonFile(slug: string): string {
  return sharedProjectPath(slug, 'claude.json')
}

/**
 * SHARED. Path to the project-local `.credentials.json` that gets mounted
 * into the container at `/home/yaac/.claude/.credentials.json`. Seeded with
 * placeholder tokens so Claude Code finds a credentials file without it ever
 * containing real secrets.
 */
export function projectClaudeCredentialsFile(slug: string): string {
  return path.join(claudeDir(slug), '.credentials.json')
}

/** SHARED: mounted at `/home/yaac/.codex`. */
export function codexDir(slug: string): string {
  return sharedProjectPath(slug, 'codex')
}

/**
 * SHARED. One worktree's ACP conversation logs — the verbatim `session/update`
 * stream acpd tees as it relays, one file per conversation, mounted read-write
 * at `/home/yaac/.yaac-acp` in that worktree's worktree.
 *
 * Deliberately beside the tool homes rather than inside one: the log is a
 * property of the *protocol*, so a future codex or pi adapter writes to the
 * same place. Project-level rather than under the worktree dir because teardown
 * prunes that, and a stopped worktree's conversation should still be readable —
 * the same reason a tool's transcripts outlive their pod.
 *
 * Worktree-scoped because the file is named for its conversation and every
 * worktree's primary window is named for its tool, so a flat project-level dir
 * would collide across worktrees.
 */
export function acpLogDir(slug: string, worktreeId: string): string {
  return sharedProjectPath(slug, 'acp', worktreeId)
}

/**
 * NODE-LOCAL. The project's pnpm store plus the per-worktree ephemeral
 * module dirs under it, mounted at `/home/yaac/.cached-packages`. A store
 * on a network filesystem turns every `link(2)`/stat into a round trip,
 * and the hardlinks it hands out must stay on one filesystem
 * (multi-node-storage-plan.md: per-node store, duplicate downloads
 * accepted). Nothing outside the worktree's own node reads it — except the
 * orphan-modules GC, which is the server-side sweep that has to learn to
 * enumerate per node.
 */
export function cachedPackagesDir(slug: string): string {
  return nodeLocalProjectPath(slug, '.cached-packages')
}

/**
 * SHARED. Host directory backing a `cacheVolumes` entry. The podman
 * backend used named volumes (`yaac-cache-<slug>-<key>`); on kubernetes
 * these are plain per-project hostPath dirs with the same
 * persist-across-worktrees semantics — and the point of persisting them is
 * that the NEXT worktree gets the warm cache, wherever it is scheduled.
 */
export function cacheVolumeDir(slug: string, key: string): string {
  return sharedProjectPath(slug, 'cache-volumes', key)
}

/**
 * SHARED. Path to the project-local `auth.json` that gets mounted into the
 * container at `/home/yaac/.codex/auth.json`. Seeded with placeholder
 * bearer tokens so Codex finds a valid bundle without ever seeing the
 * real access/refresh tokens.
 */
export function projectCodexAuthFile(slug: string): string {
  return path.join(codexDir(slug), 'auth.json')
}

/**
 * SHARED. Per-project shared opencode config root. Bind-mounted at
 * `/home/yaac/.config/opencode/` inside the container. Shared across
 * worktrees within the same project so that model selection, permissions,
 * and other opencode settings (written via `Config.updateGlobal()`)
 * persist across worktree restarts without affecting per-worktree data
 * isolation (the SQLite DB in `~/.local/share/opencode/`).
 */
export function opencodeConfigDir(slug: string): string {
  return sharedProjectPath(slug, 'opencode-config')
}

/**
 * NODE-LOCAL. Per-yaac-session opencode data root — the SQLite DB —
 * bind-mounted at `/home/yaac/.local/share/opencode/` inside the
 * container. Per-worktree isolation sidesteps opencode upstream concurrent-
 * write issues (sst/opencode#5241) and makes `opencode --continue`
 * deterministic since each container's DB only ever contains its own
 * worktree.
 *
 * Node-local because SQLite forbids WAL on a network filesystem and
 * opencode has a confirmed NFS-corruption issue (anomalyco/opencode#14970).
 * The server never opens the file (opencode-status.ts probes the in-pod
 * HTTP API), so the only consequence is that resuming a worktree has to
 * land back on the node holding this dir — the restart node-affinity in
 * multi-node-storage-plan.md.
 */
export function opencodeDataDir(slug: string, worktreeId: string): string {
  return nodeLocalProjectPath(slug, 'opencode-data', worktreeId)
}

/**
 * SHARED. Per-project pi home. Bind-mounted at `/home/yaac/.pi/` inside the
 * container (the whole `.pi` dir, mirroring `claudeDir`/`~/.claude`), so every
 * worktree's settings, extensions, and JSONL session logs are shared across all
 * worktrees of the project. Persists across container teardown, so a deleted
 * worktree's first message can still be parsed from its log on demand.
 */
export function piDir(slug: string): string {
  return sharedProjectPath(slug, 'pi')
}

/**
 * SHARED. Directory holding pi's JSONL session logs (one
 * `<timestamp>_<worktreeId>.jsonl` per worktree) under the mounted pi home. pi
 * addresses each session by id via `--session-id`, so the server reads a
 * worktree's log by matching that id in the filename rather than isolating each
 * worktree in its own dir.
 */
export function piSessionsDir(slug: string): string {
  return path.join(piDir(slug), 'agent', 'sessions')
}

/** SHARED — see {@link worktreeDir}. */
export function worktreesDir(slug: string): string {
  return sharedProjectPath(slug, 'worktrees')
}

/**
 * SHARED. What the in-pod `SessionStart` hook appends to — one JSON line per
 * firing, named for the only thing that ever writes it.
 *
 * The hook is the only witness of a user-started agent session (`/clear`, a
 * hand-typed `claude --resume`), because it alone sees `TMUX_PANE` beside the
 * tool's worktree id. Appending is what makes it safe to mount as a `File`
 * hostPath from inside a gVisor sandbox: nothing ever renames it, so the
 * inode the mount pins stays the one both sides are writing and reading.
 */
export function worktreeSessionStartsPath(slug: string, worktreeId: string): string {
  return sharedProjectPath(slug, 'meta', `${worktreeId}.session-starts.jsonl`)
}

/** SHARED. The `meta/` directory the session-starts logs live in. */
export function worktreeMetaDir(slug: string): string {
  return sharedProjectPath(slug, 'meta')
}

/**
 * SHARED, deliberately. The worktree's `/workspace`. A worktree is hot,
 * per-worktree data that would rather be node-local, but its `.git` file
 * points into `repo/.git/worktrees/<sid>` and the server creates it with
 * `git worktree add` from its own filesystem: keeping both halves on the
 * shared root means the server and the worktree pod see the same object
 * store with no new machinery. Moving it node-local needs worktree
 * creation to happen in an init container on the worktree's node.
 */
export function worktreeDir(slug: string, worktreeId: string): string {
  return path.join(worktreesDir(slug), worktreeId)
}

/**
 * SHARED. Per-worktree directory rooting everything worktree-scoped that is
 * not the worktree — today the staged builtin-skills and worktree-bin
 * copies. All of it is written by the server and mounted into the worktree
 * pod, so it has to be visible from the pod's node. Its node-local twin is
 * {@link nodeLocalWorktreeStateDir}.
 *
 * Removed wholesale by worktree cleanup and the orphan-worktree GC, which
 * sweep both roots.
 */
export function worktreeStateDir(slug: string, worktreeId: string): string {
  return sharedProjectPath(slug, 'sessions', worktreeId)
}

/**
 * NODE-LOCAL twin of {@link worktreeStateDir}: per-worktree scratch that only the
 * worktree's own node ever touches. Same directory as `worktreeStateDir` today.
 *
 * Nothing writes under it right now — its last resident, the tmux socket
 * dir, is a pod-local emptyDir (see CONTAINER_TMUX_DIR). It stays because
 * it is the tier declaration the sweeps below are built on: worktree scratch
 * that has to survive the pod but not leave the node lands here, and
 * {@link worktreeStateRoots} already reaches it.
 */
export function nodeLocalWorktreeStateDir(slug: string, worktreeId: string): string {
  return nodeLocalProjectPath(slug, 'sessions', worktreeId)
}

/**
 * Both roots a worktree's state can live under, deduplicated. Anything that
 * must see ALL of a worktree — cleanup, the orphan GC — iterates this
 * instead of re-stating the twin relationship, so a reclassification
 * (worktrees to node-local, say) is edited once, here.
 *
 * One entry on the single-node backend, where the tiers coincide.
 */
export function worktreeStateRoots(slug: string, worktreeId: string): string[] {
  return [...new Set([
    worktreeStateDir(slug, worktreeId),
    nodeLocalWorktreeStateDir(slug, worktreeId),
  ])]
}

/** The `worktrees/` parents of {@link worktreeStateRoots}, deduplicated. */
export function projectWorktreeStateRoots(slug: string): string[] {
  return [...new Set([
    sharedProjectPath(slug, 'sessions'),
    nodeLocalProjectPath(slug, 'sessions'),
  ])]
}

/** Both roots a PROJECT's state can live under, deduplicated. */
export function projectRoots(slug: string): string[] {
  return [...new Set([projectDir(slug), nodeLocalProjectPath(slug)])]
}

/**
 * Both `projects/` trees, deduplicated — the slug SOURCE for any sweep
 * that must see every project. Enumerating only the shared root would miss
 * a project whose shared half is already gone but whose node-local tree
 * (pnpm store, opencode data) survives.
 */
export function projectsRoots(): string[] {
  return [...new Set([getProjectsDir(), getNodeLocalProjectsDir()])]
}

