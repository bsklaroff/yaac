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

/**
 * The ssh keys git authenticates with, sealed at rest.
 *
 * The key travels as content, so a server on another machine can hold one at
 * all. The property worth pinning is the same one the env store's is: the
 * column is not the key, and what comes back out is.
 */

const KEY = '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----\n'
const KNOWN_HOSTS = 'git.example.com ssh-ed25519 AAAA'

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

    await upsertGitSshKey({ pattern: 'git.example.com/*', privateKey: KEY, knownHostsEntry: KNOWN_HOSTS })

    expect(await listGitSshKeys()).toMatchObject([{
      pattern: 'git.example.com/*',
      privateKey: KEY,
      knownHostsEntry: KNOWN_HOSTS,
      unreadable: false,
    }])
  })

  it('reports a key it cannot open rather than throwing', async () => {
    // The listing is the only place a user can see that a credential needs
    // re-adding, so a row that will not decrypt must not take it down.
    await upsertGitSshKey({ pattern: 'git.example.com/*', privateKey: KEY, knownHostsEntry: KNOWN_HOSTS })
    await fs.writeFile(secretKeyPath(), 'a-completely-different-key\n', { mode: 0o600 })
    forgetSecretConfig()

    expect(await listGitSshKeys()).toMatchObject([{ privateKey: undefined, unreadable: true }])
  })
})

describe('upsertGitSshKey', () => {
  it('seals the key, so the column is not the key', async () => {
    await upsertGitSshKey({ pattern: 'git.example.com/*', privateKey: KEY, knownHostsEntry: KNOWN_HOSTS })

    const db = await getDb()
    const [row] = await db.select().from(gitSshKeys)
      .where(eq(gitSshKeys.pattern, 'git.example.com/*'))
    expect(row.sealedPrivateKey).not.toContain('PRIVATE KEY')
    expect(row.sealedPrivateKey).toMatch(/^\$ba\$0\$[0-9a-f]+$/)
    // And the known_hosts line is NOT sealed: it is a public host key, and
    // the server reads it back to build a workspace's known_hosts file.
    expect(row.knownHostsEntry).toBe(KNOWN_HOSTS)
  })

  it('replaces by pattern rather than accumulating', async () => {
    await upsertGitSshKey({ pattern: 'git.example.com/*', privateKey: KEY, knownHostsEntry: KNOWN_HOSTS })
    const replaced = await upsertGitSshKey({
      pattern: 'git.example.com/*',
      privateKey: `${KEY}second`,
      knownHostsEntry: 'git.example.com ssh-ed25519 BBBB',
    })

    expect(await listGitSshKeys()).toHaveLength(1)
    expect(replaced.privateKey).toBe(`${KEY}second`)
    expect(replaced.knownHostsEntry).toBe('git.example.com ssh-ed25519 BBBB')
  })
})

describe('deleteGitSshKey', () => {
  it('removes one pattern and reports whether there was one', async () => {
    await upsertGitSshKey({ pattern: 'a.example.com/*', privateKey: KEY, knownHostsEntry: KNOWN_HOSTS })
    await upsertGitSshKey({ pattern: 'b.example.com/*', privateKey: KEY, knownHostsEntry: KNOWN_HOSTS })

    expect(await deleteGitSshKey('missing/*')).toBe(false)
    expect(await deleteGitSshKey('a.example.com/*')).toBe(true)
    expect((await listGitSshKeys()).map((k) => k.pattern)).toEqual(['b.example.com/*'])
  })
})

describe('deleteAllGitSshKeys', () => {
  it('empties the table — the wholesale replace and `auth clear`', async () => {
    await upsertGitSshKey({ pattern: 'a.example.com/*', privateKey: KEY, knownHostsEntry: KNOWN_HOSTS })
    await deleteAllGitSshKeys()
    expect(await listGitSshKeys()).toEqual([])
  })
})
