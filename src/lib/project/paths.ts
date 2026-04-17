import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

function findPackageRoot(from: string): string {
  let dir = from
  while (true) {
    if (existsSync(path.join(dir, 'package.json'))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) throw new Error('Could not find package.json')
    dir = parent
  }
}

// tsup sets process.env.YAAC_BUNDLED at build time. In the bundle, static
// assets (dockerfiles/, podman/) are copied into dist/ alongside index.js.
// In dev/test, walk up from the source file to find the repo root.
export const PACKAGE_ROOT = process.env.YAAC_BUNDLED
  ? __dirname
  : findPackageRoot(__dirname)
export const DOCKERFILES_DIR = path.join(PACKAGE_ROOT, 'dockerfiles')
export const PROXY_DIR = path.join(PACKAGE_ROOT, 'podman', 'proxy-sidecar')

let dataDir: string | null = null

export function getDataDir(): string {
  return dataDir ?? path.join(os.homedir(), '.yaac')
}

export function setDataDir(dir: string): void {
  dataDir = dir
}

export function getProjectsDir(): string {
  return path.join(getDataDir(), 'projects')
}

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

export async function ensureDataDir(): Promise<void> {
  await fs.mkdir(getProjectsDir(), { recursive: true })
}
