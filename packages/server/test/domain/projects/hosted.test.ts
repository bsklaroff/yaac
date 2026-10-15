import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { createAdaptorServer, type ServerType } from '@hono/node-server'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { installFakeWorkspaceDriver, resetWorkspaceDriver } from '#test/support/fake-driver'
import { git } from '@yaac/test-utils/git'
import { hostedRepoDir, repoDir } from '@yaac/shared/project-paths'
import { ServerError } from '@yaac/shared/errors'
import { BUILT_IN_USER_ID, closeDb, getProjectRow, seeTailnetUser, setProjectShareRevoked } from '#db'
import { getDefaultBranch } from '#domain/git'
import {
  createHostedProject,
  serveHostedRepo,
  setDefaultBranchGuard,
  shareProject,
} from '#domain/projects'

/**
 * Fixture: one hosted project, and a listener that hands every request to
 * `serveHostedRepo` as the caller its URL names, so a real git client
 * clones and pushes through the same handler the routes use:
 *   /owner/<project>/…        the project's owner
 *   /stranger/<project>/…     another user
 *   /ada/<project>/…          a user `shareProject` can share with
 *   /ws/<caller project>/<project>/…  a workspace of <caller project>
 */

type HostedRepoCaller = Parameters<typeof serveHostedRepo>[3]

let tmp: string
let server: ServerType
let origin: string
let projectId: string
let ada: string
const OTHER_PROJECT = '0a0a0a0a-0000-4000-8000-0000000000ff'
const STRANGER = '0a0a0a0a-0000-4000-8000-0000000000aa'
const ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t' }

const run = (dir: string, args: string[]): Promise<string> => git(dir, args, { env: ENV })

function callerFor(segments: string[]): { caller: HostedRepoCaller; rest: string[] } {
  if (segments[0] === 'owner') return { caller: { kind: 'user', principal: { kind: 'local', userId: BUILT_IN_USER_ID } }, rest: segments.slice(1) }
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
    return new Response(code, { status: code === 'FORBIDDEN' ? 403 : code === 'NOT_FOUND' ? 404 : 500 })
  }
}

/** Wait for the post-push fetch to bring the main clone's `origin/<branch>`
 *  to `sha`. */
async function mainCloneSees(branch: string, sha: string, project = projectId): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    const at = await run(repoDir(project), ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`]).catch(() => '')
    if (at.trim() === sha) return
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error(`main clone never saw origin/${branch} at ${sha}`)
}

beforeAll(async () => {
  tmp = await createTempDataDir()
  installFakeWorkspaceDriver({ list: () => Promise.resolve([]) })
  projectId = (await createHostedProject('Hosted App', BUILT_IN_USER_ID)).id
  ada = await seeTailnetUser('ada@example.com', 'Ada')
  server = createAdaptorServer({ fetch: handle })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
})

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve))
  resetWorkspaceDriver()
  await closeDb()
  await cleanupTempDir(tmp)
})

describe('serveHostedRepo', () => {
  it('lets the owner clone the empty remote and push, and fetches each push into the main clone', async () => {
    const work = path.join(tmp, 'owner-clone')
    await run(tmp, ['clone', '-q', `${origin}/owner/${projectId}`, work])
    await run(work, ['commit', '-q', '--allow-empty', '-m', 'first'])
    await run(work, ['push', '-q', 'origin', 'HEAD:main'])

    const tip = (await run(work, ['rev-parse', 'HEAD'])).trim()
    expect((await run(hostedRepoDir(projectId), ['rev-parse', 'main'])).trim()).toBe(tip)
    await mainCloneSees('main', tip)
  })

  it('lets a workspace read and push its own project only', async () => {
    const work = path.join(tmp, 'ws-clone')
    await run(tmp, ['clone', '-q', `${origin}/ws/${projectId}/${projectId}`, work])
    await run(work, ['commit', '-q', '--allow-empty', '-m', 'from a workspace'])
    await run(work, ['push', '-q', 'origin', 'HEAD:agent/one'])
    await mainCloneSees('agent/one', (await run(work, ['rev-parse', 'HEAD'])).trim())

    await expect(run(tmp, ['ls-remote', `${origin}/ws/${OTHER_PROJECT}/${projectId}`])).rejects.toThrow(/403/)
  })

  it('lets any user read but only the owner push', async () => {
    const work = path.join(tmp, 'stranger-clone')
    await run(tmp, ['clone', '-q', `${origin}/stranger/${projectId}`, work])
    await run(work, ['commit', '-q', '--allow-empty', '-m', 'not mine'])
    await expect(run(work, ['push', '-q', 'origin', 'HEAD:main'])).rejects.toThrow(/403/)
  })

  it('answers only the smart-HTTP paths, and only for a hosted project', async () => {
    expect((await fetch(`${origin}/owner/${projectId}/HEAD`)).status).toBe(404)
    expect((await fetch(`${origin}/owner/${projectId}/config`)).status).toBe(404)
    expect((await fetch(`${origin}/owner/${OTHER_PROJECT}/info/refs?service=git-upload-pack`)).status).toBe(404)
    // Not an id at all: missing, never a database error.
    expect((await fetch(`${origin}/owner/73adefe9/info/refs?service=git-upload-pack`)).status).toBe(404)
  })

  it('takes its default branch from the first push when that is not main, and guards it', async () => {
    const other = (await createHostedProject('legacy', BUILT_IN_USER_ID)).id
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
    await setDefaultBranchGuard({ kind: 'local', userId: BUILT_IN_USER_ID }, projectId, false)
    try {
      await expect(run(work, ['push', '-q', 'origin', 'HEAD:refs/heads/HEAD'])).rejects.toThrow(/may not be named HEAD/)
    } finally {
      await setDefaultBranchGuard({ kind: 'local', userId: BUILT_IN_USER_ID }, projectId, true)
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
    expect((await run(hostedRepoDir(projectId), ['rev-parse', 'main'])).trim()).toBe(before)

    await setDefaultBranchGuard({ kind: 'local', userId: BUILT_IN_USER_ID }, projectId, false)
    await run(work, ['push', '-q', '--force', 'origin', 'HEAD:main'])
    const after = (await run(work, ['rev-parse', 'HEAD'])).trim()
    expect((await run(hostedRepoDir(projectId), ['rev-parse', 'main'])).trim()).toBe(after)
    // The rewound tip stays recoverable from the remote's reflog.
    expect(await run(hostedRepoDir(projectId), ['reflog', 'show', '--format=%H', 'main'])).toContain(before)
    await setDefaultBranchGuard({ kind: 'local', userId: BUILT_IN_USER_ID }, projectId, true)
  })

  it("lets a share's owner and workspaces push the source's repository, into every main clone on it, until the share is removed", async () => {
    const share = (await shareProject({ kind: 'local', userId: BUILT_IN_USER_ID }, projectId, ada)).id
    const work = path.join(tmp, 'ada-clone')
    await run(tmp, ['clone', '-q', `${origin}/ada/${share}`, work])
    await run(work, ['commit', '-q', '--allow-empty', '-m', 'from ada'])
    await run(work, ['push', '-q', 'origin', 'HEAD:ada/one'])

    const tip = (await run(work, ['rev-parse', 'HEAD'])).trim()
    expect((await run(hostedRepoDir(projectId), ['rev-parse', 'ada/one'])).trim()).toBe(tip)
    await mainCloneSees('ada/one', tip, projectId)
    await mainCloneSees('ada/one', tip, share)
    await run(tmp, ['ls-remote', `${origin}/ws/${share}/${share}`])
    // The share is its owner's: the source's owner pushes through their own.
    await expect(run(work, ['push', '-q', `${origin}/owner/${share}`, 'HEAD:ada/two'])).rejects.toThrow(/403/)

    await setProjectShareRevoked(share, true)
    await expect(run(work, ['push', '-q', 'origin', 'HEAD:ada/two'])).rejects.toThrow(/403/)
    await expect(run(tmp, ['ls-remote', `${origin}/ws/${share}/${share}`])).rejects.toThrow(/403/)
  })
})

describe('setDefaultBranchGuard', () => {
  it('records the setting for the owner of a hosted project and refuses everyone and everything else', async () => {
    const owner = { kind: 'local' as const, userId: BUILT_IN_USER_ID }
    await setDefaultBranchGuard(owner, projectId, false)
    expect((await getProjectRow(projectId))?.guardDefaultBranch).toBe(false)
    await setDefaultBranchGuard(owner, projectId, true)
    expect((await getProjectRow(projectId))?.guardDefaultBranch).toBe(true)

    await expect(setDefaultBranchGuard({ kind: 'local', userId: STRANGER }, projectId, false))
      .rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(setDefaultBranchGuard(owner, OTHER_PROJECT, false)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    // A share pushes under its source's guard, which only the source's owner sets.
    const share = (await shareProject(owner, projectId, await seeTailnetUser('bo@example.com', 'Bo'))).id
    const bo = (await getProjectRow(share))?.owner ?? ''
    await expect(setDefaultBranchGuard({ kind: 'local', userId: bo }, share, false)).rejects.toMatchObject({ code: 'VALIDATION' })
  })
})
