import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import { eq } from 'drizzle-orm'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { getDb, closeDb } from '#db/client'
import { projectEnvVars } from '#db/schema'
import {
  deleteProjectEnvVar,
  deleteProjectEnvVars,
  listProjectEnvVars,
  upsertProjectEnvVar,
} from '#db'
import { forgetSecretConfig } from '#db/secret-key'
import { secretKeyPath } from '@yaac/shared/project-paths'

/**
 * The env rows, and with them the encryption every secret this server stores
 * goes through — the cipher and the key file are internal to this folder, so
 * this is where both are exercised.
 *
 * What the assertions pin is the property the whole scheme exists for: what
 * lands in the column is not the secret, and what comes back out is.
 */

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
  await db.delete(projectEnvVars)
  forgetSecretConfig()
})

afterEach(() => {
  vi.unstubAllEnvs()
  forgetSecretConfig()
})

/** The row as the database actually holds it — the two columns a caller
 *  never sees, which is the point. */
async function storedRow(name: string): Promise<typeof projectEnvVars.$inferSelect> {
  const db = await getDb()
  const rows = await db.select().from(projectEnvVars).where(eq(projectEnvVars.name, name))
  expect(rows).toHaveLength(1)
  return rows[0]
}

const RULE = { hosts: ['api.example.com'], header: 'x-api-key' }

describe('listProjectEnvVars', () => {
  it('is empty for a project with nothing set, and scoped to one project', async () => {
    expect(await listProjectEnvVars('demo')).toEqual([])

    await upsertProjectEnvVar('demo', { name: 'MINE', value: 'a', secret: false })
    await upsertProjectEnvVar('other', { name: 'THEIRS', value: 'b', secret: false })

    expect((await listProjectEnvVars('demo')).map((r) => r.name)).toEqual(['MINE'])
  })

  it('returns rows in name order, with a secret opened for the caller', async () => {
    await upsertProjectEnvVar('demo', { name: 'ZED', value: 'z', secret: false })
    await upsertProjectEnvVar('demo', { name: 'ALPHA', value: 'sekrit', secret: true, rule: RULE })

    expect(await listProjectEnvVars('demo')).toMatchObject([
      { name: 'ALPHA', value: 'sekrit', secret: true, rule: RULE, unreadable: false },
      { name: 'ZED', value: 'z', secret: false, unreadable: false },
    ])
  })

  it('reports a value it cannot open instead of throwing', async () => {
    // A key file replaced or lost: the row is still listed, so the settings
    // page can say which secret needs re-entering, and resolves to nothing,
    // so a worktree launches without it rather than with an empty header.
    await upsertProjectEnvVar('demo', { name: 'SECRET', value: 'sekrit', secret: true, rule: RULE })
    await fs.writeFile(secretKeyPath(), 'a-completely-different-key\n', { mode: 0o600 })
    forgetSecretConfig()

    expect(await listProjectEnvVars('demo')).toMatchObject([
      { name: 'SECRET', value: undefined, unreadable: true },
    ])
  })
})

describe('upsertProjectEnvVar', () => {
  it('stores a plain value as it is, in the clear', async () => {
    await upsertProjectEnvVar('demo', { name: 'NODE_ENV', value: 'development', secret: false })

    const row = await storedRow('NODE_ENV')
    expect(row.value).toBe('development')
    expect(row.sealedValue).toBeNull()
  })

  it('seals a secret, so the column is not the secret', async () => {
    await upsertProjectEnvVar('demo', { name: 'API_KEY', value: 'sekrit', secret: true, rule: RULE })

    const row = await storedRow('API_KEY')
    expect(row.value).toBeNull()
    expect(row.sealedValue).not.toBeNull()
    expect(row.sealedValue).not.toContain('sekrit')
    // The envelope the scheme writes: a version, so a key can be rotated
    // without re-encrypting anything, and hex after it.
    expect(row.sealedValue).toMatch(/^\$ba\$0\$[0-9a-f]+$/)
    expect((await listProjectEnvVars('demo'))[0].value).toBe('sekrit')
  })

  it('gives the same secret a different ciphertext every time', async () => {
    // A fresh nonce per encryption, so equal values are not visibly equal in
    // the database.
    await upsertProjectEnvVar('demo', { name: 'A', value: 'same', secret: true, rule: RULE })
    const first = (await storedRow('A')).sealedValue
    await upsertProjectEnvVar('demo', { name: 'A', value: 'same', secret: true, rule: RULE })
    expect((await storedRow('A')).sealedValue).not.toBe(first)
  })

  it('replaces by (project, name) rather than accumulating', async () => {
    const first = await upsertProjectEnvVar('demo', { name: 'A', value: '1', secret: false })
    const second = await upsertProjectEnvVar('demo', { name: 'A', value: '2', secret: false })

    expect(await listProjectEnvVars('demo')).toHaveLength(1)
    expect(second.value).toBe('2')
    // The row keeps its identity across the edit — the id is what a client
    // addresses it by.
    expect(second.id).toBe(first.id)
  })

  it('keeps the stored secret when a rule is edited with no new value', async () => {
    await upsertProjectEnvVar('demo', { name: 'A', value: 'sekrit', secret: true, rule: RULE })
    await upsertProjectEnvVar('demo', {
      name: 'A',
      secret: true,
      rule: { hosts: ['other.example.com'], bodyParam: 'client_secret' },
    })

    expect(await listProjectEnvVars('demo')).toMatchObject([{
      value: 'sekrit',
      rule: { hosts: ['other.example.com'], bodyParam: 'client_secret' },
    }])
  })

  it('leaves no plaintext behind when a plain variable becomes a secret', async () => {
    await upsertProjectEnvVar('demo', { name: 'A', value: 'was-plain', secret: false })
    await upsertProjectEnvVar('demo', { name: 'A', value: 'now-secret', secret: true, rule: RULE })

    const row = await storedRow('A')
    expect(row.value).toBeNull()
    expect(row.sealedValue).not.toContain('now-secret')
  })

  it('opens a row written under an older key when the newer set still holds it', async () => {
    // Rotation is a restart, not a re-encrypt pass: state the new key first
    // and keep the old one, and every existing row goes on opening under the
    // version its envelope names.
    await upsertProjectEnvVar('demo', { name: 'A', value: 'old-days', secret: true, rule: RULE })
    const original = await fs.readFile(secretKeyPath(), 'utf8')

    vi.stubEnv('YAAC_SECRETS', `2:a-new-key-of-adequate-length-here,0:${original.trim()}`)
    forgetSecretConfig()

    expect((await listProjectEnvVars('demo'))[0].value).toBe('old-days')
    // A write after the rotation takes the new version.
    await upsertProjectEnvVar('demo', { name: 'B', value: 'new-days', secret: true, rule: RULE })
    expect((await storedRow('B')).sealedValue).toMatch(/^\$ba\$2\$/)
    expect((await listProjectEnvVars('demo')).map((r) => r.value)).toEqual(['old-days', 'new-days'])
  })
})

describe('deleteProjectEnvVar', () => {
  it('removes by id, and refuses an id belonging to another project', async () => {
    const mine = await upsertProjectEnvVar('demo', { name: 'A', value: '1', secret: false })
    const theirs = await upsertProjectEnvVar('other', { name: 'B', value: '2', secret: false })

    expect(await deleteProjectEnvVar('demo', theirs.id)).toBe(false)
    expect(await listProjectEnvVars('other')).toHaveLength(1)

    expect(await deleteProjectEnvVar('demo', mine.id)).toBe(true)
    expect(await listProjectEnvVars('demo')).toEqual([])
  })
})

describe('deleteProjectEnvVars', () => {
  it('takes one project’s environment with it, and leaves the rest', async () => {
    await upsertProjectEnvVar('demo', { name: 'A', value: '1', secret: false })
    await upsertProjectEnvVar('demo', { name: 'B', value: 'sekrit', secret: true, rule: RULE })
    await upsertProjectEnvVar('other', { name: 'C', value: '3', secret: false })

    await deleteProjectEnvVars('demo')

    expect(await listProjectEnvVars('demo')).toEqual([])
    expect(await listProjectEnvVars('other')).toHaveLength(1)
  })
})
