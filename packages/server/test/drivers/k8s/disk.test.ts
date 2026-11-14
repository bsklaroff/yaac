import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import { fakeCluster } from '@yaac/test-utils/k8s-stub'
import { testTmpBase } from '@yaac/test-utils/tmp'
import { buildDiskProgram } from '@yaac/test-utils/workspace-bin-helpers'
import { readNodeDisks, watchNodeDisks } from '#drivers/k8s/disk'
import { LABEL_INSTALL_ID, installId, k8sNamespace } from '#drivers/k8s/substrate'

/**
 * Each node's disk as the k8s driver reads it: the real `yaac-disk` program,
 * built as a release builds it, answering for a temporary node-local root on
 * a local port, and `fakeCluster` holding the nodes and the disk pod that
 * points there.
 */

const GiB = 1024 ** 3
let tmp: string
let root: string
let port: number
let disk: ChildProcess

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = net.createServer().listen(0, '127.0.0.1', () => {
      const p = (srv.address() as net.AddressInfo).port
      srv.close(() => resolve(p))
    })
  })
}

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(testTmpBase(), 'yaac-disk-'))
  root = path.join(tmp, 'node-local')
  const tree = (w: string): string => path.join(root, 'projects', 'p1', 'trees', w, 'L1', 'tree')
  await fs.mkdir(tree('w-big'), { recursive: true })
  await fs.writeFile(path.join(tree('w-big'), 'big.bin'), Buffer.alloc(3 * 1024 * 1024, 1))
  await fs.mkdir(path.join(tree('w-sparse'), 'deep', 'er'), { recursive: true })
  // A sparse file is measured by what it allocates, not its length.
  const fh = await fs.open(path.join(tree('w-sparse'), 'deep', 'er', 'sparse'), 'w')
  await fh.truncate(GiB)
  await fh.close()
  port = await freePort()
  // `--kubelet` is the root itself, so trees count as on kubelet's disk.
  disk = spawn('node', [await buildDiskProgram(), '--root', root, '--kubelet', root, '--port', String(port)], { stdio: 'ignore' })
  for (let i = 0; i < 100; i++) {
    if (await fetch(`http://127.0.0.1:${String(port)}/disk`).then(() => true, () => false)) break
    await new Promise((r) => setTimeout(r, 100))
  }
})

afterAll(async () => {
  disk.kill()
  await fs.rm(tmp, { recursive: true, force: true })
})

afterEach(() => {
  vi.unstubAllEnvs()
})

function seed(): void {
  const node = (name: string, kubeletVersion: string) => ({
    apiVersion: 'v1', kind: 'Node', metadata: { name }, status: { nodeInfo: { kubeletVersion } },
  })
  const diskPod = (name: string, nodeName: string) => ({
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: { name, namespace: k8sNamespace(), labels: { app: 'yaac-disk', [LABEL_INSTALL_ID]: installId() } },
    spec: { nodeName, containers: [{ name: 'disk', ports: [{ containerPort: port }] }] },
    status: { phase: 'Running', podIP: '127.0.0.1' },
  })
  fakeCluster.seed(
    node('node-a', 'v1.34.1'),
    node('node-k3s', 'v1.34.1+k3s1'),
    node('node-empty', 'v1.34.1'),
    diskPod('disk-a', 'node-a'),
    diskPod('disk-k3s', 'node-k3s'),
  )
}

describe('readNodeDisks', () => {
  it('answers each node\'s free space against its floors, and its trees when asked', async () => {
    seed()
    const disks = await readNodeDisks({ trees: false })
    const byNode = new Map(disks.map((d) => [d.node, d]))
    const a = byNode.get('node-a')!
    expect(a.error).toBeUndefined()
    expect(a.totalBytes).toBeGreaterThan(a.freeBytes)
    expect(a.sharesKubeletDisk).toBe(true)
    // kind: no storage class, kubelet evicts at 0%, so the floors are the
    // settings alone.
    expect(a).toMatchObject({ warnBytes: 10 * GiB, stopBytes: 5 * GiB })
    expect(a.trees).toBeUndefined()
    expect(byNode.get('node-empty')).toMatchObject({ error: 'no disk pod is running on this node' })

    const trees = (await readNodeDisks({ trees: true })).find((d) => d.node === 'node-a')!.trees!
    expect(trees.map((t) => t.workspaceId)).toEqual(['w-big', 'w-sparse'])
    expect(trees[0]).toMatchObject({ projectId: 'p1', life: 'L1' })
    expect(trees[0].bytes).toBeGreaterThanOrEqual(3 * 1024 * 1024)
    expect(trees[1].bytes).toBeLessThan(1024 * 1024)
  })

  it('puts the floors above kubelet\'s own threshold where trees share its disk on a byo node', async () => {
    seed()
    vi.stubEnv('YAAC_VOLUME_STORAGE_CLASS', 'nfs')
    vi.stubEnv('YAAC_DISK_STOP_FLOOR_GIB', '2')
    const disks = new Map((await readNodeDisks({ trees: false })).map((d) => [d.node, d]))
    const a = disks.get('node-a')!
    expect(a.stopBytes).toBeCloseTo(a.totalBytes * 0.1 + 2 * GiB)
    expect(a.warnBytes).toBeCloseTo(a.totalBytes * 0.1 + 10 * GiB)
    const k3s = disks.get('node-k3s')!
    expect(k3s.stopBytes).toBeCloseTo(k3s.totalBytes * 0.05 + 2 * GiB)
  })
})

describe('watchNodeDisks', () => {
  it('raises the trigger while a node is under its warn floor, and not otherwise', async () => {
    seed()
    const raised: string[] = []
    vi.stubEnv('YAAC_DISK_WARN_FLOOR_GIB', '0')
    vi.stubEnv('YAAC_DISK_STOP_FLOOR_GIB', '0')
    let stop = watchNodeDisks((s) => raised.push(s))
    await new Promise((r) => setTimeout(r, 6_000))
    stop()
    expect(raised).toEqual([])
    vi.stubEnv('YAAC_DISK_WARN_FLOOR_GIB', String(1024 * 1024))
    stop = watchNodeDisks((s) => raised.push(s))
    await vi.waitFor(() => { expect(raised).toContain('disk-low') }, { timeout: 8_000, interval: 200 })
    stop()
  }, 20_000)
})
