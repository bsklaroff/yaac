import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { createAdaptorServer, type ServerType } from '@hono/node-server'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { git } from '@yaac/test-utils/git'
import { recordTestProject } from '@yaac/test-utils/project-fixture'
import { hostedRepoDir, repoDir } from '@yaac/shared/project-paths'
import { ServerError } from '@yaac/shared/errors'
import {
  BUILT_IN_USER_ID,
  closeDb,
  getRepo,
  insertRepo,
  linkProjectRepo,
  markRepoDeleted,
  removeRepoShares,
  seeTailnetUser,
  setRepoRemote,
  updateProjectRepo,
} from '#db'
import { addHttpsCredential } from '#domain/auth'
import { getDefaultBranch } from '#domain/git'
import { withProjectsHeld } from '#domain/access'
import {
  createHostedRepo,
  removeKeptHostedRepo,
  serveHostedRepo,
  setDefaultBranch,
  setDefaultBranchGuard,
  shareRepo,
  withRepoHeld,
} from '#domain/repos'

/**
 * Fixture: one hosted repo, a project of its owner's that links it, and a
 * listener that hands every request to `serveHostedRepo` as the caller its
 * URL names, so a real git client clones and pushes through the same
 * handler the routes use:
 *   /owner/<repo>/…        the repo's owner
 *   /stranger/<repo>/…     another user
 *   /ada/<repo>/…          a user `shareRepo` can share with
 *   /ws/<caller project>/<repo>/…  a workspace of <caller project>
 */

type HostedRepoCaller = Parameters<typeof serveHostedRepo>[3]

let tmp: string
let server: ServerType
let origin: string
let repoId: string
let ada: string
/** The owner's project that links the repo; ada's, which links it once it
 *  is shared with her; one that links it read-only; and one that does not. */
const PROJECT = '0a0a0a0a-0000-4000-8000-000000000001'
const ADAS_PROJECT = '0a0a0a0a-0000-4000-8000-000000000002'
const READER_PROJECT = '0a0a0a0a-0000-4000-8000-000000000003'
const OTHER_PROJECT = '0a0a0a0a-0000-4000-8000-0000000000ff'
const MISSING = '0a0a0a0a-0000-4000-8000-0000000000ee'
const STRANGER = '0a0a0a0a-0000-4000-8000-0000000000aa'
const owner = { kind: 'local' as const, userId: BUILT_IN_USER_ID }
const ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t' }

const run = (dir: string, args: string[]): Promise<string> => git(dir, args, { env: ENV })

function callerFor(segments: string[]): { caller: HostedRepoCaller; rest: string[] } {
  if (segments[0] === 'owner') return { caller: { kind: 'user', principal: owner }, rest: segments.slice(1) }
  if (segments[0] === 'ada') return { caller: { kind: 'user', principal: { kind: 'local', userId: ada } }, rest: segments.slice(1) }
  if (segments[0] === 'stranger') return { caller: { kind: 'user', principal: { kind: 'local', userId: STRANGER } }, rest: segments.slice(1) }
  return { caller: { kind: 'workspace', projectId: segments[1] }, rest: segments.slice(2) }
}

async function handle(request: Request): Promise<Response> {
  const segments = new URL(request.url).pathname.split('/').filter(Boolean)
  const { caller, rest } = callerFor(segments)
  try {
    return await serveHostedRepo(rest[0], request, `/${rest.slice(1).join('/')}`, caller)
  } catch (err) {
    const code = err instanceof ServerError ? err.code : 'INTERNAL'
    return new Response(code, { status: err instanceof ServerError ? err.httpStatus : 500 })
  }
}

/** A hosted repo with `main` pushed to it, then moved to another git host
 *  as a move leaves it. Answers its id and `main`. */
async function movedRepo(name: string): Promise<{ id: string; tip: string }> {
  const { id } = await createHostedRepo(BUILT_IN_USER_ID)
  const work = path.join(tmp, `${name}-work`)
  await run(tmp, ['clone', '-q', `${origin}/owner/${id}`, work])
  await run(work, ['commit', '-q', '--allow-empty', '-m', 'before the move'])
  await run(work, ['push', '-q', 'origin', 'HEAD:main'])
  const cred = await addHttpsCredential(BUILT_IN_USER_ID, { name: `${name}-gh`, token: 'ghp_x' })
  await setRepoRemote(id, `https://github.com/acme/${name}.git`, { id: cred.id, knownHostsEntry: null })
  return { id, tip: (await run(work, ['rev-parse', 'HEAD'])).trim() }
}

/** Wait for the post-push fetch to bring the main clone's `origin/<branch>`
 *  to `sha`. */
async function mainCloneSees(branch: string, sha: string, repo = repoId): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    const at = await run(repoDir(repo), ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`]).catch(() => '')
    if (at.trim() === sha) return
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error(`main clone never saw origin/${branch} at ${sha}`)
}

beforeAll(async () => {
  tmp = await createTempDataDir()
  repoId = (await createHostedRepo(BUILT_IN_USER_ID)).id
  ada = await seeTailnetUser('ada@example.com', 'Ada')
  for (const [id, projectOwner] of [[PROJECT, BUILT_IN_USER_ID], [ADAS_PROJECT, ada], [READER_PROJECT, BUILT_IN_USER_ID], [OTHER_PROJECT, BUILT_IN_USER_ID]] as const) {
    await recordTestProject(id, { repo: false, owner: projectOwner })
  }
  for (const id of [PROJECT, ADAS_PROJECT, READER_PROJECT]) await linkProjectRepo(id, repoId, 'app')
  await updateProjectRepo(READER_PROJECT, repoId, { readOnly: true })
  server = createAdaptorServer({ fetch: handle })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
})

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve))
  await closeDb()
  await cleanupTempDir(tmp)
})

describe('serveHostedRepo', () => {
  it('lets the owner clone the empty remote and push, and fetches each push into the main clone', async () => {
    const work = path.join(tmp, 'owner-clone')
    await run(tmp, ['clone', '-q', `${origin}/owner/${repoId}`, work])
    await run(work, ['commit', '-q', '--allow-empty', '-m', 'first'])
    await run(work, ['push', '-q', 'origin', 'HEAD:main'])

    const tip = (await run(work, ['rev-parse', 'HEAD'])).trim()
    expect((await run(hostedRepoDir(repoId), ['rev-parse', 'main'])).trim()).toBe(tip)
    await mainCloneSees('main', tip)
  })

  it('lets a workspace read and push the repos its project links, and only read one linked read-only', async () => {
    const work = path.join(tmp, 'ws-clone')
    await run(tmp, ['clone', '-q', `${origin}/ws/${PROJECT}/${repoId}`, work])
    await run(work, ['commit', '-q', '--allow-empty', '-m', 'from a workspace'])
    await run(work, ['push', '-q', 'origin', 'HEAD:agent/one'])
    await mainCloneSees('agent/one', (await run(work, ['rev-parse', 'HEAD'])).trim())

    // A project that does not link the repo, or does not exist, reaches nothing.
    await expect(run(tmp, ['ls-remote', `${origin}/ws/${OTHER_PROJECT}/${repoId}`])).rejects.toThrow(/403/)
    await expect(run(tmp, ['ls-remote', `${origin}/ws/${MISSING}/${repoId}`])).rejects.toThrow(/403/)
    // A read-only link fetches but never pushes.
    await run(work, ['fetch', '-q', `${origin}/ws/${READER_PROJECT}/${repoId}`])
    await expect(run(work, ['push', '-q', `${origin}/ws/${READER_PROJECT}/${repoId}`, 'HEAD:agent/two'])).rejects.toThrow(/403/)

    // Nobody pushes from a held project, or to a held repo, as a move holds
    // both; reads go on.
    await run(work, ['commit', '-q', '--allow-empty', '-m', 'while held'])
    await withProjectsHeld([PROJECT], 'moving', async () => {
      await expect(run(work, ['push', '-q', 'origin', 'HEAD:agent/one'])).rejects.toThrow(/409/)
      await run(work, ['fetch', '-q', 'origin'])
    })
    await withRepoHeld(repoId, 'moving', async () => {
      await expect(run(work, ['push', '-q', 'origin', 'HEAD:agent/one'])).rejects.toThrow(/409/)
      await expect(run(work, ['push', '-q', `${origin}/owner/${repoId}`, 'HEAD:agent/one'])).rejects.toThrow(/409/)
      await run(work, ['fetch', '-q', 'origin'])
    })
    await run(work, ['push', '-q', 'origin', 'HEAD:agent/one'])
  })

  it('lets any user read but only the owner, and a user the repo is shared with, push', async () => {
    const work = path.join(tmp, 'stranger-clone')
    await run(tmp, ['clone', '-q', `${origin}/stranger/${repoId}`, work])
    await run(work, ['commit', '-q', '--allow-empty', '-m', 'not mine'])
    await expect(run(work, ['push', '-q', 'origin', 'HEAD:stranger/one'])).rejects.toThrow(/403/)

    // Ada links the repo, but it is not shared with her yet: neither she nor
    // her project's workspaces reach it to push, and the workspaces not at all.
    await expect(run(work, ['push', '-q', `${origin}/ada/${repoId}`, 'HEAD:ada/one'])).rejects.toThrow(/403/)
    await expect(run(tmp, ['ls-remote', `${origin}/ws/${ADAS_PROJECT}/${repoId}`])).rejects.toThrow(/403/)

    await shareRepo(owner, repoId, ada)
    await run(work, ['push', '-q', `${origin}/ada/${repoId}`, 'HEAD:ada/one'])
    await run(work, ['push', '-q', `${origin}/ws/${ADAS_PROJECT}/${repoId}`, 'HEAD:ada/two'])
    const tip = (await run(work, ['rev-parse', 'HEAD'])).trim()
    await mainCloneSees('ada/two', tip)

    await removeRepoShares(repoId, ada)
    await expect(run(work, ['push', '-q', `${origin}/ada/${repoId}`, 'HEAD:ada/three'])).rejects.toThrow(/403/)
    await expect(run(tmp, ['ls-remote', `${origin}/ws/${ADAS_PROJECT}/${repoId}`])).rejects.toThrow(/403/)
  })

  it('answers only the smart-HTTP paths, and only for a hosted repo that exists', async () => {
    expect((await fetch(`${origin}/owner/${repoId}/HEAD`)).status).toBe(404)
    expect((await fetch(`${origin}/owner/${repoId}/config`)).status).toBe(404)
    expect((await fetch(`${origin}/owner/${MISSING}/info/refs?service=git-upload-pack`)).status).toBe(404)
    // Not an id at all: missing, never a database error.
    expect((await fetch(`${origin}/owner/73adefe9/info/refs?service=git-upload-pack`)).status).toBe(404)
    // A project that links no hosted repo names none.
    expect((await fetch(`${origin}/owner/${OTHER_PROJECT}/info/refs?service=git-upload-pack`)).status).toBe(404)
  })

  it('takes a URL naming a project for that project\'s one hosted repo', async () => {
    // What the checkouts of a project that was a share carry until restart.
    const tip = (await run(hostedRepoDir(repoId), ['rev-parse', 'main'])).trim()
    expect(await run(tmp, ['ls-remote', `${origin}/ws/${PROJECT}/${PROJECT}`, 'refs/heads/main'])).toBe(`${tip}\trefs/heads/main\n`)
    const work = path.join(tmp, 'ws-clone')
    await run(work, ['push', '-q', `${origin}/ws/${PROJECT}/${PROJECT}`, 'HEAD:agent/legacy'])
    expect((await run(hostedRepoDir(repoId), ['rev-parse', 'agent/legacy'])).trim()).toBe((await run(work, ['rev-parse', 'HEAD'])).trim())

    // A deleted repo's id names nothing, even where a project shares the
    // id, as every repo from before repos were rows does: a push to it must
    // not land in the repo the project links now.
    await insertRepo({ id: PROJECT, owner: BUILT_IN_USER_ID, remoteUrl: 'http://yaac.internal/gone.git', hosted: true })
    await markRepoDeleted(PROJECT)
    await expect(run(work, ['push', '-q', `${origin}/ws/${PROJECT}/${PROJECT}`, 'HEAD:agent/gone'])).rejects.toThrow(/not found/i)
    await expect(run(hostedRepoDir(repoId), ['rev-parse', '--verify', '-q', 'agent/gone'])).rejects.toThrow()
  })

  it('takes its default branch from the first push when that is not main, and guards it', async () => {
    const other = (await createHostedRepo(BUILT_IN_USER_ID)).id
    const work = path.join(tmp, 'legacy-clone')
    await run(tmp, ['clone', '-q', `${origin}/owner/${other}`, work])
    await run(work, ['checkout', '-q', '-b', 'master'])
    await run(work, ['commit', '-q', '--allow-empty', '-m', 'first'])
    await run(work, ['push', '-q', 'origin', 'master'])

    expect((await run(hostedRepoDir(other), ['symbolic-ref', 'HEAD'])).trim()).toBe('refs/heads/master')
    // The main clone follows, so creates fork from master.
    await vi.waitFor(async () => expect(await getDefaultBranch(repoDir(other))).toBe('master'), { timeout: 20_000, interval: 100 })
    expect((await run(tmp, ['ls-remote', '--symref', `${origin}/owner/${other}`, 'HEAD'])))
      .toContain('ref: refs/heads/master\tHEAD')

    await run(work, ['commit', '-q', '--amend', '--allow-empty', '-m', 'rewritten'])
    await expect(run(work, ['push', '-q', '--force', 'origin', 'master'])).rejects.toThrow(/cannot be force-pushed/)
    await expect(run(work, ['push', '-q', 'origin', ':master'])).rejects.toThrow(/cannot be deleted/)
  })

  it('never takes a branch named HEAD, guard or no guard', async () => {
    const work = path.join(tmp, 'owner-clone')
    await setDefaultBranchGuard(owner, repoId, false)
    try {
      await expect(run(work, ['push', '-q', 'origin', 'HEAD:refs/heads/HEAD'])).rejects.toThrow(/may not be named HEAD/)
    } finally {
      await setDefaultBranchGuard(owner, repoId, true)
    }
  })

  it('checks every pushed object', async () => {
    const work = path.join(tmp, 'owner-clone')
    // A commit with no author, which `git commit` would never write.
    const tree = (await run(work, ['rev-parse', 'HEAD^{tree}'])).trim()
    const parent = (await run(work, ['rev-parse', 'HEAD'])).trim()
    const bad = path.join(tmp, 'bad-commit')
    await fs.writeFile(bad, `tree ${tree}\nparent ${parent}\ncommitter T <t@t> 0 +0000\n\nno author\n`)
    const sha = (await run(work, ['hash-object', '-t', 'commit', '--literally', '-w', bad])).trim()
    await expect(run(work, ['push', '-q', 'origin', `${sha}:refs/heads/broken`])).rejects.toThrow(/missingAuthor/)
  })

  it('guards the default branch against deletion and rewinds while the guard is on', async () => {
    const work = path.join(tmp, 'owner-clone')
    await run(work, ['fetch', '-q', 'origin'])
    await run(work, ['reset', '-q', '--hard', 'origin/main'])
    const before = (await run(work, ['rev-parse', 'HEAD'])).trim()
    await run(work, ['commit', '-q', '--amend', '--allow-empty', '-m', 'rewritten'])

    await expect(run(work, ['push', '-q', '--force', 'origin', 'HEAD:main'])).rejects.toThrow(/cannot be force-pushed/)
    await expect(run(work, ['push', '-q', 'origin', ':main'])).rejects.toThrow(/cannot be deleted/)
    // Other branches stay the agents' to rewrite.
    await run(work, ['push', '-q', '--force', 'origin', 'HEAD:agent/one'])
    expect((await run(hostedRepoDir(repoId), ['rev-parse', 'main'])).trim()).toBe(before)

    await setDefaultBranchGuard(owner, repoId, false)
    await run(work, ['push', '-q', '--force', 'origin', 'HEAD:main'])
    const after = (await run(work, ['rev-parse', 'HEAD'])).trim()
    expect((await run(hostedRepoDir(repoId), ['rev-parse', 'main'])).trim()).toBe(after)
    // The rewound tip stays recoverable from the remote's reflog.
    expect(await run(hostedRepoDir(repoId), ['reflog', 'show', '--format=%H', 'main'])).toContain(before)
    await setDefaultBranchGuard(owner, repoId, true)
  })

  it("serves a moved repo's old repository read-only, to compare with its new remote, and a deleted repo not at all", async () => {
    const { id, tip } = await movedRepo('moved')
    await linkProjectRepo(OTHER_PROJECT, id, 'moved')
    expect(await run(tmp, ['ls-remote', `${origin}/owner/${id}`, 'refs/heads/main'])).toBe(`${tip}\trefs/heads/main\n`)
    const work = path.join(tmp, 'moved-clone')
    await run(tmp, ['clone', '-q', `${origin}/owner/${id}`, work])
    await run(work, ['commit', '-q', '--allow-empty', '-m', 'after the move'])
    await expect(run(work, ['push', '-q', 'origin', 'HEAD:main'])).rejects.toThrow(/403/)
    await expect(run(work, ['push', '-q', `${origin}/ws/${OTHER_PROJECT}/${id}`, 'HEAD:main'])).rejects.toThrow(/403/)

    await markRepoDeleted(id)
    await expect(run(tmp, ['ls-remote', `${origin}/owner/${id}`])).rejects.toThrow(/not found/i)
  })
})

describe('withRepoHeld', () => {
  it('holds one repo at a time, and lets go when its work settles either way', async () => {
    const other = (await createHostedRepo(BUILT_IN_USER_ID)).id
    await withRepoHeld(repoId, 'first', async () => {
      await expect(withRepoHeld(repoId, 'second', () => Promise.resolve())).rejects.toMatchObject({ code: 'CONFLICT', message: 'first' })
      expect(await withRepoHeld(other, 'elsewhere', () => Promise.resolve('free'))).toBe('free')
    })
    await expect(withRepoHeld(repoId, 'fails', () => Promise.reject(new Error('boom')))).rejects.toThrow('boom')
    expect(await withRepoHeld(repoId, 'again', () => Promise.resolve('done'))).toBe('done')
  })
})

describe('removeKeptHostedRepo', () => {
  it("deletes a moved repo's old repository for its owner, and refuses anyone else or any other repo", async () => {
    const { id } = await movedRepo('removed')
    await expect(removeKeptHostedRepo({ kind: 'local', userId: STRANGER }, id)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(removeKeptHostedRepo(owner, repoId)).rejects.toThrow(/keeps no old repository/)
    await expect(removeKeptHostedRepo(owner, MISSING)).rejects.toMatchObject({ code: 'NOT_FOUND' })

    await removeKeptHostedRepo(owner, id)
    await expect(fs.access(hostedRepoDir(id))).rejects.toThrow()
    expect(await getRepo(id)).toMatchObject({ keepsHostedRepo: false })
    await expect(run(tmp, ['ls-remote', `${origin}/owner/${id}`])).rejects.toThrow(/not found/i)
    await expect(removeKeptHostedRepo(owner, id)).rejects.toThrow(/keeps no old repository/)
  })
})

describe('setDefaultBranchGuard', () => {
  it('records the setting for the owner of a hosted repo and refuses everyone and everything else', async () => {
    await setDefaultBranchGuard(owner, repoId, false)
    expect((await getRepo(repoId))?.guardDefaultBranch).toBe(false)
    await setDefaultBranchGuard(owner, repoId, true)
    expect((await getRepo(repoId))?.guardDefaultBranch).toBe(true)

    await expect(setDefaultBranchGuard({ kind: 'local', userId: STRANGER }, repoId, false))
      .rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(setDefaultBranchGuard(owner, MISSING, false)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    // A user the repo is shared with pushes under its guard, which only its
    // owner sets.
    await shareRepo(owner, repoId, ada)
    await expect(setDefaultBranchGuard({ kind: 'local', userId: ada }, repoId, false)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    const { id: moved } = await movedRepo('moved-guard')
    await expect(setDefaultBranchGuard(owner, moved, false)).rejects.toThrow(/not hosted by yaac/)
  })
})

describe('setDefaultBranch', () => {
  it('points the repository and its main clone at a branch it has, so creates and the guard follow, for its owner only', async () => {
    const id = (await createHostedRepo(BUILT_IN_USER_ID)).id
    await expect(setDefaultBranch(owner, id, 'main')).rejects.toThrow(/has no branch "main"/)

    const work = path.join(tmp, 'retargeted-clone')
    await run(tmp, ['clone', '-q', `${origin}/owner/${id}`, work])
    await run(work, ['commit', '-q', '--allow-empty', '-m', 'first'])
    await run(work, ['push', '-q', 'origin', 'HEAD:main', 'HEAD:develop'])
    await vi.waitFor(async () => expect(await getDefaultBranch(repoDir(id))).toBe('main'), { timeout: 20_000, interval: 100 })

    await setDefaultBranch(owner, id, 'develop')
    expect(await run(tmp, ['ls-remote', '--symref', `${origin}/owner/${id}`, 'HEAD'])).toContain('ref: refs/heads/develop\tHEAD')
    expect(await getDefaultBranch(repoDir(id))).toBe('develop')
    // The guard protects the new default, and no longer the old one.
    await run(work, ['commit', '-q', '--amend', '--allow-empty', '-m', 'rewritten'])
    await expect(run(work, ['push', '-q', '--force', 'origin', 'HEAD:develop'])).rejects.toThrow(/cannot be force-pushed/)
    await run(work, ['push', '-q', '--force', 'origin', 'HEAD:main'])

    await expect(setDefaultBranch(owner, id, 'gone')).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(setDefaultBranch({ kind: 'local', userId: STRANGER }, id, 'main')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(setDefaultBranch(owner, MISSING, 'main')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    const { id: moved } = await movedRepo('moved-default')
    await expect(setDefaultBranch(owner, moved, 'main')).rejects.toThrow(/not hosted by yaac/)
    expect(await getDefaultBranch(repoDir(id))).toBe('develop')

    // A main clone that cannot take the change does not fail it: the
    // repository moves, and a retry brings the clone along.
    const lock = path.join(repoDir(id), '.git', 'refs', 'remotes', 'origin', 'HEAD.lock')
    await fs.writeFile(lock, '')
    await setDefaultBranch(owner, id, 'main')
    expect((await run(hostedRepoDir(id), ['symbolic-ref', 'HEAD'])).trim()).toBe('refs/heads/main')
    expect(await getDefaultBranch(repoDir(id))).toBe('develop')
    await fs.rm(lock)
    await setDefaultBranch(owner, id, 'main')
    expect(await getDefaultBranch(repoDir(id))).toBe('main')
  })
})
