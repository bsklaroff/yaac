import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { git } from '@yaac/test-utils/git'
import { kubectl } from '@yaac/test-utils/kubectl'
import { cloneRepo } from '@yaac/server/domain/git'
import { listWorkspacePods, type PodInfo } from '@yaac/server/drivers/k8s/substrate/pods'
import { k8sNamespace } from '@yaac/server/drivers/k8s/substrate/api'
import { createYaacTestEnv, spawnYaacServer, setTestGitIdentity, runYaac, type YaacTestEnv } from '#support/cli'
import { assignTestGitCredential, registerTestProject, signInTestTool, type SpawnedServer } from '@yaac/test-utils/api'
import { requireCluster } from '@yaac/test-utils/setup'
import { requirePodman, cleanupWorkspaceJobs, execInJob } from '#support/cluster'
import { startMockLLM, startMockGit, seedMockGitRepo, cleanupMocks, type MockLLM, type MockGit } from '#support/mock-remotes'
import type { ResourceReport } from '@yaac/shared/types'

const execFileAsync = promisify(execFile)

/**
 * A k8s workspace's files on its node (docs/node-local-workspaces.md):
 * the tree container fills `/workspace` there with each checkout's `.git`
 * on the shared tier, checkpoints unsaved work, and a restart restores it,
 * after a clean stop or after the sandbox was killed and its tree salvaged.
 * Last, the full-node guard: its stop floor is set just under the host's
 * free space, so one workspace writing past it is stopped for it.
 *
 * One server and one project for the file; the cases share one workspace,
 * in order, and the guard's case, which stops it, runs last.
 */
const GiB = 1024 ** 3

async function hostFreeGiB(): Promise<number> {
  const s = await fs.statfs('/')
  return (s.bavail * s.bsize) / GiB
}

describe('workspace trees on the node', () => {
  let testEnv: YaacTestEnv
  let server: SpawnedServer
  let serverEnv: NodeJS.ProcessEnv
  let mockLLM: MockLLM
  let mockGit: MockGit
  const PROJECT_ID = crypto.randomUUID()
  const REMOTE = 'https://github.com/test-org/tree-demo.git'
  let workspaceId = ''
  let stopFloorGiB = 0

  beforeAll(async () => {
    await requirePodman()
    await requireCluster()
    testEnv = await createYaacTestEnv()
    mockLLM = await startMockLLM()
    mockGit = await startMockGit()
    // Its rules ignore the default scratch dir, as most JS repos' do.
    await seedMockGitRepo(mockGit, 'tree-demo', {
      files: { 'README.md': '# demo\n', 'src/a.ts': 'export const a = 1\n', '.gitignore': 'node_modules/\n' },
    })
    const repoDir = path.join(testEnv.dataDir, 'global', 'repos', PROJECT_ID)
    await fs.mkdir(path.join(testEnv.dataDir, 'global', 'projects', PROJECT_ID, 'claude'), { recursive: true })
    await cloneRepo(path.join(mockGit.reposDir, 'tree-demo.git'), repoDir, null)
    await git(repoDir, ['remote', 'set-url', 'origin', REMOTE])
    // The guard stops a workspace once free space falls under the stop
    // floor: set it 1.5 GiB under what the host has now, so the cases
    // before the last never cross it. Trees and the host's podman store
    // share this disk on kind.
    const freeGiB = await hostFreeGiB()
    stopFloorGiB = Math.max(0, freeGiB - 1.5)
    const gitTarget = { host: mockGit.host, port: mockGit.port, tls: false }
    const llmTarget = { host: mockLLM.host, port: mockLLM.port, tls: false }
    serverEnv = {
      ...testEnv.env,
      YAAC_DISK_STOP_FLOOR_GIB: String(stopFloorGiB),
      YAAC_DISK_WARN_FLOOR_GIB: String(freeGiB + 50),
      YAAC_E2E_UPSTREAM_REDIRECTS: JSON.stringify({ 'github.com': gitTarget, 'api.github.com': gitTarget, 'api.anthropic.com': llmTarget }),
      YAAC_E2E_SKIP_FETCH: '1',
      YAAC_E2E_NO_ATTACH: '1',
    }
    server = await spawnYaacServer(serverEnv)
    await signInTestTool(server, 'claude', { kind: 'api-key', apiKey: 'sk-ant-fake-real-key' })
    await setTestGitIdentity(serverEnv)
    await registerTestProject(server, PROJECT_ID, 'tree-demo', REMOTE)
    await assignTestGitCredential(server, 'tree-demo', 'fake-ghp-token')
  }, 600_000)

  afterAll(async () => {
    await server?.stop()
    await cleanupWorkspaceJobs()
    await cleanupMocks([mockLLM, mockGit])
    await testEnv?.cleanup()
  })

  const pod = async (): Promise<PodInfo> => {
    const pods = (await listWorkspacePods(PROJECT_ID)).filter((p) => p.workspaceId === workspaceId && p.running)
    if (!pods[0]) throw new Error('no running pod yet')
    return pods[0]
  }
  const sh = async (script: string): Promise<string> => (await execInJob((await pod()).jobName, ['sh', '-c', script])).stdout
  const checkpoints = (): string => path.join(testEnv.dataDir, 'global', 'projects', PROJECT_ID, 'checkpoints', workspaceId)
  const lives = async (): Promise<string[]> => (await fs.readdir(path.join(checkpoints(), 'lives')).catch(() => [])).sort()
  const manifest = async (life: string): Promise<{ final: boolean; pass: string } | null> =>
    fs.readFile(path.join(checkpoints(), 'lives', life, 'manifest.json'), 'utf8').then((t) => JSON.parse(t) as { final: boolean; pass: string }, () => null)
  const api = (p: string, init?: RequestInit): Promise<Response> => fetch(`http://127.0.0.1:${String(server.lock.port)}/api${p}`, init)

  async function stop(): Promise<void> {
    const { exitCode, stderr } = await runYaac(serverEnv, 'workspace', 'stop', workspaceId)
    expect(exitCode, stderr).toBe(0)
    await vi.waitFor(async () => {
      expect((await listWorkspacePods(PROJECT_ID)).filter((p) => p.workspaceId === workspaceId)).toEqual([])
    }, { timeout: 180_000, interval: 2_000 })
  }

  async function restart(): Promise<void> {
    const { exitCode, stdout, stderr } = await runYaac(serverEnv, 'workspace', 'restart', workspaceId)
    expect(exitCode, `${stdout}\n${stderr}`).toBe(0)
    await vi.waitFor(() => pod(), { timeout: 300_000, interval: 2_000 })
  }

  it('fills the workspace\'s tree on its node, each .git from the shared tier, its index current', async () => {
    const created = await runYaac(serverEnv, 'workspace', 'create', 'tree-demo', '--tool', 'claude', '--mode', 'tui')
    expect(created.exitCode, `${created.stdout}\n${created.stderr}`).toBe(0)
    workspaceId = (await listWorkspacePods(PROJECT_ID))[0].workspaceId
    expect(await sh('cat /workspace/README.md')).toBe('# demo\n')
    // The shared tier holds the checkout's .git and nothing else.
    expect(await fs.readdir(path.join(testEnv.dataDir, 'global', 'projects', PROJECT_ID, 'workspaces', workspaceId))).toEqual(['.git'])
    expect((await fs.stat(path.join(testEnv.dataDir, 'global', 'projects', PROJECT_ID, 'workspaces', workspaceId, '.git', 'HEAD'))).isFile()).toBe(true)
    // The tree container's index is current in the workspace container.
    expect(await sh('cd /workspace && git config core.checkStat && git diff-files --name-only | wc -l')).toBe('minimal\n0\n')
    expect(await sh('git -C /workspace status --porcelain')).toBe('')
    const [life] = await lives()
    expect(life).toBeDefined()
    const pods = await kubectl(['get', 'pods', '-n', k8sNamespace(), '-l', `job-name=${(await pod()).jobName}`, '-o', 'jsonpath={.items[0].spec.initContainers[*].name}'])
    expect(pods.stdout.split(' ')).toContain('tree')
  }, 400_000)

  it('takes a checkpoint after an editor save', async () => {
    const [life] = await lives()
    const before = (await manifest(life))?.pass
    const read = await (await api(`/workspace/${workspaceId}/file?path=README.md`)).json() as { version: string; content: string }
    const saved = await api(`/workspace/${workspaceId}/file`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'README.md', content: `${read.content}saved\n`, baseVersion: read.version }),
    })
    expect(saved.status).toBe(200)
    await vi.waitFor(async () => {
      const m = await manifest(life)
      expect(m?.pass).toBeDefined()
      expect(m?.pass).not.toBe(before)
    }, { timeout: 30_000, interval: 1_000 })
  }, 60_000)

  it('saves unsaved work at a stop and restores it at the restart, the file routes refusing while stopped', async () => {
    await sh('cd /workspace && echo unsaved > notes.txt && printf "#!/bin/sh\\n" > run.sh && chmod +x run.sh && sudo sh -c "echo secret > key && chmod 600 key"')
    await stop()
    const [first] = await lives()
    expect((await manifest(first))?.final).toBe(true)
    expect((await api(`/workspace/${workspaceId}/file?path=README.md`)).status).toBe(409)
    await restart()
    expect(await sh('cat /workspace/README.md /workspace/notes.txt /workspace/key')).toBe('# demo\nsaved\nunsaved\nsecret\n')
    expect(await sh('test -x /workspace/run.sh && echo x')).toBe('x\n')
    expect((await sh('git -C /workspace status --porcelain')).split('\n').filter(Boolean).sort())
      .toEqual([' M README.md', '?? key', '?? notes.txt', '?? run.sh'])
    expect(await lives()).toHaveLength(2)
  }, 600_000)

  it('salvages the tree of a killed sandbox on its node and restores it at the restart', async () => {
    const p = await pod()
    await sh('echo after-the-last-pass > /workspace/late.txt')
    // Every process of the pod's sandbox, killed outright on its node: no
    // TERM, so no final pass.
    const uid = (await kubectl(['get', 'pod', '-n', k8sNamespace(), p.podName, '-o', 'jsonpath={.metadata.uid}'])).stdout.replace(/-/g, '_')
    const node = (await kubectl(['get', 'pod', '-n', k8sNamespace(), p.podName, '-o', 'jsonpath={.spec.nodeName}'])).stdout
    await execFileAsync('podman', ['exec', node, 'sh', '-c',
      `CG=$(find /sys/fs/cgroup -maxdepth 5 -type d -name '*pod${uid}.slice' | head -1); kill -9 $(cat $CG/*/cgroup.procs $CG/cgroup.procs 2>/dev/null) 2>/dev/null; true`])
    const [, second] = await lives()
    // The reaper records the death, and the salvage stamps the life.
    await vi.waitFor(async () => {
      expect((await manifest(second))?.final).toBe(true)
    }, { timeout: 300_000, interval: 2_000 })
    await restart()
    expect(await sh('cat /workspace/late.txt /workspace/notes.txt')).toBe('after-the-last-pass\nunsaved\n')
  }, 900_000)

  it('refuses a restart whose checkpoint is unreadable, and with --restore-newest restores what still is', async () => {
    await sh('echo after-the-damage > /workspace/lost.txt')
    await stop()
    const newest = (await lives()).at(-1)!
    const m = await fs.readFile(path.join(checkpoints(), 'lives', newest, 'manifest.json'), 'utf8').then((t) => JSON.parse(t) as { bundles: string[] })
    expect(m.bundles.length).toBeGreaterThan(1)
    const last = path.join(checkpoints(), m.bundles.at(-1)!)
    await fs.truncate(last, (await fs.stat(last)).size - 10)

    const refused = await runYaac(serverEnv, 'workspace', 'restart', workspaceId)
    expect(refused.exitCode).not.toBe(0)
    expect(`${refused.stdout}${refused.stderr}`).toContain('--restore-newest')
    await vi.waitFor(async () => {
      expect((await listWorkspacePods(PROJECT_ID)).filter((p) => p.workspaceId === workspaceId)).toEqual([])
    }, { timeout: 180_000, interval: 2_000 })

    const { exitCode, stdout, stderr } = await runYaac(serverEnv, 'workspace', 'restart', workspaceId, '--restore-newest')
    expect(exitCode, `${stdout}\n${stderr}`).toBe(0)
    await vi.waitFor(() => pod(), { timeout: 300_000, interval: 2_000 })
    // The chain before the damaged bundle: what came before it is back,
    // what only it held is not, and the bundle is set aside, not deleted.
    expect(await sh('cat /workspace/notes.txt')).toBe('unsaved\n')
    expect(await sh('test -e /workspace/lost.txt && echo there || echo gone')).toBe('gone\n')
    await expect(fs.stat(`${last}.unreadable`)).resolves.toBeDefined()
  }, 900_000)

  it('stops the workspace that fills its node past the stop floor, naming the disk it used', async () => {
    const usage = await (await api('/server/usage')).json() as ResourceReport
    expect(usage.nodeDisks?.length).toBeGreaterThan(0)
    expect(usage.nodeDisks?.every((d) => d.error === undefined && d.totalBytes > 0), JSON.stringify(usage.nodeDisks)).toBe(true)
    // Other users of the host disk move its free space during the suite,
    // so write what crosses the floor now, plus a margin.
    const fillMiB = Math.ceil((await hostFreeGiB() - stopFloorGiB + 0.75) * 1024)
    expect(fillMiB, 'the host freed too much disk since the suite started').toBeLessThan(6 * 1024)
    // The stop it causes can kill the write, and the exec with it.
    await sh(`dd if=/dev/zero of=/workspace/big.bin bs=1M count=${String(Math.max(fillMiB, 1100))} status=none || true`).catch(() => '')
    await vi.waitFor(async () => {
      expect((await listWorkspacePods(PROJECT_ID)).filter((p) => p.workspaceId === workspaceId && p.running)).toEqual([])
    }, { timeout: 180_000, interval: 2_000 })
    // The pod can be gone a moment before the stop is recorded.
    const detail = await vi.waitFor(async () => {
      const stopped = await (await api(`/workspace/list-stopped?workspace=${workspaceId}`)).json() as {
        entries: Array<{ workspaceId: string; deathReason?: string; deathDetail?: string }>
      }
      const entry = stopped.entries.find((e) => e.workspaceId === workspaceId)
      expect(entry, JSON.stringify(stopped)).toBeDefined()
      return entry!
    }, { timeout: 60_000, interval: 2_000 })
    expect(detail.deathReason).toBe('disk-full')
    expect(detail.deathDetail).toMatch(/held \d+\.\d GiB on node/)
  }, 400_000)
})
