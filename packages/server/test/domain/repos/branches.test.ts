import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { repoDir } from '@yaac/shared/project-paths'
import { getRepoBranches } from '#domain/repos'
import { cloneRepo } from '#domain/git'
import { BUILT_IN_USER_ID, closeDb, insertRepo, markRepoDeleted } from '#db'
import { git } from '@yaac/test-utils/git'

describe('getRepoBranches', () => {
  let tmp: string
  let sourceRepo: string
  const repoId = '7d4e2a1c-5b3f-4e8a-9c6d-1f2e3a4b5c6d'

  /** A repo row for `remoteUrl` whose main clone is a clone of the source. */
  async function repoAt(id: string, remoteUrl: string): Promise<void> {
    await insertRepo({ id, owner: BUILT_IN_USER_ID, remoteUrl })
    await cloneRepo(sourceRepo, repoDir(id), null)
  }

  beforeEach(async () => {
    tmp = await createTempDataDir()
    sourceRepo = path.join(tmp, 'source')
    await fs.mkdir(sourceRepo, { recursive: true })
    await git(sourceRepo, ['init', '-b', 'main'])
    await git(sourceRepo, ['config', 'user.email', 'test@test.com'])
    await git(sourceRepo, ['config', 'user.name', 'Test'])
    await fs.writeFile(path.join(sourceRepo, 'hello.txt'), 'hello\n')
    await git(sourceRepo, ['add', '.'])
    await git(sourceRepo, ['commit', '-m', 'initial'])
    await git(sourceRepo, ['branch', 'develop'])
    // A refresh fetches from the row's remote, a local path here.
    await repoAt(repoId, sourceRepo)
  })

  afterEach(async () => {
    await closeDb()
    await cleanupTempDir(tmp)
  })

  it('returns branches and the default branch', async () => {
    const result = await getRepoBranches(repoId)
    expect(result.branches).toContain('main')
    expect(result.branches).toContain('develop')
    expect(result.branches).not.toContain('HEAD')
    expect(result.defaultBranch).toBe('main')
  })

  it('refresh picks up a branch pushed after the clone', async () => {
    await git(sourceRepo, ['branch', 'feature/new'])

    expect((await getRepoBranches(repoId)).branches).not.toContain('feature/new')
    const refreshed = await getRepoBranches(repoId, { refresh: true })
    expect(refreshed.branches).toContain('feature/new')
  })

  it('surfaces a failed refresh as INTERNAL, keeping the message', async () => {
    await fs.rm(sourceRepo, { recursive: true, force: true })

    const attempt = getRepoBranches(repoId, { refresh: true })
    await expect(attempt).rejects.toMatchObject({ code: 'INTERNAL' })
    await expect(attempt).rejects.toThrow(/could not fetch from remote/)

    // A non-refresh read still works off the local refs.
    expect((await getRepoBranches(repoId)).branches).toContain('main')
  })

  it('refreshes from the row\'s remote, not the one the clone names', async () => {
    // A pod can rewrite the shared clone's origin; the refresh must not follow it.
    await git(repoDir(repoId), ['remote', 'set-url', 'origin', path.join(tmp, 'nowhere')])
    await git(sourceRepo, ['branch', 'feature/new'])

    expect((await getRepoBranches(repoId, { refresh: true })).branches).toContain('feature/new')
  })

  it('surfaces a rejected credential as VALIDATION, pointing at Settings', async () => {
    // git's `ext::` transport runs a command as the wire protocol, so a stub
    // can print the stderr isGitAuthError matches, with no network. The
    // fetch takes its URL, and so its transport, from the row.
    const stub = path.join(tmp, 'reject-auth.sh')
    await fs.writeFile(stub, '#!/bin/sh\necho "fatal: Authentication failed for xyz" >&2\nexit 128\n')
    await fs.chmod(stub, 0o755)
    const rejected = '4a2f1d3b-0c9e-4f8a-b7d6-1e2f3a4b5c6d'
    await repoAt(rejected, `ext::${stub}`)

    await expect(getRepoBranches(rejected, { refresh: true })).rejects.toMatchObject({
      code: 'VALIDATION',
      message: expect.stringMatching(/Settings/) as string,
    })
  })

  it('refuses to refresh a deleted repo, but still reads its local refs', async () => {
    await markRepoDeleted(repoId)
    await expect(getRepoBranches(repoId, { refresh: true })).rejects.toMatchObject({ code: 'VALIDATION' })
    expect((await getRepoBranches(repoId)).branches).toContain('main')
  })
})
