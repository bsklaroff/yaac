import { describe, it, expect } from 'vitest'
import {
  validatePattern,
  parsePattern,
  matchPattern,
  ghApiHostForGitHost,
} from '#credentials'

describe('credential patterns', () => {
  describe('validatePattern', () => {
    it('accepts <host>/*', () => {
      expect(validatePattern('github.com/*')).toBe(true)
      expect(validatePattern('git.example.com/*')).toBe(true)
    })

    it('accepts <host>/<owner>/*', () => {
      expect(validatePattern('github.com/acme/*')).toBe(true)
    })

    it('accepts <host>/<owner>/<repo>', () => {
      expect(validatePattern('github.com/acme/my-repo')).toBe(true)
    })

    it('accepts deep prefix patterns', () => {
      expect(validatePattern('gitlab.com/group/sub/*')).toBe(true)
    })

    it('accepts deep exact patterns', () => {
      expect(validatePattern('gitlab.com/group/sub/repo')).toBe(true)
    })

    it('accepts single-segment exact path (Gerrit-style)', () => {
      expect(validatePattern('gerrit.example.com/myrepo')).toBe(true)
    })

    it('rejects bare *', () => {
      expect(validatePattern('*')).toBe(false)
    })

    it('rejects bare <owner>/*', () => {
      expect(validatePattern('acme/*')).toBe(false)  // 'acme' is not a host (no dot)
    })

    it('rejects bare <owner>/<repo>', () => {
      // 'acme/repo' is rejected — first segment has no dot, treated as owner
      expect(validatePattern('acme/repo')).toBe(false)
    })

    it('rejects empty string', () => {
      expect(validatePattern('')).toBe(false)
    })

    it('rejects wildcard in host', () => {
      expect(validatePattern('*.example.com/*')).toBe(false)
    })

    it('rejects wildcard in middle path segment', () => {
      expect(validatePattern('github.com/*/repo')).toBe(false)
      expect(validatePattern('gitlab.com/group/*/repo')).toBe(false)
    })

    it('rejects partial wildcards in path', () => {
      expect(validatePattern('github.com/owner/repo-*')).toBe(false)
    })

    it('rejects bare host with no path', () => {
      expect(validatePattern('github.com')).toBe(false)
    })

    it('rejects empty path segments', () => {
      expect(validatePattern('github.com//repo')).toBe(false)
    })
  })

  describe('parsePattern', () => {
    it('canonicalizes <host>/*', () => {
      expect(parsePattern('git.example.com/*'))
        .toEqual({ host: 'git.example.com', kind: 'any', path: '' })
    })

    it('canonicalizes <host>/<owner>/*', () => {
      expect(parsePattern('github.com/acme/*'))
        .toEqual({ host: 'github.com', kind: 'prefix', path: 'acme' })
    })

    it('canonicalizes <host>/<owner>/<repo>', () => {
      expect(parsePattern('github.com/acme/repo'))
        .toEqual({ host: 'github.com', kind: 'exact', path: 'acme/repo' })
    })

    it('canonicalizes deep prefix patterns', () => {
      expect(parsePattern('gitlab.com/group/sub/*'))
        .toEqual({ host: 'gitlab.com', kind: 'prefix', path: 'group/sub' })
    })

    it('canonicalizes deep exact patterns', () => {
      expect(parsePattern('gitlab.com/group/sub/repo'))
        .toEqual({ host: 'gitlab.com', kind: 'exact', path: 'group/sub/repo' })
    })

    it('canonicalizes single-segment exact patterns', () => {
      expect(parsePattern('gerrit.example.com/myrepo'))
        .toEqual({ host: 'gerrit.example.com', kind: 'exact', path: 'myrepo' })
    })

    it('throws on bare patterns', () => {
      expect(() => parsePattern('*')).toThrow()
      expect(() => parsePattern('acme/*')).toThrow()
    })
  })


  describe('matchPattern', () => {
    it('<host>/* matches everything on host', () => {
      expect(matchPattern('github.com/*', 'github.com', 'any/repo')).toBe(true)
      expect(matchPattern('github.com/*', 'github.com', 'single')).toBe(true)
    })

    it('<host>/* does not match other host', () => {
      expect(matchPattern('github.com/*', 'git.example.com', 'any/repo')).toBe(false)
    })

    it('<host>/<owner>/* matches owner', () => {
      expect(matchPattern('github.com/acme/*', 'github.com', 'acme/r1')).toBe(true)
      expect(matchPattern('github.com/acme/*', 'github.com', 'other/r1')).toBe(false)
    })

    it('<host>/<owner>/* matches the bare owner path too', () => {
      // The prefix matches the path equal to the prefix as well as anything
      // beneath it. Mostly relevant for deep prefixes; bare owners rarely
      // occur as a full repo path.
      expect(matchPattern('github.com/acme/*', 'github.com', 'acme')).toBe(true)
    })

    it('<host>/<owner>/<repo> exact', () => {
      expect(matchPattern('github.com/acme/repo', 'github.com', 'acme/repo')).toBe(true)
      expect(matchPattern('github.com/acme/repo', 'github.com', 'acme/other')).toBe(false)
    })

    it('deep prefix matches nested paths', () => {
      expect(matchPattern('gitlab.com/group/sub/*', 'gitlab.com', 'group/sub/repo')).toBe(true)
      expect(matchPattern('gitlab.com/group/sub/*', 'gitlab.com', 'group/sub/deep/repo')).toBe(true)
      expect(matchPattern('gitlab.com/group/sub/*', 'gitlab.com', 'group/other/repo')).toBe(false)
    })

    it('deep prefix does not match sibling prefix', () => {
      // path "groupextra" should not match prefix "group"
      expect(matchPattern('gitlab.com/group/*', 'gitlab.com', 'groupextra')).toBe(false)
    })

    it('single-segment exact path', () => {
      expect(matchPattern('gerrit.example.com/myrepo', 'gerrit.example.com', 'myrepo')).toBe(true)
      expect(matchPattern('gerrit.example.com/myrepo', 'gerrit.example.com', 'other')).toBe(false)
    })
  })

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
})
