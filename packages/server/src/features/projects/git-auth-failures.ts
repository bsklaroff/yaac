import fs from 'node:fs/promises'
import path from 'node:path'
import { proxyDataHostDir } from '#features/cluster'
import type { GitAuthFailure } from '@yaac/shared/types'

/**
 * Host path of the proxy's git-auth-failures write-through file. The proxy
 * writes `/data/git-auth-failures.json` (projectSlug -> failures) atomically
 * whenever it sees an upstream reject an injected git credential (and when
 * a later success clears one); /data is a hostPath, so the server reads the
 * live state straight off the filesystem — same pattern as
 * blocked-hosts.json.
 */
export function gitAuthFailuresStatePath(): string {
  return path.join(proxyDataHostDir(), 'git-auth-failures.json')
}

/**
 * Read every project's git auth failures from the proxy write-through file.
 * Tolerant of a missing or transiently torn file (the proxy writes via
 * tmp+rename, but virtiofs rename atomicity for host-side readers is not
 * guaranteed) — both cases return an empty map and the next read sees the
 * settled state. Malformed entries are dropped; only projects with at least
 * one valid failure appear.
 */
export async function readAllGitAuthFailures(): Promise<Record<string, GitAuthFailure[]>> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await fs.readFile(gitAuthFailuresStatePath(), 'utf8'))
  } catch {
    return {}
  }
  if (!parsed || typeof parsed !== 'object') return {}
  const result: Record<string, GitAuthFailure[]> = {}
  for (const [slug, entries] of Object.entries(parsed as Record<string, unknown>)) {
    if (!Array.isArray(entries)) continue
    const valid = entries.filter((e): e is GitAuthFailure => {
      if (!e || typeof e !== 'object') return false
      const { host, status, atMs } = e as Record<string, unknown>
      return typeof host === 'string' && typeof status === 'number' && typeof atMs === 'number'
    })
    if (valid.length > 0) result[slug] = valid
  }
  return result
}

/** Read the git auth failures the proxy has recorded for one project. */
export async function readGitAuthFailures(projectSlug: string): Promise<GitAuthFailure[]> {
  return (await readAllGitAuthFailures())[projectSlug] ?? []
}
