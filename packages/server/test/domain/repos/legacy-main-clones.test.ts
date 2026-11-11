import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { git, stagingBeside } from '@yaac/test-utils/git'
import { recordTestProject } from '@yaac/test-utils/project-fixture'
import { handleFixture, installFakeWorkspaceDriver } from '#test/support/fake-driver'
import { claudeDir, legacyRepoDir, repoDir } from '@yaac/shared/project-paths'
import { closeDb, linkProjectRepo } from '#db'
import { cloneRepo, createCheckout } from '#domain/git'
import { moveLegacyMainClones } from '#domain/repos'

/**
 * Fixture, as an install from before repos were rows leaves it: a project
 * whose repo carries its id, a project that was a share of it and so links
 * that same repo, each with a main clone under its own project dir, and a
 * project with no repo at all.
 */
const SOURCE = '0a0a0a0a-0000-4000-8000-000000000001'
const SHARE = '0a0a0a0a-0000-4000-8000-000000000002'
const EMPTY = '0a0a0a0a-0000-4000-8000-000000000003'

let tmp: string
let remote: string
let checkout: string
let onlyInShare: string

const tip = async (repo: string, ref: string): Promise<string> => (await git(repo, ['rev-parse', ref])).trim()
const isLinkTo = async (link: string, target: string): Promise<boolean> =>
  (await fs.lstat(link)).isSymbolicLink() && await fs.realpath(link) === await fs.realpath(target)

beforeAll(async () => {
  tmp = await createTempDataDir()
  remote = path.join(tmp, 'remote')
  await fs.mkdir(remote)
  await git(remote, ['init', '-q', '-b', 'main'])
  await git(remote, ['-c', 'user.email=t@t', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', 'initial'])
  await recordTestProject(SOURCE, { remoteUrl: remote })
  await recordTestProject(SHARE, { repo: false })
  await linkProjectRepo(SHARE, SOURCE, 'app')
  await recordTestProject(EMPTY, { repo: false })
  await cloneRepo(remote, legacyRepoDir(SOURCE), null)
  // A branch only the share's clone ever fetched: the remote has since
  // deleted it.
  await git(remote, ['checkout', '-q', '-b', 'short-lived'])
  await git(remote, ['-c', 'user.email=t@t', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', 'short-lived'])
  onlyInShare = await tip(remote, 'short-lived')
  await cloneRepo(remote, legacyRepoDir(SHARE), null)
  await git(remote, ['checkout', '-q', 'main'])
  await git(remote, ['branch', '-q', '-D', 'short-lived'])
  // Each project's one claude memory, as it was named then.
  for (const projectId of [SOURCE, SHARE]) {
    await fs.mkdir(path.join(claudeDir(projectId), 'projects', '-repo', 'memory'), { recursive: true })
    await fs.writeFile(path.join(claudeDir(projectId), 'projects', '-repo', 'memory', 'MEMORY.md'), projectId)
  }
  // A checkout made before the upgrade borrows through the old path.
  checkout = path.join(tmp, 'checkout')
  await createCheckout(legacyRepoDir(SOURCE), checkout, {
    staging: stagingBeside(checkout), branch: 'agent/w', baseBranch: 'main', remoteUrl: remote,
  })
})

afterAll(async () => {
  await closeDb()
  await cleanupTempDir(tmp)
})

describe('moveLegacyMainClones', () => {
  it('moves a clone to its repo, absorbs a former share\'s once none of its workspaces runs, and leaves links behind', async () => {
    const running = handleFixture({ workspaceId: 'w-share', projectId: SHARE })
    let live = [running]
    const driver = { list: (projectId?: string) => Promise.resolve(live.filter((h) => h.projectId === projectId)) }
    installFakeWorkspaceDriver(driver)
    const sourceTip = await tip(legacyRepoDir(SOURCE), 'origin/main')

    await moveLegacyMainClones()

    // The project's own clone is its repo's now, reached through the old path.
    expect(await tip(repoDir(SOURCE), 'origin/main')).toBe(sourceTip)
    expect(await isLinkTo(legacyRepoDir(SOURCE), repoDir(SOURCE))).toBe(true)
    expect((await git(checkout, ['log', '-1', '--format=%s'])).trim()).toBe('initial')
    // The share's stays while a workspace of it runs: a pod mounts it.
    expect((await fs.lstat(legacyRepoDir(SHARE))).isDirectory()).toBe(true)
    await expect(git(repoDir(SOURCE), ['cat-file', '-e', onlyInShare])).rejects.toThrow()

    live = []
    installFakeWorkspaceDriver(driver)
    await moveLegacyMainClones()

    // Nothing the share's clone held is lost, and its old path is the repo's.
    await git(repoDir(SOURCE), ['cat-file', '-e', onlyInShare])
    expect(await isLinkTo(legacyRepoDir(SHARE), repoDir(SOURCE))).toBe(true)
    // The links are relative, so they survive the data dir moving.
    expect(path.isAbsolute(await fs.readlink(legacyRepoDir(SHARE)))).toBe(false)
    expect(path.isAbsolute(await fs.readlink(legacyRepoDir(SOURCE)))).toBe(false)
    expect(await tip(repoDir(SOURCE), 'origin/main')).toBe(sourceTip)
    await expect(fs.access(legacyRepoDir(EMPTY))).rejects.toThrow()

    // Each project's memory is its repo's now (a former share's is the
    // repo it links), still reached through the old name.
    for (const projectId of [SOURCE, SHARE]) {
      const projects = path.join(claudeDir(projectId), 'projects')
      expect(await fs.readFile(path.join(projects, `-repo-${SOURCE}`, 'memory', 'MEMORY.md'), 'utf8')).toBe(projectId)
      expect(await isLinkTo(path.join(projects, '-repo'), path.join(projects, `-repo-${SOURCE}`))).toBe(true)
    }

    // Done: another start changes nothing, but for a link a start that died
    // after its rename never made.
    await fs.unlink(legacyRepoDir(SOURCE))
    await moveLegacyMainClones()
    expect(await isLinkTo(legacyRepoDir(SOURCE), repoDir(SOURCE))).toBe(true)
    expect(await isLinkTo(legacyRepoDir(SHARE), repoDir(SOURCE))).toBe(true)
  })
})
