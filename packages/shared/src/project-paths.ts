import path from 'node:path'
import {
  PACKAGE_ROOT,
  clientLocalPath,
  clientLocalRoot,
  ensureClientLocalRoot,
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
  globalPath,
  globalProjectPath,
  globalRoot,
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
  clientLocalPath,
  clientLocalRoot,
  ensureClientLocalRoot,
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
  globalPath,
  globalProjectPath,
  globalRoot,
}

/*
 * ── Where each path lives ──────────────────────────────────────────────
 *
 * Every helper below is tagged with its storage tier — GLOBAL must be
 * visible from every node, NODE-LOCAL never has to leave the node it was
 * written on, SERVER-LOCAL is touched only by the server process, and
 * CLIENT-LOCAL only by processes on the user's own machine (the legend is
 * in paths.ts). Those tags are the classification's single source, and
 * the tier a path declares is what the k8s driver resolves its mount
 * source from (docs/server-in-cluster.md "Storage is two claims").
 *
 * A new helper picks a tier by calling `globalProjectPath` /
 * `nodeLocalProjectPath` / `serverLocalPath` / `clientLocalPath` (or a
 * helper built on one). There is deliberately no un-tiered way to reach
 * the data dir here.
 */

export const DOCKERFILES_DIR = path.join(PACKAGE_ROOT, 'dockerfiles')
export const PROXY_DIR = path.join(PACKAGE_ROOT, 'k8s', 'proxy')
/** Build context of the per-node network daemon (see k8s/netd/netd.ts). */
export const NETD_DIR = path.join(PACKAGE_ROOT, 'k8s', 'netd')
/** Pin for the Calico install manifest: version + checksum, no manifest
 *  bytes (see features/cluster/setup.ts). */
export const CALICO_DIR = path.join(PACKAGE_ROOT, 'k8s', 'calico')

/**
 * CLIENT-LOCAL. Where a verified Calico install manifest is cached:
 * `yaac cluster install` downloads it and feeds it to the apiserver, so no
 * pod ever reads the file and no server does either — standing a CNI up is
 * substrate administration, which only the CLI runs. Beside the data dir,
 * not in the install: it is downloaded content keyed by version, so it
 * survives yaac upgrades and is dropped with the install's client state.
 */
export function calicoManifestCachePath(version: string): string {
  return clientLocalPath('cache', `calico-${version}.yaml`)
}

/**
 * SERVER-LOCAL. Top-level directory for all host-side credential files,
 * one per service. The server is their one reader and one writer: a
 * runtime that injects them is handed the contents (`syncCredentials`)
 * and nothing mounts the directory, so the bytes never have to leave the
 * server's own volume — which is where secrets belong.
 */
export function credentialsDir(): string {
  return serverLocalPath('.credentials')
}

/** SERVER-LOCAL — see {@link credentialsDir}. */
export function githubCredentialsPath(): string {
  return path.join(credentialsDir(), 'github.json')
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
 * SERVER-LOCAL. The key the server seals stored secrets with, generated on
 * first use when the operator states none (`YAAC_SECRETS` / `YAAC_SECRET`).
 *
 * Deliberately NOT under {@link credentialsDir}, whose contents a runtime
 * is handed wholesale: a key handed out beside the ciphertext it opens is
 * not a key. This tier is the server's alone — nothing else mounts it, and
 * on a multi-node cluster nothing else needs to.
 *
 * Losing this file means every sealed row is unreadable, so it belongs in
 * whatever backs up the data dir (see README, "Secrets at rest").
 */
export function secretKeyPath(): string {
  return serverLocalPath('secret.key')
}

/**
 * GLOBAL: the project's state tree — everything a worktree pod mounts
 * hangs off it, plus the project metadata the server keeps beside it.
 * The node-local counterpart is {@link nodeLocalProjectPath}.
 */
export function projectDir(slug: string): string {
  return globalProjectPath(slug)
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
 * are root-owned and unreadable to the server's own uid — and the project
 * removal that `rm -rf`s the project tree as the server user would fail on
 * them. The store's own removal goes through a node-side pod instead (the
 * same shape the registry's `certs.d` cleanup uses).
 */
export function imageStoreDir(slug: string): string {
  return nodeLocalPath('shared-images', slug)
}

/** GLOBAL: the bare git repo. `repo/.git` is mounted into every worktree. */
export function repoDir(slug: string): string {
  return globalProjectPath(slug, 'repo')
}

/**
 * GLOBAL: mounted at `/home/yaac/.claude` in every worktree of the project,
 * and named by `CLAUDE_CONFIG_DIR` — so claude's global config is the
 * `.claude.json` INSIDE this directory, carried by this mount.
 */
export function claudeDir(slug: string): string {
  return globalProjectPath(slug, 'claude')
}

/**
 * GLOBAL, and legacy only: where claude's global config lived before
 * worktrees named `CLAUDE_CONFIG_DIR`, when it resolved beside the home dir
 * rather than inside the claude home and needed a `File` mount of its own.
 * Nothing mounts or writes it now; its one caller is the adoption that
 * carries a pre-move install's state forward, and it goes with that
 * (`adoptLegacyClaudeJson`, docs/legacy-compat-shims.md).
 */
export function claudeJsonFile(slug: string): string {
  return globalProjectPath(slug, 'claude.json')
}

/**
 * GLOBAL. Path to the project-local `.credentials.json` that gets mounted
 * into the container at `/home/yaac/.claude/.credentials.json`. Seeded with
 * placeholder tokens so Claude Code finds a credentials file without it ever
 * containing real secrets.
 */
export function projectClaudeCredentialsFile(slug: string): string {
  return path.join(claudeDir(slug), '.credentials.json')
}

/** GLOBAL: mounted at `/home/yaac/.codex`. */
export function codexDir(slug: string): string {
  return globalProjectPath(slug, 'codex')
}

/**
 * GLOBAL. One worktree's ACP conversation logs — the verbatim `session/update`
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
  return globalProjectPath(slug, 'acp', worktreeId)
}

/**
 * NODE-LOCAL. The project's package-manager caches, mounted at
 * `/home/yaac/.cached-packages`: per node, because a cache on a network
 * filesystem turns every `link(2)`/stat into a round trip. On a host it is
 * also where the project's pnpm store lives (every worktree there is a
 * process on one disk); a pod keeps its store in its own module dirs
 * instead (docs/containerless-driver.md, docs/worktree-storage.md).
 */
export function cachedPackagesDir(slug: string): string {
  return nodeLocalProjectPath(slug, '.cached-packages')
}

/**
 * GLOBAL. Host directory backing a `cacheVolumes` entry. The podman
 * backend used named volumes (`yaac-cache-<slug>-<key>`); on kubernetes
 * these are plain per-project hostPath dirs with the same
 * persist-across-worktrees semantics — and the point of persisting them is
 * that the NEXT worktree gets the warm cache, wherever it is scheduled.
 */
export function cacheVolumeDir(slug: string, key: string): string {
  return globalProjectPath(slug, 'cache-volumes', key)
}

/**
 * GLOBAL. Path to the project-local `auth.json` that gets mounted into the
 * container at `/home/yaac/.codex/auth.json`. Seeded with placeholder
 * bearer tokens so Codex finds a valid bundle without ever seeing the
 * real access/refresh tokens.
 */
export function projectCodexAuthFile(slug: string): string {
  return path.join(codexDir(slug), 'auth.json')
}

/**
 * GLOBAL. Per-project shared opencode config root. Bind-mounted at
 * `/home/yaac/.config/opencode/` inside the container. Shared across
 * worktrees within the same project so that model selection, permissions,
 * and other opencode settings (written via `Config.updateGlobal()`)
 * persist across worktree restarts without affecting per-worktree data
 * isolation (the SQLite DB in `~/.local/share/opencode/`).
 */
export function opencodeConfigDir(slug: string): string {
  return globalProjectPath(slug, 'opencode-config')
}

/**
 * GLOBAL. The one durable home of a worktree's opencode history: its
 * per-worktree SQLite database and everything beside it, as a plain copy
 * of the data directory. A k8s pod works on a node-local copy of this
 * ({@link opencodeDataDir}), checkpoints into here on a timer and at
 * `preStop`, and every start restores from here unconditionally; a
 * containerless workspace opens this directory directly, there being no
 * other filesystem to copy it to.
 *
 * Per-worktree isolation sidesteps opencode's concurrent-write issues
 * (sst/opencode#5241) and makes `opencode --continue` deterministic, since
 * each database only ever holds its own worktree.
 *
 * The spelling is frozen: it is the pre-split node-local location inside
 * the projects tree, so the layout migration's `projects/` row carries
 * every older worktree's history into place with nothing to convert
 * (docs/legacy-compat-shims.md, `migrateDataDirLayout`). Renaming it is a
 * migration of that history.
 */
export function opencodeCheckpointDir(slug: string, worktreeId: string): string {
  return globalProjectPath(slug, 'opencode-data', worktreeId)
}

/**
 * NODE-LOCAL. The WORKING COPY of {@link opencodeCheckpointDir} a k8s pod
 * runs opencode against, mounted at `CONTAINER_OPENCODE_DATA`. Present only
 * while the pod runs: the init script restores it from the checkpoint at
 * start, the checkpoint script copies it back on a timer and empties it at
 * a clean stop, and the node-local sweep collects what an unclean stop
 * left. Node-local because SQLite forbids WAL on a network filesystem and
 * opencode has a confirmed NFS-corruption issue (anomalyco/opencode#14970);
 * the server never opens the file (opencode-status.ts probes the in-pod
 * HTTP API). Unused under containerless.
 */
export function opencodeDataDir(slug: string, worktreeId: string): string {
  return nodeLocalProjectPath(slug, 'opencode-data', worktreeId)
}

/**
 * GLOBAL. Per-project pi home. Bind-mounted at `/home/yaac/.pi/` inside the
 * container (the whole `.pi` dir, mirroring `claudeDir`/`~/.claude`), so every
 * worktree's settings, extensions, and JSONL session logs are shared across all
 * worktrees of the project. Persists across container teardown, so a deleted
 * worktree's first message can still be parsed from its log on demand.
 */
export function piDir(slug: string): string {
  return globalProjectPath(slug, 'pi')
}

/**
 * GLOBAL. Directory holding pi's JSONL session logs (one
 * `<timestamp>_<worktreeId>.jsonl` per worktree) under the mounted pi home. pi
 * addresses each session by id via `--session-id`, so the server reads a
 * worktree's log by matching that id in the filename rather than isolating each
 * worktree in its own dir.
 */
export function piSessionsDir(slug: string): string {
  return path.join(piDir(slug), 'agent', 'sessions')
}

/** GLOBAL — see {@link worktreeDir}. */
export function worktreesDir(slug: string): string {
  return globalProjectPath(slug, 'worktrees')
}

/**
 * GLOBAL. What the in-pod `SessionStart` hook appends to — one JSON line per
 * firing, named for the only thing that ever writes it.
 *
 * The hook is the only witness of a user-started agent session (`/clear`, a
 * hand-typed `claude --resume`), because it alone sees `TMUX_PANE` beside the
 * tool's worktree id. Appending is what makes it safe to mount as a `File`
 * hostPath from inside a gVisor sandbox: nothing ever renames it, so the
 * inode the mount pins stays the one both sides are writing and reading.
 */
export function worktreeSessionStartsPath(slug: string, worktreeId: string): string {
  return globalProjectPath(slug, 'meta', `${worktreeId}.session-starts.jsonl`)
}

/** GLOBAL. The `meta/` directory the session-starts logs live in. */
export function worktreeMetaDir(slug: string): string {
  return globalProjectPath(slug, 'meta')
}

/**
 * GLOBAL, deliberately. The worktree's `/workspace`. A worktree is hot,
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
 * GLOBAL. Per-worktree directory rooting everything worktree-scoped that is
 * not the worktree — today the staged builtin-skills and worktree-bin
 * copies. All of it is written by the server and mounted into the worktree
 * pod, so it has to be visible from the pod's node.
 *
 * Removed wholesale by worktree cleanup and the orphan-worktree GC.
 */
export function worktreeStateDir(slug: string, worktreeId: string): string {
  return globalProjectPath(slug, 'sessions', worktreeId)
}

/**
 * Both `projects/` trees — the slug SOURCE for any sweep that must see
 * every project. Enumerating only the global root would miss a project
 * whose global half is already gone but whose node-local tree (pnpm
 * store, opencode working copy) survives.
 */
export function projectsRoots(): string[] {
  return [getProjectsDir(), getNodeLocalProjectsDir()]
}

