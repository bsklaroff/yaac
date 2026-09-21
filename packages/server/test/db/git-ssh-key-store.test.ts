import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import fs from 'node:fs/promises'
import { eq } from 'drizzle-orm'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { getDb, closeDb } from '#db/client'
import { gitSshKeys } from '#db/schema'
import {
  deleteAllGitSshKeys,
  deleteGitSshKey,
  listGitSshKeys,
  upsertGitSshKey,
} from '#db'
import { forgetSecretConfig } from '#db/secret-key'
import { secretKeyPath } from '@yaac/shared/project-paths'
import { generateSshKey } from '#lib/ssh-key'

/**
 * The ssh keys git authenticates with, sealed at rest.
 *
 * The property worth pinning is the same one the env store's is: the column
 * is not the seed, and what comes back out is — while the public half sits
 * beside it in the clear.
 */

const KEY = generateSshKey('yaac test')
const KNOWN_HOSTS = 'git.example.com ssh-ed25519 AAAA'

function entry(pattern: string, key = KEY, knownHostsEntry = KNOWN_HOSTS) {
  return { pattern, seed: key.seed, publicKey: key.publicKey, knownHostsEntry }
}

let tmpDir: string

beforeAll(async () => {
  tmpDir = await createTempDataDir()
})

afterAll(async () => {
  await closeDb()
  await cleanupTempDir(tmpDir)
})

beforeEach(async () => {
  const db = await getDb()
  await db.delete(gitSshKeys)
  forgetSecretConfig()
})

describe('listGitSshKeys', () => {
  it('is empty until something is stored, and opens what is', async () => {
    expect(await listGitSshKeys()).toEqual([])

    await upsertGitSshKey(entry('git.example.com/*'))

    const [row] = await listGitSshKeys()
    expect(row).toMatchObject({
      pattern: 'git.example.com/*',
      publicKey: KEY.publicKey,
      knownHostsEntry: KNOWN_HOSTS,
    })
    expect(await row.openSeed()).toEqual(KEY.seed)
  })

  it('reports a key it cannot open rather than throwing', async () => {
    // The listing is the only place a user can see that a credential needs
    // re-adding, so a row that will not decrypt must not take it down.
    await upsertGitSshKey(entry('git.example.com/*'))
    await fs.writeFile(secretKeyPath(), 'a-completely-different-key\n', { mode: 0o600 })
    forgetSecretConfig()

    // The public half still reads, so the listing can show the row beside
    // "generate a new key" instead of dropping it.
    const [row] = await listGitSshKeys()
    expect(row.publicKey).toBe(KEY.publicKey)
    expect(await row.openSeed()).toBeUndefined()
  })
})

describe('upsertGitSshKey', () => {
  it('seals the seed, so the column is not the key', async () => {
    await upsertGitSshKey(entry('git.example.com/*'))

    const db = await getDb()
    const [row] = await db.select().from(gitSshKeys)
      .where(eq(gitSshKeys.pattern, 'git.example.com/*'))
    expect(row.sealedPrivateKey).not.toContain(KEY.seed.toString('base64'))
    expect(row.sealedPrivateKey).toMatch(/^\$ba\$0\$[0-9a-f]+$/)
    // And the two public things are NOT sealed: the host key the server
    // reads back to build a workspace's known_hosts file, and the public
    // key the user registers.
    expect(row.knownHostsEntry).toBe(KNOWN_HOSTS)
    expect(row.publicKey).toBe(KEY.publicKey)
  })

  it('replaces by pattern rather than accumulating', async () => {
    await upsertGitSshKey(entry('git.example.com/*'))
    const second = generateSshKey('yaac second')
    const replaced = await upsertGitSshKey(
      entry('git.example.com/*', second, 'git.example.com ssh-ed25519 BBBB'),
    )

    expect(await listGitSshKeys()).toHaveLength(1)
    expect(await replaced.openSeed()).toEqual(second.seed)
    expect(replaced.publicKey).toBe(second.publicKey)
    expect(replaced.knownHostsEntry).toBe('git.example.com ssh-ed25519 BBBB')
  })
})

describe('deleteGitSshKey', () => {
  it('removes one pattern and reports whether there was one', async () => {
    await upsertGitSshKey(entry('a.example.com/*'))
    await upsertGitSshKey(entry('b.example.com/*'))

    expect(await deleteGitSshKey('missing/*')).toBe(false)
    expect(await deleteGitSshKey('a.example.com/*')).toBe(true)
    expect((await listGitSshKeys()).map((k) => k.pattern)).toEqual(['b.example.com/*'])
  })
})

describe('deleteAllGitSshKeys', () => {
  it('empties the table — `auth clear`', async () => {
    await upsertGitSshKey(entry('a.example.com/*'))
    await deleteAllGitSshKeys()
    expect(await listGitSshKeys()).toEqual([])
  })
})
