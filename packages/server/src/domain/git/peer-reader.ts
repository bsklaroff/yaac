/**
 * The child process behind `bundleCheckout` (docs/server-git.md, "Reading
 * another workspace's git"). It is given a snapshot of a checkout's git
 * data, which the server copied with every link refused, and writes to
 * stdout one JSON line naming the refs it found, then a pack of every object
 * the snapshot holds that they reach.
 *
 * The data is agent-written, so it is parsed, never obeyed. isomorphic-git
 * starts no process and does not read `objects/info/alternates`, so the walk
 * stops at the first object the checkout borrows from the main clone. This
 * process runs under Node's permission model, reading only the snapshot and
 * its own file and refusing to start otherwise, and inside an address-space
 * limit that bounds what inflating an object can allocate; the parent also
 * caps its time and output.
 *
 * Usage: git-peer-reader <snapshot git dir>. Exits non-zero with a one-line
 * reason on stderr.
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { deflateSync } from 'node:zlib'
import git, { type CommitObject, type TagObject, type TreeObject } from 'isomorphic-git'

/** Caps on what the pack may carry. Memory is bounded by the address-space
 *  limit, since an object's declared size can lie about what it inflates to;
 *  the object cap keeps a read well inside the parent's two-minute deadline. */
const MAX_OBJECTS = 50_000
const MAX_TOTAL_BYTES = 128 * 1024 * 1024
/** A cap on branches, which are cheap for an agent to make by the million. */
const MAX_REFS = 10_000
const OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/

class ReadError extends Error {}

const tooMuch = (): ReadError => new ReadError('the workspace holds too much unshared history to send')

/**
 * The branches (`packed-refs`, then loose files under `refs/heads`, which
 * win) and HEAD. Read here rather than by isomorphic-git, which drops every
 * branch when one entry is unreadable. Names are checked by the parent.
 */
async function readRefs(gitdir: string): Promise<Map<string, string>> {
  const read = async (rel: string): Promise<string> =>
    fs.promises.readFile(path.join(gitdir, rel), 'utf8').catch(() => '')
  const refs = new Map<string, string>()
  for (const line of (await read('packed-refs')).split('\n')) {
    const [oid, name] = line.split(' ')
    if (refs.size < MAX_REFS && OID.test(oid) && name?.startsWith('refs/heads/')) refs.set(name, oid)
  }
  const walk = async (dir: string): Promise<void> => {
    const entries = await fs.promises.readdir(path.join(gitdir, dir), { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (refs.size >= MAX_REFS) return
      const rel = `${dir}/${entry.name}`
      if (entry.isDirectory()) await walk(rel)
      else if (entry.isFile()) {
        const oid = (await read(rel)).trim()
        if (OID.test(oid)) refs.set(rel, oid)
      }
    }
  }
  await walk('refs/heads')
  const head = (await read('HEAD')).trim()
  const target = head.startsWith('ref: ') ? refs.get(head.slice(5)) : head
  if (target !== undefined && OID.test(target)) refs.set('HEAD', target)
  return refs
}

/** Write to stdout, waiting while the pipe is full. */
async function emit(data: Uint8Array): Promise<void> {
  if (!process.stdout.write(data)) await new Promise((resolve) => process.stdout.once('drain', resolve))
}

const PACK_TYPES: Record<string, number> = { commit: 1, tree: 2, blob: 3, tag: 4 }

/**
 * isomorphic-git's cache for every read, so a pack and its index are loaded
 * once rather than for each object they hold. It keeps the snapshot's packs
 * in memory, which the 256 MiB snapshot cap bounds.
 */
const cache = {}

/**
 * Stream a version-2 pack of `oids` to stdout, one object at a time, so the
 * reader holds about one object rather than the whole pack (isomorphic-git's
 * `packObjects` builds it in memory three times over).
 */
async function writePack(gitdir: string, oids: string[]): Promise<void> {
  const hash = createHash('sha1')
  const write = async (data: Uint8Array): Promise<void> => {
    hash.update(data)
    await emit(data)
  }
  const head = Buffer.alloc(12)
  head.write('PACK')
  head.writeUInt32BE(2, 4)
  head.writeUInt32BE(oids.length, 8)
  await write(head)
  for (const oid of oids) {
    const { type, object } = await git.readObject({ fs, gitdir, oid, format: 'content', cache })
    const content = object as Uint8Array
    // Type and size: 3 type bits and 4 size bits, then 7 size bits a byte.
    let size = content.length
    const header = [(PACK_TYPES[type] << 4) | (size & 0x0f)]
    size = Math.floor(size / 16)
    while (size > 0) {
      header[header.length - 1] |= 0x80
      header.push(size & 0x7f)
      size = Math.floor(size / 128)
    }
    await write(Buffer.from(header))
    await write(deflateSync(content))
  }
  await emit(hash.digest())
}

async function readGit(gitdir: string): Promise<void> {
  const refs = await readRefs(gitdir)
  if ([...refs.values()].some((oid) => oid.length !== 40)) {
    throw new ReadError('only SHA-1 repositories can be read')
  }

  // Everything the snapshot holds itself, reachable from those refs.
  const seen = new Set<string>()
  const own = new Set<string>()
  let bytes = 0
  const stack = [...refs.values()]
  while (stack.length > 0) {
    const oid = stack.pop()!
    if (seen.has(oid)) continue
    seen.add(oid)
    let read: Awaited<ReturnType<typeof git.readObject>>
    try {
      read = await git.readObject({ fs, gitdir, oid, format: 'parsed', cache })
    } catch (err) {
      // Not here: borrowed from the main clone, or nowhere.
      if ((err as { code?: string }).code === 'NotFoundError') continue
      throw err
    }
    own.add(oid)
    if (read.type === 'commit') {
      const commit = read.object as CommitObject
      stack.push(commit.tree, ...commit.parent)
    } else if (read.type === 'tag') stack.push((read.object as TagObject).object)
    else if (read.type === 'tree') {
      // A gitlink (submodule) names a commit in another repository.
      for (const entry of read.object as TreeObject) if (entry.type !== 'commit') stack.push(entry.oid)
    } else bytes += (read.object as Uint8Array).length
    if (own.size > MAX_OBJECTS || bytes > MAX_TOTAL_BYTES) throw tooMuch()
  }

  await emit(Buffer.from(`${JSON.stringify({ refs: [...refs].map(([name, oid]) => [name, oid, own.has(oid)]) })}\n`))
  await writePack(gitdir, [...own])
}

/**
 * Whether this process runs under the sandbox `bundleCheckout` starts it in:
 * Node's permission model with nothing but reads granted. A scope counts
 * only where this Node can enforce it, which its `--allow-*` flag shows;
 * `has()` answers false for a scope it has never heard of. Child processes,
 * workers and writes must be enforceable.
 */
function sandboxed(): boolean {
  const permission = (process as { permission?: { has(scope: string): boolean } }).permission
  if (permission === undefined) return false
  const scopes: Array<[scope: string, flag: string, required: boolean]> = [
    ['child', '--allow-child-process', true],
    ['worker', '--allow-worker', true],
    ['fs.write', '--allow-fs-write', true],
    ['addon', '--allow-addons', false],
    ['wasi', '--allow-wasi', false],
    ['net', '--allow-net', false],
    ['inspector', '--allow-inspector', false],
  ]
  return scopes.every(([scope, flag, required]) => {
    if (!process.allowedNodeEnvironmentFlags.has(flag)) return !required
    return !permission.has(scope)
  })
}

try {
  if (!sandboxed()) throw new ReadError('the git reader runs only under a permission model that grants nothing but reads')
  await readGit(process.argv[2] ?? '')
} catch (err) {
  process.stderr.write(`${
    err instanceof ReadError ? err.message
      : err instanceof RangeError ? 'reading its git took too much memory'
      : `cannot read its git: ${String(err)}`
  }\n`)
  process.exit(1)
}
