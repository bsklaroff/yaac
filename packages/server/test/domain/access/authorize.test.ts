import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import type { ServerError } from '@yaac/shared/errors'
import { BUILT_IN_USER_ID, closeDb, recordProject, seeTailnetUser } from '#db'
import {
  authorizeProject,
  systemPrincipal,
  workspacePrincipal,
  type Actor,
} from '#domain/access'

const BOB = 'a1b2c3d4-0000-4000-8000-000000000002'
const PROJ = '83878c91-1713-4890-8e0f-e0fb97a8c47a'
const MISSING = '4101bef8-794f-4d98-8e95-dfb54850c68b'

function user(userId: string): Actor {
  return { kind: 'tailnet', userId, login: `${userId}@example.com`, name: userId }
}

async function codeOf(p: Promise<unknown>): Promise<string | undefined> {
  return p.then(() => undefined, (err: unknown) => (err as ServerError).code)
}

let tmpDir: string
let owner: string

// One data dir for the file: a project owned by a tailnet user, which no
// case changes.
beforeAll(async () => {
  tmpDir = await createTempDataDir()
  owner = await seeTailnetUser('owner@example.com', 'Owner')
  await recordProject({ id: PROJ, name: 'demo', remoteUrl: 'https://github.com/o/r', addedAt: 'now' }, owner)
})

afterAll(async () => {
  await closeDb()
  await cleanupTempDir(tmpDir)
})

describe('authorizeProject', () => {
  it("admits the project's owner and the server, refuses everyone else", async () => {
    await expect(authorizeProject(user(owner), PROJ)).resolves.toBeUndefined()
    await expect(authorizeProject(systemPrincipal, PROJ)).resolves.toBeUndefined()
    expect(await codeOf(authorizeProject(user(BOB), PROJ))).toBe('FORBIDDEN')
    expect(await codeOf(authorizeProject({ kind: 'local', userId: BUILT_IN_USER_ID }, PROJ))).toBe('FORBIDDEN')
    expect(await codeOf(authorizeProject({ kind: 'workspace', workspaceId: 'w1', userId: BOB }, PROJ))).toBe('FORBIDDEN')
    const refused = await authorizeProject(user(BOB), PROJ).catch((e: unknown) => e as ServerError)
    expect(refused?.httpStatus).toBe(403)
  })

  it('is NOT_FOUND for a project that does not exist, never open', async () => {
    expect(await codeOf(authorizeProject(user(BOB), MISSING))).toBe('NOT_FOUND')
  })
})

describe('workspacePrincipal', () => {
  it("acts as the calling workspace with its project's owner", async () => {
    const principal = await workspacePrincipal('w1', PROJ)
    expect(principal).toEqual({ kind: 'workspace', workspaceId: 'w1', userId: owner })
    await expect(authorizeProject(principal, PROJ)).resolves.toBeUndefined()
    expect(await codeOf(workspacePrincipal('w1', MISSING))).toBe('NOT_FOUND')
  })
})
