import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { writeProxySecrets } from '#drivers/k8s/egress/proxy-secrets'
import { proxySecretsCredentialsPath } from '@yaac/shared/project-paths'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await createTempDataDir()
})

afterEach(async () => {
  await cleanupTempDir(tmpDir)
})

describe('writeProxySecrets', () => {
  async function readSecretsFile(): Promise<Record<string, string>> {
    const raw = JSON.parse(await fs.readFile(proxySecretsCredentialsPath(), 'utf8')) as {
      secrets: Record<string, string>
    }
    return raw.secrets
  }

  it('writes secrets keyed by env var name with 0600 mode', async () => {
    await writeProxySecrets({ MY_KEY: 'sekrit' })
    expect(await readSecretsFile()).toEqual({ MY_KEY: 'sekrit' })
    expect((await fs.stat(proxySecretsCredentialsPath())).mode & 0o777).toBe(0o600)
  })

  it('merges into existing entries instead of replacing them', async () => {
    await writeProxySecrets({ A: '1', B: '2' })
    await writeProxySecrets({ B: 'updated', C: '3' })
    expect(await readSecretsFile()).toEqual({ A: '1', B: 'updated', C: '3' })
  })

  it('no-ops on an empty secrets map', async () => {
    await writeProxySecrets({})
    await expect(fs.access(proxySecretsCredentialsPath())).rejects.toThrow()
  })

  it('starts fresh when the existing file is corrupt or the wrong shape', async () => {
    await fs.mkdir(path.dirname(proxySecretsCredentialsPath()), { recursive: true })
    for (const bad of ['{not json', 'null', '{"secrets": "nope"}', '{"secrets": {"A": 5, "B": ""}}']) {
      await fs.writeFile(proxySecretsCredentialsPath(), bad)
      await writeProxySecrets({ Z: '1' })
      expect(await readSecretsFile()).toEqual({ Z: '1' })
    }
  })
})
