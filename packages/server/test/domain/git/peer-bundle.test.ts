import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { bundleCheckout, cloneRepo, createCheckout, getDefaultBranch } from '#domain/git'
import { git } from '@yaac/test-utils/git'
import { buildPeerReader } from '@yaac/test-utils/peer-reader'
import { READER_ADDRESS_SPACE_KB, setPeerReaderEntry } from '#domain/git/peer-bundle'

// Two checkouts of one main clone, as the server lays them out: a peer with
// work of its own, and a reader that fetches the peer's bundle with plain git.
let tmpDir: string
let main: string
let peer: string
let reader: string

async function commit(repo: string, file: string, message: string): Promise<string> {
  await fs.mkdir(path.dirname(path.join(repo, file)), { recursive: true })
  await fs.writeFile(path.join(repo, file), `${message}\n`)
  await git(repo, ['add', '.'])
  await git(repo, ['-c', 'user.email=t@t', '-c', 'user.name=T', 'commit', '-qm', message])
  return (await git(repo, ['rev-parse', 'HEAD'])).trim()
}

/** Every hook name git runs. */
const HOOKS = [
  'applypatch-msg', 'pre-applypatch', 'post-applypatch', 'pre-commit', 'pre-merge-commit',
  'prepare-commit-msg', 'commit-msg', 'post-commit', 'pre-rebase', 'post-checkout', 'post-merge',
  'pre-push', 'pre-receive', 'update', 'proc-receive', 'post-receive', 'post-update',
  'reference-transaction', 'push-to-checkout', 'pre-auto-gc', 'post-rewrite', 'sendemail-validate',
  'fsmonitor-watchman', 'post-index-change',
]

/** The object ids in a bundle's pack, as git's own pack reader lists them. */
async function packedObjects(bundle: Buffer): Promise<string[]> {
  const dir = await fs.mkdtemp(path.join(tmpDir, 'pack-'))
  await fs.writeFile(path.join(dir, 'b.pack'), bundle.subarray(bundle.indexOf('\n\nPACK') + 2))
  await git(dir, ['index-pack', 'b.pack'])
  return (await git(dir, ['verify-pack', '-v', 'b.idx'])).split('\n')
    .map((line) => line.split(' ')[0]).filter((oid) => /^[0-9a-f]{40}$/.test(oid))
}

/**
 * A zlib stream of `prefix` and then `zeros` zero bytes, about a thousandth
 * of their size, made from one repeated full-flush chunk so the test never
 * holds what it inflates to.
 */
async function deflateBomb(prefix: Buffer, zeros: number): Promise<Buffer> {
  const MiB = 1 << 20
  const deflate = zlib.createDeflate({ level: 9 })
  const parts: Buffer[] = []
  deflate.on('data', (chunk: Buffer) => parts.push(chunk))
  const flushed = async (data: Buffer): Promise<Buffer> => {
    deflate.write(data)
    await new Promise<void>((resolve) => { deflate.flush(zlib.constants.Z_FULL_FLUSH, () => resolve()) })
    return Buffer.concat(parts.splice(0))
  }
  const head = await flushed(prefix)
  const chunk = await flushed(Buffer.alloc(MiB))
  // zlib's Adler-32 trailer over prefix + zeros.
  let a = 1
  let b = 0
  for (const byte of prefix) { a = (a + byte) % 65521; b = (b + a) % 65521 }
  b = (b + a * (zeros % 65521)) % 65521
  const trailer = Buffer.alloc(4)
  trailer.writeUInt32BE(((b << 16) | a) >>> 0)
  return Buffer.concat([head, ...Array<Buffer>(zeros / MiB).fill(chunk), Buffer.from([0x03, 0x00]), trailer])
}

/** Fetch `dir`'s bundle into the reader the way `yaac-mama fetch` does. */
async function fetchInto(dir: string): Promise<string[]> {
  const file = path.join(tmpDir, 'peer.bundle')
  await fs.writeFile(file, await bundleCheckout(dir, main))
  await git(reader, ['-c', 'transfer.fsckObjects=true', 'fetch', '--quiet', '--prune', '--no-tags', file,
    '+refs/heads/*:refs/yaac/peers/peer/*', '+HEAD:refs/yaac/peers/peer/HEAD'])
  return (await git(reader, ['for-each-ref', '--format=%(refname:lstrip=1)', 'refs/yaac/peers/peer/']))
    .trim().split('\n')
}

beforeAll(async () => {
  setPeerReaderEntry(await buildPeerReader())
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-peer-bundle-'))
  const source = path.join(tmpDir, 'source')
  await fs.mkdir(source)
  await git(source, ['init', '-q'])
  await commit(source, 'shared.txt', 'on origin')
  main = path.join(tmpDir, 'main')
  await cloneRepo(source, main, null)
  const base = await getDefaultBranch(main)
  peer = path.join(tmpDir, 'peer')
  reader = path.join(tmpDir, 'reader')
  await createCheckout(main, peer, { branch: 'agent/peer', baseBranch: base, remoteUrl: source })
  await createCheckout(main, reader, { branch: 'agent/reader', baseBranch: base, remoteUrl: source })
})

afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('bundleCheckout', () => {
  it('carries the checkout\'s own commits, loose or packed, and nothing it borrows', async () => {
    const first = await commit(peer, 'a/one.txt', 'first')
    await git(peer, ['gc', '-q'])
    const second = await commit(peer, 'b/two.txt', 'second')
    await git(peer, ['branch', 'side', first])

    expect((await fetchInto(peer)).sort())
      .toEqual(['yaac/peers/peer/HEAD', 'yaac/peers/peer/agent/peer', 'yaac/peers/peer/side'])
    expect((await git(reader, ['rev-parse', 'yaac/peers/peer/agent/peer', 'yaac/peers/peer/side'])).split('\n'))
      .toEqual([second, first, ''])
    expect(await git(reader, ['show', 'yaac/peers/peer/HEAD:b/two.txt'])).toBe('second\n')

    // Only objects the main clone lacks travel.
    const own = (await git(peer, ['rev-list', '--objects', 'agent/peer', 'side', '--not', '--remotes']))
      .trim().split('\n').length
    const bundle = await bundleCheckout(peer, main)
    const pack = bundle.subarray(bundle.indexOf('\n\nPACK') + 2)
    expect(pack.readUInt32BE(8)).toBe(own)
  })

  it('runs nothing a checkout asks git to run: hooks, fsmonitor, filters, helpers or transports', async () => {
    const trapped = path.join(tmpDir, 'trapped')
    await createCheckout(main, trapped, { branch: 'agent/trapped', baseBranch: await getDefaultBranch(main), remoteUrl: main })
    await commit(trapped, 'src/a.txt', 'trapped work')
    const fired = path.join(tmpDir, 'fired')
    await fs.mkdir(fired)
    const touch = (name: string): string => `touch ${path.join(fired, name)}`
    const gitDir = path.join(trapped, '.git')

    // Every hook git knows, in .git/hooks and in a core.hooksPath dir.
    const hookDir = path.join(tmpDir, 'hooks')
    await fs.mkdir(hookDir)
    await fs.mkdir(path.join(gitDir, 'hooks'), { recursive: true })
    for (const hook of HOOKS) {
      await fs.writeFile(path.join(gitDir, 'hooks', hook), `#!/bin/sh\n${touch(`hook-${hook}`)}\n`, { mode: 0o755 })
      await fs.writeFile(path.join(hookDir, hook), `#!/bin/sh\n${touch(`hookspath-${hook}`)}\n`, { mode: 0o755 })
    }
    // Every config key whose value git runs, and an include that adds one.
    const included = path.join(tmpDir, 'included.gitconfig')
    await fs.writeFile(included, `[core]\n\tpager = ${touch('include')}\n`)
    const config: Array<[string, string]> = [
      ['core.hooksPath', hookDir],
      ['core.fsmonitor', touch('fsmonitor')],
      ['core.sshCommand', touch('sshCommand')],
      ['core.gitProxy', touch('gitProxy')],
      ['core.askPass', touch('askPass')],
      ['core.pager', touch('pager')],
      ['core.editor', touch('editor')],
      ['sequence.editor', touch('sequenceEditor')],
      ['credential.helper', `!${touch('credential')}`],
      ['diff.external', touch('diffExternal')],
      ['diff.trap.textconv', touch('textconv')],
      ['filter.trap.clean', touch('clean')],
      ['filter.trap.smudge', touch('smudge')],
      ['filter.trap.process', touch('process')],
      ['merge.trap.driver', touch('mergeDriver')],
      ['gpg.program', touch('gpg')],
      ['uploadpack.packObjectsHook', touch('packObjectsHook')],
      ['protocol.allow', 'always'],
      ['remote.origin.url', `ext::sh -c ${touch('ext').replace(/ /g, '% ')}`],
      ['remote.origin.uploadpack', touch('uploadpack')],
      ['include.path', included],
    ]
    for (const [key, value] of config) await git(trapped, ['config', key, value])
    await fs.mkdir(path.join(gitDir, 'info'), { recursive: true })
    await fs.writeFile(path.join(gitDir, 'info', 'attributes'), '* filter=trap diff=trap merge=trap\n')

    const bundle = await bundleCheckout(trapped, main)
    expect(bundle.toString('latin1')).toContain('refs/heads/agent/trapped')
    expect(await fs.readdir(fired)).toEqual([])

    // The traps are live: git itself, run in that checkout, fires them.
    await fs.writeFile(path.join(trapped, 'src', 'a.txt'), 'changed\n')
    await git(trapped, ['diff']).catch(() => '')
    expect(await fs.readdir(fired)).toEqual(expect.arrayContaining(['fsmonitor', 'process']))
  })

  it('never reads a planted alternate: another repository\'s objects stay out of the bundle', async () => {
    const other = path.join(tmpDir, 'other')
    await fs.mkdir(other)
    await git(other, ['init', '-q'])
    const foreign = await commit(other, 'secret.txt', 'another project')
    const foreignObjects = (await git(other, ['rev-list', '--objects', '--all'])).trim().split('\n').map((l) => l.split(' ')[0])
    const victim = path.join(tmpDir, 'victim')
    await createCheckout(main, victim, { branch: 'agent/victim', baseBranch: await getDefaultBranch(main), remoteUrl: main })
    await commit(victim, 'mine.txt', 'own work')
    await fs.appendFile(path.join(victim, '.git', 'objects', 'info', 'alternates'), `${path.join(other, '.git', 'objects')}\n`)
    await fs.writeFile(path.join(victim, '.git', 'refs', 'heads', 'foreign'), `${foreign}\n`)

    const sent = await packedObjects(await bundleCheckout(victim, main))
    expect(sent.length).toBeGreaterThan(0)
    expect(sent.filter((oid) => foreignObjects.includes(oid))).toEqual([])
  })

  it('takes only refs it can trust: no link is followed and no odd name is sent', async () => {
    // A ref planted as a link to a file outside, and a name that would add a
    // line to the bundle header.
    await fs.writeFile(path.join(tmpDir, 'secret'), `${'f'.repeat(40)}\n`)
    await fs.symlink(path.join(tmpDir, 'secret'), path.join(peer, '.git', 'refs', 'heads', 'linked'))
    const tip = (await git(peer, ['rev-parse', 'HEAD'])).trim()
    await fs.writeFile(path.join(peer, '.git', 'refs', 'heads', 'two\nlines'), `${tip}\n`)
    // A branch named HEAD, which the caller's refspecs would map onto HEAD's
    // own destination, and one whose tip is nowhere, which would fail the
    // caller's whole fetch.
    await fs.writeFile(path.join(peer, '.git', 'refs', 'heads', 'HEAD'), `${tip}\n`)
    await fs.writeFile(path.join(peer, '.git', 'refs', 'heads', 'dangling'), `${'e'.repeat(40)}\n`)

    const fetched = await fetchInto(peer)
    expect(fetched).not.toContain('yaac/peers/peer/linked')
    expect(fetched.some((r) => r.includes('lines'))).toBe(false)
    expect(fetched).not.toContain('yaac/peers/peer/dangling')
    expect(fetched).toContain('yaac/peers/peer/agent/peer')
    expect(fetched).toContain('yaac/peers/peer/HEAD')
  })

  it('runs its reader only where nothing but reads is allowed', async () => {
    // The reader checks its own sandbox, so neither a missing permission
    // model nor a widened one goes unnoticed.
    const reader = await buildPeerReader()
    const snapshot = await fs.mkdtemp(path.join(tmpDir, 'snapshot-'))
    const run = (flags: string[]) => new Promise<{ code: number | null; stderr: string }>((resolve) => {
      execFile(process.execPath, [...flags, reader, snapshot], (err, _stdout, stderr) =>
        resolve({ code: err ? (err as { code?: number }).code ?? 1 : 0, stderr }))
    })
    const sandbox = ['--permission', `--allow-fs-read=${reader}`, `--allow-fs-read=${snapshot}`]
    const widened = ['--allow-child-process', '--allow-fs-write=*', '--allow-worker', '--allow-addons',
      '--allow-wasi', '--allow-inspector', '--allow-net']
      .filter((flag) => process.allowedNodeEnvironmentFlags.has(flag))
    for (const flags of [[], ...widened.map((flag) => [...sandbox, flag])]) {
      const { code, stderr } = await run(flags)
      expect(code, flags.join(' ')).toBe(1)
      expect(stderr).toContain('runs only under a permission model that grants nothing but reads')
    }
    expect((await run(sandbox)).code).toBe(0)
  })

  it.skipIf(process.platform === 'darwin')('packs an answer just under its byte cap with room to spare in its address space', async () => {
    // 120 MiB of incompressible blobs, under the 128 MiB cap. The reader
    // streams the pack, so it fits 300 MiB below the shipped limit; building
    // the pack in memory peaks at the shipped limit itself.
    const heavy = path.join(tmpDir, 'heavy')
    await fs.mkdir(heavy)
    await git(heavy, ['init', '-q'])
    for (let i = 0; i < 4; i++) await fs.writeFile(path.join(heavy, `blob-${String(i)}`), crypto.randomBytes(30 * (1 << 20)))
    await git(heavy, ['add', '.'])
    await git(heavy, ['-c', 'user.email=t@t', '-c', 'user.name=T', 'commit', '-qm', 'heavy'])
    // Packed, as gc leaves a workspace: the reader then holds the pack too.
    await git(heavy, ['gc', '-q'])
    const snapshot = path.join(heavy, '.git')
    const entry = await buildPeerReader()

    const size = await new Promise<number>((resolve, reject) => {
      const child = execFile('/bin/sh', [
        '-c', 'ulimit -v "$0"; exec "$@"', String(READER_ADDRESS_SPACE_KB - 300 * 1024),
        process.execPath, '--permission', `--allow-fs-read=${entry}`, `--allow-fs-read=${snapshot}`,
        '--max-old-space-size=256', entry, snapshot,
      ], { encoding: 'buffer', maxBuffer: 256 << 20 }, (err, stdout, stderr) => {
        if (err) reject(new Error(stderr.toString() || err.message))
        else resolve(stdout.length)
      })
      child.stdin?.end()
    })
    expect(size).toBeGreaterThan(120 * (1 << 20))
  }, 120_000)

  it('reads a packed checkout in time, loading each pack once', async () => {
    // 5,000 objects in one pack, as gc leaves a busy workspace. Reloading the
    // pack for every object takes minutes.
    const packed = path.join(tmpDir, 'packed')
    await createCheckout(main, packed, { branch: 'agent/packed', baseBranch: await getDefaultBranch(main), remoteUrl: main })
    await fs.mkdir(path.join(packed, 'many'))
    for (let i = 0; i < 4997; i++) await fs.writeFile(path.join(packed, 'many', String(i)), `${String(i)}\n`)
    await git(packed, ['add', '.'])
    await git(packed, ['-c', 'user.email=t@t', '-c', 'user.name=T', '-c', 'gc.auto=0', 'commit', '-qm', 'many'])
    await git(packed, ['gc', '-q'])

    const started = Date.now()
    const bundle = await bundleCheckout(packed, main)
    expect(Date.now() - started).toBeLessThan(30_000)
    expect(bundle.readUInt32BE(bundle.indexOf('\n\nPACK') + 2 + 8)).toBe(5000)
  }, 120_000)

  it.skipIf(process.platform === 'darwin')('stops a decompression bomb at its memory limit, two readers at a time', async () => {
    // 1.9 GiB of zeros in a 2 MB loose object: without the address-space
    // limit the reader inflates it whole, past any heap cap.
    const size = 1900 * (1 << 20)
    const bombed = path.join(tmpDir, 'bombed')
    await createCheckout(main, bombed, { branch: 'agent/bombed', baseBranch: await getDefaultBranch(main), remoteUrl: main })
    const oid = `ab${'1'.repeat(38)}`
    await fs.mkdir(path.join(bombed, '.git', 'objects', 'ab'), { recursive: true })
    await fs.writeFile(path.join(bombed, '.git', 'objects', 'ab', oid.slice(2)), await deflateBomb(Buffer.from(`blob ${String(size)}\0`), size))
    await fs.writeFile(path.join(bombed, '.git', 'refs', 'heads', 'bomb'), `${oid}\n`)

    const first = bundleCheckout(bombed, main)
    const second = bundleCheckout(bombed, main)
    await expect(bundleCheckout(peer, main)).rejects.toThrow('try again')
    await Promise.all([first, second].map((read) => expect(read).rejects.toThrow('too much memory')))
    // The cap frees as readers finish.
    await expect(bundleCheckout(peer, main)).resolves.toBeInstanceOf(Buffer)
  }, 60_000)

  it('refuses a checkout whose .git is a link, rather than reading where it leads', async () => {
    const linked = path.join(tmpDir, 'linked')
    await fs.mkdir(linked)
    await fs.symlink(path.join(reader, '.git'), path.join(linked, '.git'))
    await expect(bundleCheckout(linked, main)).rejects.toThrow('no checkout')
    await expect(bundleCheckout(path.join(tmpDir, 'missing'), main)).rejects.toThrow('no checkout')
  })
})
