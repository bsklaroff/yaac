import fs from 'node:fs/promises'
import path from 'node:path'
import { proxyDataHostDir } from '@/lib/k8s/bootstrap'

/**
 * Host path of the proxy's blocked-hosts write-through file. The proxy
 * writes `/data/blocked-hosts.json` (sessionId -> hostnames) atomically
 * whenever a session's blocked set grows; /data is a hostPath, so the
 * server reads the live state straight off the filesystem — no proxy
 * HTTP round-trip, no background-loop snapshotting, no staleness.
 */
export function blockedHostsStatePath(): string {
  return path.join(proxyDataHostDir(), 'blocked-hosts.json')
}

/**
 * Read the blocked hostnames the proxy has recorded for one session.
 * Tolerant of a missing or transiently torn file (the proxy writes via
 * tmp+rename, but virtiofs rename atomicity for host-side readers is not
 * guaranteed) — both cases return the empty list and the next read
 * sees the settled state.
 */
export async function readBlockedHosts(sessionId: string): Promise<string[]> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await fs.readFile(blockedHostsStatePath(), 'utf8'))
  } catch {
    return []
  }
  if (!parsed || typeof parsed !== 'object') return []
  const hosts = (parsed as Record<string, unknown>)[sessionId]
  if (!Array.isArray(hosts)) return []
  return hosts.filter((h): h is string => typeof h === 'string')
}
