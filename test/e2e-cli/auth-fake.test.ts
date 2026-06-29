import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import {
  createYaacTestEnv,
  spawnYaacDaemon,
  runYaac,
  type YaacTestEnv,
  type SpawnedDaemon,
} from '@test/helpers/cli'

describe('yaac auth fake (real CLI + real daemon)', () => {
  let testEnv: YaacTestEnv
  let daemon: SpawnedDaemon

  beforeEach(async () => {
    testEnv = await createYaacTestEnv()
    daemon = await spawnYaacDaemon(testEnv.env)
  })

  afterEach(async () => {
    await daemon.stop()
    await testEnv.cleanup()
  })

  function credPath(file: string): string {
    return path.join(testEnv.dataDir, '.credentials', file)
  }

  it('auth fake claude-oauth seeds an OAuth bundle in the data dir', async () => {
    const { exitCode, stderr } = await runYaac(testEnv.env, 'auth', 'fake', 'claude-oauth')
    expect(exitCode, stderr).toBe(0)

    const parsed = JSON.parse(await fs.readFile(credPath('claude.json'), 'utf8')) as {
      kind: string
      claudeAiOauth: { accessToken: string; refreshToken: string }
    }
    expect(parsed.kind).toBe('oauth')
    expect(parsed.claudeAiOauth.accessToken).toBe('yaac-ph-access')
    expect(parsed.claudeAiOauth.refreshToken).toBe('yaac-ph-refresh')
  })

  it('auth fake github seeds an https github.com/* credential', async () => {
    const { exitCode, stderr } = await runYaac(testEnv.env, 'auth', 'fake', 'github')
    expect(exitCode, stderr).toBe(0)

    const parsed = JSON.parse(await fs.readFile(credPath('github.json'), 'utf8')) as {
      tokens: Array<{ kind: string; pattern: string; token: string }>
    }
    expect(parsed.tokens).toContainEqual({
      kind: 'https',
      pattern: 'github.com/*',
      token: 'yaac-ph-gh-token',
    })
  })

  it('rejects an unknown kind', async () => {
    const { exitCode, stderr } = await runYaac(testEnv.env, 'auth', 'fake', 'bogus')
    expect(exitCode).not.toBe(0)
    expect(stderr).toMatch(/claude-oauth|github|Allowed choices/i)
  })
})
