import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createTempDataDir, cleanupTempDir, getDataDir } from '@test/helpers/setup'
import { credentialsPath, loadCredentials, getGithubToken } from '@/lib/credentials'

describe('credentials', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
  })

  afterEach(async () => {
    await cleanupTempDir(tmpDir)
  })

  it('credentialsPath returns path inside data dir', () => {
    expect(credentialsPath()).toBe(path.join(getDataDir(), '.credentials.json'))
  })

  it('loadCredentials returns null when file is missing', async () => {
    const result = await loadCredentials()
    expect(result).toBeNull()
  })

  it('loadCredentials returns credentials from valid file', async () => {
    await fs.writeFile(
      credentialsPath(),
      JSON.stringify({ GITHUB_TOKEN: 'ghp_test123' }),
    )
    const result = await loadCredentials()
    expect(result).toEqual({ GITHUB_TOKEN: 'ghp_test123' })
  })

  it('loadCredentials returns null for empty token', async () => {
    await fs.writeFile(
      credentialsPath(),
      JSON.stringify({ GITHUB_TOKEN: '' }),
    )
    const result = await loadCredentials()
    expect(result).toBeNull()
  })

  it('loadCredentials returns null for invalid JSON', async () => {
    await fs.writeFile(credentialsPath(), 'not json')
    const result = await loadCredentials()
    expect(result).toBeNull()
  })

  it('loadCredentials returns null for missing GITHUB_TOKEN key', async () => {
    await fs.writeFile(credentialsPath(), JSON.stringify({ OTHER: 'value' }))
    const result = await loadCredentials()
    expect(result).toBeNull()
  })

  it('getGithubToken returns token string from file', async () => {
    await fs.writeFile(
      credentialsPath(),
      JSON.stringify({ GITHUB_TOKEN: 'ghp_abc' }),
    )
    const token = await getGithubToken()
    expect(token).toBe('ghp_abc')
  })

  it('getGithubToken returns null when file missing', async () => {
    const token = await getGithubToken()
    expect(token).toBeNull()
  })
})
