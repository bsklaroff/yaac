import { describe, it, expect } from 'vitest'
import { getGitUserConfig } from '#git'

describe('getGitUserConfig', () => {
  it('returns name and email or null', async () => {
    const result = await getGitUserConfig()
    if (result) {
      expect(typeof result.name).toBe('string')
      expect(typeof result.email).toBe('string')
    } else {
      expect(result).toBeNull()
    }
  })
})
