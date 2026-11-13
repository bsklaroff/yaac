import { describe, it, expect } from 'vitest'
import { isGitHubHost } from '#credentials'

describe('isGitHubHost', () => {
  it('is true for github.com only, not its API hosts, other forges, GHE or lookalikes', () => {
    expect(isGitHubHost('github.com')).toBe(true)
    for (const host of [
      'api.github.com', 'uploads.github.com', 'gitlab.com', 'bitbucket.org',
      'github.acme.com', 'github.com.evil.example', 'notgithub.com',
    ]) {
      expect(isGitHubHost(host), host).toBe(false)
    }
  })
})
