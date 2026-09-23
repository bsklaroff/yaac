import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { setDataDir, projectDir, repoDir } from '@yaac/shared/project-paths'
import { getProjectBranches, setProjectReferenceBranch } from '#domain/projects'
import { cloneRepo } from '#domain/git'
import { recordProject } from '#db'
import { git } from '@yaac/test-utils/git'

const execFileAsync = promisify(execFile)

describe('getProjectBranches', () => {
  let tmp: string
  let sourceRepo: string
  const slug = 'proj'

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-branches-test-'))
    setDataDir(tmp)
    sourceRepo = path.join(tmp, 'source')
    // The row's remote is the one a refresh fetches from — a local path here.
    await fs.mkdir(projectDir(slug), { recursive: true })
    await fs.writeFile(path.join(projectDir(slug), 'project.json'), JSON.stringify({
      slug, remoteUrl: sourceRepo, addedAt: '2026-01-01T00:00:00.000Z',
    }))

    await fs.mkdir(sourceRepo, { recursive: true })
    await git(sourceRepo, ['init', '-b', 'main'])
    await git(sourceRepo, ['config', 'user.email', 'test@test.com'])
    await git(sourceRepo, ['config', 'user.name', 'Test'])
    await fs.writeFile(path.join(sourceRepo, 'hello.txt'), 'hello\n')
    await git(sourceRepo, ['add', '.'])
    await git(sourceRepo, ['commit', '-m', 'initial'])
    await git(sourceRepo, ['branch', 'develop'])

    await cloneRepo(sourceRepo, repoDir(slug), null)
  })

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true })
  })

  it('returns branches, the default branch, and a null referenceBranch when unset', async () => {
    const result = await getProjectBranches(slug)
    expect(result.branches).toContain('main')
    expect(result.branches).toContain('develop')
    expect(result.branches).not.toContain('HEAD')
    expect(result.defaultBranch).toBe('main')
    expect(result.referenceBranch).toBeNull()
  })

  it('surfaces the configured referenceBranch', async () => {
    await setProjectReferenceBranch(slug, 'develop')
    const result = await getProjectBranches(slug)
    expect(result.referenceBranch).toBe('develop')
  })

  it('refresh picks up a branch pushed after the clone', async () => {
    await git(sourceRepo, ['branch', 'feature/new'])

    expect((await getProjectBranches(slug)).branches).not.toContain('feature/new')
    const refreshed = await getProjectBranches(slug, { refresh: true })
    expect(refreshed.branches).toContain('feature/new')
  })

  it('surfaces a failed refresh as INTERNAL, keeping the message', async () => {
    await fs.rm(sourceRepo, { recursive: true, force: true })

    const attempt = getProjectBranches(slug, { refresh: true })
    await expect(attempt).rejects.toMatchObject({ code: 'INTERNAL' })
    await expect(attempt).rejects.toThrow(/could not fetch from remote/)

    // The instant (non-refresh) read still works off the local refs.
    expect((await getProjectBranches(slug)).branches).toContain('main')
  })

  it('refreshes from the row\'s remote, not the one the clone names', async () => {
    // A pod can rewrite the shared clone's origin; the refresh must not follow it.
    await execFileAsync('git', ['-C', repoDir(slug), 'remote', 'set-url', 'origin', path.join(tmp, 'nowhere')])
    await git(sourceRepo, ['branch', 'feature/new'])

    expect((await getProjectBranches(slug, { refresh: true })).branches).toContain('feature/new')
  })

  it('surfaces a rejected credential as AUTH_REQUIRED, pointing at auth update', async () => {
    // git's `ext::` transport runs an arbitrary command as the wire protocol,
    // so a stub can produce the exact stderr a real rejected credential does
    // — the string isGitAuthError classifies on — with no network.
    const stub = path.join(tmp, 'reject-auth.sh')
    await fs.writeFile(stub, '#!/bin/sh\necho "fatal: Authentication failed for xyz" >&2\nexit 128\n')
    await fs.chmod(stub, 0o755)
    // The row is the only place a fetch's URL comes from; the transport it
    // names is the one transport the fetch may use.
    await recordProject({ slug, remoteUrl: `ext::${stub}`, addedAt: '2026-01-01T00:00:00.000Z' })

    await expect(getProjectBranches(slug, { refresh: true })).rejects.toMatchObject({
      code: 'AUTH_REQUIRED',
    })
  })

})
