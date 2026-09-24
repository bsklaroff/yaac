import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { importLegacyGitCredentials, listCredentialSummaries, resolveProjectCredential } from '#domain/projects'
import { closeDb, insertGitCredential, recordProject, setProjectGitCredential } from '#db'
import { getDb } from '#db/client'
import { gitCredentials, legacyGitSshKeys } from '#db/schema'
import { githubCredentialsPath } from '@yaac/shared/project-paths'
import { generateSshKey } from '#lib/ssh-key'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await createTempDataDir()
})

afterEach(async () => {
  await closeDb()
  await cleanupTempDir(tmpDir)
})

/** A per-pattern key as an older server stored it: the seed sealed with the
 *  install's key (sealed here through the new store, then moved across). */
async function legacyKey(pattern: string, knownHostsEntry: string): Promise<string> {
  const key = generateSshKey(`yaac ${pattern}`)
  await insertGitCredential({ name: 'tmp', kind: 'ssh', secret: key.seed.toString('base64') })
  const db = await getDb()
  const [{ sealedSecret }] = await db.select().from(gitCredentials)
  await db.delete(gitCredentials)
  await db.insert(legacyGitSshKeys).values({
    pattern, sealedPrivateKey: sealedSecret, publicKey: key.publicKey, knownHostsEntry,
  })
  return key.publicKey
}

describe('importLegacyGitCredentials', () => {
  it('names every old credential and assigns each project what its pattern matched', async () => {
    await fs.mkdir(path.dirname(githubCredentialsPath()), { recursive: true })
    await fs.writeFile(githubCredentialsPath(), JSON.stringify({
      tokens: [
        { kind: 'https', pattern: 'github.com/acme/*', token: 'ghp_acme' },
        { pattern: 'github.com/*', token: 'ghp_any' },
        { kind: 'ssh', pattern: 'x/*', keyPath: '/home/me/.ssh/id' },
      ],
    }))
    const publicKey = await legacyKey('git.example.com/*', 'git.example.com ssh-ed25519 HOST')
    await recordProject({ slug: 'web', remoteUrl: 'https://github.com/acme/web.git', addedAt: 'x' })
    await recordProject({ slug: 'other', remoteUrl: 'https://github.com/else/other', addedAt: 'x' })
    await recordProject({ slug: 'svc', remoteUrl: 'git@git.example.com:team/svc.git', addedAt: 'x' })
    await recordProject({ slug: 'none', remoteUrl: 'https://gitlab.com/g/none', addedAt: 'x' })
    // Already assigned: left alone.
    const mine = await insertGitCredential({ name: 'mine', kind: 'https', secret: 'ghp_mine' })
    await recordProject({ slug: 'kept', remoteUrl: 'https://github.com/acme/kept', addedAt: 'x' })
    await setProjectGitCredential('kept', mine.id, null)

    await importLegacyGitCredentials()

    expect((await listCredentialSummaries()).map((c) => [c.name, c.kind, c.projects])).toEqual([
      ['mine', 'https', ['kept']],
      ['git.example.com/* (ssh key)', 'ssh', ['svc']],
      ['github.com/acme/* (token)', 'https', ['web']],
      ['github.com/* (token)', 'https', ['other']],
    ])
    expect(await resolveProjectCredential('web')).toEqual({ kind: 'https', token: 'ghp_acme' })
    expect(await resolveProjectCredential('svc')).toMatchObject({
      kind: 'ssh', knownHostsEntry: 'git.example.com ssh-ed25519 HOST',
    })
    // The same key, under a comment that follows its new name.
    expect((await listCredentialSummaries())[1].publicKey?.split(' ')[1]).toBe(publicKey.split(' ')[1])
    expect(await resolveProjectCredential('none')).toBeNull()

    // Both sources are consumed, so the next start is a no-op.
    await expect(fs.access(githubCredentialsPath())).rejects.toThrow()
    expect(await (await getDb()).select().from(legacyGitSshKeys)).toEqual([])
    await importLegacyGitCredentials()
    expect(await listCredentialSummaries()).toHaveLength(4)
  })

  it('leaves a file that does not parse in place, and skips a key that no longer opens', async () => {
    // Plaintext tokens the user can still fix: deleting them would lose them.
    await fs.mkdir(path.dirname(githubCredentialsPath()), { recursive: true })
    await fs.writeFile(githubCredentialsPath(), '{ "tokens": [{ "pattern": "github.com/*", "token": "ghp_x" },] }')
    // The first matching key will not decrypt; the old lookup fell through
    // to the next match, and so does the import.
    const db = await getDb()
    await db.insert(legacyGitSshKeys).values({
      pattern: 'git.example.com/*', sealedPrivateKey: 'not-sealed', publicKey: 'ssh-ed25519 AAAA x', knownHostsEntry: 'h1',
    })
    await legacyKey('git.example.com/team/*', 'h2')
    await recordProject({ slug: 'svc', remoteUrl: 'git@git.example.com:team/svc.git', addedAt: 'x' })
    await recordProject({ slug: 'web', remoteUrl: 'https://github.com/acme/web.git', addedAt: 'x' })

    await importLegacyGitCredentials()

    expect(await resolveProjectCredential('svc')).toMatchObject({ kind: 'ssh', knownHostsEntry: 'h2' })
    expect(await resolveProjectCredential('web')).toBeNull()
    await fs.access(githubCredentialsPath())

    // Fixed by hand, it is imported at the next start.
    await fs.writeFile(githubCredentialsPath(), JSON.stringify({ tokens: [{ pattern: 'github.com/*', token: 'ghp_x' }] }))
    await importLegacyGitCredentials()
    expect(await resolveProjectCredential('web')).toEqual({ kind: 'https', token: 'ghp_x' })
    await expect(fs.access(githubCredentialsPath())).rejects.toThrow()
  })
})
