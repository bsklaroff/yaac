import { describe, it, expect } from 'vitest'
import { expandOwnerRepo, validateGithubHttpsUrl } from '@/lib/project/add'
import { DaemonError } from '@/daemon/errors'

describe('expandOwnerRepo', () => {
  it('expands owner/repo shorthand', () => {
    expect(expandOwnerRepo('acme/foo')).toBe('https://github.com/acme/foo')
  })

  it('leaves https URLs unchanged', () => {
    const url = 'https://github.com/acme/foo'
    expect(expandOwnerRepo(url)).toBe(url)
  })

  it('leaves ssh-style URLs unchanged (validation catches them later)', () => {
    const url = 'git@github.com:acme/foo.git'
    expect(expandOwnerRepo(url)).toBe(url)
  })

  it('leaves anything without exactly two segments unchanged', () => {
    expect(expandOwnerRepo('plain')).toBe('plain')
    expect(expandOwnerRepo('a/b/c')).toBe('a/b/c')
  })
})

describe('validateGithubHttpsUrl', () => {
  it('accepts a github.com https URL', () => {
    expect(() => validateGithubHttpsUrl('https://github.com/acme/foo')).not.toThrow()
  })

  it('rejects ssh-style URLs', () => {
    expect(() => validateGithubHttpsUrl('git@github.com:acme/foo'))
      .toThrow(DaemonError)
  })

  it('rejects non-https URLs', () => {
    expect(() => validateGithubHttpsUrl('http://github.com/acme/foo'))
      .toThrow(/HTTPS/)
  })

  it('rejects non-github hosts', () => {
    expect(() => validateGithubHttpsUrl('https://gitlab.com/acme/foo'))
      .toThrow(/GitHub/)
  })

  it('rejects garbage strings', () => {
    expect(() => validateGithubHttpsUrl('not a url')).toThrow(DaemonError)
  })
})
