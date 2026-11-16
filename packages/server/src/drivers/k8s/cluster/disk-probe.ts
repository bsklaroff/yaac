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
import { lstatSync, readdirSync, type BigIntStats, type Dirent } from 'node:fs'
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
/** How long a finished walk answers later asks. A walk outlasting the
 *  server's timeout keeps going, and the server's next ask, a few seconds
 *  on, gets its result rather than starting another. */
const KEEP_WALK_MS = 15_000

/**
 * Allocated bytes under `dir`, each inode once, never following a link.
 * The calls are synchronous because Node's promise-based ones cost tens of
 * microseconds of CPU each, which under the pod's CPU limit made a tree of
 * tens of thousands of files take seconds. It hands the event loop back
 * every thousand or so entries, so a free-space ask is answered mid-walk.
 */
async function allocated(dir: string, budget: { left: number }): Promise<number> {
  const seen = new Set<string>()
  const stack = [dir]
  let total = 0
  let sinceYield = 0
  while (stack.length > 0) {
    const d = stack.pop() as string
    let entries: Dirent[] = []
    try { entries = readdirSync(d, { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      if (--budget.left < 0) return total
      const p = path.join(d, e.name)
      let st: BigIntStats
      try { st = lstatSync(p, { bigint: true }) } catch { continue }
      const id = `${String(st.dev)}:${String(st.ino)}`
      if (!seen.has(id)) total += Number(st.blocks) * 512
      seen.add(id)
      if (e.isDirectory()) stack.push(p)
    }
    sinceYield += entries.length
    if (sinceYield >= 1000) {
      sinceYield = 0
      await new Promise((r) => setImmediate(r))
    }
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
        const bytes = await allocated(path.join(projects, project, 'trees', workspace, life), budget)
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
  const kubelet = f.kubelet ?? '/etc/hosts'
  // The guard and the health report can ask at once; they share one walk.
  let walking: Promise<DiskReading> | null = null
  let walked: { at: number; reading: DiskReading } | null = null
  http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://disk')
    if (req.method !== 'GET' || url.pathname !== '/disk') {
      res.writeHead(404).end()
      return
    }
    const kept = walked !== null && Date.now() - walked.at < KEEP_WALK_MS ? walked.reading : null
    const reading = url.searchParams.get('trees') !== '1'
      ? readDisk(f.root, kubelet, false)
      // A kept walk's trees, with the free space as it is now.
      : kept ? readDisk(f.root, kubelet, false).then((now) => ({ ...kept, ...now }))
      : walking ??= readDisk(f.root, kubelet, true)
        .then((r) => { walked = { at: Date.now(), reading: r }; return r })
        .finally(() => { walking = null })
    reading.then((r) => {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(r))
    }, (err: unknown) => {
      res.writeHead(500).end(err instanceof Error ? err.message : String(err))
    })
  }).listen(Number(f.port ?? 8790))
}

// Run only as the program, not when the server imports the reading's types.
if (process.argv[1]?.endsWith('yaac-disk.mjs')) main()
