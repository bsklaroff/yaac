/**
 * The node-local orphan sweep, through its one barrel entry. The POD is
 * what the server hands the cluster; the SCRIPT is what decides what goes,
 * so it is run for real against a tree laid out the way a node's is.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const execFileAsync = promisify(execFile)

vi.mock('#drivers/k8s/substrate/kubectl', () => ({
  isKubectlAbsentError: vi.fn(() => false),
  kubectlErrorSummary: vi.fn((e: unknown) => String(e)),
  k8sNamespace: vi.fn(() => 'test-ns'),
  dataDirHash: vi.fn(() => 'ddh16'),
  kubectlApply: vi.fn().mockResolvedValue(undefined),
  kubectlGetJson: vi.fn(),
  kubectlWithRetry: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
  execFileAsync: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
}))
vi.mock('#drivers/k8s/container/registry', () => ({
  registryHasTag: vi.fn().mockResolvedValue(true),
  registryRef: vi.fn((tag: string) => `localhost:5001/${tag}`),
  pushImageToRegistry: vi.fn((tag: string) => Promise.resolve(`localhost:5001/${tag}`)),
}))
vi.mock('#log', () => ({ serverLog: vi.fn(), pipeToServerLog: vi.fn() }))

import { reapNodeLocal } from '#drivers/k8s/images'
import {
  NODE_LOCAL_SWEEP_INTERVAL_MS,
  _resetNodeLocalSweepForTests,
  buildNodeLocalSweepScript,
} from '#drivers/k8s/images/node-local-sweep'
import { kubectlApply, kubectlGetJson, kubectlWithRetry } from '#drivers/k8s/substrate/kubectl'

const mockApply = vi.mocked(kubectlApply)
const mockGetJson = vi.mocked(kubectlGetJson)
const mockWithRetry = vi.mocked(kubectlWithRetry)

interface PodManifest {
  metadata: { name: string; namespace: string; labels: Record<string, string> }
  spec: {
    nodeName: string
    tolerations: unknown[]
    runtimeClassName?: string
    volumes: Array<{ hostPath?: { path: string } }>
    containers: Array<{ command: string[]; securityContext: unknown; volumeMounts: Array<{ mountPath: string }> }>
  }
}
const appliedPods = (): PodManifest[] => mockApply.mock.calls.map((c) => c[0] as unknown as PodManifest)

function stageNodes(names: string[]): void {
  mockGetJson.mockImplementation((args: string[]): Promise<unknown> => {
    if (args[1] === 'nodes') return Promise.resolve({ items: names.map((name) => ({ metadata: { name } })) })
    return Promise.resolve({ status: { phase: 'Succeeded' } })
  })
}

beforeEach(() => {
  mockApply.mockReset().mockResolvedValue(undefined)
  mockGetJson.mockReset()
  mockWithRetry.mockReset().mockResolvedValue({ stdout: '', stderr: '' })
  _resetNodeLocalSweepForTests()
})

describe('reapNodeLocal', () => {
  it('runs one root pod per node over the install\'s node tree, with the live set as argv', async () => {
    stageNodes(['n1', 'n2'])
    await reapNodeLocal(new Map([['demo', new Set(['a', 'b'])], ['empty', new Set()]]))

    const pods = appliedPods()
    expect(pods.map((p) => p.spec.nodeName)).toEqual(['n1', 'n2'])
    for (const pod of pods) {
      expect(pod.metadata.namespace).toBe('test-ns')
      expect(pod.spec.runtimeClassName).toBeUndefined()
      expect(pod.spec.tolerations).toEqual([{ operator: 'Exists' }])
      expect(pod.spec.containers[0].securityContext).toEqual({ runAsUser: 0 })
      expect(pod.spec.volumes[0].hostPath?.path).toBe('/var/lib/yaac/node/ddh16')
      expect(pod.spec.containers[0].volumeMounts).toEqual([{ name: 'node', mountPath: '/node' }])
      const argv = pod.spec.containers[0].command.slice(4)
      expect(argv).toHaveLength(2)
      expect(Number(argv[0])).toBeGreaterThan(0)
      expect(argv[1]).toBe('demo=a,b')
    }
    await expect(execFileAsync('sh', ['-n', '-c', pods[0].spec.containers[0].command[2]])).resolves.toBeTruthy()
  })

  it('first deletes the sweep pods a previous server life left behind, by this install\'s labels', async () => {
    stageNodes(['n1'])
    await reapNodeLocal(new Map())
    // runPodToCompletion deletes each finished pod by name; the stray
    // delete is the one by label, and it comes before any pod is applied.
    const strays = mockWithRetry.mock.calls
      .map(([args], i) => ({ args, order: mockWithRetry.mock.invocationCallOrder[i] }))
      .filter(({ args }) => args[0] === 'delete' && args.includes('-l'))
    expect(strays).toHaveLength(1)
    expect(strays[0].args).toContain('app=yaac-node-local-sweep,yaac.sweep-data-dir-hash=ddh16')
    expect(strays[0].order).toBeLessThan(mockApply.mock.invocationCallOrder[0])
  })

  it('throttles to once per interval, and runs again after it', async () => {
    stageNodes(['n1'])
    await reapNodeLocal(new Map(), { nowMs: 1_000_000 })
    await reapNodeLocal(new Map(), { nowMs: 1_000_000 + 60_000 })
    expect(appliedPods()).toHaveLength(1)
    await reapNodeLocal(new Map(), { nowMs: 1_000_000 + NODE_LOCAL_SWEEP_INTERVAL_MS })
    expect(appliedPods()).toHaveLength(2)
  })

  it('never rejects: a node whose pod fails is logged and the next one still runs', async () => {
    mockGetJson.mockImplementation((args: string[]): Promise<unknown> => {
      if (args[1] === 'nodes') return Promise.resolve({ items: [{ metadata: { name: 'n1' } }, { metadata: { name: 'n2' } }] })
      return Promise.resolve({ status: { phase: 'Failed' } })
    })
    await expect(reapNodeLocal(new Map())).resolves.toBeUndefined()
    expect(appliedPods()).toHaveLength(2)
  })

  describe('the in-pod script, run for real against a node tree', () => {
    let root: string
    const STALE = new Date(Date.now() - 3_600_000)

    beforeEach(async () => {
      root = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-node-sweep-'))
    })
    afterEach(async () => {
      await fs.rm(root, { recursive: true, force: true })
    })

    async function seed(rel: string, when = STALE): Promise<string> {
      const dir = path.join(root, rel)
      await fs.mkdir(dir, { recursive: true })
      await fs.writeFile(path.join(dir, 'f'), 'x')
      await fs.utimes(dir, when, when)
      return dir
    }

    /** Run the script with `root` standing in for the pod's /node mount. */
    async function run(keep: string[], cutoffEpoch: number): Promise<string> {
      const script = buildNodeLocalSweepScript().replaceAll('/node/', `${root}/`)
      const { stdout } = await execFileAsync('sh', ['-c', script, '--', String(cutoffEpoch), ...keep])
      return stdout
    }

    it('spares the live ids per slug, removes the rest, and honours the cutoff', async () => {
      const liveModules = await seed('projects/demo/.cached-packages/modules/live')
      const deadModules = await seed('projects/demo/.cached-packages/modules/dead')
      const liveCopy = await seed('projects/demo/opencode-data/live')
      const stoppedCopy = await seed('projects/demo/opencode-data/stopped')
      const otherSlugSameId = await seed('projects/other/opencode-data/live')
      const fresh = await seed('projects/demo/opencode-data/staging', new Date())
      const store = await seed('projects/demo/.cached-packages/pnpm-store/v3')

      const out = await run(['demo=live,x'], Math.floor((Date.now() - 10_000) / 1000))

      for (const kept of [liveModules, liveCopy, fresh, store]) {
        await expect(fs.access(kept)).resolves.toBeUndefined()
      }
      for (const gone of [deadModules, stoppedCopy, otherSlugSameId]) {
        await expect(fs.access(gone)).rejects.toThrow()
      }
      expect(out).toContain('removed demo/.cached-packages/modules/dead')
      expect(out).toContain('removed demo/opencode-data/stopped')
      expect(out).toContain('removed other/opencode-data/live')
      expect(out.trim().endsWith('node-local-sweep removed 3')).toBe(true)
    })

    it('never walks through a symlink a pod planted, at any level', async () => {
      // A pod can turn any pod-writable directory of the tree into a link;
      // the sweep runs as root, so following one is an rm -rf of its target.
      const victim = await seed('victim/precious')
      await fs.mkdir(path.join(root, 'projects'), { recursive: true })
      await fs.symlink(path.join(root, 'victim'), path.join(root, 'projects/evil'))
      await fs.mkdir(path.join(root, 'projects/demo/.cached-packages'), { recursive: true })
      await fs.symlink(path.join(root, 'victim'), path.join(root, 'projects/demo/.cached-packages/modules'))
      await fs.mkdir(path.join(root, 'projects/demo/opencode-data'), { recursive: true })
      await fs.symlink(path.join(root, 'victim'), path.join(root, 'projects/demo/opencode-data/linked'))
      await fs.symlink('../../..', path.join(root, 'projects/demo/opencode-data/relative'))

      const out = await run([], Math.floor(Date.now() / 1000) + 60)

      await expect(fs.access(victim)).resolves.toBeUndefined()
      await expect(fs.access(path.join(root, 'projects'))).resolves.toBeUndefined()
      expect(out.trim()).toBe('node-local-sweep removed 0')
    })

    it('is a no-op on an empty tree', async () => {
      const out = await run([], Math.floor(Date.now() / 1000))
      expect(out.trim()).toBe('node-local-sweep removed 0')
    })
  })
})
