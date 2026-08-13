import fs from 'node:fs/promises'
import path from 'node:path'
import { proxyDataHostDir } from '@yaac/shared/project-paths'

/**
 * Host path of the proxy's blocked-hosts write-through file. The proxy
 * writes `/data/blocked-hosts.json` (worktreeId -> hostnames) atomically
 * whenever a worktree's blocked set grows; /data is a hostPath, so the
 * server reads the live state straight off the filesystem — no proxy
 * HTTP round-trip, no reconcile-pass snapshotting, no staleness.
 *
 * The file is the data plane; knowing *when* to re-read it is the proxy
 * event stream's job (see proxy-events.ts), which emits a contentless
 * `blocked-hosts` after each write.
 */
export function blockedHostsStatePath(): string {
  return path.join(proxyDataHostDir(), 'blocked-hosts.json')
}

/**
 * Read the blocked hostnames the proxy has recorded for one worktree.
 * Tolerant of a missing or transiently torn file (the proxy writes via
 * tmp+rename, but virtiofs rename atomicity for host-side readers is not
 * guaranteed) — both cases return the empty list and the next read
 * sees the settled state.
 */
export async function readBlockedHosts(worktreeId: string): Promise<string[]> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await fs.readFile(blockedHostsStatePath(), 'utf8'))
  } catch {
    return []
  }
  if (!parsed || typeof parsed !== 'object') return []
  const hosts = (parsed as Record<string, unknown>)[worktreeId]
  if (!Array.isArray(hosts)) return []
  return hosts.filter((h): h is string => typeof h === 'string')
}
