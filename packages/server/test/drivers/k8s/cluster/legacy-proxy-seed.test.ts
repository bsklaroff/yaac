import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('#log', () => ({ serverLog: vi.fn() }))

import { sweepLegacyProxySecretsFile } from '#drivers/k8s/cluster'
import { credentialsDir } from '@yaac/shared/project-paths'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'

// `seedProxyObjects` is internal to the folder and covered through
// `ensureProxyResources` in proxy-apply.test.ts; the sweep is the one name
// this module puts on the barrel.

let tmpDir: string

beforeEach(async () => {
  tmpDir = await createTempDataDir()
})

afterEach(async () => {
  await cleanupTempDir(tmpDir)
})

describe('sweepLegacyProxySecretsFile', () => {
  it('removes the old plaintext secrets file, and only that', async () => {
    await fs.mkdir(credentialsDir(), { recursive: true })
    const file = path.join(credentialsDir(), 'proxy-secrets.json')
    await fs.writeFile(file, '{"demo/KEY":"sekrit"}')
    await fs.writeFile(path.join(credentialsDir(), 'claude.json'), '{}')

    await sweepLegacyProxySecretsFile()

    await expect(fs.stat(file)).rejects.toThrow()
    await expect(fs.stat(path.join(credentialsDir(), 'claude.json'))).resolves.toBeDefined()
  })

  it('is a no-op on an install that never had the file', async () => {
    await expect(sweepLegacyProxySecretsFile()).resolves.toBeUndefined()
  })
})
