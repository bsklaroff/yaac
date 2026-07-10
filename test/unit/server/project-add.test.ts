import { describe, it, expect } from 'vitest'
import { validateGitRemoteUrl } from '@/lib/project/add'
import { ServerError } from '@/server/errors'

describe('validateGitRemoteUrl', () => {
  it('accepts a github.com https URL', () => {
    expect(validateGitRemoteUrl('https://github.com/acme/foo'))
      .toEqual({ scheme: 'https', host: 'github.com', path: 'acme/foo' })
  })

  it('accepts a non-github https URL', () => {
    expect(validateGitRemoteUrl('https://git.example.com/team/repo'))
      .toEqual({ scheme: 'https', host: 'git.example.com', path: 'team/repo' })
  })

  it('accepts deep path URLs (gitlab subgroups)', () => {
    expect(validateGitRemoteUrl('https://gitlab.com/group/sub/repo.git'))
      .toEqual({ scheme: 'https', host: 'gitlab.com', path: 'group/sub/repo' })
  })

  it('accepts single-segment path URLs (Gerrit-style)', () => {
    expect(validateGitRemoteUrl('git@gerrit.example.com:myrepo.git'))
      .toEqual({ scheme: 'ssh', host: 'gerrit.example.com', path: 'myrepo' })
  })

  it('accepts SCP-style ssh URLs', () => {
    expect(validateGitRemoteUrl('git@github.com:acme/foo'))
      .toEqual({ scheme: 'ssh', host: 'github.com', path: 'acme/foo' })
    expect(validateGitRemoteUrl('git@git.example.com:acme/foo.git'))
      .toEqual({ scheme: 'ssh', host: 'git.example.com', path: 'acme/foo' })
  })

  it('rejects non-https URLs', () => {
    expect(() => validateGitRemoteUrl('http://github.com/acme/foo'))
      .toThrow(ServerError)
  })

  it('rejects ssh:// URLs with a clear pointer to SCP-style', () => {
    expect(() => validateGitRemoteUrl('ssh://git@github.com/acme/foo'))
      .toThrow(/SCP-style/)
  })

  it('rejects custom HTTPS ports', () => {
    expect(() => validateGitRemoteUrl('https://git.example.com:8443/a/b'))
      .toThrow(ServerError)
  })

  it('rejects HTTPS URL with no path', () => {
    expect(() => validateGitRemoteUrl('https://github.com/'))
      .toThrow(ServerError)
  })

  it('rejects bare owner/repo shorthand (no longer expanded)', () => {
    expect(() => validateGitRemoteUrl('acme/foo')).toThrow(ServerError)
  })

  it('rejects garbage strings', () => {
    expect(() => validateGitRemoteUrl('not a url')).toThrow(ServerError)
  })
})
