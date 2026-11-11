import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { addRepoShare, BUILT_IN_USER_ID, closeDb, getRepo, insertRepo, markRepoDeleted, seeTailnetUser, type RepoRow } from '#db'
import { systemPrincipal } from '#domain/access'
import { assertCanUseRepo, canUseRepo, ownRepo } from '#domain/repos'

/** Fixture: a repo shared with ada and not with bo, and one its owner
 *  deleted. */
const REPO = '0a0a0a0a-0000-4000-8000-000000000001'
const DELETED = '0a0a0a0a-0000-4000-8000-000000000002'
const MISSING = '0a0a0a0a-0000-4000-8000-0000000000ee'

let tmp: string
let ada: string
let bo: string
let repo: RepoRow
let deleted: RepoRow

beforeAll(async () => {
  tmp = await createTempDataDir()
  ada = await seeTailnetUser('ada@example.com', 'Ada')
  bo = await seeTailnetUser('bo@example.com', 'Bo')
  repo = await insertRepo({ id: REPO, owner: BUILT_IN_USER_ID, remoteUrl: 'https://github.com/acme/app.git' })
  await addRepoShare(REPO, ada)
  await insertRepo({ id: DELETED, owner: BUILT_IN_USER_ID, remoteUrl: 'https://github.com/acme/gone.git' })
  await addRepoShare(DELETED, ada)
  await markRepoDeleted(DELETED)
  deleted = (await getRepo(DELETED)) as RepoRow
})

afterAll(async () => {
  await closeDb()
  await cleanupTempDir(tmp)
})

describe('ownRepo', () => {
  it('answers the repo to its owner and the server, and refuses everyone else', async () => {
    expect(await ownRepo({ kind: 'local', userId: BUILT_IN_USER_ID }, REPO)).toEqual(repo)
    expect(await ownRepo(systemPrincipal, REPO)).toEqual(repo)
    // Sharing gives the use of a repo, not its settings.
    await expect(ownRepo({ kind: 'local', userId: ada }, REPO)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(ownRepo({ kind: 'workspace', workspaceId: 'w', userId: bo }, REPO)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(ownRepo(systemPrincipal, MISSING)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    // Not an id at all: missing, never a database error.
    await expect(ownRepo(systemPrincipal, 'app')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('canUseRepo', () => {
  it('admits the owner and a user the repo is shared with, and nobody once it is deleted', async () => {
    expect(await canUseRepo(BUILT_IN_USER_ID, repo)).toBe(true)
    expect(await canUseRepo(ada, repo)).toBe(true)
    expect(await canUseRepo(bo, repo)).toBe(false)
    expect(await canUseRepo(BUILT_IN_USER_ID, deleted)).toBe(false)
    expect(await canUseRepo(ada, deleted)).toBe(false)
  })
})

describe('assertCanUseRepo', () => {
  it('refuses a user who may not use the repo, saying why', async () => {
    await expect(assertCanUseRepo(ada, repo)).resolves.toBeUndefined()
    await expect(assertCanUseRepo(bo, repo)).rejects.toMatchObject({
      code: 'FORBIDDEN', message: expect.stringMatching(/app\.git is not shared with/) as string,
    })
    await expect(assertCanUseRepo(BUILT_IN_USER_ID, deleted)).rejects.toMatchObject({
      code: 'FORBIDDEN', message: expect.stringMatching(/was deleted by its owner/) as string,
    })
  })
})
