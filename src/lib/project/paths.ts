import path from 'node:path'
import {
  PACKAGE_ROOT,
  ensureDataDir,
  getDataDir,
  getProjectsDir,
  setDataDir,
} from '@/shared/paths'

export { PACKAGE_ROOT, ensureDataDir, getDataDir, getProjectsDir, setDataDir }

export const DOCKERFILES_DIR = path.join(PACKAGE_ROOT, 'dockerfiles')
export const PROXY_DIR = path.join(PACKAGE_ROOT, 'podman', 'proxy-sidecar')

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

export function projectDir(slug: string): string {
  return path.join(getProjectsDir(), slug)
}

export function repoDir(slug: string): string {
  return path.join(projectDir(slug), 'repo')
}

export function configOverrideDir(slug: string): string {
  return path.join(projectDir(slug), 'config-override')
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

export function worktreesDir(slug: string): string {
  return path.join(projectDir(slug), 'worktrees')
}

export function worktreeDir(slug: string, sessionId: string): string {
  return path.join(worktreesDir(slug), sessionId)
}

export function blockedHostsDir(slug: string): string {
  return path.join(projectDir(slug), 'blocked-hosts')
}

export function blockedHostsFile(slug: string, sessionId: string): string {
  return path.join(blockedHostsDir(slug), `${sessionId}.json`)
}
