/**
 * The node-local orphan sweep. The pod manifest is asserted, and the script
 * that decides what to delete is run for real against a node-like tree.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const execFileAsync = promisify(execFile)

vi.mock('#drivers/k8s/container/registry', () => ({
  registryHasTag: vi.fn().mockResolvedValue(true),
  registryRef: vi.fn((tag: string) => `localhost:5001/${tag}`),
  pushImageToRegistry: vi.fn((tag: string) => Promise.resolve(`localhost:5001/${tag}`)),
}))

import { reapNodeLocal } from '#drivers/k8s/images'
import { buildNodeLocalSweepScript } from '#drivers/k8s/images/node-local-sweep'
import { LABEL_DATA_DIR_HASH, LABEL_WORKSPACE_ID, dataDirHash, k8sNamespace } from '#drivers/k8s/substrate'
import { apiError, fakeCluster } from '@yaac/test-utils/k8s-stub'

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
const appliedPods = (): PodManifest[] =>
  fakeCluster.callsOf('apply', 'Pod').map((c) => c.body as unknown as PodManifest)

/** Every sweep pod the code applies reaches `phase` at once. */
function podsFinish(phase: string): void {
  fakeCluster.intercept((c) => {
    if (c.verb === 'apply' && c.kind === 'Pod') c.body = { ...c.body, status: { phase } }
  })
}

const LIVE = '3f2a9c1e-7b4d-4e8a-9c2f-5d6e7f8a9b0c'
const GONE = 'c9d8e7f6-a5b4-4c3d-8e2f-1a0b9c8d7e6f'
const NOTHING = { projectIds: new Set<string>(), workspaceIds: new Set<string>() }

/** Nodes, and the hostPath volumes this install's workspace pod mounts. */
function stageNodes(names: string[], podHostPaths: string[] = []): void {
  fakeCluster.seed(...names.map((name) => ({ apiVersion: 'v1', kind: 'Node', metadata: { name } })))
  fakeCluster.seed({
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name: 'workspace-pod',
      namespace: k8sNamespace(),
      labels: { [LABEL_DATA_DIR_HASH]: dataDirHash(), [LABEL_WORKSPACE_ID]: 'w1' },
    },
    spec: { volumes: podHostPaths.map((p) => ({ hostPath: { path: p } })) },
  })
}

const NODE_TREE = `/var/lib/yaac/node/${dataDirHash()}`

beforeEach(() => {
  podsFinish('Succeeded')
})

describe('reapNodeLocal', () => {
  it('runs one root pod per node over the install\'s node tree, with the live set as argv', async () => {
    // A pod mounting the slug-named `projects/demo` keeps that tree alive;
    // a volume outside the node-local tree is ignored.
    stageNodes(['n1', 'n2'], [
      `${NODE_TREE}/projects/demo/.cached-packages`,
      `${NODE_TREE}/shared-images/${LIVE}/gen-1`,
      `/var/lib/yaac/global/${dataDirHash()}/projects/elsewhere`,
    ])
    await reapNodeLocal({ projectIds: new Set([LIVE]), workspaceIds: new Set(['a', 'b']) })

    const pods = appliedPods()
    expect(pods.map((p) => p.spec.nodeName)).toEqual(['n1', 'n2'])
    for (const pod of pods) {
      expect(pod.metadata.namespace).toBe(k8sNamespace())
      expect(pod.spec.runtimeClassName).toBeUndefined()
      expect(pod.spec.tolerations).toEqual([{ operator: 'Exists' }])
      expect(pod.spec.containers[0].securityContext).toEqual({ runAsUser: 0 })
      expect(pod.spec.volumes[0].hostPath?.path).toBe(NODE_TREE)
      expect(pod.spec.containers[0].volumeMounts).toEqual([{ name: 'node', mountPath: '/node' }])
      const argv = pod.spec.containers[0].command.slice(4)
      expect(argv).toHaveLength(3)
      expect(Number(argv[0])).toBeGreaterThan(0)
      expect(argv[1].split(',').sort()).toEqual([LIVE, 'demo'].sort())
      expect(argv[2]).toBe('a,b')
    }
    await expect(execFileAsync('sh', ['-n', '-c', pods[0].spec.containers[0].command[2]])).resolves.toBeTruthy()
  })

  it('stands down when the pods holding the tree cannot be read', async () => {
    stageNodes(['n1'])
    fakeCluster.intercept((c) => { if (c.verb === 'list' && c.kind === 'Pod') throw apiError(503) })
    await expect(reapNodeLocal(NOTHING)).resolves.toBeUndefined()
    // An unknown mount set must not read as "nothing is mounted".
    expect(appliedPods()).toHaveLength(0)
  })

  it('first deletes the sweep pods a previous server life left behind, by this install\'s labels', async () => {
    stageNodes(['n1'])
    const labels = { app: 'yaac-node-local-sweep', 'yaac.sweep-data-dir-hash': dataDirHash() }
    fakeCluster.seed(
      { apiVersion: 'v1', kind: 'Pod', metadata: { name: 'stray', namespace: k8sNamespace(), labels } },
      { apiVersion: 'v1', kind: 'Pod', metadata: { name: 'other-install', namespace: k8sNamespace(), labels: { ...labels, 'yaac.sweep-data-dir-hash': 'x' } } },
    )
    await reapNodeLocal(NOTHING)
    // The label delete sweeps leftover pods before any pod is applied.
    const verbs = fakeCluster.calls.map((c) => `${c.verb} ${c.name ?? ''}`)
    expect(verbs.indexOf('delete stray')).toBeGreaterThan(-1)
    expect(verbs.indexOf('delete stray')).toBeLessThan(verbs.findIndex((v) => v.startsWith('apply')))
    expect(fakeCluster.get('Pod', 'other-install')).toBeDefined()
  })

  it('never rejects: a node whose pod fails is logged and the next one still runs', async () => {
    stageNodes(['n1', 'n2'])
    podsFinish('Failed')
    await expect(reapNodeLocal(NOTHING)).resolves.toBeUndefined()
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
    async function run(kept: string[], live: string[], cutoffEpoch: number): Promise<string> {
      const script = buildNodeLocalSweepScript().replaceAll('/node/', `${root}/`)
      const { stdout } = await execFileAsync('sh', ['-c', script, '--', String(cutoffEpoch), kept.join(','), live.join(',')])
      return stdout
    }

    /** Mark a directory stale; call after seeding, which bumps its mtime. */
    const stale = (rel: string): Promise<void> => fs.utimes(path.join(root, rel), STALE, STALE)

    it('keeps live and mounted project trees, removes the rest whole, and honours the cutoff', async () => {
      const liveStore = await seed(`shared-images/${LIVE}/gen-1`)
      const liveCache = await seed(`projects/${LIVE}/.cached-packages`)
      const mounted = await seed('projects/legacy-mounted/.cached-packages')
      const goneTree = await seed(`projects/${GONE}/.cached-packages`)
      const goneStore = await seed(`shared-images/${GONE}/gen-1`)
      const slugNamed = await seed('shared-images/old-slug/gen-1')
      const staging = await seed('projects/just-added/.cached-packages', new Date())
      for (const rel of [`projects/${LIVE}`, 'projects/legacy-mounted', `projects/${GONE}`,
        `shared-images/${GONE}`, 'shared-images/old-slug', `shared-images/${LIVE}`]) await stale(rel)

      const out = await run([LIVE, 'legacy-mounted'], [], Math.floor((Date.now() - 10_000) / 1000))

      for (const kept of [liveStore, liveCache, mounted, staging]) {
        await expect(fs.access(kept)).resolves.toBeUndefined()
      }
      for (const gone of [goneTree, goneStore, slugNamed]) {
        await expect(fs.access(gone)).rejects.toThrow()
      }
      await expect(fs.access(path.join(root, 'projects', GONE))).rejects.toThrow()
      expect(out).toContain(`removed projects/${GONE}`)
      expect(out).toContain(`removed shared-images/${GONE}`)
      expect(out).toContain('removed shared-images/old-slug')
      expect(out.trim().endsWith('node-local-sweep removed 3')).toBe(true)
    })

    it('inside a live project, spares live workspaces\' working copies and removes the rest', async () => {
      const liveCopy = await seed(`projects/${LIVE}/opencode-data/live`)
      const stoppedCopy = await seed(`projects/${LIVE}/opencode-data/stopped`)
      const fresh = await seed(`projects/${LIVE}/opencode-data/staging`, new Date())

      const out = await run([LIVE], ['live', 'x'], Math.floor((Date.now() - 10_000) / 1000))

      for (const kept of [liveCopy, fresh]) {
        await expect(fs.access(kept)).resolves.toBeUndefined()
      }
      await expect(fs.access(stoppedCopy)).rejects.toThrow()
      expect(out).toContain(`removed ${LIVE}/opencode-data/stopped`)
      expect(out.trim().endsWith('node-local-sweep removed 1')).toBe(true)
    })

    it('never walks through a symlink a pod planted, at any level', async () => {
      // A pod can replace a writable directory with a symlink, and the
      // sweep runs as root, so following it would delete the target.
      const victim = await seed('victim/precious')
      await fs.mkdir(path.join(root, 'projects'), { recursive: true })
      await fs.symlink(path.join(root, 'victim'), path.join(root, 'projects/evil'))
      await fs.mkdir(path.join(root, 'projects/demo/opencode-data'), { recursive: true })
      await fs.symlink(path.join(root, 'victim'), path.join(root, 'projects/demo/opencode-data/linked'))
      await fs.symlink('../../..', path.join(root, 'projects/demo/opencode-data/relative'))
      await fs.mkdir(path.join(root, 'projects/other'), { recursive: true })
      await fs.symlink(path.join(root, 'victim'), path.join(root, 'projects/other/opencode-data'))
      await fs.mkdir(path.join(root, 'shared-images'), { recursive: true })
      await fs.symlink(path.join(root, 'victim'), path.join(root, 'shared-images/evil'))

      const future = Math.floor(Date.now() / 1000) + 60
      // `evil` is not live either, but a symlink is skipped entirely.
      const out = await run(['demo', 'other'], [], future)

      await expect(fs.access(victim)).resolves.toBeUndefined()
      await expect(fs.lstat(path.join(root, 'projects/evil'))).resolves.toBeTruthy()
      await expect(fs.lstat(path.join(root, 'shared-images/evil'))).resolves.toBeTruthy()
      expect(out.trim()).toBe('node-local-sweep removed 0')
    })

    it('is a no-op on an empty tree', async () => {
      const out = await run([], [], Math.floor(Date.now() / 1000))
      expect(out.trim()).toBe('node-local-sweep removed 0')
    })
  })
})
