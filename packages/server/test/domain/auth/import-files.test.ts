import fs from 'node:fs/promises'
import path from 'node:path'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { importToolCredentialFiles } from '#domain/auth'
import { BUILT_IN_USER_ID, closeDb, getToolCredential, setToolCredential } from '#db'
import { credentialsDir } from '@yaac/shared/project-paths'

let tmpDir: string

beforeAll(async () => {
  tmpDir = await createTempDataDir()
})

afterAll(async () => {
  await closeDb()
  await cleanupTempDir(tmpDir)
})

describe('importToolCredentialFiles', () => {
  it('moves the pre-database files to the built-in user, keeping a sign-in it already has, and deletes only what it covered', async () => {
    const write = (file: string, body: unknown): Promise<void> =>
      fs.writeFile(path.join(credentialsDir(), file), typeof body === 'string' ? body : JSON.stringify(body))
    await importToolCredentialFiles() // no directory: nothing to do

    await fs.mkdir(credentialsDir(), { recursive: true })
    const claude = {
      kind: 'oauth', savedAt: 's', claudeAiOauth: { accessToken: 'sk-ant-oat', refreshToken: 'r', expiresAt: 1, scopes: [] },
    }
    await write('claude.json', claude)
    await write('pi.json', { kind: 'api-key', provider: 'openrouter', savedAt: 's', apiKey: 'from-file' })
    await write('codex.json', '{ not json')
    await write('README', 'notes')
    // Signed in since the upgrade: the database wins over the old file.
    await setToolCredential(BUILT_IN_USER_ID, 'pi', { kind: 'api-key', provider: 'openrouter', savedAt: 's', apiKey: 'from-db' })

    await importToolCredentialFiles()

    expect(await getToolCredential(BUILT_IN_USER_ID, 'claude')).toEqual(claude)
    expect(await getToolCredential(BUILT_IN_USER_ID, 'pi')).toMatchObject({ apiKey: 'from-db' })
    expect(await getToolCredential(BUILT_IN_USER_ID, 'codex')).toBeNull()
    // The unreadable file is kept aside for a hand repair, and a file that
    // is not a sign-in is not ours to delete, so the directory stays.
    const aside = path.join(path.dirname(credentialsDir()), '.credentials-unreadable', 'codex.json')
    expect(await fs.readFile(aside, 'utf8')).toBe('{ not json')
    expect((await fs.readdir(credentialsDir())).sort()).toEqual(['README'])

    // Once it holds nothing else, the directory goes.
    await fs.rm(path.join(credentialsDir(), 'README'))
    await importToolCredentialFiles()
    await expect(fs.access(credentialsDir())).rejects.toThrow()
  })
})
