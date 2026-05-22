import { describe, it, expect } from 'vitest'
import { expandOwnerRepo, validateGitRemoteUrl } from '@/lib/project/add'
import { DaemonError } from '@/daemon/errors'

describe('expandOwnerRepo', () => {
  it('expands owner/repo shorthand to github.com', () => {
    expect(expandOwnerRepo('acme/foo')).toBe('https://github.com/acme/foo')
  })

  it('leaves https URLs unchanged', () => {
    const url = 'https://github.com/acme/foo'
    expect(expandOwnerRepo(url)).toBe(url)
  })

  it('leaves SCP-style ssh URLs unchanged', () => {
    const url = 'git@github.com:acme/foo.git'
    expect(expandOwnerRepo(url)).toBe(url)
  })

  it('leaves anything without exactly two segments unchanged', () => {
    expect(expandOwnerRepo('plain')).toBe('plain')
    expect(expandOwnerRepo('a/b/c')).toBe('a/b/c')
  })
})

describe('validateGitRemoteUrl', () => {
  it('accepts a github.com https URL', () => {
    expect(() => validateGitRemoteUrl('https://github.com/acme/foo')).not.toThrow()
  })

  it('accepts a non-github https URL', () => {
    expect(() => validateGitRemoteUrl('https://git.example.com/team/repo')).not.toThrow()
  })

  it('accepts SCP-style ssh URLs', () => {
    expect(() => validateGitRemoteUrl('git@github.com:acme/foo')).not.toThrow()
    expect(() => validateGitRemoteUrl('git@git.example.com:acme/foo.git')).not.toThrow()
  })

  it('rejects non-https URLs', () => {
    expect(() => validateGitRemoteUrl('http://github.com/acme/foo'))
      .toThrow(DaemonError)
  })

  it('rejects ssh:// URLs with a clear pointer to SCP-style', () => {
    expect(() => validateGitRemoteUrl('ssh://git@github.com/acme/foo'))
      .toThrow(/SCP-style/)
  })

  it('rejects custom HTTPS ports', () => {
    expect(() => validateGitRemoteUrl('https://git.example.com:8443/a/b'))
      .toThrow(DaemonError)
  })

  it('rejects HTTPS URL with no owner/repo', () => {
    expect(() => validateGitRemoteUrl('https://github.com/acme'))
      .toThrow(DaemonError)
  })

  it('rejects garbage strings', () => {
    expect(() => validateGitRemoteUrl('not a url')).toThrow(DaemonError)
  })
})
