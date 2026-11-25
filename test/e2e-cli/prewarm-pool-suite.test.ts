import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { git } from '@yaac/test-utils/git'
import { cloneRepo } from '@yaac/server/domain/git'
import { listSpares } from '@yaac/server/drivers/k8s/workspaces/spares'
import { execFileAsync, k8sNamespace, listObjects } from '@yaac/server/drivers/k8s/substrate'
import { createYaacTestEnv, spawnYaacServer, setTestGitIdentity, runYaac, type YaacTestEnv } from '#support/cli'
import { assignTestGitCredential, registerTestProject, signInTestTool, type SpawnedServer } from '@yaac/test-utils/api'
import { requireCluster } from '@yaac/test-utils/setup'
import { requirePodman, cleanupWorkspaceJobs, execInJob } from '#support/cluster'
import {
  startMockLLM,
  startMockGit,
  seedMockGitRepo,
  cleanupMocks,
  type MockLLM,
  type MockGit,
} from '#support/mock-remotes'

/**
 * Generic workspace pods and their pool (docs/generic-workspace-pods.md),
 * against one server for the whole file: a spare that belongs to no project
 * is taken by whichever start comes next, of any project, and mountd
 * binds the workspace into it; a restart gets a pod made on demand; a server
 * restart replaces the spares and leaves workspaces running. How the server
 * picks a commit without waiting on origin is covered by workspace-create.
 */
describe('generic workspace pods and the prewarmed pool', () => {
  let testEnv: YaacTestEnv
  let serverEnv: NodeJS.ProcessEnv
  let server: SpawnedServer | null = null
  let mockLLM: MockLLM | null = null
  let mockGit: MockGit | null = null

  const PROJECT_A = crypto.randomUUID()
  const PROJECT_B = crypto.randomUUID()

  /** A project whose main clone is staged on disk as `project add` would
   *  leave it; its repo carries the project's id. */
  async function stageProject(id: string, repo: string): Promise<void> {
    const repoDir = path.join(testEnv.dataDir, 'global', 'repos', id)
    await fs.mkdir(path.join(testEnv.dataDir, 'global', 'projects', id, 'claude'), { recursive: true })
    await cloneRepo(path.join(mockGit!.reposDir, `${repo}.git`), repoDir, null)
    await git(repoDir, ['remote', 'set-url', 'origin', `https://github.com/test-org/${repo}.git`])
  }

  async function startServer(): Promise<void> {
    server = await spawnYaacServer(serverEnv)
  }

  beforeAll(async () => {
    await requirePodman()
    await requireCluster()
    testEnv = await createYaacTestEnv()
    ;[mockLLM, mockGit] = await Promise.all([startMockLLM(), startMockGit()])
    await seedMockGitRepo(mockGit, 'repo-a', {
      files: { 'README.md': '# a\n' },
      extraBranches: { dev: { 'dev-only.txt': 'dev content\n' } },
    })
    await seedMockGitRepo(mockGit, 'repo-b', { files: { 'README.md': '# b\n' } })
    await stageProject(PROJECT_A, 'repo-a')
    await stageProject(PROJECT_B, 'repo-b')
    const llmTarget = { host: mockLLM.host, port: mockLLM.port, tls: false }
    const gitTarget = { host: mockGit.host, port: mockGit.port, tls: false }
    serverEnv = {
      ...testEnv.env,
      // The pool is off by default in e2e.
      YAAC_PREWARM_POOL_SIZE: '1',
      YAAC_E2E_UPSTREAM_REDIRECTS: JSON.stringify({
        'github.com': gitTarget,
        'api.github.com': gitTarget,
        'api.anthropic.com': llmTarget,
      }),
      YAAC_E2E_NO_ATTACH: '1',
    }
    await mockGit.serveServerFetches(serverEnv, 'https://github.com/test-org/')
    await startServer()
    await signInTestTool(server!, 'claude', { kind: 'api-key', apiKey: 'sk-ant-fake-real-key' })
    await setTestGitIdentity(serverEnv)
    await registerTestProject(server!, PROJECT_A, 'repo-a', 'https://github.com/test-org/repo-a.git')
    await registerTestProject(server!, PROJECT_B, 'repo-b', 'https://github.com/test-org/repo-b.git')
    await assignTestGitCredential(server!, 'repo-a', 'fake-ghp-token')
    await assignTestGitCredential(server!, 'repo-b', 'fake-ghp-token')
  })

  afterAll(async () => {
    if (server) await server.stop()
    server = null
    await cleanupWorkspaceJobs()
    await cleanupMocks([mockLLM, mockGit])
    await testEnv.cleanup()
  })

  const create = async (project: string, ...args: string[]): Promise<{ id: string; stdout: string }> => {
    const made = await runYaac(serverEnv, 'workspace', 'create', project, '--mode', 'tui', '--tool', 'claude', ...args)
    if (made.exitCode !== 0) console.error(made.stdout, made.stderr)
    expect(made.exitCode).toBe(0)
    const id = /Workspace ([0-9a-f-]{36})/.exec(made.stdout)?.[1]
    expect(id).toBeDefined()
    return { id: id!, stdout: made.stdout }
  }
  const job = (workspaceId: string): string => `yaac-${workspaceId}`
  const inPod = async (workspaceId: string, script: string): Promise<string> =>
    (await execInJob(job(workspaceId), ['sh', '-c', script], { timeout: 60_000 })).stdout
  /** A spare that is ready to take and not one of `besides`. */
  const readySpare = (besides: string[] = []): Promise<string> => vi.waitFor(async () => {
    const s = (await listSpares()).find((u) => u.ready && !u.orphaned && !besides.includes(u.workspaceId))
    if (!s) throw new Error('no ready spare yet')
    return s.workspaceId
  }, { timeout: 300_000, interval: 1_000 })
  const stop = (workspaceId: string): Promise<unknown> => runYaac(serverEnv, 'workspace', 'stop', workspaceId)
  /** A workspace pod's node-mounts directory, by its volume. */
  const nodeMountsDir = async (workspaceId: string): Promise<string> => {
    const [pod] = await listObjects<{ spec?: { volumes?: Array<{ name?: string; hostPath?: { path?: string } }> } }>('v1', 'Pod', {
      namespace: k8sNamespace(), labelSelector: `yaac.workspace-id=${workspaceId}`,
    })
    const p = pod?.spec?.volumes?.find((v) => v.name === 'node-mounts')?.hostPath?.path
    expect(p).toBeDefined()
    return path.basename(p!)
  }
  /** What mountd's root on this node holds, and its mount table's
   *  lines under it. */
  const mountdRoot = async (): Promise<{ dirs: string[]; mounts: string }> => {
    const run = async (cmd: string): Promise<string> => (await execInAgent(cmd)).trim()
    return {
      dirs: (await run('ls -A /node-mounts-root')).split('\n').filter(Boolean),
      mounts: await run('grep /node-mounts-root/ /proc/self/mountinfo || true'),
    }
  }
  const execInAgent = async (cmd: string): Promise<string> => {
    return (await execFileAsync('kubectl', ['exec', '-n', k8sNamespace(), 'ds/yaac-mountd', '-c', 'mountd', '--', 'sh', '-c', cmd])).stdout
  }

  let first = ''
  let taken = ''

  it('takes one pool\'s spare for any project, binding into it a workspace that sees only its own', async () => {
    // A cold create gives the pool a reason to exist: nothing waits yet.
    first = (await create('repo-a')).id
    expect(await inPod(first, 'cat /workspace/README.md')).toBe('# a\n')

    // A spare belongs to no project and holds nothing of one.
    const spare = await readySpare()
    expect(await inPod(spare, 'ls -A /node-mounts; ls -A /workspace 2>/dev/null; echo done')).toBe('done\n')

    // The other project's next create takes it, under the spare's id.
    const made = await create('repo-b')
    expect(made.id).toBe(spare)
    expect(made.stdout).toContain('Using a prewarmed workspace...')
    taken = made.id
    expect(await inPod(taken, 'cat /workspace/README.md && git -C /workspace status --porcelain && echo clean')).toBe('# b\nclean\n')

    // It reaches nothing of project A's, cannot write its own main clone
    // or its node-mounts directory, and cannot mount, even as root. The
    // entries under node-mounts stay read-only to root too, the tree-only
    // ones (its scratch repository, its checkpoint log) included.
    const refused = await inPod(taken, [
      `ls /yaac/global/projects/${PROJECT_A} >/dev/null 2>&1 && echo read-other`,
      `touch /yaac/global/repos/${PROJECT_B}/.git/x 2>/dev/null && echo wrote-clone`,
      'touch /node-mounts/x 2>/dev/null && echo wrote-node-mounts',
      'for d in /node-mounts/*/; do sudo touch "$d.yaac-probe" 2>/dev/null && echo "wrote $d"; done',
      'sudo mount -t tmpfs none /mnt 2>/dev/null && echo mounted',
      'echo checked',
    ].join('; '))
    expect(refused).toBe('checked\n')
  }, 900_000)

  it('builds a tree on demand for a branch no tree is kept for', async () => {
    const spare = await readySpare([taken])
    const onDev = await create('repo-a', '--branch', 'dev')
    expect(onDev.id).toBe(spare)
    expect(await inPod(onDev.id, 'cat /workspace/dev-only.txt')).toBe('dev content\n')
    await stop(onDev.id)
  }, 900_000)

  it('has a yaac-mama create and a queued launch take spares, naming their workspaces for them', async () => {
    const spare = await readySpare([taken])
    const { stdout } = await execInJob(job(taken), ['sh', '-c', 'yaac-mama create --tool claude "hello" 2>&1'], { timeout: 120_000 })
    expect(stdout.trim()).toBe(spare)
    await vi.waitFor(async () => { expect(await inPod(spare, 'cat /workspace/README.md')).toBe('# b\n') }, { timeout: 180_000, interval: 1_000 })

    // A follow-up queued behind it launches when it stops.
    await execInJob(job(spare), ['sh', '-c', `yaac-mama queue --parent-workspace ${spare} "later" 2>&1`], { timeout: 120_000 })
    const next = await readySpare([taken, spare])
    await stop(spare)
    await vi.waitFor(async () => {
      expect(await inPod(next, 'cat /workspace/README.md')).toBe('# b\n')
    }, { timeout: 180_000, interval: 1_000 })
    await stop(next)
  }, 900_000)

  it('restarts in a pod made on demand under the workspace\'s own id, with its files, and releases the old pod\'s mounts', async () => {
    await inPod(taken, 'echo kept > /workspace/kept.txt && rm /workspace/README.md')
    const before = await nodeMountsDir(taken)
    await stop(taken)
    await vi.waitFor(async () => {
      const root = await mountdRoot()
      expect(root.dirs).not.toContain(before)
      expect(root.mounts).not.toContain(before)
    }, { timeout: 120_000, interval: 1_000 })

    const restarted = await runYaac(serverEnv, 'workspace', 'restart', taken)
    expect(restarted.exitCode).toBe(0)
    expect(await nodeMountsDir(taken)).not.toBe(before)
    expect(await inPod(taken, 'cat /workspace/kept.txt; ls /workspace/README.md 2>/dev/null; git -C /workspace status --porcelain'))
      .toBe('kept\n D README.md\n?? kept.txt\n')
  }, 900_000)

  it('starts while mountd\'s pod is being replaced', async () => {
    // Whether it takes the waiting spare or a pod made on demand depends on
    // when the node stops counting as ready; either way it binds through
    // mountd's next pod.
    await readySpare([taken])
    await execFileAsync('kubectl', ['delete', 'pod', '-n', k8sNamespace(), '-l', 'app=yaac-mountd', '--wait=false'])
    const made = await create('repo-a')
    expect(await inPod(made.id, 'cat /workspace/README.md')).toBe('# a\n')
    await stop(made.id)
  }, 900_000)

  it('deletes every spare on a server restart, leaving workspaces running, and refills', async () => {
    const spare = await readySpare([taken])
    await server!.stop()
    await startServer()
    await readySpare([taken, spare])
    // The reap deletes in the background, so the old pod may list a while.
    await vi.waitFor(async () => {
      expect((await listSpares()).map((s) => s.workspaceId)).not.toContain(spare)
    }, { timeout: 120_000, interval: 1_000 })
    expect(await inPod(first, 'cat /workspace/README.md')).toBe('# a\n')
    expect(await inPod(taken, 'cat /workspace/kept.txt')).toBe('kept\n')
  }, 900_000)
})
