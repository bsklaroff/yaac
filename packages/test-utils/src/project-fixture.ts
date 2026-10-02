import fs from 'node:fs/promises'
import { vi } from 'vitest'
import { insertGitCredential, recordProject, setGitIdentity, setProjectGitCredential } from '@yaac/server/db'
import { projectDir, repoDir } from '@yaac/shared/project-paths'
import type { ProjectMeta } from '@yaac/shared/types'
import { git } from './git.js'
import { createTestRepo } from './setup.js'

/** A recorded project and its directory, with nothing cloned into it. */
export async function recordTestProject(slug: string, meta: Partial<ProjectMeta> = {}): Promise<void> {
  await fs.mkdir(projectDir(slug), { recursive: true })
  await recordProject({ slug, remoteUrl: `https://example.com/${slug}`, addedAt: '2026-01-01T00:00:00.000Z', ...meta })
}

/**
 * A project a create can run to completion against with no network, under
 * the current temp data dir: a main clone whose `origin/main` and
 * `origin/dev` are set locally, an HTTPS GitHub remote with a credential,
 * and a server git identity. Stubs `YAAC_E2E_SKIP_FETCH`, so the caller's
 * teardown must call `vi.unstubAllEnvs()`.
 */
export async function seedProject(slug = 'demo'): Promise<void> {
  vi.stubEnv('YAAC_E2E_SKIP_FETCH', '1')
  const repo = repoDir(slug)
  await createTestRepo(repo)
  await git(repo, ['branch', '-M', 'main'])
  for (const branch of ['main', 'dev']) {
    await git(repo, ['update-ref', `refs/remotes/origin/${branch}`, 'HEAD'])
  }
  await git(repo, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main'])
  await recordTestProject(slug, { remoteUrl: 'https://github.com/o/r.git' })
  await setGitIdentity({ name: 'Ada', email: 'ada@example.com' })
  const cred = await insertGitCredential({ name: 'gh', kind: 'https', secret: 'ghp_x' })
  await setProjectGitCredential(slug, cred.id, null)
}
