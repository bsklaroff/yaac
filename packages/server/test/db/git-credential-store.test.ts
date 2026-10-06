import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import fs from 'node:fs/promises'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { getDb, closeDb } from '#db/client'
import { gitCredentials, projects } from '#db/schema'
import {
  deleteGitCredential,
  getGitCredential,
  getGitCredentialByName,
  getProjectRow,
  insertGitCredential,
  listGitCredentials,
  recordProject,
  renameGitCredential,
  replaceGitCredential,
  setProjectGitCredential,
} from '#db'
import { forgetSecretConfig } from '#db/secret-key'
import { secretKeyPath } from '@yaac/shared/project-paths'
import { generateSshKey } from '#lib/ssh-key'

const P = '83878c91-1713-4890-8e0f-e0fb97a8c47a'

/**
 * The named git credentials, sealed at rest.
 *
 * The property worth pinning is the same one the env store's is: the column
 * is not the secret, and what comes back out is — while an ssh key's public
 * half sits beside it in the clear.
 */

const KEY = generateSshKey('yaac deploy')

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
  await db.delete(projects)
  await db.delete(gitCredentials)
  forgetSecretConfig()
})

describe('insertGitCredential', () => {
  it('seals the secret, keeps the public key in the clear, and refuses a taken name', async () => {
    const row = await insertGitCredential({
      name: 'deploy', kind: 'ssh', secret: KEY.seed.toString('base64'), publicKey: KEY.publicKey,
    })

    const db = await getDb()
    const [raw] = await db.select().from(gitCredentials)
    expect(raw.sealedSecret).not.toContain(KEY.seed.toString('base64'))
    expect(raw.sealedSecret).toMatch(/^\$ba\$0\$[0-9a-f]+$/)
    expect(raw.publicKey).toBe(KEY.publicKey)
    expect(await row.openSecret()).toBe(KEY.seed.toString('base64'))

    await expect(insertGitCredential({ name: 'deploy', kind: 'https', secret: 'ghp_x' }))
      .rejects.toMatchObject({ code: 'CONFLICT' })
  })
})

describe('listGitCredentials', () => {
  it('lists oldest first, and reports a secret it cannot open rather than throwing', async () => {
    expect(await listGitCredentials()).toEqual([])
    await insertGitCredential({ name: 'a', kind: 'https', secret: 'ghp_aaaa' })
    await insertGitCredential({ name: 'b', kind: 'ssh', secret: 'c2VlZA==', publicKey: KEY.publicKey })
    expect((await listGitCredentials()).map((c) => [c.name, c.kind])).toEqual([['a', 'https'], ['b', 'ssh']])

    // The listing is the only place a user can see that a credential needs
    // replacing, so a row that will not decrypt must not take it down.
    await fs.writeFile(secretKeyPath(), 'a-completely-different-key\n', { mode: 0o600 })
    forgetSecretConfig()
    const [a, b] = await listGitCredentials()
    expect(await a.openSecret()).toBeUndefined()
    expect(b.publicKey).toBe(KEY.publicKey)
  })
})

describe('getGitCredential', () => {
  it('finds by id, and answers undefined for an unknown one', async () => {
    const row = await insertGitCredential({ name: 'a', kind: 'https', secret: 'ghp_aaaa' })
    expect((await getGitCredential(row.id))?.name).toBe('a')
    expect(await getGitCredential('00000000-0000-4000-8000-000000000000')).toBeUndefined()
  })
})

describe('getGitCredentialByName', () => {
  it('finds by name', async () => {
    const row = await insertGitCredential({ name: 'a', kind: 'https', secret: 'ghp_aaaa' })
    expect((await getGitCredentialByName('a'))?.id).toBe(row.id)
    expect(await getGitCredentialByName('b')).toBeUndefined()
  })
})

describe('renameGitCredential', () => {
  it('renames, refuses a name another credential holds, and reports a missing id', async () => {
    const a = await insertGitCredential({ name: 'a', kind: 'ssh', secret: 'c2VlZA==', publicKey: KEY.publicKey })
    await insertGitCredential({ name: 'b', kind: 'https', secret: 'ghp_bbbb' })

    expect(await renameGitCredential(a.id, 'a2', 'ssh-ed25519 AAAA yaac a2')).toBe(true)
    expect(await getGitCredential(a.id)).toMatchObject({ name: 'a2', publicKey: 'ssh-ed25519 AAAA yaac a2' })
    // Its own name is not a clash.
    expect(await renameGitCredential(a.id, 'a2', 'ssh-ed25519 AAAA yaac a2')).toBe(true)
    await expect(renameGitCredential(a.id, 'b', null)).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(await renameGitCredential('00000000-0000-4000-8000-000000000000', 'c', null)).toBe(false)
  })
})

describe('deleteGitCredential', () => {
  it('deletes even while a project uses it, leaving the project with no credential or host key', async () => {
    const row = await insertGitCredential({ name: 'a', kind: 'ssh', secret: 'c2VlZA==', publicKey: 'ssh-ed25519 AAAA yaac a' })
    await recordProject({ id: P, name: 'demo', remoteUrl: 'git@x:acme/p.git', addedAt: 'now' })
    await setProjectGitCredential(P, row.id, 'x ssh-ed25519 HOST')

    expect(await deleteGitCredential(row.id)).toBe(true)
    expect(await getProjectRow(P)).toMatchObject({ gitCredentialId: null, knownHostsEntry: null })
    expect(await listGitCredentials()).toEqual([])
    expect(await deleteGitCredential(row.id)).toBe(false)
  })
})

describe('replaceGitCredential', () => {
  it('moves the name and every project onto a new row, keeping their host keys, and drops the old one', async () => {
    const old = await insertGitCredential({ name: 'deploy', kind: 'ssh', secret: 'b2xk', publicKey: 'ssh-ed25519 OLD yaac deploy' })
    await recordProject({ id: P, name: 'demo', remoteUrl: 'git@x:acme/p.git', addedAt: 'now' })
    await setProjectGitCredential(P, old.id, 'x ssh-ed25519 HOST')

    const fresh = await replaceGitCredential(old.id, { secret: 'bmV3', publicKey: 'ssh-ed25519 NEW yaac deploy' })
    expect(fresh?.id).not.toBe(old.id)
    expect(fresh).toMatchObject({ name: 'deploy', kind: 'ssh', publicKey: 'ssh-ed25519 NEW yaac deploy' })
    expect(await fresh?.openSecret()).toBe('bmV3')
    expect(await getProjectRow(P)).toMatchObject({ gitCredentialId: fresh?.id, knownHostsEntry: 'x ssh-ed25519 HOST' })
    expect((await listGitCredentials()).map((c) => c.id)).toEqual([fresh?.id])
    expect(await replaceGitCredential(old.id, { secret: 'x' })).toBeUndefined()
  })
})
