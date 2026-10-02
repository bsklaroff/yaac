/**
 * What the proxy observes and reports back: hosts each workspace was
 * blocked from, and git credentials an upstream rejected, per project. The
 * record is written (debounced) to the `yaac-proxy-state` ConfigMap the
 * server watches, and seeded from it at boot so a replacement pod keeps it.
 */

import type { GitAuthFailureRecord, ProxyState } from './objects'
import { isGitSmartHttpPath } from './injection'

/** Debounce for the write, since blocked hosts come in bursts. */
const WRITE_DEBOUNCE_MS = 250
/** Retry after a failed write; the next change also retries it. */
const WRITE_RETRY_MS = 5_000

export class ObservedState {
  private readonly blockedHosts = new Map<string, Set<string>>()
  /** projectSlug -> hostname -> failure. Keyed by project because the
   *  credential is the project's. */
  private readonly gitAuthFailures = new Map<string, Map<string, GitAuthFailureRecord>>()
  private writeTimer: NodeJS.Timeout | null = null

  constructor(private readonly write: (state: ProxyState) => Promise<void>) {}

  seed(state: ProxyState): void {
    for (const [workspaceId, hosts] of Object.entries(state.blockedHosts)) {
      this.blockedHosts.set(workspaceId, new Set(hosts))
    }
    for (const [slug, entries] of Object.entries(state.gitAuthFailures)) {
      this.gitAuthFailures.set(slug, new Map(entries.map(({ host, status, atMs }) => [host, { status, atMs }])))
    }
  }

  current(): ProxyState {
    const state: ProxyState = { blockedHosts: {}, gitAuthFailures: {} }
    for (const [workspaceId, hosts] of this.blockedHosts) {
      if (hosts.size > 0) state.blockedHosts[workspaceId] = [...hosts]
    }
    for (const [slug, byHost] of this.gitAuthFailures) {
      if (byHost.size > 0) state.gitAuthFailures[slug] = [...byHost].map(([host, rec]) => ({ host, ...rec }))
    }
    return state
  }

  recordBlockedHost(workspaceId: string, hostname: string): void {
    let hosts = this.blockedHosts.get(workspaceId)
    if (!hosts) {
      hosts = new Set()
      this.blockedHosts.set(workspaceId, hosts)
    }
    if (hosts.has(hostname)) return
    hosts.add(hostname)
    this.scheduleWrite()
  }

  /**
   * A workspace's registration changed: forget the blocked hosts it now
   * allows, or every one when `isAllowed` is null (the registration went).
   */
  pruneBlocked(workspaceId: string, isAllowed: ((host: string) => boolean) | null): void {
    const blocked = this.blockedHosts.get(workspaceId)
    if (!blocked) return
    if (isAllowed === null) {
      this.blockedHosts.delete(workspaceId)
      this.scheduleWrite()
      return
    }
    let pruned = false
    for (const host of blocked) {
      if (isAllowed(host)) {
        blocked.delete(host)
        pruned = true
      }
    }
    if (pruned) this.scheduleWrite()
  }

  /**
   * Record the upstream's answer to a git request that carried a project's
   * injected credential. A 401/403 means the stored token was rejected, so
   * it is recorded for the server to surface. A later 2xx on the same host
   * clears it, e.g. after `yaac auth update`.
   */
  noteGitUpstreamStatus(
    projectSlug: string | undefined,
    hostname: string,
    requestPath: string,
    status: number,
  ): void {
    if (!projectSlug || !isGitSmartHttpPath(requestPath)) return
    const byHost = this.gitAuthFailures.get(projectSlug)
    if (status === 401 || status === 403) {
      if (byHost?.has(hostname)) return
      console.log(`[proxy] GIT AUTH FAILED for ${hostname} (HTTP ${status}, project ${projectSlug})`)
      const hosts = byHost ?? new Map<string, GitAuthFailureRecord>()
      hosts.set(hostname, { status, atMs: Date.now() })
      this.gitAuthFailures.set(projectSlug, hosts)
      this.scheduleWrite()
      return
    }
    if (status >= 200 && status < 300 && byHost?.delete(hostname)) {
      console.log(`[proxy] git auth recovered for ${hostname} (project ${projectSlug})`)
      this.scheduleWrite()
    }
  }

  private scheduleWrite(delayMs = WRITE_DEBOUNCE_MS): void {
    if (this.writeTimer) return
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null
      this.write(this.current()).catch((err: unknown) => {
        console.error('[proxy] Failed to write the observed state:', String(err))
        this.scheduleWrite(WRITE_RETRY_MS)
      })
    }, delayMs)
  }
}
