import { describe, it, expect } from 'vitest'
import { HOSTED_REMOTE_PREFIX, hostedCloneUrl, hostedRemoteUrl } from '#hosted-git'

const REPO = '7d4e2a1c-5b3f-4e8a-9c6d-1f2e3a4b5c6d'

describe('hostedRemoteUrl', () => {
  it('names a hosted repo by its id, under the prefix a checkout\'s origin is recognized by', () => {
    expect(hostedRemoteUrl(REPO)).toBe(`http://yaac.internal/api/workspace/git/${REPO}.git`)
    expect(hostedRemoteUrl(REPO).startsWith(HOSTED_REMOTE_PREFIX)).toBe(true)
  })
})

describe('hostedCloneUrl', () => {
  it('is the repo\'s route on the server\'s API origin, whatever slashes the origin ends in', () => {
    expect(hostedCloneUrl('https://yaac.example.com', REPO)).toBe(`https://yaac.example.com/api/repo/${REPO}/git`)
    expect(hostedCloneUrl('http://127.0.0.1:4120//', REPO)).toBe(`http://127.0.0.1:4120/api/repo/${REPO}/git`)
  })
})
