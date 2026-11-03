import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import type { ServerError } from '@yaac/shared/errors'
import { BUILT_IN_USER_ID, closeDb, recordProject, seeTailnetUser, setProjectShareRevoked } from '#db'
import {
  authorizeProject,
  isProjectHeld,
  systemPrincipal,
  withProjectsHeld,
  workspacePrincipal,
  type Actor,
} from '#domain/access'

const BOB = 'a1b2c3d4-0000-4000-8000-000000000002'
const PROJ = '83878c91-1713-4890-8e0f-e0fb97a8c47a'
const SHARE = '9c0d6b1e-2f3a-4b5c-8d7e-0f1a2b3c4d5e'
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

  it("refuses everyone, the server too, a share its source's owner removed", async () => {
    const recipient = await seeTailnetUser('recipient@example.com', 'Recipient')
    await recordProject({ id: SHARE, name: 'demo', remoteUrl: 'https://github.com/o/r', addedAt: 'now', sharedFrom: PROJ }, recipient)
    await expect(authorizeProject(user(recipient), SHARE)).resolves.toBeUndefined()
    await setProjectShareRevoked(SHARE, true)
    expect(await codeOf(authorizeProject(user(recipient), SHARE))).toBe('FORBIDDEN')
    expect(await codeOf(authorizeProject(systemPrincipal, SHARE))).toBe('FORBIDDEN')
    expect(await codeOf(authorizeProject(user(owner), SHARE))).toBe('FORBIDDEN')
  })
})

describe('withProjectsHeld', () => {
  it('refuses every write to the held projects, the server too, until it settles, and one hold at a time', async () => {
    const reason = 'demo is moving; try again once it has.'
    let release = (): void => {}
    const held = withProjectsHeld([PROJ], reason, () => new Promise<string>((resolve) => { release = () => resolve('done') }))

    for (const actor of [user(owner), systemPrincipal]) {
      await expect(authorizeProject(actor, PROJ)).rejects.toMatchObject({ code: 'CONFLICT', message: reason })
    }
    await expect(withProjectsHeld([MISSING, PROJ], 'again', () => Promise.resolve())).rejects.toMatchObject({ code: 'CONFLICT', message: reason })
    // A refused hold takes none of its projects.
    expect(isProjectHeld(MISSING)).toBe(false)

    release()
    expect(await held).toBe('done')
    await expect(authorizeProject(user(owner), PROJ)).resolves.toBeUndefined()
    // A failure lifts the hold too.
    await expect(withProjectsHeld([PROJ], reason, () => Promise.reject(new Error('boom')))).rejects.toThrow('boom')
    await expect(authorizeProject(user(owner), PROJ)).resolves.toBeUndefined()
  })
})

describe('isProjectHeld', () => {
  it('answers whether a hold is on the project', async () => {
    expect(isProjectHeld(PROJ)).toBe(false)
    await withProjectsHeld([PROJ], 'held', () => {
      expect(isProjectHeld(PROJ)).toBe(true)
      return Promise.resolve()
    })
    expect(isProjectHeld(PROJ)).toBe(false)
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
