import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { git } from '@yaac/test-utils/git'
import { cloneRepo } from '@yaac/server/domain/git'
import { listWorkspacePods, isPrewarmed } from '@yaac/server/drivers/k8s/substrate/pods'
import { listActiveWorkspaces } from '@yaac/server/domain/workspaces/list'
import { listProjects } from '@yaac/server/domain/projects/list'
import {
  createYaacTestEnv,
  spawnYaacServer,
  setTestGitIdentity,
  runYaac,
  type YaacTestEnv,
  type SpawnedServer,
} from '@yaac/test-utils/cli'
import { assignTestGitCredential, registerTestProject } from '@yaac/test-utils/api'
import {
  requirePodman,
  requireCluster,
  cleanupWorkspaceJobs,
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
import { CONTAINER_TMUX_SOCK } from '@yaac/shared/paths'

/**
 * Prewarmed workspaces: with the pool enabled, a project with an open
 * workspace gets a hidden spare, the next `workspace create` claims it
 * instead of provisioning from scratch, and a new spare replaces it.
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
    testEnv = await createYaacTestEnv()
    mockLLM = await startMockLLM()
    mockGit = await startMockGit()
    await seedMockGitRepo(mockGit, 'repo-demo', {
      files: { 'README.md': '# demo\n' },
      // A second branch for the claim to switch to.
      extraBranches: { dev: { 'dev-only.txt': 'dev content\n' } },
    })
  })

  afterEach(async () => {
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
    const repoDir = path.join(projectDir, 'repo')
    await fs.mkdir(path.join(projectDir, 'claude'), { recursive: true })

    await cloneRepo(path.join(mockGit!.reposDir, 'repo-demo.git'), repoDir, null)
    await git(repoDir, ['remote', 'set-url', 'origin', FAKE_REMOTE])

    const credsDir = path.join(testEnv.dataDir, 'server-local', '.credentials')
    await fs.mkdir(credsDir, { recursive: true, mode: 0o700 })
    await fs.writeFile(
      path.join(credsDir, 'claude.json'),
      JSON.stringify({ kind: 'api-key', savedAt: new Date().toISOString(), apiKey: 'sk-ant-fake-real-key' }) + '\n',
    )
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
    await setTestGitIdentity(serverEnv)
    await registerTestProject(server, PROJECT_ID, 'repo-demo', FAKE_REMOTE)
    await assignTestGitCredential(server, 'repo-demo', 'fake-ghp-token')

    // 1. A cold create gives the project an open workspace.
    const first = await runYaac(serverEnv, 'workspace', 'create', 'repo-demo', '--tool', 'claude', '--mode', 'tui')
    if (first.exitCode !== 0) console.error(first.stdout, first.stderr)
    expect(first.exitCode).toBe(0)

    // 2. Wait for a spare that is running with tmux up, so it is claimable.
    const spare = await vi.waitFor(async () => {
      const pods = await listWorkspacePods(PROJECT_ID)
      const s = pods.find((p) => isPrewarmed(p) && p.running)
      if (!s || !await tmuxAliveInPod(s.jobName)) throw new Error('no claimable spare yet')
      return s
    }, { timeout: 150_000, interval: 2_000 })
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

    // 4. Spares work for any tool and branch: a codex create on `dev`
    //    claims the claude/main spare, switching its branch and tool. This
    //    also covers the plain same-tool, same-branch claim.
    const third = await runYaac(
      serverEnv, 'workspace', 'create', 'repo-demo', '--tool', 'codex', '--mode', 'tui', '--branch', 'dev',
    )
    if (third.exitCode !== 0) console.error(third.stdout, third.stderr)
    expect(third.exitCode).toBe(0)
    expect(third.stdout).toContain('Switching prewarmed session to branch dev...')
    expect(third.stdout).toContain('Switching prewarmed session to codex...')
    expect(third.stdout).toContain('Using prewarmed session...')

    // The spare's own pod, no longer marked prewarmed and retooled.
    const retooled = (await listWorkspacePods(PROJECT_ID)).find((p) => p.jobName === spareJob)
    expect(retooled).toBeDefined()
    expect(isPrewarmed(retooled!)).toBe(false)
    expect(retooled!.tool).toBe('codex')

    // The checkout tracks origin/dev and the row records the new base.
    const { stdout: upstream } = await execInJob(retooled!.jobName, [
      'git', '-C', '/workspace', 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}',
    ])
    expect(upstream.trim()).toBe('origin/dev')
    const { stdout: devFile } = await execInJob(retooled!.jobName, ['cat', '/workspace/dev-only.txt'])
    expect(devFile).toBe('dev content\n')
    // Read through the server; this process's DB handle cannot see its write.
    const listed = await (await fetch(`http://127.0.0.1:${server.lock.port}/api/workspace/list?project=repo-demo`))
      .json() as { workspaces: Array<{ workspaceId: string; baseBranch?: string }> }
    expect(listed.workspaces.find((w) => w.workspaceId === retooled!.workspaceId)?.baseBranch).toBe('dev')

    // 5. A replacement spare is warmed with the project's last-used tool
    //    (codex). Nothing claims it, so running is enough.
    const refilled = await vi.waitFor(async () => {
      const pods = await listWorkspacePods(PROJECT_ID)
      const s = pods.find((p) => isPrewarmed(p) && p.running && p.jobName !== spareJob)
      if (!s) throw new Error('no replacement spare yet')
      return s
    }, { timeout: 150_000, interval: 2_000 })
    expect(refilled.tool).toBe('codex')
  }, 420_000)
})
