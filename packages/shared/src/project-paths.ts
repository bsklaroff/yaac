import path from 'node:path'
import {
  PACKAGE_ROOT,
  ensureDataDir,
  getDataDir,
  getProjectsDir,
  projectConfigDir,
  setDataDir,
} from '#paths'

export { PACKAGE_ROOT, ensureDataDir, getDataDir, getProjectsDir, projectConfigDir, setDataDir }

export const DOCKERFILES_DIR = path.join(PACKAGE_ROOT, 'dockerfiles')
export const PROXY_DIR = path.join(PACKAGE_ROOT, 'k8s', 'proxy')

/**
 * Top-level directory for all host-side credential files. Split into
 * per-service files and bind-mounted RW into the proxy sidecar so that
 * credential updates (via `yaac auth update`) propagate to every running
 * container without needing to restart sessions.
 */
export function credentialsDir(): string {
  return path.join(getDataDir(), '.credentials')
}

export function githubCredentialsPath(): string {
  return path.join(credentialsDir(), 'github.json')
}

export function claudeCredentialsPath(): string {
  return path.join(credentialsDir(), 'claude.json')
}

export function codexCredentialsPath(): string {
  return path.join(credentialsDir(), 'codex.json')
}

export function opencodeCredentialsPath(): string {
  return path.join(credentialsDir(), 'opencode.json')
}

/**
 * File holding envSecretProxy values (env var name -> secret), written by
 * the server before each session registration. Injection rules sent to
 * the proxy reference these entries by key (`secretRef`) instead of
 * embedding the value, which keeps registrations secret-free so the proxy
 * can persist them across pod replacements.
 */
export function proxySecretsCredentialsPath(): string {
  return path.join(credentialsDir(), 'proxy-secrets.json')
}

export function projectDir(slug: string): string {
  return path.join(getProjectsDir(), slug)
}

export function repoDir(slug: string): string {
  return path.join(projectDir(slug), 'repo')
}

export function claudeDir(slug: string): string {
  return path.join(projectDir(slug), 'claude')
}

export function claudeJsonFile(slug: string): string {
  return path.join(projectDir(slug), 'claude.json')
}

/**
 * Path to the project-local `.credentials.json` that gets mounted into the
 * container at `/home/yaac/.claude/.credentials.json`. Seeded with placeholder
 * tokens so Claude Code finds a credentials file without it ever containing
 * real secrets.
 */
export function projectClaudeCredentialsFile(slug: string): string {
  return path.join(claudeDir(slug), '.credentials.json')
}

export function codexDir(slug: string): string {
  return path.join(projectDir(slug), 'codex')
}

export function cachedPackagesDir(slug: string): string {
  return path.join(projectDir(slug), '.cached-packages')
}

/**
 * Host directory backing a `cacheVolumes` entry. The podman backend used
 * named volumes (`yaac-cache-<slug>-<key>`); on kubernetes these are
 * plain per-project hostPath dirs with the same persist-across-sessions
 * semantics.
 */
export function cacheVolumeDir(slug: string, key: string): string {
  return path.join(projectDir(slug), 'cache-volumes', key)
}

/**
 * Path to the project-local `auth.json` that gets mounted into the
 * container at `/home/yaac/.codex/auth.json`. Seeded with placeholder
 * bearer tokens so Codex finds a valid bundle without ever seeing the
 * real access/refresh tokens.
 */
export function projectCodexAuthFile(slug: string): string {
  return path.join(codexDir(slug), 'auth.json')
}

export function codexTranscriptDir(slug: string): string {
  return path.join(codexDir(slug), '.yaac-transcripts')
}

export function codexTranscriptFile(slug: string, sessionId: string): string {
  return path.join(codexTranscriptDir(slug), `${sessionId}.jsonl`)
}

/**
 * Per-project shared opencode config root. Bind-mounted at
 * `/home/yaac/.config/opencode/` inside the container. Shared across
 * sessions within the same project so that model selection, permissions,
 * and other opencode settings (written via `Config.updateGlobal()`)
 * persist across session restarts without affecting per-session data
 * isolation (the SQLite DB in `~/.local/share/opencode/`).
 */
export function opencodeConfigDir(slug: string): string {
  return path.join(projectDir(slug), 'opencode-config')
}

/**
 * Per-yaac-session opencode data root. Bind-mounted at
 * `/home/yaac/.local/share/opencode/` inside the container. Per-session
 * isolation sidesteps opencode upstream concurrent-write issues
 * (sst/opencode#5241) and makes `opencode --continue` deterministic since
 * each container's DB only ever contains its own session.
 *
 * Persists across container teardown so `yaac session list -d` first-
 * message lookups still work via the meta cache below.
 */
export function opencodeDataDir(slug: string, sessionId: string): string {
  return path.join(projectDir(slug), 'opencode-data', sessionId)
}

export function worktreesDir(slug: string): string {
  return path.join(projectDir(slug), 'worktrees')
}

export function worktreeDir(slug: string, sessionId: string): string {
  return path.join(worktreesDir(slug), sessionId)
}

/**
 * Per-session host directory rooting everything session-scoped that is
 * not the worktree: the tmux socket dir, the vcluster kubeconfig dir,
 * and the yaac-in-yaac data dir. Removed wholesale by session cleanup
 * and the orphan-session GC.
 */
export function sessionDir(slug: string, sessionId: string): string {
  return path.join(projectDir(slug), 'sessions', sessionId)
}

/**
 * Per-session host directory bind-mounted into the container at
 * `CONTAINER_TMUX_DIR`. Holds the tmux server socket so the server can
 * probe liveness without hitting the podman API.
 */
export function sessionTmuxDir(slug: string, sessionId: string): string {
  return path.join(sessionDir(slug, sessionId), 'tmux')
}

/**
 * Per-session host directory holding the vcluster kubeconfig, mounted
 * at /home/yaac/.kube inside the session container (virtualCluster
 * sessions only). Dir-mounted (not the file) so the server's background
 * kubeconfig heal can rewrite the file without remounting.
 */
export function sessionVclusterDir(slug: string, sessionId: string): string {
  return path.join(sessionDir(slug, sessionId), 'vcluster')
}

/**
 * Per-session host directory backing the yaac-in-yaac data dir
 * (YAAC_DATA_DIR inside the session). Mounted at the IDENTICAL absolute
 * path in the pod — the kind $HOME extraMount makes the node see it, so
 * inner synced-pod hostPaths resolve. Also the VAP guard's only allowed
 * hostPath prefix for the session's synced pods.
 */
export function nestedYaacDataDir(slug: string, sessionId: string): string {
  return path.join(sessionDir(slug, sessionId), 'nested-yaac')
}
