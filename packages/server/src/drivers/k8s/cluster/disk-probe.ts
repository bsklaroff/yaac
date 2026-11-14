/**
 * `yaac-disk`: the per-node disk pod's program (docs/node-local-workspaces.md
 * "A full node"), built into a self-contained `dist/yaac-disk.mjs` that runs
 * in the server image. It answers one request, `GET /disk`, with the free
 * space of the node-local root and, with `?trees=1`, the size of every
 * life's tree there in allocated blocks, so a sparse file is not blamed for
 * space it does not use.
 *
 *   node yaac-disk.mjs --root /node-local --port 8790
 *
 * It runs as root with the root mounted read-only, since an agent's `sudo`
 * can put gigabytes in a folder another uid cannot list, and runs no
 * workspace's code. Whether trees share kubelet's filesystem it tells from
 * `/etc/hosts`, a file kubelet keeps for the container in its own folder,
 * so nothing of kubelet's needs mounting; `--kubelet` names another file.
 */
import fs from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'

/** One life's tree and scratch repository: `projects/<p>/trees/<w>/<life>`. */
export interface TreeSize { project: string; workspace: string; life: string; bytes: number }

export interface DiskReading {
  totalBytes: number
  freeBytes: number
  /** Whether the node-local root is on kubelet's own filesystem. */
  sharesKubeletDisk: boolean
  trees?: TreeSize[]
  /** The walk ran out of its budget, so some trees are undercounted. */
  truncated?: boolean
}

/** Walking the trees stops after this many entries, a bound on one answer's time. */
const MAX_ENTRIES = 5_000_000

/** Allocated bytes under `dir`, each inode once, never following a link. */
async function allocated(dir: string, seen: Set<string>, budget: { left: number }): Promise<number> {
  let total = 0
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
  for (const e of entries) {
    if (--budget.left < 0) break
    const p = path.join(dir, e.name)
    const st = await fs.lstat(p, { bigint: true }).catch(() => null)
    if (!st) continue
    const id = `${String(st.dev)}:${String(st.ino)}`
    if (!seen.has(id)) {
      seen.add(id)
      total += Number(st.blocks) * 512
    }
    if (e.isDirectory()) total += await allocated(p, seen, budget)
  }
  return total
}

export async function readDisk(root: string, kubelet: string, withTrees: boolean): Promise<DiskReading> {
  const s = await fs.statfs(root)
  const rootDev = (await fs.stat(root)).dev
  const kubeletDev = (await fs.stat(kubelet).catch(() => null))?.dev
  const reading: DiskReading = {
    totalBytes: s.blocks * s.bsize,
    freeBytes: s.bavail * s.bsize,
    sharesKubeletDisk: kubeletDev !== undefined && kubeletDev === rootDev,
  }
  if (!withTrees) return reading
  const trees: TreeSize[] = []
  const budget = { left: MAX_ENTRIES }
  const projects = path.join(root, 'projects')
  for (const project of await fs.readdir(projects).catch(() => [])) {
    for (const workspace of await fs.readdir(path.join(projects, project, 'trees')).catch(() => [])) {
      for (const life of await fs.readdir(path.join(projects, project, 'trees', workspace)).catch(() => [])) {
        const bytes = await allocated(path.join(projects, project, 'trees', workspace, life), new Set(), budget)
        trees.push({ project, workspace, life, bytes })
      }
    }
  }
  return { ...reading, trees: trees.sort((a, b) => b.bytes - a.bytes), ...(budget.left < 0 ? { truncated: true } : {}) }
}

function flags(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (let i = 0; i + 1 < argv.length; i += 2) out[argv[i].replace(/^--/, '')] = argv[i + 1]
  return out
}

function main(): void {
  const f = flags(process.argv.slice(2))
  if (!f.root) throw new Error('--root is required')
  http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://disk')
    if (req.method !== 'GET' || url.pathname !== '/disk') {
      res.writeHead(404).end()
      return
    }
    readDisk(f.root, f.kubelet ?? '/etc/hosts', url.searchParams.get('trees') === '1').then((r) => {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(r))
    }, (err: unknown) => {
      res.writeHead(500).end(err instanceof Error ? err.message : String(err))
    })
  }).listen(Number(f.port ?? 8790))
}

// Run only as the program, not when the server imports the reading's types.
if (process.argv[1]?.endsWith('yaac-disk.mjs')) main()
