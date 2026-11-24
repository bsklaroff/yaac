import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { git } from '@yaac/test-utils/git'
import { cloneRepo } from '@yaac/server/domain/git'
import { listWorkspacePods, isPrewarmed } from '@yaac/server/drivers/k8s/substrate/pods'
import { listActiveWorkspaces } from '@yaac/server/domain/workspaces/list'
import { listProjects } from '@yaac/server/domain/projects/list'
import { createYaacTestEnv, spawnYaacServer, setTestGitIdentity, runYaac, type YaacTestEnv } from '#support/cli'
import { assignTestGitCredential, registerTestProject, signInTestTool, type SpawnedServer } from '@yaac/test-utils/api'
import { requireCluster } from '@yaac/test-utils/setup'
import { requirePodman, cleanupWorkspaceJobs, execInJob } from '#support/cluster'
import {
  startMockLLM,
  startMockGit,
  seedMockGitRepo,
  pushMockGitCommit,
  cleanupMocks,
  type MockLLM,
  type MockGit,
} from '#support/mock-remotes'
import { CONTAINER_TMUX_SOCK } from '@yaac/shared/paths'

/**
 * Prewarmed workspaces: with the pool enabled, a project with an open
 * workspace gets a hidden spare, the next `workspace create` claims it
 * instead of provisioning from scratch, and a new spare replaces it.
 *
 * The server here really fetches origin, from the mock git remote, which a
 * case keeps slow or moves on. So the file also covers how a start, cold or
 * claimed, picks its commit from the main clone without waiting for that
 * fetch and catches up once it lands (docs/server-git.md "Starting a
 * workspace").
 */
describe('yaac prewarmed sessions', () => {
  let testEnv: YaacTestEnv
  let server: SpawnedServer | null = null
  let mockLLM: MockLLM | null = null
  let mockGit: MockGit | null = null

  beforeAll(async () => {
    await requirePodman()
    await requireCluster()
    testEnv = await createYaacTestEnv()
    ;[mockLLM, mockGit] = await Promise.all([startMockLLM(), startMockGit()])
    await seedMockGitRepo(mockGit, 'repo-demo', {
      files: { 'README.md': '# demo\n' },
      // A second branch for the claim to switch to.
      extraBranches: { dev: { 'dev-only.txt': 'dev content\n' } },
    })
  })

  afterAll(async () => {
    if (server) await server.stop()
    server = null
    await cleanupWorkspaceJobs()
    await cleanupMocks([mockLLM, mockGit])
    mockLLM = null
    mockGit = null
    await testEnv.cleanup()
  })

  const FAKE_REMOTE = 'https://github.com/test-org/repo-demo.git'
  const PROJECT_ID = crypto.randomUUID()

  /**
   * Put a project and fake claude creds on disk, as `project add` would.
   * It is registered with the server once the server is up.
   */
  async function stageProject(): Promise<void> {
    const projectDir = path.join(testEnv.dataDir, 'global', 'projects', PROJECT_ID)
    // The main clone of the project's repo, which carries the project's id.
    const repoDir = path.join(testEnv.dataDir, 'global', 'repos', PROJECT_ID)
    await fs.mkdir(path.join(projectDir, 'claude'), { recursive: true })

    await cloneRepo(path.join(mockGit!.reposDir, 'repo-demo.git'), repoDir, null)
    await git(repoDir, ['remote', 'set-url', 'origin', FAKE_REMOTE])
  }

/**
 * Whether the pod's tmux server is up, checked with `kubectl exec`. The
 * server's own `isTmuxSessionAlive` dials an in-cluster Service that is
 * unreachable from the test host (docs/server-in-cluster.md).
 */
async function tmuxAliveInPod(jobName: string): Promise<boolean> {
  try {
    await execInJob(
      jobName,
      ['tmux', '-S', CONTAINER_TMUX_SOCK, 'has-session', '-t', 'yaac'],
      { timeout: 15_000 },
    )
    return true
  } catch {
    return false
  }
}

  it('warms a hidden spare, claims it without waiting on origin, catches it up when the fetch lands, then refills', async () => {
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
      YAAC_E2E_NO_ATTACH: '1',
    }
    await mockGit!.serveServerFetches(serverEnv, 'https://github.com/test-org/')
    server = await spawnYaacServer(serverEnv)
    await signInTestTool(server, 'claude', { kind: 'api-key', apiKey: 'sk-ant-fake-real-key' })
    await setTestGitIdentity(serverEnv)
    await registerTestProject(server, PROJECT_ID, 'repo-demo', FAKE_REMOTE)
    await assignTestGitCredential(server, 'repo-demo', 'fake-ghp-token')

    const create = (...args: string[]): ReturnType<typeof runYaac> =>
      runYaac(serverEnv, 'workspace', 'create', 'repo-demo', '--mode', 'tui', ...args)
    const push = (branch: string, files: Record<string, string>, opts: { rewrite?: boolean; from?: string } = {}): Promise<string> =>
      pushMockGitCommit(mockGit!, 'repo-demo', { branch, files, ...opts })
    /** A commit of a workspace's checkout, as its own git reads it. */
    const rev = async (jobName: string, what = 'HEAD'): Promise<string> =>
      (await execInJob(jobName, ['git', '-C', '/workspace', 'rev-parse', what])).stdout.trim()
    const fileIn = async (jobName: string, file: string): Promise<string> =>
      (await execInJob(jobName, ['cat', `/workspace/${file}`])).stdout
    /** The project's workspaces as the server lists them. Read through the
     *  server: this process's DB handle cannot see its writes. */
    const listed = async (): Promise<Array<{
      workspaceId: string
      repos: Array<{ baseBranch?: string; startCommit?: string }>
      sessions: Array<{ tool: string }>
    }>> => ((await (await fetch(`http://127.0.0.1:${server!.lock.port}/api/workspace/list?project=repo-demo`)).json()) as {
      workspaces: Array<{ workspaceId: string; repos: Array<{ baseBranch?: string; startCommit?: string }>; sessions: Array<{ tool: string }> }>
    }).workspaces
    const startCommit = async (workspaceId: string): Promise<string | undefined> =>
      (await listed()).find((w) => w.workspaceId === workspaceId)?.repos[0]?.startCommit

    /** Spares already claimed, by job name. */
    const claimed = new Set<string>()
    /**
     * Wait for a spare that is running with tmux up, so it is claimable,
     * and whose checkout is at `at`, where the pool keeps it once the main
     * clone has that commit.
     */
    const spareAt = (at: string): Promise<{ jobName: string; workspaceId: string }> => vi.waitFor(async () => {
      const s = (await listWorkspacePods(PROJECT_ID)).find((p) => isPrewarmed(p) && p.running && !claimed.has(p.jobName))
      if (!s || !await tmuxAliveInPod(s.jobName)) throw new Error('no claimable spare yet')
      if (await rev(s.jobName) !== at) throw new Error(`the spare is not at ${at} yet`)
      return s
    }, { timeout: 240_000, interval: 500 })
    /** Claim `spare` with a create, which must take it. */
    const claim = async (spare: { jobName: string }, ...args: string[]): Promise<string> => {
      const made = await create(...args)
      if (made.exitCode !== 0) console.error(made.stdout, made.stderr)
      expect(made.exitCode).toBe(0)
      expect(made.stdout).toContain('Using prewarmed session...')
      claimed.add(spare.jobName)
      return made.stdout
    }
    /** Stop a claimed workspace once a case is done with it, in the
     *  background, to leave the node room for the next spare. */
    const stop = (workspaceId: string): void => {
      void runYaac(serverEnv, 'workspace', 'stop', workspaceId).catch(() => { /* swept after the test */ })
    }

    // 1. A cold create gives the project an open workspace. Origin's
    //    branch was rewritten (a force-push) after the main clone was made:
    //    the create starts at the clone's commit, its fetch lands while the
    //    pod boots, and the checkout, which nothing has touched and nothing
    //    runs in yet, is reset to the new tip before the agent's window
    //    opens.
    const base = (await git(path.join(mockGit!.reposDir, 'repo-demo.git'), ['rev-parse', 'main'])).trim()
    let tip = await push('main', { 'cold.txt': 'pushed before the cold create\n' }, { rewrite: true })
    const first = await create('--tool', 'claude')
    if (first.exitCode !== 0) console.error(first.stdout, first.stderr)
    expect(first.exitCode).toBe(0)
    const [cold] = (await listWorkspacePods(PROJECT_ID)).filter((p) => !isPrewarmed(p))
    await vi.waitFor(async () => { expect(await rev(cold.jobName)).toBe(tip) }, { timeout: 30_000, interval: 250 })
    expect(await rev(cold.jobName, 'origin/main')).toBe(tip)
    expect(await fileIn(cold.jobName, 'cold.txt')).toBe('pushed before the cold create\n')
    expect((await execInJob(cold.jobName, ['git', '-C', '/workspace', 'status', '--porcelain'])).stdout).toBe('')
    expect(await startCommit(cold.workspaceId)).toBe(tip)
    expect(tip).not.toBe(base)

    // 2. A spare is warmed, at the commit the main clone has now.
    let spare = await spareAt(tip)
    const spareJob = spare.jobName

    // 3. The spare is hidden from listings and the project's count.
    const allPods = await listWorkspacePods(PROJECT_ID)
    expect(allPods.filter(isPrewarmed)).toHaveLength(1)
    expect(allPods.filter((p) => !isPrewarmed(p))).toHaveLength(1)

    const active = await listActiveWorkspaces(PROJECT_ID)
    expect(active.workspaces).toHaveLength(1)
    expect(active.workspaces[0].workspaceId).not.toBe(spare.workspaceId)

    const proj = (await listProjects()).find((p) => p.id === PROJECT_ID)
    expect(proj?.workspaceCount).toBe(1)

    // 4. Spares run no session, so they serve any tool, and any branch: a
    //    codex create on `dev`, which the main clone has, claims the main
    //    spare, switching its branch and opening a codex session in it.
    const third = await claim(spare, '--tool', 'codex', '--branch', 'dev')
    expect(third).toContain('Switching prewarmed session to branch dev...')

    // The spare's own pod, no longer marked prewarmed.
    const retooled = (await listWorkspacePods(PROJECT_ID)).find((p) => p.jobName === spareJob)
    expect(retooled).toBeDefined()
    expect(isPrewarmed(retooled!)).toBe(false)

    // The checkout tracks origin/dev and the row records the new base.
    const { stdout: upstream } = await execInJob(retooled!.jobName, [
      'git', '-C', '/workspace', 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}',
    ])
    expect(upstream.trim()).toBe('origin/dev')
    expect(await fileIn(retooled!.jobName, 'dev-only.txt')).toBe('dev content\n')
    const onDev = (await listed()).find((w) => w.workspaceId === retooled!.workspaceId)
    expect(onDev?.repos.map((r) => r.baseBranch)).toEqual(['dev'])
    expect(onDev?.sessions.map((s) => s.tool)).toEqual(['codex'])
    stop(retooled!.workspaceId)

    // 5. Origin is slow and has moved on: the claim launches on the commit
    //    the spare stands at, and the checkout is fast-forwarded once the
    //    fetch lands, a few seconds later.
    spare = await spareAt(tip)
    await mockGit!.delayFetches(3_000)
    tip = await push('main', { 'late.txt': 'pushed before the claim\n' })
    await claim(spare, '--tool', 'claude')
    await vi.waitFor(async () => { expect(await rev(spare.jobName)).toBe(tip) }, { timeout: 60_000, interval: 250 })
    expect(await fileIn(spare.jobName, 'late.txt')).toBe('pushed before the claim\n')
    await vi.waitFor(async () => { expect(await startCommit(spare.workspaceId)).toBe(tip) }, { timeout: 30_000 })
    stop(spare.workspaceId)

    // How a claim's catch-up leaves a checkout it cannot safely move (work
    // of its own, a rewritten origin, a fetch that outlasts the wait) and a
    // claim onto a branch the main clone has not fetched are unit-tested in
    // start.test, over real git.

    // 6. A replacement spare is warmed. Nothing claims it, so running is
    //    enough.
    const refilled = await vi.waitFor(async () => {
      const pods = await listWorkspacePods(PROJECT_ID)
      const s = pods.find((p) => isPrewarmed(p) && p.running && !claimed.has(p.jobName))
      if (!s) throw new Error('no replacement spare yet')
      return s
    }, { timeout: 240_000, interval: 500 })
    expect(refilled.running).toBe(true)
  }, 1_800_000)
})
