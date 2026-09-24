import { describe, it, expect } from 'vitest'
import { ghApiHostForGitHost } from '#credentials'

describe('ghApiHostForGitHost', () => {
  it('maps github.com to its API host', () => {
    expect(ghApiHostForGitHost('github.com')).toBe('api.github.com')
  })

  it('returns null for the API host itself (not a git remote host)', () => {
    expect(ghApiHostForGitHost('api.github.com')).toBeNull()
  })

  it('returns null for non-GitHub hosts', () => {
    expect(ghApiHostForGitHost('gitlab.com')).toBeNull()
    expect(ghApiHostForGitHost('bitbucket.org')).toBeNull()
  })

  it('returns null for GitHub Enterprise hosts (not auto-wired)', () => {
    expect(ghApiHostForGitHost('github.acme.com')).toBeNull()
  })

  it('does not match a lookalike subdomain of github.com', () => {
    expect(ghApiHostForGitHost('github.com.evil.example')).toBeNull()
    expect(ghApiHostForGitHost('notgithub.com')).toBeNull()
  })
})
