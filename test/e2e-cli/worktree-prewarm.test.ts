import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import simpleGit from 'simple-git'
import { cloneRepo, worktreeUpstreamBranch } from '@yaac/server/domain/git'
import { listWorktreePods, isPrewarmed } from '@yaac/server/drivers/k8s/substrate/pods'
import { listActiveWorktrees } from '@yaac/server/domain/worktrees/list'
import { listProjects } from '@yaac/server/domain/projects/list'
import { isTmuxSessionAlive } from '@yaac/server/runtime/status/liveness'
import {
  createYaacTestEnv,
  spawnYaacServer,
  runYaac,
  type YaacTestEnv,
  type SpawnedServer,
} from '@yaac/test-utils/cli'
import {
  requirePodman,
  requireCluster,
  cleanupWorktreeJobs,
  execInJob,
} from '@yaac/test-utils/setup'
import {
  startMockLLM,
  startMockGit,
  seedMockGitRepo,
  cleanupMocks,
  type MockLLM,
  type MockGit,
} from '@yaac/test-utils/mock-remotes'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Poll `fn` until it returns a truthy value or the budget elapses. */
async function waitFor<T>(fn: () => Promise<T | undefined | false>, timeoutMs: number, intervalMs = 2_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > deadline) throw new Error('waitFor: timed out')
    await sleep(intervalMs)
  }
}

/**
 * End-to-end coverage for prewarmed worktrees: with the pool enabled, a project
 * that has an open session gets a hidden spare warmed by the background loop;
 * the next `session create` claims it instead of cold-provisioning; and a fresh
 * spare is warmed to replace it.
 */
describe('yaac prewarmed sessions', () => {
  let testEnv: YaacTestEnv
  let server: SpawnedServer | null = null
  let mockLLM: MockLLM | null = null
  let mockGit: MockGit | null = null

  beforeAll(async () => {
    await requirePodman()
    await requireCluster()
  })

  beforeEach(async () => {
    // The listing and the project count are JOINS: the rows are read here,
    // and what a substrate is running comes back across the boundary. This
    // file asserts on both in-process, so it needs a substrate of its own — the
    // spawned server under test has its own (docs/layered-server.md).
    testEnv = await createYaacTestEnv()
    mockLLM = await startMockLLM()
    mockGit = await startMockGit()
    await seedMockGitRepo(mockGit, 'repo-demo', {
      files: { 'README.md': '# demo\n' },
      // A second branch so the claim-time re-branch prep has a target.
      extraBranches: { dev: { 'dev-only.txt': 'dev content\n' } },
    })
  })

  afterEach(async () => {
    if (server) await server.stop()
    server = null
    await cleanupWorktreeJobs()
    await cleanupMocks([mockLLM, mockGit])
    mockLLM = null
    mockGit = null
    await testEnv.cleanup()
  })

  /** Stage a yaac project + fake creds on disk (same shape as `project add`). */
  async function stageProject(): Promise<void> {
    const projectDir = path.join(testEnv.dataDir, 'projects', 'repo-demo')
    const repoDir = path.join(projectDir, 'repo')
    await fs.mkdir(path.join(projectDir, 'claude'), { recursive: true })

    await cloneRepo(path.join(mockGit!.reposDir, 'repo-demo.git'), repoDir, null)
    const fakeRemote = 'https://github.com/test-org/repo-demo.git'
    await simpleGit(repoDir).remote(['set-url', 'origin', fakeRemote])
    await fs.writeFile(
      path.join(projectDir, 'project.json'),
      JSON.stringify({ slug: 'repo-demo', remoteUrl: fakeRemote, addedAt: new Date().toISOString() }) + '\n',
    )

    const credsDir = path.join(testEnv.dataDir, '.credentials')
    await fs.mkdir(credsDir, { recursive: true, mode: 0o700 })
    await fs.writeFile(
      path.join(credsDir, 'github.json'),
      JSON.stringify({ tokens: [{ pattern: 'github.com/test-org/*', token: 'fake-ghp-token' }] }) + '\n',
    )
    await fs.writeFile(
      path.join(credsDir, 'claude.json'),
      JSON.stringify({ kind: 'api-key', savedAt: new Date().toISOString(), apiKey: 'sk-ant-fake-real-key' }) + '\n',
    )
    await fs.writeFile(testEnv.gitConfigPath, '[user]\n\tname = Test User\n\temail = test@example.com\n')
  }

  it('warms a hidden spare, claims it on the next create, then refills', async () => {
    await stageProject()

    const llmTarget = { host: mockLLM!.host, port: mockLLM!.port, tls: false }
    const gitTarget = { host: mockGit!.host, port: mockGit!.port, tls: false }
    const serverEnv: NodeJS.ProcessEnv = {
      ...testEnv.env,
      YAAC_PREWARM_POOL_SIZE: '1', // re-enable the pool (off by default in e2e)
      YAAC_E2E_UPSTREAM_REDIRECTS: JSON.stringify({
        'github.com': gitTarget,
        'api.github.com': gitTarget,
        'api.anthropic.com': llmTarget,
      }),
      YAAC_E2E_SKIP_FETCH: '1',
      YAAC_E2E_NO_ATTACH: '1',
    }
    server = await spawnYaacServer(serverEnv)

    // 1. First (cold) create — the project now has an open session.
    const first = await runYaac(serverEnv, 'worktree', 'create', 'repo-demo', '--tool', 'claude')
    if (first.exitCode !== 0) console.error(first.stdout, first.stderr)
    expect(first.exitCode).toBe(0)

    // 2. The background loop warms a spare. Wait until it is Running AND its
    //    tmux is alive (so the next create can actually claim it).
    const spare = await waitFor(async () => {
      const pods = await listWorktreePods('repo-demo')
      const s = pods.find((p) => isPrewarmed(p) && p.running)
      if (s && await isTmuxSessionAlive({
        projectSlug: 'repo-demo', workspaceId: s.worktreeId, jobName: s.jobName,
      })) return s
      return undefined
    }, 150_000)
    const spareJob = spare.jobName

    // 3. The spare is hidden from user-facing views: one active session, one
    //    project session-count — even though two pods exist.
    const allPods = await listWorktreePods('repo-demo')
    expect(allPods.filter(isPrewarmed)).toHaveLength(1)
    expect(allPods.filter((p) => !isPrewarmed(p))).toHaveLength(1)

    const active = await listActiveWorktrees('repo-demo')
    expect(active.worktrees).toHaveLength(1)
    expect(active.worktrees[0].worktreeId).not.toBe(spare.worktreeId)

    const proj = (await listProjects()).find((p) => p.slug === 'repo-demo')
    expect(proj?.worktreeCount).toBe(1)

    // 4. Spares are tool- AND branch-agnostic: a create for a different tool
    //    and a different reference branch claims the claude/main-warmed spare,
    //    re-branches its worktree, and retools it — no cold provisioning.
    //
    //    This is also the plain-claim case. A same-tool, same-branch create
    //    asserts a strict subset of what this one does — the "Using
    //    prewarmed session..." line and the reused pod — so running it first
    //    only bought a second cold create and a second wait for the pool to
    //    refill, on the suite's longest test.
    const third = await runYaac(
      serverEnv, 'worktree', 'create', 'repo-demo', '--tool', 'codex', '--branch', 'dev',
    )
    if (third.exitCode !== 0) console.error(third.stdout, third.stderr)
    expect(third.exitCode).toBe(0)
    expect(third.stdout).toContain('Switching prewarmed session to branch dev...')
    expect(third.stdout).toContain('Switching prewarmed session to codex...')
    expect(third.stdout).toContain('Using prewarmed session...')

    // Same pod as the spare — label gone, tool label flipped. Proves the
    // claim reused the warmed pod rather than minting one.
    const retooled = (await listWorktreePods('repo-demo')).find((p) => p.jobName === spareJob)
    expect(retooled).toBeDefined()
    expect(isPrewarmed(retooled!)).toBe(false)
    expect(retooled!.tool).toBe('codex')

    // The re-branch actually landed: the worktree tracks origin/dev and has
    // the branch's file, and the shared repo config records the new upstream.
    const { stdout: upstream } = await execInJob(retooled!.jobName, [
      'git', '-C', '/workspace', 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}',
    ])
    expect(upstream.trim()).toBe('origin/dev')
    const { stdout: devFile } = await execInJob(retooled!.jobName, ['cat', '/workspace/dev-only.txt'])
    expect(devFile).toBe('dev content\n')
    expect(await worktreeUpstreamBranch(
      path.join(testEnv.dataDir, 'projects', 'repo-demo', 'repo'),
      `agent/${retooled!.worktreeId}`,
    )).toBe('dev')

    // 5. The claim leaves the pool short, so a fresh spare is warmed to
    //    replace it — warmed for the project's tool, not the codex the claim
    //    retooled into. Running is enough here: nothing claims this one, and
    //    waiting on its tmux would just be waiting.
    const refilled = await waitFor(async () => {
      const pods = await listWorktreePods('repo-demo')
      return pods.find((p) => isPrewarmed(p) && p.running && p.jobName !== spareJob)
    }, 150_000)
    expect(refilled.tool).toBe('claude')
  }, 420_000)
})
