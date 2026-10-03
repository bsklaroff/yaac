import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ConfinedPathError, openRoot, type ConfinedRoot } from '#lib/confined-fs'
import { runGit } from './run'

/** What a snapshot may copy, and how many files. */
const MAX_SNAPSHOT_BYTES = 256 * 1024 * 1024
const MAX_SNAPSHOT_FILES = 200_000
/** A pack bigger than this is refused rather than sent. */
const MAX_PACK_BYTES = 256 * 1024 * 1024
/** The reader's limits: heap, address space (which bounds the buffers the
 *  heap limit does not), and time. Node itself maps about 1.2 GiB. */
const READER_HEAP_MB = 256
export const READER_ADDRESS_SPACE_KB = 2560 * 1024
const READER_TIMEOUT_MS = 120_000
/** Readers running at once, across every caller. */
const MAX_READERS = 2

let readerOverride: string | null = null
let readers = 0

/**
 * Run a reader built elsewhere (tests, which run from source). Only built
 * JavaScript can run in the reader's sandbox: tsx's loader needs a worker
 * thread, and a worker can leave the permission model.
 */
export function setPeerReaderEntry(file: string | null): void {
  readerOverride = file
}

/** The built, self-contained `peer-reader`, beside the bundle in `dist/`. */
function readerEntry(): string {
  if (readerOverride !== null) return readerOverride
  if (import.meta.url.endsWith('.ts')) throw new Error('reading another workspace needs the built yaac')
  return fileURLToPath(new URL('./git-peer-reader.mjs', import.meta.url))
}

const tooMuch = (): Error => new Error('the workspace holds too much unshared history to send')

/**
 * Copy what the reader needs from a checkout's git dir (HEAD, the branches
 * and the object store, never `objects/info`) into `dest`, through a
 * confined root that refuses every link. The copy is a tree the server
 * wrote and holds no link, which is what makes the reader's read permission
 * a boundary: Node checks a path as written, so a link inside the allowed
 * tree would lead out of it.
 */
async function snapshotGitDir(checkoutDir: string, dest: string): Promise<void> {
  const root: ConfinedRoot | null = await openRoot(checkoutDir, 'no-links', { base: path.join(checkoutDir, '.git') })
    .catch(() => null)
  // A `.git` that is a link is unreachable here, like a missing one.
  if (!(await root?.stat(''))?.isDirectory()) throw new Error('the workspace has no checkout')
  let bytes = 0
  let files = 0
  const copy = async (rel: string): Promise<void> => {
    if (++files > MAX_SNAPSHOT_FILES) throw tooMuch()
    const data = await root!.readFile(rel, { maxBytes: MAX_SNAPSHOT_BYTES - bytes }).catch((err: unknown) => {
      throw err instanceof ConfinedPathError && err.reason === 'too-large' ? tooMuch() : err
    })
    if (data === null) return
    bytes += data.length
    await fs.mkdir(path.dirname(path.join(dest, rel)), { recursive: true })
    await fs.writeFile(path.join(dest, rel), data)
  }
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await root!.readdir(dir)) {
      const rel = `${dir}/${entry.name}`
      if (entry.isDirectory()) {
        if (rel !== 'objects/info') await walk(rel)
      } else if (entry.isFile()) await copy(rel)
    }
  }
  await copy('HEAD')
  await copy('packed-refs')
  await walk('refs/heads')
  await walk('objects')
}

/**
 * Whether a ref name is safe to write into the bundle header and into the
 * receiving checkout: plain characters, no empty or dot-led component, no
 * `..` or `.lock`, and not `refs/heads/HEAD`, which the caller's refspecs
 * would map onto HEAD's own destination.
 */
function safeRefName(name: string): boolean {
  return name === 'HEAD' || (
    name.startsWith('refs/heads/')
    && name !== 'refs/heads/HEAD'
    && /^[A-Za-z0-9._+/-]+$/.test(name)
    && !name.includes('..')
    && !name.endsWith('.lock')
    && name.split('/').every((part) => part !== '' && !part.startsWith('.')))
}

/**
 * Run the reader on a snapshot and return what it wrote: a JSON line, then
 * a pack. Node's permission model lets it read only the snapshot and its own
 * file, with no process, worker, addon, WASI, inspector or write (and no
 * network where this Node can deny it); `ulimit -v` bounds its memory where
 * the OS supports it (not macOS).
 */
async function runReader(snapshot: string): Promise<Buffer> {
  const entry = readerEntry()
  const permission = process.allowedNodeEnvironmentFlags.has('--permission') ? '--permission' : '--experimental-permission'
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/sh', [
      '-c', 'ulimit -v "$0" 2>/dev/null; exec "$@"', String(READER_ADDRESS_SPACE_KB),
      process.execPath, permission, `--allow-fs-read=${entry}`, `--allow-fs-read=${snapshot}`,
      `--max-old-space-size=${String(READER_HEAP_MB)}`, entry, snapshot,
    ], { env: {}, stdio: ['ignore', 'pipe', 'pipe'], timeout: READER_TIMEOUT_MS, killSignal: 'SIGKILL' })
    const out: Buffer[] = []
    let size = 0
    let refused = false
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_PACK_BYTES) {
        refused = true
        child.kill('SIGKILL')
        return
      }
      out.push(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-2000) })
    child.on('error', reject)
    child.on('close', (code, signal) => {
      if (code === 0) return resolve(Buffer.concat(out))
      reject(refused ? tooMuch() : new Error(
        signal !== null ? 'reading its git took too long or too much memory'
          : stderr.trim().split('\n').pop() || `the git reader exited with ${String(code)}`,
      ))
    })
  })
}

/**
 * A git bundle of a checkout's branches and HEAD, holding only the objects
 * the checkout has that the project's main clone (`repoPath`) may not
 * (docs/server-git.md, "Reading another workspace's git"). The checkout is
 * read, never run: its git data is copied into a link-free snapshot, which
 * `peer-reader` parses in a sandboxed child process. A ref is dropped when
 * its tip is in neither the checkout nor the main clone, so one dangling
 * branch cannot fail the caller's whole fetch. At most `MAX_READERS` run at
 * once; another call is refused. Rejects with a reason for the caller.
 */
export async function bundleCheckout(checkoutDir: string, repoPath: string): Promise<Buffer<ArrayBuffer>> {
  if (readers >= MAX_READERS) throw new Error('other workspaces are being read right now; try again in a minute')
  readers++
  let dest: string | undefined
  try {
    dest = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-git-peer-'))
    const snapshot = await fs.realpath(dest)
    await snapshotGitDir(checkoutDir, snapshot)
    const out = await runReader(snapshot)
    const newline = out.indexOf('\n')
    const { refs } = JSON.parse(out.subarray(0, newline).toString('utf8')) as { refs: Array<[string, string, boolean]> }
    const named = refs.filter(([name, oid]) => safeRefName(name) && /^[0-9a-f]{40}$/.test(oid))
    const borrowed = [...new Set(named.filter(([, , own]) => !own).map(([, oid]) => oid))]
    const inMainClone = new Set(borrowed.length === 0 ? [] : (await runGit(
      { kind: 'repo', repoPath }, ['rev-list', '--no-walk', '--ignore-missing', ...borrowed],
    )).split('\n'))
    const header = named.filter(([, oid, own]) => own || inMainClone.has(oid))
      .map(([name, oid]) => `${oid} ${name}\n`).join('')
    return Buffer.concat([Buffer.from(`# v2 git bundle\n${header}\n`), out.subarray(newline + 1)])
  } finally {
    readers--
    if (dest !== undefined) await fs.rm(dest, { recursive: true, force: true })
  }
}
