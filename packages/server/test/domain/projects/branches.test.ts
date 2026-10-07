import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { setDataDir, projectDir, repoDir } from '@yaac/shared/project-paths'
import { getProjectBranches } from '#domain/projects'
import { cloneRepo } from '#domain/git'
import { BUILT_IN_USER_ID, recordProject } from '#db'
import { git } from '@yaac/test-utils/git'
import { DEMO_PROJECT_ID } from '@yaac/test-utils/project-fixture'

const execFileAsync = promisify(execFile)

describe('getProjectBranches', () => {
  let tmp: string
  let sourceRepo: string
  const projectId = DEMO_PROJECT_ID

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-branches-test-'))
    setDataDir(tmp)
    sourceRepo = path.join(tmp, 'source')
    // A refresh fetches from the row's remote, a local path here.
    await fs.mkdir(projectDir(projectId), { recursive: true })
    await recordProject({ id: projectId, name: 'demo', remoteUrl: sourceRepo, addedAt: '2026-01-01T00:00:00.000Z' }, BUILT_IN_USER_ID)

    await fs.mkdir(sourceRepo, { recursive: true })
    await git(sourceRepo, ['init', '-b', 'main'])
    await git(sourceRepo, ['config', 'user.email', 'test@test.com'])
    await git(sourceRepo, ['config', 'user.name', 'Test'])
    await fs.writeFile(path.join(sourceRepo, 'hello.txt'), 'hello\n')
    await git(sourceRepo, ['add', '.'])
    await git(sourceRepo, ['commit', '-m', 'initial'])
    await git(sourceRepo, ['branch', 'develop'])

    await cloneRepo(sourceRepo, repoDir(projectId), null)
  })

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true })
  })

  it('returns branches and the default branch', async () => {
    const result = await getProjectBranches(projectId)
    expect(result.branches).toContain('main')
    expect(result.branches).toContain('develop')
    expect(result.branches).not.toContain('HEAD')
    expect(result.defaultBranch).toBe('main')
  })

  it('refresh picks up a branch pushed after the clone', async () => {
    await git(sourceRepo, ['branch', 'feature/new'])

    expect((await getProjectBranches(projectId)).branches).not.toContain('feature/new')
    const refreshed = await getProjectBranches(projectId, { refresh: true })
    expect(refreshed.branches).toContain('feature/new')
  })

  it('surfaces a failed refresh as INTERNAL, keeping the message', async () => {
    await fs.rm(sourceRepo, { recursive: true, force: true })

    const attempt = getProjectBranches(projectId, { refresh: true })
    await expect(attempt).rejects.toMatchObject({ code: 'INTERNAL' })
    await expect(attempt).rejects.toThrow(/could not fetch from remote/)

    // A non-refresh read still works off the local refs.
    expect((await getProjectBranches(projectId)).branches).toContain('main')
  })

  it('refreshes from the row\'s remote, not the one the clone names', async () => {
    // A pod can rewrite the shared clone's origin; the refresh must not follow it.
    await execFileAsync('git', ['-C', repoDir(projectId), 'remote', 'set-url', 'origin', path.join(tmp, 'nowhere')])
    await git(sourceRepo, ['branch', 'feature/new'])

    expect((await getProjectBranches(projectId, { refresh: true })).branches).toContain('feature/new')
  })

  it('surfaces a rejected credential as VALIDATION, pointing at Settings', async () => {
    // git's `ext::` transport runs a command as the wire protocol, so a stub
    // can print the stderr isGitAuthError matches, with no network.
    const stub = path.join(tmp, 'reject-auth.sh')
    await fs.writeFile(stub, '#!/bin/sh\necho "fatal: Authentication failed for xyz" >&2\nexit 128\n')
    await fs.chmod(stub, 0o755)
    // The fetch takes its URL, and so its transport, from the row.
    await recordProject({ id: projectId, name: 'demo', remoteUrl: `ext::${stub}`, addedAt: '2026-01-01T00:00:00.000Z' }, BUILT_IN_USER_ID)

    await expect(getProjectBranches(projectId, { refresh: true })).rejects.toMatchObject({
      code: 'VALIDATION',
      message: expect.stringMatching(/Settings/) as string,
    })
  })

})
