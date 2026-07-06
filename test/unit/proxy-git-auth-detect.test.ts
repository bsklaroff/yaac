import { describe, it, expect, beforeEach } from 'vitest'

/**
 * Tests for the proxy's git-auth-failure detection. Mirrors
 * `isGitSmartHttpPath` / `noteGitUpstreamStatus` in k8s/proxy/proxy.ts —
 * the proxy runs in its own container and can't be imported directly, so we
 * copy the logic under test (same convention as proxy-github-gate.test.ts).
 *
 * The proxy calls this on every MITM'd response whose request went to the
 * session's git host with an injected credential: 401/403 on a git
 * smart-HTTP path records a per-session failure (write-through to disk),
 * a later 2xx on the same host clears it, and everything else is inert.
 */

interface GitAuthFailureRecord {
  status: number
  atMs: number
}

function isGitSmartHttpPath(requestPath: string): boolean {
  const [pathname, query = ''] = requestPath.split('?', 2)
  if (pathname.endsWith('/info/refs')) {
    const service = new URLSearchParams(query).get('service')
    return service === 'git-upload-pack' || service === 'git-receive-pack'
  }
  return pathname.endsWith('/git-upload-pack') || pathname.endsWith('/git-receive-pack')
}

const gitAuthFailuresBySession = new Map<string, Map<string, GitAuthFailureRecord>>()
let persistCount = 0

function persistGitAuthFailures(): void {
  persistCount++
}

function noteGitUpstreamStatus(
  sessionId: string,
  hostname: string,
  requestPath: string,
  status: number,
): void {
  if (!isGitSmartHttpPath(requestPath)) return
  const byHost = gitAuthFailuresBySession.get(sessionId)
  if (status === 401 || status === 403) {
    if (byHost?.has(hostname)) return // repeat failure — no disk traffic
    const hosts = byHost ?? new Map<string, GitAuthFailureRecord>()
    hosts.set(hostname, { status, atMs: Date.now() })
    gitAuthFailuresBySession.set(sessionId, hosts)
    persistGitAuthFailures()
    return
  }
  if (status >= 200 && status < 300 && byHost?.delete(hostname)) {
    persistGitAuthFailures()
  }
}

const SID = 'session-1'
const FETCH_PATH = '/acme/repo.git/info/refs?service=git-upload-pack'

describe('isGitSmartHttpPath', () => {
  it('matches the ref advertisement for fetch and push', () => {
    expect(isGitSmartHttpPath('/acme/repo.git/info/refs?service=git-upload-pack')).toBe(true)
    expect(isGitSmartHttpPath('/acme/repo.git/info/refs?service=git-receive-pack')).toBe(true)
  })

  it('matches the upload-pack and receive-pack RPC endpoints', () => {
    expect(isGitSmartHttpPath('/acme/repo.git/git-upload-pack')).toBe(true)
    expect(isGitSmartHttpPath('/acme/repo.git/git-receive-pack')).toBe(true)
  })

  it('does not match non-git traffic on the same host', () => {
    expect(isGitSmartHttpPath('/acme/repo.git/info/refs')).toBe(false)
    expect(isGitSmartHttpPath('/acme/repo.git/info/refs?service=other')).toBe(false)
    expect(isGitSmartHttpPath('/api/v3/user')).toBe(false)
    expect(isGitSmartHttpPath('/')).toBe(false)
  })
})

describe('noteGitUpstreamStatus', () => {
  beforeEach(() => {
    gitAuthFailuresBySession.clear()
    persistCount = 0
  })

  it('records a 401 on a git path and writes through once', () => {
    noteGitUpstreamStatus(SID, 'github.com', FETCH_PATH, 401)
    const rec = gitAuthFailuresBySession.get(SID)?.get('github.com')
    expect(rec?.status).toBe(401)
    expect(rec?.atMs).toBeTypeOf('number')
    expect(persistCount).toBe(1)
  })

  it('records a 403 (token valid but forbidden — e.g. SSO not authorized)', () => {
    noteGitUpstreamStatus(SID, 'github.com', FETCH_PATH, 403)
    expect(gitAuthFailuresBySession.get(SID)?.get('github.com')?.status).toBe(403)
  })

  it('skips disk traffic on repeat failures of the same host', () => {
    noteGitUpstreamStatus(SID, 'github.com', FETCH_PATH, 401)
    noteGitUpstreamStatus(SID, 'github.com', FETCH_PATH, 401)
    noteGitUpstreamStatus(SID, 'github.com', FETCH_PATH, 401)
    expect(persistCount).toBe(1)
  })

  it('ignores 401s on non-git paths (unrelated API auth is not a git failure)', () => {
    noteGitUpstreamStatus(SID, 'github.com', '/api/v3/user', 401)
    expect(gitAuthFailuresBySession.size).toBe(0)
    expect(persistCount).toBe(0)
  })

  it('ignores statuses that prove nothing about the credential', () => {
    for (const status of [404, 429, 500, 502]) {
      noteGitUpstreamStatus(SID, 'github.com', FETCH_PATH, status)
    }
    expect(gitAuthFailuresBySession.size).toBe(0)
    expect(persistCount).toBe(0)
  })

  it('clears the failure when a later git request succeeds', () => {
    noteGitUpstreamStatus(SID, 'github.com', FETCH_PATH, 401)
    noteGitUpstreamStatus(SID, 'github.com', FETCH_PATH, 200)
    expect(gitAuthFailuresBySession.get(SID)?.has('github.com')).toBe(false)
    expect(persistCount).toBe(2)
  })

  it('a success with nothing recorded does not write through', () => {
    noteGitUpstreamStatus(SID, 'github.com', FETCH_PATH, 200)
    expect(persistCount).toBe(0)
  })

  it('tracks sessions and hosts independently', () => {
    noteGitUpstreamStatus(SID, 'github.com', FETCH_PATH, 401)
    noteGitUpstreamStatus('session-2', 'gitlab.acme.com', FETCH_PATH, 403)
    noteGitUpstreamStatus('session-2', 'gitlab.acme.com', FETCH_PATH, 200)
    expect(gitAuthFailuresBySession.get(SID)?.has('github.com')).toBe(true)
    expect(gitAuthFailuresBySession.get('session-2')?.has('gitlab.acme.com')).toBe(false)
  })
})
