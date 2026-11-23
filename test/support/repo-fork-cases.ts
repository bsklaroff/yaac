import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import path from 'node:path'
import { runYaac, type RunYaacOptions } from '#support/cli'
import { cleanupMocks, seedMockGitRepo, type MockGit } from '#support/mock-remotes'
import { git } from '@yaac/test-utils/git'

/** What the repo-fork cases need from the file that runs them. */
export interface ForkRig {
  env: () => NodeJS.ProcessEnv
  port: () => number
  scratchDir: () => string
}

/**
 * The repo-fork cases (docs/repo-forks.md), run by both e2e tiers: under
 * containerless against a mock git server on the host, and under k8s
 * against one in the cluster, the only run where a cluster server's push
 * probes, forks and hosted moves reach a remote through the cluster. The
 * calling file's server must hold the `fake-github` credential.
 */
export function describeRepoForks(rig: ForkRig, startGit: () => Promise<MockGit>): void {
  describe('repo forks: project add and move, repo read-only and upstream, config upstream-rebase (real CLI + real server)', () => {
    /** Remotes under BASE are served by the mock git server: `tool` and
     *  `app` refuse the credential a push, `up` and `up2` let a push's probe
     *  through, and the rest answer nothing about it. */
    const BASE = 'https://git.e2e.test/forks/'
    const url = (name: string): string => `${BASE}${name}.git`
    const yaac = (...args: Array<string | RunYaacOptions>): ReturnType<typeof runYaac> => runYaac(rig.env(), ...args)
    const repos = async (): Promise<Array<{ id: string; remoteUrl: string; hosted: boolean; readOnly: boolean; upstreamRepoId?: string }>> =>
      await (await fetch(`http://127.0.0.1:${String(rig.port())}/api/repo/list`)).json() as never
    const repoOf = async (remoteUrl: string): Promise<{ id: string; upstreamRepoId?: string; readOnly: boolean }> => {
      const found = (await repos()).find((r) => r.remoteUrl === remoteUrl)
      if (!found) throw new Error(`no repo for ${remoteUrl}`)
      return found
    }
    let mockGit: MockGit

    beforeAll(async () => {
      mockGit = await startGit()
      await mockGit.serveServerFetches(rig.env(), BASE)
      for (const name of ['tool', 'app']) await seedMockGitRepo(mockGit, name, { files: { 'README.md': name }, push: 'refuse' })
      for (const name of ['up', 'up2']) await seedMockGitRepo(mockGit, name, { files: { 'README.md': name }, push: 'advertise' })
      for (const name of ['lib2', 'extra']) await seedMockGitRepo(mockGit, name, { files: { 'README.md': name } })
    })

    afterAll(async () => {
      await cleanupMocks([mockGit])
    })

    it('project add refuses a remote the credential cannot push to, naming --fork and --read-only, which add it', async () => {
      const refused = await yaac('project', 'add', url('tool'), 'fake-github')
      expect(refused.exitCode).not.toBe(0)
      expect(refused.stdout + refused.stderr).toMatch(/You can't push to git.e2e.test\/forks\/tool with "fake-github"[\s\S]*--fork[\s\S]*--read-only/)

      // Read-only needs no credential for a public https remote.
      const readOnly = await yaac('project', 'add', url('tool'), '--read-only')
      expect(readOnly.exitCode, readOnly.stderr).toBe(0)
      expect((await repoOf(url('tool'))).readOnly).toBe(true)
      expect((await yaac('repo', 'list')).stdout).toMatch(/read-only/)

      const fork = await yaac('project', 'add', url('app'), 'fake-github', '--fork')
      expect(fork.exitCode, fork.stderr).toBe(0)
      expect(fork.stdout).toContain('Project "app"')
      const upstream = await repoOf(url('app'))
      expect(upstream.readOnly).toBe(true)
      expect((await repos()).find((r) => r.upstreamRepoId === upstream.id)?.hosted).toBe(true)
      expect((await yaac('repo', 'upstream', 'app/app')).stdout).toContain(`is a fork of ${url('app')}`)
    })

    it('project add takes an upstream, with its credential, or adds around a repo by id', async () => {
      const added = await yaac('project', 'add', url('lib2'), 'fake-github', '--upstream', url('up'), '--upstream-credential', 'fake-github')
      expect(added.exitCode, added.stderr).toBe(0)
      const up = await repoOf(url('up'))
      expect((await repoOf(url('lib2'))).upstreamRepoId).toBe(up.id)
      // Its credential can push there, so it is not read-only.
      expect(up.readOnly).toBe(false)

      const around = await yaac('project', 'add', '--repo-id', up.id)
      expect(around.exitCode, around.stderr).toBe(0)
      expect(around.stdout).toContain('Project "up"')
    })

    it('project repo add takes --read-only, --fork and --upstream with its credential', async () => {
      const readOnly = await yaac('project', 'repo', 'add', 'lib2', url('extra'), '--read-only')
      expect(readOnly.exitCode, readOnly.stderr).toBe(0)
      expect((await repoOf(url('extra'))).readOnly).toBe(true)
      const fork = await yaac('project', 'repo', 'add', 'up', url('app'), '--fork', '--dir', 'app-fork')
      expect(fork.exitCode, fork.stderr).toBe(0)
      // A second fork of the same upstream.
      const appUpstream = await repoOf(url('app'))
      expect((await repos()).filter((r) => r.upstreamRepoId === appUpstream.id)).toHaveLength(2)
      const withUpstream = await yaac('project', 'repo', 'add', 'up', url('tool'), 'fake-github', '--upstream', url('up2'), '--upstream-credential', 'fake-github')
      expect(withUpstream.exitCode, withUpstream.stderr).toBe(0)
      expect((await repoOf(url('tool'))).upstreamRepoId).toBe((await repoOf(url('up2'))).id)
    })

    it('repo read-only and repo upstream show and set a repo\'s', async () => {
      expect((await yaac('repo', 'read-only', url('extra'))).stdout).toContain('is read-only')
      expect((await yaac('repo', 'read-only', url('extra'), 'off')).stdout).toContain('now can be pushed to by workspaces')
      expect((await repoOf(url('extra'))).readOnly).toBe(false)
      expect((await yaac('repo', 'read-only', url('extra'), 'on')).exitCode).toBe(0)

      expect((await yaac('repo', 'upstream', url('lib2'))).stdout).toContain(`is a fork of ${url('up')}`)
      const none = await yaac('repo', 'upstream', url('lib2'), '--none')
      expect(none.stdout).toContain('has no upstream now')
      expect((await repoOf(url('lib2'))).upstreamRepoId).toBeUndefined()
      const set = await yaac('repo', 'upstream', url('lib2'), url('extra'), 'fake-github')
      expect(set.exitCode, set.stderr).toBe(0)
      expect((await repoOf(url('lib2'))).upstreamRepoId).toBe((await repoOf(url('extra'))).id)
    })

    it('config upstream-rebase shows and sets whether a hosted fork lets a rebase onto its upstream through', async () => {
      expect((await yaac('config', 'upstream-rebase', 'app')).stdout).toContain('lets a rebase of its default branch onto the upstream through')
      expect((await yaac('config', 'upstream-rebase', 'app', 'off', '--repo', 'app')).stdout).toContain('now refuses every rewrite')
      expect((await yaac('config', 'upstream-rebase', 'app', 'on')).exitCode).toBe(0)
      expect((await yaac('config', 'upstream-rebase', 'lib2', '--repo', 'lib2')).stdout).toContain('not a fork yaac hosts')
    })

    it('project move --hosted moves a repo onto yaac, asking first unless --yes', async () => {
      const unconfirmed = await yaac('project', 'move', 'lib2', '--repo', 'lib2', '--hosted')
      expect(unconfirmed.exitCode).toBe(1)
      expect(unconfirmed.stderr).toContain('No terminal to confirm on; pass --yes')
      const moved = await yaac('project', 'move', 'lib2', '--repo', 'lib2', '--hosted', '-y')
      expect(moved.exitCode, moved.stderr).toBe(0)
      expect(moved.stdout).toContain(`is now hosted by yaac, a fork of ${url('lib2')}`)
      const upstream = await repoOf(url('lib2'))
      expect((await repos()).find((r) => r.upstreamRepoId === upstream.id)?.hosted).toBe(true)
    })

    it('project move --upstream lists the branches that need a choice, and takes --push, --push-all and --leave-rest', async () => {
      expect((await yaac('project', 'add', url('up2'), 'fake-github', '--fork')).exitCode).toBe(0)
      // The fork's main gets a commit of its own, so it needs a choice.
      const clone = path.join(rig.scratchDir(), 'up2-fork')
      expect((await yaac('project', 'clone', 'up2', clone)).exitCode).toBe(0)
      await git(clone, ['-c', 'user.name=T', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'the fork adds'])
      await git(clone, ['push', '-q', 'origin', 'HEAD:main'])

      const unchosen = await yaac('project', 'move', 'up2', '--upstream', '--yes')
      expect(unchosen.exitCode).toBe(1)
      expect(unchosen.stderr + unchosen.stdout).toMatch(/need a choice[\s\S]*main\s+ahead/)
      // The mock serves no pushes, so each move reaches the push and stays.
      for (const choice of [['--push', 'main', '--leave-rest'], ['--push-all'], ['--push', 'main=from-fork']]) {
        const attempt = await yaac('project', 'move', 'up2', '--upstream', ...choice, '--yes')
        expect(attempt.exitCode).not.toBe(0)
        expect(attempt.stdout + attempt.stderr).toMatch(/refused the push[\s\S]*stays where it was/)
      }
    })
  })
}
