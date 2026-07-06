import fs from 'node:fs/promises'
import path from 'node:path'
import { proxyDataHostDir } from '@/lib/k8s/bootstrap'
import type { GitAuthFailure } from '@/shared/types'

/**
 * Host path of the proxy's git-auth-failures write-through file. The proxy
 * writes `/data/git-auth-failures.json` (sessionId -> failures) atomically
 * whenever it sees an upstream reject an injected git credential (and when
 * a later success clears one); /data is a hostPath, so the daemon reads
 * the live state straight off the filesystem — same pattern as
 * blocked-hosts.json.
 */
export function gitAuthFailuresStatePath(): string {
  return path.join(proxyDataHostDir(), 'git-auth-failures.json')
}

/**
 * Read the git auth failures the proxy has recorded for one session.
 * Tolerant of a missing or transiently torn file (the proxy writes via
 * tmp+rename, but virtiofs rename atomicity for host-side readers is not
 * guaranteed) — both cases return the empty list and the next read sees
 * the settled state.
 */
export async function readGitAuthFailures(sessionId: string): Promise<GitAuthFailure[]> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await fs.readFile(gitAuthFailuresStatePath(), 'utf8'))
  } catch {
    return []
  }
  if (!parsed || typeof parsed !== 'object') return []
  const entries = (parsed as Record<string, unknown>)[sessionId]
  if (!Array.isArray(entries)) return []
  return entries.filter((e): e is GitAuthFailure => {
    if (!e || typeof e !== 'object') return false
    const { host, status, atMs } = e as Record<string, unknown>
    return typeof host === 'string' && typeof status === 'number' && typeof atMs === 'number'
  })
}
