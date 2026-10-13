import { describe, it, expect } from 'vitest'
import { parseGitRemote, usableAssignment } from '#git-remote'

describe('parseGitRemote', () => {
  it('parses https URLs at any path depth, dropping .git and a trailing slash', () => {
    expect(parseGitRemote('https://github.com/acme/repo.git'))
      .toEqual({ scheme: 'https', host: 'github.com', path: 'acme/repo' })
    expect(parseGitRemote('https://git.example.com/acme/repo'))
      .toEqual({ scheme: 'https', host: 'git.example.com', path: 'acme/repo' })
    expect(parseGitRemote('https://gitlab.com/group/sub/repo.git'))
      .toEqual({ scheme: 'https', host: 'gitlab.com', path: 'group/sub/repo' })
    expect(parseGitRemote('https://gerrit.example.com/myrepo'))
      .toEqual({ scheme: 'https', host: 'gerrit.example.com', path: 'myrepo' })
    expect(parseGitRemote('https://github.com/acme/repo/'))
      .toEqual({ scheme: 'https', host: 'github.com', path: 'acme/repo' })
  })

  it('parses SCP-style remotes with or without a user', () => {
    expect(parseGitRemote('git@github.com:acme/repo.git'))
      .toEqual({ scheme: 'ssh', host: 'github.com', path: 'acme/repo' })
    expect(parseGitRemote('git.example.com:acme/repo'))
      .toEqual({ scheme: 'ssh', host: 'git.example.com', path: 'acme/repo' })
    expect(parseGitRemote('git@gitlab.com:group/sub/repo.git'))
      .toEqual({ scheme: 'ssh', host: 'gitlab.com', path: 'group/sub/repo' })
    expect(parseGitRemote('git@gerrit.example.com:myrepo.git'))
      .toEqual({ scheme: 'ssh', host: 'gerrit.example.com', path: 'myrepo' })
    expect(parseGitRemote('git@github.com:acme/repo/'))
      .toEqual({ scheme: 'ssh', host: 'github.com', path: 'acme/repo' })
  })

  it('rejects unsupported schemes, ports, and empty paths', () => {
    expect(() => parseGitRemote('ssh://git@github.com/acme/repo')).toThrow(/SCP-style/)
    expect(() => parseGitRemote('http://github.com/acme/repo')).toThrow(/Only HTTPS/)
    expect(() => parseGitRemote('https://github.com:8443/acme/repo')).toThrow(/Custom HTTPS ports/)
    expect(() => parseGitRemote('https://github.com/')).toThrow(/Cannot parse repo path/)
    expect(() => parseGitRemote('git@github.com:.git')).toThrow(/Cannot parse repo path/)
    expect(() => parseGitRemote('not-a-url')).toThrow(/Unrecognized git remote URL/)
  })

  it('rejects a remote-helper URL, which git would run rather than dial', () => {
    // `ext::<cmd>` is shaped like `host:path` with a path of `:<cmd>`; git
    // reads it as the ext helper and runs the command.
    for (const url of ['ext::sh -c touch% /tmp/x', 'fd::17', 'git@ext::sh']) {
      expect(() => parseGitRemote(url)).toThrow(/Unrecognized git remote URL/)
    }
  })
})

describe('usableAssignment', () => {
  const https = { owner: 'me', remoteUrl: 'https://github.com/acme/web.git', knownHostsEntry: null }
  const ssh = { owner: 'me', remoteUrl: 'git@github.com:acme/svc.git', knownHostsEntry: 'github.com ssh-ed25519 AAAA' }

  it('accepts the owner\'s credential of the remote\'s kind, an ssh key only with a trusted host key', () => {
    expect(usableAssignment(https, { owner: 'me', kind: 'https' })).toBe(true)
    expect(usableAssignment(ssh, { owner: 'me', kind: 'ssh' })).toBe(true)
    expect(usableAssignment({ ...ssh, knownHostsEntry: null }, { owner: 'me', kind: 'ssh' })).toBe(false)
  })

  it('refuses no credential, another user\'s, the wrong kind, and an unparseable remote', () => {
    expect(usableAssignment(https, undefined)).toBe(false)
    expect(usableAssignment(https, { owner: 'bob', kind: 'https' })).toBe(false)
    expect(usableAssignment(https, { owner: 'me', kind: 'ssh' })).toBe(false)
    expect(usableAssignment({ ...https, remoteUrl: 'ext::sh' }, { owner: 'me', kind: 'https' })).toBe(false)
  })
})
