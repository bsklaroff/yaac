import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import type { ServerError } from '@yaac/shared/errors'
import { BUILT_IN_USER_ID, closeDb, recordProject, seeTailnetUser } from '#db'
import {
  actorLabel,
  authorizeProject,
  isPerson,
  isProjectHeld,
  personId,
  requirePerson,
  requireWithinCeiling,
  systemPrincipal,
  withProjectsHeld,
  type Actor,
} from '#domain/access'
import { workspaceDelegate } from '#test/support/delegate'
import type { PermissionMode } from '@yaac/shared/types'

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
  await recordProject({ id: PROJ, name: 'demo', addedAt: 'now' }, owner)
})

afterAll(async () => {
  await closeDb()
  await cleanupTempDir(tmpDir)
})

describe('authorizeProject', () => {
  it("admits the project's owner and the server at every level, refuses another user's writes", async () => {
    for (const level of ['reader', 'delegate', 'owner'] as const) {
      await expect(authorizeProject(user(owner), PROJ, level)).resolves.toBeUndefined()
      await expect(authorizeProject(systemPrincipal, PROJ, level)).resolves.toBeUndefined()
    }
    await expect(authorizeProject(user(BOB), PROJ, 'reader')).resolves.toBeUndefined()
    expect(await codeOf(authorizeProject(user(BOB), PROJ))).toBe('FORBIDDEN')
    expect(await codeOf(authorizeProject(user(BOB), PROJ, 'delegate'))).toBe('FORBIDDEN')
    expect(await codeOf(authorizeProject({ kind: 'local', userId: BUILT_IN_USER_ID }, PROJ))).toBe('FORBIDDEN')
    const refused = await authorizeProject(user(BOB), PROJ).catch((e: unknown) => e as ServerError)
    expect(refused?.httpStatus).toBe(403)
  })

  it("admits the owner's delegate at delegate and reader, never at owner, and only in its own project", async () => {
    const agent = workspaceDelegate(owner, 'w1', { projectId: PROJ })
    await expect(authorizeProject(agent, PROJ, 'delegate')).resolves.toBeUndefined()
    await expect(authorizeProject(agent, PROJ, 'reader')).resolves.toBeUndefined()
    await expect(authorizeProject(agent, PROJ)).rejects.toMatchObject({ code: 'FORBIDDEN', message: expect.stringContaining('workspace w1') as unknown })
    // Unscoped, it reaches every project its user owns.
    await expect(authorizeProject(workspaceDelegate(owner, 'w1'), PROJ, 'delegate')).resolves.toBeUndefined()
    // Scoped to another project, it reaches none of this one, reads included.
    const elsewhere = workspaceDelegate(owner, 'w1', { projectId: MISSING })
    for (const level of ['reader', 'delegate'] as const) {
      expect(await codeOf(authorizeProject(elsewhere, PROJ, level))).toBe('FORBIDDEN')
    }
    // Another user's delegate is that user, no more.
    expect(await codeOf(authorizeProject(workspaceDelegate(BOB, 'w1'), PROJ, 'delegate'))).toBe('FORBIDDEN')
  })

  it('is NOT_FOUND for a project that does not exist, never open', async () => {
    expect(await codeOf(authorizeProject(user(BOB), MISSING))).toBe('NOT_FOUND')
    expect(await codeOf(authorizeProject(systemPrincipal, MISSING, 'reader'))).toBe('NOT_FOUND')
  })
})

describe('isPerson', () => {
  it('answers for a person, never the server or a delegate', () => {
    expect(isPerson(user(BOB))).toBe(true)
    expect(isPerson({ kind: 'local', userId: BUILT_IN_USER_ID })).toBe(true)
    expect(isPerson(systemPrincipal)).toBe(false)
    expect(isPerson(workspaceDelegate(BOB, 'w1'))).toBe(false)
  })
})

describe('requirePerson', () => {
  it('refuses the server and a delegate with FORBIDDEN, naming what only a person may do and who asked', () => {
    expect(() => requirePerson(user(BOB), 'publish a site')).not.toThrow()
    expect(() => requirePerson(workspaceDelegate(BOB, 'w1'), 'publish a site'))
      .toThrow(expect.objectContaining({ code: 'FORBIDDEN', message: 'only a person may publish a site, not workspace w1' }) as Error)
    expect(() => requirePerson(systemPrincipal, 'x')).toThrow()
  })
})

describe('requireWithinCeiling', () => {
  it('refuses a delegate anything more permissive than its ceiling, or a mode it cannot rank, and passes everyone else', () => {
    const agent = workspaceDelegate(BOB, 'w1', { ceiling: 'accept-edits' })
    expect(() => requireWithinCeiling(agent, 'accept-edits', 'x')).not.toThrow()
    expect(() => requireWithinCeiling(agent, 'plan', 'x')).not.toThrow()
    expect(() => requireWithinCeiling(agent, 'bypass', 'its sibling'))
      .toThrow(expect.objectContaining({
        code: 'FORBIDDEN',
        message: "its sibling: permission mode 'bypass' is more permissive than workspace w1's ceiling ('accept-edits')",
      }) as Error)
    expect(() => requireWithinCeiling(agent, 'dontAsk' as PermissionMode, 'x')).toThrow(/cannot tell/)
    expect(() => requireWithinCeiling({ ...agent, ceiling: 'dontAsk' as PermissionMode }, 'plan', 'x')).toThrow(/cannot tell/)
    expect(() => requireWithinCeiling(user(BOB), 'bypass', 'x')).not.toThrow()
    expect(() => requireWithinCeiling(systemPrincipal, 'bypass', 'x')).not.toThrow()
  })
})

describe('personId', () => {
  it("answers a person's own id, and refuses a delegate its user's and the server any", () => {
    expect(personId(user(BOB))).toBe(BOB)
    expect(personId({ kind: 'local', userId: BUILT_IN_USER_ID })).toBe(BUILT_IN_USER_ID)
    expect(() => personId(workspaceDelegate(BOB, 'w1')))
      .toThrow(expect.objectContaining({ code: 'FORBIDDEN', message: expect.stringContaining('workspace w1 has no account of its own') as unknown }) as Error)
    expect(() => personId(systemPrincipal)).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }) as Error)
  })
})

describe('actorLabel', () => {
  it("names the server, a person by login, and a delegate by its user's login and what acts", () => {
    expect(actorLabel(systemPrincipal)).toBe('server')
    expect(actorLabel({ kind: 'local', userId: BUILT_IN_USER_ID })).toBe('local')
    expect(actorLabel(user(BOB))).toBe(`${BOB}@example.com`)
    expect(actorLabel(workspaceDelegate(BOB, 'abcdef0123', { login: 'bob@example.com' }))).toBe('bob@example.com via workspace abcdef01')
    expect(actorLabel(workspaceDelegate(BUILT_IN_USER_ID, 'abcdef0123'))).toBe('local via workspace abcdef01')
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
