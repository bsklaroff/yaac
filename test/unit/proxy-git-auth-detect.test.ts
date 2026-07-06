import { describe, it, expect, beforeEach } from 'vitest'

/**
 * Tests for the proxy's git-auth-failure detection. Mirrors
 * `isGitSmartHttpPath` / `noteGitUpstreamStatus` in k8s/proxy/proxy.ts —
 * the proxy runs in its own container and can't be imported directly, so we
 * copy the logic under test (same convention as proxy-github-gate.test.ts).
 *
 * The proxy calls this on every MITM'd response whose request went to the
 * session's git host with an injected credential: 401/403 on a git
 * smart-HTTP path records a failure against the session's PROJECT
 * (write-through to disk) — the credential is the project's, so one bad
 * token flags every session of the project — a later 2xx on the same host
 * from any of the project's sessions clears it, and everything else is
 * inert.
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

const sessionProject = new Map<string, string>()
const gitAuthFailuresByProject = new Map<string, Map<string, GitAuthFailureRecord>>()
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
  const projectSlug = sessionProject.get(sessionId)
  if (!projectSlug) return // unregistered session — can't attribute
  const byHost = gitAuthFailuresByProject.get(projectSlug)
  if (status === 401 || status === 403) {
    if (byHost?.has(hostname)) return // repeat failure — no disk traffic
    const hosts = byHost ?? new Map<string, GitAuthFailureRecord>()
    hosts.set(hostname, { status, atMs: Date.now() })
    gitAuthFailuresByProject.set(projectSlug, hosts)
    persistGitAuthFailures()
    return
  }
  if (status >= 200 && status < 300 && byHost?.delete(hostname)) {
    persistGitAuthFailures()
  }
}

const SID = 'session-1'
const PROJECT = 'project-a'
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
    sessionProject.clear()
    sessionProject.set(SID, PROJECT)
    sessionProject.set('session-2', PROJECT)
    sessionProject.set('session-other', 'project-b')
    gitAuthFailuresByProject.clear()
    persistCount = 0
  })

  it('records a 401 on a git path against the session\'s project and writes through once', () => {
    noteGitUpstreamStatus(SID, 'github.com', FETCH_PATH, 401)
    const rec = gitAuthFailuresByProject.get(PROJECT)?.get('github.com')
    expect(rec?.status).toBe(401)
    expect(rec?.atMs).toBeTypeOf('number')
    expect(persistCount).toBe(1)
  })

  it('records a 403 (token valid but forbidden — e.g. SSO not authorized)', () => {
    noteGitUpstreamStatus(SID, 'github.com', FETCH_PATH, 403)
    expect(gitAuthFailuresByProject.get(PROJECT)?.get('github.com')?.status).toBe(403)
  })

  it('skips disk traffic on repeat failures of the same host', () => {
    noteGitUpstreamStatus(SID, 'github.com', FETCH_PATH, 401)
    noteGitUpstreamStatus(SID, 'github.com', FETCH_PATH, 401)
    noteGitUpstreamStatus(SID, 'github.com', FETCH_PATH, 401)
    expect(persistCount).toBe(1)
  })

  it('a repeat failure from a sibling session of the same project also skips disk traffic', () => {
    noteGitUpstreamStatus(SID, 'github.com', FETCH_PATH, 401)
    noteGitUpstreamStatus('session-2', 'github.com', FETCH_PATH, 401)
    expect(persistCount).toBe(1)
  })

  it('ignores 401s on non-git paths (unrelated API auth is not a git failure)', () => {
    noteGitUpstreamStatus(SID, 'github.com', '/api/v3/user', 401)
    expect(gitAuthFailuresByProject.size).toBe(0)
    expect(persistCount).toBe(0)
  })

  it('ignores sessions with no registered project (cannot attribute)', () => {
    noteGitUpstreamStatus('unregistered-session', 'github.com', FETCH_PATH, 401)
    expect(gitAuthFailuresByProject.size).toBe(0)
    expect(persistCount).toBe(0)
  })

  it('ignores statuses that prove nothing about the credential', () => {
    for (const status of [404, 429, 500, 502]) {
      noteGitUpstreamStatus(SID, 'github.com', FETCH_PATH, status)
    }
    expect(gitAuthFailuresByProject.size).toBe(0)
    expect(persistCount).toBe(0)
  })

  it('clears the failure when a later git request succeeds', () => {
    noteGitUpstreamStatus(SID, 'github.com', FETCH_PATH, 401)
    noteGitUpstreamStatus(SID, 'github.com', FETCH_PATH, 200)
    expect(gitAuthFailuresByProject.get(PROJECT)?.has('github.com')).toBe(false)
    expect(persistCount).toBe(2)
  })

  it('a success from a sibling session clears the project flag (self-heal is project-wide)', () => {
    noteGitUpstreamStatus(SID, 'github.com', FETCH_PATH, 401)
    noteGitUpstreamStatus('session-2', 'github.com', FETCH_PATH, 200)
    expect(gitAuthFailuresByProject.get(PROJECT)?.has('github.com')).toBe(false)
    expect(persistCount).toBe(2)
  })

  it('a success with nothing recorded does not write through', () => {
    noteGitUpstreamStatus(SID, 'github.com', FETCH_PATH, 200)
    expect(persistCount).toBe(0)
  })

  it('tracks projects and hosts independently', () => {
    noteGitUpstreamStatus(SID, 'github.com', FETCH_PATH, 401)
    noteGitUpstreamStatus('session-other', 'gitlab.acme.com', FETCH_PATH, 403)
    noteGitUpstreamStatus('session-other', 'gitlab.acme.com', FETCH_PATH, 200)
    expect(gitAuthFailuresByProject.get(PROJECT)?.has('github.com')).toBe(true)
    expect(gitAuthFailuresByProject.get('project-b')?.has('gitlab.acme.com')).toBe(false)
  })
})
