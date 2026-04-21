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

describe('yaac auth clear (real CLI + real daemon)', () => {
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

  async function seedTokens(tokens: Array<{ pattern: string; token: string }>): Promise<void> {
    const credsDir = path.join(testEnv.dataDir, '.credentials')
    await fs.mkdir(credsDir, { recursive: true, mode: 0o700 })
    await fs.writeFile(
      path.join(credsDir, 'github.json'),
      JSON.stringify({ tokens }) + '\n',
    )
  }

  it('reports "No credentials configured." on a clean data dir', async () => {
    const { stdout, exitCode } = await runYaac(testEnv.env, 'auth', 'clear')
    expect(exitCode).toBe(0)
    expect(stdout).toContain('No credentials configured.')
  })

  it('removes a specific GitHub token by menu index', async () => {
    await seedTokens([
      { pattern: 'acme/*', token: 'ghp_acme_token_xxxx' },
      { pattern: '*', token: 'ghp_fallback_token_yy' },
    ])

    const { stdout, exitCode } = await runYaac(
      testEnv.env, 'auth', 'clear', { stdin: '1\n' },
    )
    expect(exitCode).toBe(0)
    expect(stdout).toContain('Removed GitHub token for pattern "acme/*"')

    const raw = await fs.readFile(
      path.join(testEnv.dataDir, '.credentials', 'github.json'), 'utf8',
    )
    expect(JSON.parse(raw)).toEqual({
      tokens: [{ pattern: '*', token: 'ghp_fallback_token_yy' }],
    })
  })

  it('removes every credential when the user answers "all"', async () => {
    await seedTokens([
      { pattern: 'acme/*', token: 'ghp_acme_token_xxxx' },
      { pattern: '*', token: 'ghp_fallback_token_yy' },
    ])

    const { stdout, exitCode } = await runYaac(
      testEnv.env, 'auth', 'clear', { stdin: 'all\n' },
    )
    expect(exitCode).toBe(0)
    expect(stdout).toContain('All credentials removed.')

    const raw = await fs.readFile(
      path.join(testEnv.dataDir, '.credentials', 'github.json'), 'utf8',
    )
    expect(JSON.parse(raw)).toEqual({ tokens: [] })
  })

  it('prints "Cancelled." on an out-of-range menu choice', async () => {
    await seedTokens([{ pattern: 'acme/*', token: 'ghp_acme_token_xxxx' }])

    const { stdout, exitCode } = await runYaac(
      testEnv.env, 'auth', 'clear', { stdin: '99\n' },
    )
    expect(exitCode).toBe(0)
    expect(stdout).toContain('Cancelled.')

    // Nothing removed.
    const raw = await fs.readFile(
      path.join(testEnv.dataDir, '.credentials', 'github.json'), 'utf8',
    )
    const parsed = JSON.parse(raw) as { tokens: unknown[] }
    expect(parsed.tokens).toHaveLength(1)
  })
})
