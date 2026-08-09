import { describe, it, expect } from 'vitest'
import type http from 'node:http'

/**
 * Tests for the proxy's placeholder-gated GitHub CLI (`gh`) credential
 * injection. Mirrors the relevant slice of `buildDynamicRules` /
 * `resolveGithubApiTokenForWorktree` in k8s/proxy/proxy.ts — the proxy runs in
 * its own container and can't be imported directly, so we copy the logic
 * under test.
 *
 * `gh` reads GH_TOKEN (seeded with the placeholder) and sends it to the GitHub
 * API host. Injection fires only when the worktree has a github.com HTTPS git
 * credential AND the inbound Authorization header carries the placeholder
 * sentinel; the real token is swapped in while preserving gh's auth scheme
 * (`token ` or `Bearer `). Every other combination passes through unchanged.
 */

const PLACEHOLDER_GH_TOKEN = 'yaac-ph-gh-token'

type Injection = { action: 'set_header'; name: string; value: string }
type InjectionRule = { pathPattern: string; injections: Injection[] }
type HttpsCred = { token: string; host: string } | null

function ghApiHostForGitHost(host: string): string | null {
  if (host === 'github.com') return 'api.github.com'
  return null
}

function headerValue(
  headers: http.IncomingHttpHeaders,
  name: string,
): string | undefined {
  const v = headers[name.toLowerCase()]
  if (typeof v === 'string') return v
  if (Array.isArray(v)) return v[0]
  return undefined
}

function resolveGithubApiTokenForWorktree(cred: HttpsCred, hostname: string): string | null {
  if (!cred) return null
  if (ghApiHostForGitHost(cred.host) !== hostname) return null
  return cred.token
}

function buildGithubRules(
  cred: HttpsCred,
  hostname: string,
  reqHeaders: http.IncomingHttpHeaders,
): InjectionRule[] {
  const ghApiToken = resolveGithubApiTokenForWorktree(cred, hostname)
  if (!ghApiToken) return []
  const incomingAuth = headerValue(reqHeaders, 'authorization')
  if (!incomingAuth || !incomingAuth.includes(PLACEHOLDER_GH_TOKEN)) return []
  return [{
    pathPattern: '*',
    injections: [{
      action: 'set_header',
      name: 'Authorization',
      value: incomingAuth.replace(PLACEHOLDER_GH_TOKEN, () => ghApiToken),
    }],
  }]
}

describe('gh CLI credential injection gating', () => {
  const cred: HttpsCred = { token: 'ghp_real', host: 'github.com' }

  it('injects on api.github.com when Authorization carries the placeholder (token scheme)', () => {
    const rules = buildGithubRules(cred, 'api.github.com', {
      authorization: 'token ' + PLACEHOLDER_GH_TOKEN,
    })
    expect(rules).toEqual([{
      pathPattern: '*',
      injections: [{
        action: 'set_header',
        name: 'Authorization',
        value: 'token ghp_real',
      }],
    }])
  })

  it('preserves the Bearer scheme when gh uses it', () => {
    const rules = buildGithubRules(cred, 'api.github.com', {
      authorization: 'Bearer ' + PLACEHOLDER_GH_TOKEN,
    })
    expect(rules[0].injections[0].value).toBe('Bearer ghp_real')
  })

  it('does not inject on github.com itself (only the API host)', () => {
    const rules = buildGithubRules(cred, 'github.com', {
      authorization: 'token ' + PLACEHOLDER_GH_TOKEN,
    })
    expect(rules).toEqual([])
  })

  it('does not inject for a GitHub Enterprise credential (not auto-wired)', () => {
    const ghe: HttpsCred = { token: 'ghp_ghe', host: 'github.acme.com' }
    const rules = buildGithubRules(ghe, 'api.github.com', {
      authorization: 'token ' + PLACEHOLDER_GH_TOKEN,
    })
    expect(rules).toEqual([])
  })

  it('does not inject when the worktree has no github credential', () => {
    const rules = buildGithubRules(null, 'api.github.com', {
      authorization: 'token ' + PLACEHOLDER_GH_TOKEN,
    })
    expect(rules).toEqual([])
  })

  it('does not inject when the credential is for a non-GitHub host', () => {
    const gitlab: HttpsCred = { token: 'glpat', host: 'gitlab.com' }
    const rules = buildGithubRules(gitlab, 'api.github.com', {
      authorization: 'token ' + PLACEHOLDER_GH_TOKEN,
    })
    expect(rules).toEqual([])
  })

  it('does not inject when Authorization carries a user-supplied real token', () => {
    const rules = buildGithubRules(cred, 'api.github.com', {
      authorization: 'token ghp_user_supplied',
    })
    expect(rules).toEqual([])
  })

  it('does not inject when Authorization is absent', () => {
    const rules = buildGithubRules(cred, 'api.github.com', {})
    expect(rules).toEqual([])
  })

  it('does not inject when Authorization is empty', () => {
    const rules = buildGithubRules(cred, 'api.github.com', { authorization: '' })
    expect(rules).toEqual([])
  })
})
