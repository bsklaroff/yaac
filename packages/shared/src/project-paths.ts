import path from 'node:path'
import {
  PACKAGE_ROOT,
  ensureDataDir,
  getNodeLocalProjectsDir,
  getProjectsDir,
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
 * every running container without needing to restart sessions.
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
 * session pods' mounted CA stays valid through proxy image upgrades.
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
 * (env var name -> secret), written by the server before each session
 * registration. Injection rules sent to the proxy reference these entries
 * by key (`secretRef`) instead of embedding the value, which keeps
 * registrations secret-free so the proxy can persist them across pod
 * replacements.
 */
export function proxySecretsCredentialsPath(): string {
  return path.join(credentialsDir(), 'proxy-secrets.json')
}

/**
 * SHARED: the project's state tree — everything a session pod mounts
 * hangs off it, plus the project metadata the server keeps beside it.
 * The node-local counterpart is {@link nodeLocalProjectPath}; the two are
 * the same directory today.
 */
export function projectDir(slug: string): string {
  return sharedProjectPath(slug)
}

/** SHARED: the bare git repo. `repo/.git` is mounted into every session. */
export function repoDir(slug: string): string {
  return sharedProjectPath(slug, 'repo')
}

/** SHARED: mounted at `/home/yaac/.claude` in every session of the project. */
export function claudeDir(slug: string): string {
  return sharedProjectPath(slug, 'claude')
}

/** SHARED: mounted at `/home/yaac/.claude.json`. */
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
 * NODE-LOCAL. The project's pnpm store plus the per-session ephemeral
 * module dirs under it, mounted at `/home/yaac/.cached-packages`. A store
 * on a network filesystem turns every `link(2)`/stat into a round trip,
 * and the hardlinks it hands out must stay on one filesystem
 * (multi-node-storage-plan.md: per-node store, duplicate downloads
 * accepted). Nothing outside the session's own node reads it — except the
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
 * persist-across-sessions semantics — and the point of persisting them is
 * that the NEXT session gets the warm cache, wherever it is scheduled.
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

/** SHARED: written in-pod, read by the server's transcript reader. */
export function codexTranscriptDir(slug: string): string {
  return path.join(codexDir(slug), '.yaac-transcripts')
}

/** SHARED — see {@link codexTranscriptDir}. */
export function codexTranscriptFile(slug: string, sessionId: string): string {
  return path.join(codexTranscriptDir(slug), `${sessionId}.jsonl`)
}

/**
 * SHARED, inheriting the tool home it selects. The tools whose home is
 * shared across a project's sessions (`.claude`, `.codex`, `.pi`) are the
 * ones that can hold agent-session links; opencode keeps its history in a
 * per-session sqlite DB inside the container and has no host home to link
 * into, so it has no entry here (its conversations are enumerated over
 * HTTP while the pod runs).
 */
export function toolHomeDir(slug: string, tool: 'claude' | 'codex' | 'pi'): string {
  if (tool === 'claude') return claudeDir(slug)
  if (tool === 'codex') return codexDir(slug)
  return piDir(slug)
}

/**
 * SHARED. Root of the agent-session link tree a tool's SessionStart hook maintains
 * inside its host-mounted home. One subtree per worktree (the hook keys it by
 * `$YAAC_SESSION_ID`, which is the worktree id) — see `worktreeLinksDir`.
 */
export function agentLinksDir(slug: string, tool: 'claude' | 'codex' | 'pi'): string {
  return path.join(toolHomeDir(slug, tool), '.yaac-links')
}

/**
 * SHARED. One worktree's link subtree, holding:
 *   `sessions/<agentSessionId>.jsonl` — symlink to the live transcript, one
 *      per agent session the worktree has ever hosted (its history);
 *   `panes/<paneId>` — a pointer file naming the agent session currently on
 *      that tmux pane (its live set).
 *
 * Written by the in-pod hook, read host-side by the agent-session registry.
 * Both are needed: the symlinks survive the pod (so a stopped worktree can
 * still list its history) while the pane pointers are what make "active"
 * knowable.
 */
export function worktreeLinksDir(
  slug: string,
  tool: 'claude' | 'codex' | 'pi',
  worktreeId: string,
): string {
  return path.join(agentLinksDir(slug, tool), worktreeId)
}

/**
 * SHARED. Per-project shared opencode config root. Bind-mounted at
 * `/home/yaac/.config/opencode/` inside the container. Shared across
 * sessions within the same project so that model selection, permissions,
 * and other opencode settings (written via `Config.updateGlobal()`)
 * persist across session restarts without affecting per-session data
 * isolation (the SQLite DB in `~/.local/share/opencode/`).
 */
export function opencodeConfigDir(slug: string): string {
  return sharedProjectPath(slug, 'opencode-config')
}

/**
 * NODE-LOCAL. Per-yaac-session opencode data root — the SQLite DB —
 * bind-mounted at `/home/yaac/.local/share/opencode/` inside the
 * container. Per-session isolation sidesteps opencode upstream concurrent-
 * write issues (sst/opencode#5241) and makes `opencode --continue`
 * deterministic since each container's DB only ever contains its own
 * session.
 *
 * Node-local because SQLite forbids WAL on a network filesystem and
 * opencode has a confirmed NFS-corruption issue (anomalyco/opencode#14970).
 * The server never opens the file (opencode-status.ts probes the in-pod
 * HTTP API), so the only consequence is that resuming a session has to
 * land back on the node holding this dir — the restart node-affinity in
 * multi-node-storage-plan.md.
 */
export function opencodeDataDir(slug: string, sessionId: string): string {
  return nodeLocalProjectPath(slug, 'opencode-data', sessionId)
}

/**
 * SHARED. Per-project pi home. Bind-mounted at `/home/yaac/.pi/` inside the
 * container (the whole `.pi` dir, mirroring `claudeDir`/`~/.claude`), so every
 * session's settings, extensions, and JSONL session logs are shared across all
 * sessions of the project. Persists across container teardown, so a deleted
 * session's first message can still be parsed from its log on demand.
 */
export function piDir(slug: string): string {
  return sharedProjectPath(slug, 'pi')
}

/**
 * SHARED. Directory holding pi's JSONL session logs (one
 * `<timestamp>_<sessionId>.jsonl` per session) under the mounted pi home. pi
 * addresses each session by id via `--session-id`, so the server reads a
 * session's log by matching that id in the filename rather than isolating each
 * session in its own dir.
 */
export function piSessionsDir(slug: string): string {
  return path.join(piDir(slug), 'agent', 'sessions')
}

/** SHARED — see {@link worktreeDir}. */
export function worktreesDir(slug: string): string {
  return sharedProjectPath(slug, 'worktrees')
}

/**
 * SHARED, deliberately. The session's `/workspace`. A worktree is hot,
 * per-session data that would rather be node-local, but its `.git` file
 * points into `repo/.git/worktrees/<sid>` and the server creates it with
 * `git worktree add` from its own filesystem: keeping both halves on the
 * shared root means the server and the session pod see the same object
 * store with no new machinery. Moving it node-local needs worktree
 * creation to happen in an init container on the session's node.
 */
export function worktreeDir(slug: string, sessionId: string): string {
  return path.join(worktreesDir(slug), sessionId)
}

/**
 * SHARED. Per-session directory rooting everything session-scoped that is
 * not the worktree: the vcluster kubeconfig dir, the yaac-in-yaac data dir,
 * and the staged builtin-skills / session-bin copies. All of it is written
 * by the server and mounted into the session pod, so it has to be visible
 * from the pod's node. The one node-local exception is the tmux socket
 * dir — {@link nodeLocalSessionDir}.
 *
 * Removed wholesale by session cleanup and the orphan-session GC, which
 * sweep both roots.
 */
export function sessionDir(slug: string, sessionId: string): string {
  return sharedProjectPath(slug, 'sessions', sessionId)
}

/**
 * NODE-LOCAL twin of {@link sessionDir}: per-session scratch that only the
 * session's own node ever touches. Same directory as `sessionDir` today.
 */
export function nodeLocalSessionDir(slug: string, sessionId: string): string {
  return nodeLocalProjectPath(slug, 'sessions', sessionId)
}

/**
 * Both roots a session's state can live under, deduplicated. Anything that
 * must see ALL of a session — cleanup, the orphan GC — iterates this
 * instead of re-stating the twin relationship, so a later reclassification
 * (tmux to an emptyDir, worktrees to node-local) is edited once, here.
 *
 * One entry on the single-node backend, where the tiers coincide.
 */
export function sessionRoots(slug: string, sessionId: string): string[] {
  return [...new Set([
    sessionDir(slug, sessionId),
    nodeLocalSessionDir(slug, sessionId),
  ])]
}

/** The `sessions/` parents of {@link sessionRoots}, deduplicated. */
export function sessionsRoots(slug: string): string[] {
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

/**
 * NODE-LOCAL. Per-session directory bind-mounted into the container at
 * `CONTAINER_TMUX_DIR`, holding the tmux server socket. A UNIX socket only
 * rendezvous within the kernel that bound it, so it is node-local by
 * nature; nothing host-side connects to it either (every consumer —
 * attach, the status watcher's `tmux -C` stream, the liveness probe —
 * goes through `kubectl exec`). Nothing else is written here, so this can
 * become a pod-local emptyDir.
 */
export function sessionTmuxDir(slug: string, sessionId: string): string {
  return path.join(nodeLocalSessionDir(slug, sessionId), 'tmux')
}

/**
 * SHARED. Per-session directory holding the vcluster kubeconfig, mounted
 * at /home/yaac/.kube inside the session container (virtualCluster
 * sessions only). Written by the server (including a background heal that
 * rewrites the file in place) and read in-pod, so both sides must see it.
 * Dir-mounted (not the file) so the heal can rewrite without remounting.
 */
export function sessionVclusterDir(slug: string, sessionId: string): string {
  return path.join(sessionDir(slug, sessionId), 'vcluster')
}

/**
 * SHARED. Per-session directory backing the yaac-in-yaac data dir
 * (YAAC_DATA_DIR inside the session). Mounted at the IDENTICAL absolute
 * path in the pod — the kind $HOME extraMount makes the node see it, so
 * inner synced-pod hostPaths resolve. Also the VAP guard's only allowed
 * hostPath prefix for the session's synced pods. The inner yaac splits
 * this dir into the same three tiers again, so it must be the shared kind.
 */
export function nestedYaacDataDir(slug: string, sessionId: string): string {
  return path.join(sessionDir(slug, sessionId), 'nested-yaac')
}
