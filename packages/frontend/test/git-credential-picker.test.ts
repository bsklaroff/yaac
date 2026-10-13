import { describe, it, expect } from 'vitest'
import { remoteKind, remoteProjectName } from '#components/GitCredentialPicker'

describe('remoteKind', () => {
  it('asks for an SSH key for an SCP-style remote, and a token otherwise', () => {
    expect(remoteKind('git@github.com:acme/repo.git')).toBe('ssh')
    expect(remoteKind('https://github.com/acme/repo.git')).toBe('https')
    expect(remoteKind('')).toBe('https')
    // A remote-helper URL is no SCP remote: the server refuses it, so no
    // key is offered for it.
    expect(remoteKind('ext::sh -c touch% /tmp/x')).toBe('https')
  })
})

describe('remoteProjectName', () => {
  it('names the project as the server will, and nothing for a remote it refuses', () => {
    expect(remoteProjectName('git@github.com:acme/My_Repo.git')).toBe('my_repo')
    expect(remoteProjectName('https://github.com/o/Repo.git/')).toBe('repo')
    expect(remoteProjectName('ext::sh -c touch% /tmp/x')).toBe('')
  })
})
