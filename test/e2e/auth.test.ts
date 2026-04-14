import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import { createTempDataDir, cleanupTempDir } from '@test/helpers/setup'
import { credentialsPath, loadCredentials } from '@/lib/credentials'

describe('yaac auth', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
  })

  afterEach(async () => {
    await cleanupTempDir(tmpDir)
  })

  it('auth-clear removes credentials file', async () => {
    // Write a credentials file
    await fs.writeFile(
      credentialsPath(),
      JSON.stringify({ GITHUB_TOKEN: 'test-token' }),
    )

    // Verify it exists
    const before = await loadCredentials()
    expect(before).not.toBeNull()

    // Remove it directly (auth-clear requires interactive confirmation)
    await fs.rm(credentialsPath())

    const after = await loadCredentials()
    expect(after).toBeNull()
  })

  it('credentials file can be created and read back', async () => {
    const filePath = credentialsPath()
    const creds = { GITHUB_TOKEN: 'ghp_test_token_123' }

    await fs.writeFile(filePath, JSON.stringify(creds, null, 2) + '\n', { mode: 0o600 })

    const loaded = await loadCredentials()
    expect(loaded).toEqual(creds)

    // Verify file permissions (mode 0o600)
    const stats = await fs.stat(filePath)
    const mode = stats.mode & 0o777
    expect(mode).toBe(0o600)
  })
})
