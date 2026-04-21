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

describe('yaac auth (real CLI + real daemon)', () => {
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

  it('auth list on a clean data dir reports no credentials configured', async () => {
    const { stdout, exitCode } = await runYaac(testEnv.env, 'auth', 'list')
    expect(exitCode).toBe(0)
    expect(stdout).toContain('GitHub tokens:')
    expect(stdout).toContain('(none configured)')
    expect(stdout).toContain('Tool credentials:')
    expect(stdout).toMatch(/claude\s+not configured/)
    expect(stdout).toMatch(/codex\s+not configured/)
  })

  it('auth list renders seeded GitHub tokens and tool credentials with masked previews', async () => {
    const credsDir = path.join(testEnv.dataDir, '.credentials')
    await fs.mkdir(credsDir, { recursive: true, mode: 0o700 })
    await fs.writeFile(
      path.join(credsDir, 'github.json'),
      JSON.stringify({
        tokens: [
          { pattern: 'acme/*', token: 'ghp_abcdef123456' },
          { pattern: '*', token: 'ghp_fallback_token' },
        ],
      }) + '\n',
    )
    await fs.writeFile(
      path.join(credsDir, 'claude.json'),
      JSON.stringify({
        kind: 'api-key',
        savedAt: '2026-01-15T00:00:00.000Z',
        apiKey: 'sk-ant-api03-fake-claude-key',
      }) + '\n',
    )
    await fs.writeFile(
      path.join(credsDir, 'codex.json'),
      JSON.stringify({
        kind: 'api-key',
        savedAt: '2026-02-20T00:00:00.000Z',
        apiKey: 'sk-fake-codex-key',
      }) + '\n',
    )

    const { stdout, exitCode } = await runYaac(testEnv.env, 'auth', 'list')
    expect(exitCode).toBe(0)

    expect(stdout).toContain('acme/*')
    expect(stdout).toContain('***3456')
    expect(stdout).toContain('***oken')
    expect(stdout).not.toContain('ghp_abcdef123456')
    expect(stdout).not.toContain('ghp_fallback_token')

    expect(stdout).toMatch(/claude\s+\*\*\*-key.*api-key.*2026-01-15/)
    expect(stdout).toMatch(/codex\s+\*\*\*-key.*api-key.*2026-02-20/)
    expect(stdout).not.toContain('sk-ant-api03-fake-claude-key')
    expect(stdout).not.toContain('sk-fake-codex-key')
  })
})
