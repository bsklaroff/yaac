import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { testTmpBase } from '@yaac/test-utils/tmp'
import { buildTreeScript } from '@yaac/test-utils/workspace-bin-helpers'
import { git } from '@yaac/test-utils/git'
import { execFileAsync } from '#lib/shell'

/**
 * The tree container's program, built as a release builds it and run as a
 * process against real git in temporary directories laid out as the pod
 * mounts them: a tree, a scratch repository, a checkpoint dir, and a
 * checkout's git dir beside a main clone. Its files belong to this test's
 * own uid, so no `setpriv` is needed.
 */

let script: string
let tmp: string
let mainClone: string
let base: string

const uid = process.getuid?.() ?? 0
const gid = process.getgid?.() ?? 0

beforeAll(async () => {
  script = await buildTreeScript()
  tmp = await fs.mkdtemp(path.join(testTmpBase(), 'yaac-tree-'))
  const src = path.join(tmp, 'src')
  await fs.mkdir(src)
  await git(src, ['init', '-q', '-b', 'main'])
  await git(src, ['config', 'user.email', 't@t'])
  await git(src, ['config', 'user.name', 'T'])
  // A scratch dir its own rules ignore too, as most JS repos' do.
  await put(src, '.gitignore', 'dist/\n*.log\nnode_modules/\n')
  await put(src, 'README.md', 'line one\nline two\n')
  await put(src, 'src/a.ts', 'export const a = 1\n')
  await put(src, 'run.sh', '#!/bin/sh\necho run\n', 0o755)
  await put(src, 'cache/tracked.txt', 'tracked in a mounted folder\n')
  await put(src, 'data.bin', Buffer.from([0, 1, 2, 255]))
  await fs.symlink('README.md', path.join(src, 'link'))
  await git(src, ['add', '-A'])
  await git(src, ['commit', '-qm', 'initial'])
  base = (await git(src, ['rev-parse', 'HEAD'])).trim()
  mainClone = path.join(tmp, 'main.git')
  await git(tmp, ['clone', '-q', '--bare', src, mainClone])
})

afterAll(async () => {
  await fs.rm(tmp, { recursive: true, force: true })
})

async function put(dir: string, rel: string, content: string | Buffer, mode?: number): Promise<void> {
  await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true })
  await fs.writeFile(path.join(dir, rel), content)
  if (mode !== undefined) await fs.chmod(path.join(dir, rel), mode)
}

/** A workspace laid out as its pods mount it: its checkpoint dir and the
 *  git dir of its one checkout, at `app`, set up as the server does. */
async function workspace(name: string): Promise<{ ckpt: string; gitDir: string; root: string }> {
  const root = path.join(tmp, name)
  const gitDir = path.join(root, 'git', 'repo1')
  await fs.mkdir(gitDir, { recursive: true })
  await execFileAsync('git', ['--git-dir', gitDir, 'init', '-q'])
  await execFileAsync('git', ['--git-dir', gitDir, 'config', 'core.bare', 'false'])
  await fs.writeFile(path.join(gitDir, 'objects', 'info', 'alternates'), `${path.join(mainClone, 'objects')}\n`)
  await execFileAsync('git', ['--git-dir', gitDir, 'update-ref', 'refs/heads/agent/w', base])
  await execFileAsync('git', ['--git-dir', gitDir, 'symbolic-ref', 'HEAD', 'refs/heads/agent/w'])
  await fs.appendFile(path.join(gitDir, 'info', 'exclude'), '/private.txt\n')
  return { ckpt: path.join(root, 'ckpt'), gitDir, root }
}

interface Life { name: string; tree: string; scratch: string; args: string[]; trigger: string }

/** A life of the workspace: its start instruction written, its node dirs
 *  made, as the server and the node-dirs init container do. */
async function life(
  ws: { ckpt: string; gitDir: string; root: string }, name: string, restore?: string, newestReadable = false,
): Promise<Life> {
  const tree = path.join(ws.root, 'node', name, 'tree')
  const scratch = path.join(ws.root, 'node', name, 'scratch')
  await fs.mkdir(tree, { recursive: true })
  await fs.mkdir(scratch, { recursive: true })
  await put(path.join(ws.ckpt, 'lives', name), 'start.json', JSON.stringify({
    version: 1, life: name, uid, gid,
    checkouts: [{ id: 'repo1', path: 'app', gitDir: ws.gitDir, commit: base, kept: ['dist/keep.txt'] }],
    excluded: ['app/cache', 'app/node_modules', 'scratchdir'],
    ...(restore !== undefined ? { restore } : {}),
    ...(newestReadable ? { restoreNewestReadable: true } : {}),
  }))
  const trigger = path.join(ws.root, `${name}.trigger`)
  await fs.writeFile(trigger, '')
  return { name, tree, scratch, trigger, args: ['--tree', tree, '--scratch', scratch, '--ckpt', ws.ckpt, '--life', name] }
}

function start(l: Life): ChildProcess {
  // Passes only on the trigger, so a test decides what each one sees.
  const child = spawn(script, ['run', ...l.args, '--trigger', l.trigger, '--interval', '3600'], { stdio: ['ignore', 'ignore', 'pipe'] })
  child.stderr?.on('data', (b: Buffer) => { process.stderr.write(b) })
  return child
}

async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, ms = 60_000): Promise<T> {
  const until = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > until) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 200))
  }
}

const probe = (l: Life): Promise<boolean> =>
  execFileAsync(script, ['probe', '--scratch', l.scratch, '--life', l.name]).then(() => true, () => false)

interface ManifestLike { life: string; final: boolean; pass: string; bundles: string[]; units: Array<{ kind: string; path?: string }> }
const manifest = (ws: { ckpt: string }, name: string): Promise<ManifestLike | null> =>
  fs.readFile(path.join(ws.ckpt, 'lives', name, 'manifest.json'), 'utf8').then((t) => JSON.parse(t) as ManifestLike, () => null)

/** Touch the trigger and wait for a pass to land a new checkpoint. */
async function passNow(ws: { ckpt: string }, l: Life): Promise<ManifestLike> {
  const before = (await manifest(ws, l.name))?.pass
  const now = new Date()
  await fs.utimes(l.trigger, now, new Date(now.getTime() + Math.random() * 1000 + 1000))
  return waitFor(async () => {
    const m = await manifest(ws, l.name)
    return m && m.pass !== before ? m : null
  })
}

const exited = (child: ChildProcess): Promise<number | null> =>
  new Promise((r) => { child.on('exit', (code) => r(code)) })

/** Every file and link under `dir` but `.git` folders: kind, exec bit,
 *  content hash or link target. */
async function snapshot(dir: string): Promise<string[]> {
  const out: string[] = []
  const walk = async (rel: string): Promise<void> => {
    for (const e of await fs.readdir(path.join(dir, rel), { withFileTypes: true })) {
      const p = rel === '' ? e.name : `${rel}/${e.name}`
      if (e.name === '.git') continue
      const abs = path.join(dir, p)
      if (e.isSymbolicLink()) out.push(`L ${p} -> ${await fs.readlink(abs)}`)
      else if (e.isDirectory()) await walk(p)
      else {
        const st = await fs.stat(abs)
        out.push(`F ${p} ${st.mode & 0o100 ? 'x' : '-'} ${createHash('sha256').update(await fs.readFile(abs)).digest('hex').slice(0, 12)}`)
      }
    }
  }
  await walk('')
  return out.sort()
}

const inCheckout = (ws: { gitDir: string }, l: Life, args: string[]): Promise<string> =>
  execFileAsync('git', ['--git-dir', ws.gitDir, '--work-tree', path.join(l.tree, 'app'), '-c', 'user.email=t@t', '-c', 'user.name=T', ...args])
    .then((r) => r.stdout)

describe('yaac-tree', () => {
  it('checks a life out, saves every kind of content, and restores it whole after a stop', async () => {
    const ws = await workspace('whole')
    const one = await life(ws, 'L1')
    const run = start(one)
    await waitFor(() => probe(one))

    // The checkout is there with its first index current, and the mount
    // points the workspace container needs.
    expect(await fs.readFile(path.join(one.tree, 'app', 'README.md'), 'utf8')).toBe('line one\nline two\n')
    expect(await inCheckout(ws, one, ['status', '--porcelain'])).toBe('')
    expect((await execFileAsync('git', ['--git-dir', ws.gitDir, 'config', 'core.checkStat'])).stdout.trim()).toBe('minimal')
    for (const p of ['app/.git', 'app/cache', 'scratchdir']) expect((await fs.stat(path.join(one.tree, p))).isDirectory()).toBe(true)

    const app = path.join(one.tree, 'app')
    await put(app, 'README.md', 'line one\nedited\n')
    await fs.rm(path.join(app, 'src/a.ts'))
    await put(app, 'new.txt', 'untracked\n')
    await put(app, 'tool.sh', '#!/bin/sh\n', 0o755)
    await fs.symlink('README.md', path.join(app, 'l2'))
    await put(app, 'debug.log', 'ignored\n')
    await put(app, 'private.txt', 'ignored by info/exclude\n')
    await put(app, 'dist/keep.txt', 'kept though ignored\n')
    await put(app, 'dist/other.js', 'ignored\n')
    await put(app, 'cache/tracked.txt', 'changed under a mount\n')
    await put(app, 'cache/junk.txt', 'under a mount\n')
    await put(one.tree, 'notes.md', 'at the root\n')
    await put(one.tree, 'data/x.bin', Buffer.from([9, 8, 7]))
    await put(one.tree, 'scratchdir/big', 'excluded\n')
    // A repository the agent made at the root: history, an edit, a stash.
    const lib = path.join(one.tree, 'vendor', 'lib')
    await fs.mkdir(lib, { recursive: true })
    await git(lib, ['init', '-q', '-b', 'main'])
    await git(lib, ['config', 'user.email', 't@t'])
    await git(lib, ['config', 'user.name', 'T'])
    await put(lib, 'lib.c', 'int x;\n')
    await git(lib, ['add', '-A'])
    await git(lib, ['commit', '-qm', 'lib one'])
    await put(lib, 'lib.c', 'int stashed;\n')
    await git(lib, ['stash', '-q'])
    await put(lib, 'lib.c', 'int y;\n')
    // And one inside the checkout's folder: committed, dirty, untracked.
    const nested = path.join(app, 'vendor2')
    await fs.mkdir(nested, { recursive: true })
    await git(nested, ['init', '-q', '-b', 'main'])
    await git(nested, ['config', 'user.email', 't@t'])
    await git(nested, ['config', 'user.name', 'T'])
    await put(nested, 'n.c', 'int n;\n')
    await git(nested, ['add', '-A'])
    await git(nested, ['commit', '-qm', 'nested one'])
    await put(nested, 'n.c', 'int dirty;\n')
    await put(nested, 'untracked-in-nested', 'u\n')

    const libIndex = (await fs.stat(path.join(lib, '.git/index'))).mtimeMs
    const first = await passNow(ws, one)
    expect(first.units.map((u) => `${u.kind}:${u.path ?? ''}`)).toEqual(['root:', 'checkout:app', 'repo:vendor/lib', 'repo:app/vendor2'])
    // A pass with nothing changed writes nothing.
    const count = (await fs.readdir(path.join(ws.ckpt, 'bundles'))).length
    await fs.utimes(one.trigger, new Date(), new Date(Date.now() + 5000))
    await new Promise((r) => setTimeout(r, 3000))
    expect((await manifest(ws, 'L1'))?.pass).toBe(first.pass)
    // Saving a repository never runs git inside it, which would rewrite its index.
    expect((await fs.stat(path.join(lib, '.git/index'))).mtimeMs).toBe(libIndex)
    expect((await fs.readdir(path.join(ws.ckpt, 'bundles'))).length).toBe(count)
    await put(one.tree, 'notes.md', 'at the root, again\n')
    await passNow(ws, one)

    const before = (await snapshot(one.tree)).filter((l) =>
      !/ (app\/debug\.log|app\/private\.txt|app\/dist\/other\.js|app\/cache\/junk\.txt|scratchdir\/big) /.test(` ${l.split(' ')[1]} `)
      && !l.startsWith('F app/cache/tracked.txt '))

    run.kill('SIGTERM')
    expect(await exited(run)).toBe(0)
    const last = await manifest(ws, 'L1')
    expect(last?.final).toBe(true)
    // This life's small bundles are compacted into one.
    expect(last?.bundles).toHaveLength(1)
    expect(await fs.readdir(one.tree)).toEqual([])
    expect(await fs.readdir(one.scratch)).toEqual([])

    const two = await life(ws, 'L2', 'lives/L1/manifest.json')
    const run2 = start(two)
    await waitFor(() => probe(two))
    const after = await snapshot(two.tree)
    // The mounted folder holds HEAD's tracked file, never what was there.
    expect(after).toContain(before.find((l) => l.startsWith('F app/README.md ')))
    expect(after.filter((l) => !l.startsWith('F app/cache/tracked.txt '))).toEqual(before)
    expect(await fs.readFile(path.join(two.tree, 'app', 'cache', 'tracked.txt'), 'utf8')).toBe('tracked in a mounted folder\n')
    expect((await inCheckout(ws, two, ['status', '--porcelain'])).split('\n').filter(Boolean).sort())
      .toEqual([' D src/a.ts', ' M README.md', '?? l2', '?? new.txt', '?? tool.sh', '?? vendor2/'].sort())
    const lib2 = path.join(two.tree, 'vendor', 'lib')
    expect((await git(lib2, ['log', '--format=%s'])).trim()).toBe('lib one')
    expect((await git(lib2, ['stash', 'list'])).trim()).toMatch(/^stash@\{0\}/)
    expect(await fs.readFile(path.join(lib2, 'lib.c'), 'utf8')).toBe('int y;\n')
    const nested2 = path.join(two.tree, 'app', 'vendor2')
    expect((await git(nested2, ['log', '--format=%s'])).trim()).toBe('nested one')
    expect((await git(nested2, ['status', '--porcelain'])).split('\n').filter(Boolean).sort())
      .toEqual([' M n.c', '?? untracked-in-nested'])
    // The new life starts from the chain it restored, so it rewrites none
    // of it, and adds its own bundle only for what it changes.
    expect((await manifest(ws, 'L2'))?.bundles).toEqual(last?.bundles)
    await put(two.tree, 'notes.md', 'third\n')
    await passNow(ws, two)
    run2.kill('SIGTERM')
    expect(await exited(run2)).toBe(0)
    const final2 = await manifest(ws, 'L2')
    expect(final2?.bundles).toHaveLength(2)
    expect(final2?.bundles[0]).toBe(last?.bundles[0])
  }, 180_000)

  it('merges a checkpoint onto a HEAD that moved after it, HEAD winning a conflict', async () => {
    const ws = await workspace('moved')
    const one = await life(ws, 'L1')
    const run = start(one)
    await waitFor(() => probe(one))
    const app = path.join(one.tree, 'app')
    await put(app, 'README.md', 'line one\nunsaved edit\n')
    await put(app, 'extra.txt', 'untracked\n')
    await passNow(ws, one)
    // Killed without a final pass; a commit had landed after the last one.
    run.kill('SIGKILL')
    await exited(run)
    await put(app, 'README.md', 'line one\ncommitted\n')
    await put(app, 'src/a.ts', 'export const a = 2\n')
    await inCheckout(ws, one, ['commit', '-qam', 'later'])

    const two = await life(ws, 'L2', 'lives/L1/manifest.json')
    const run2 = start(two)
    await waitFor(() => probe(two))
    const app2 = path.join(two.tree, 'app')
    expect(await fs.readFile(path.join(app2, 'README.md'), 'utf8')).toBe('line one\ncommitted\n')
    expect(await fs.readFile(path.join(app2, 'src/a.ts'), 'utf8')).toBe('export const a = 2\n')
    expect(await fs.readFile(path.join(app2, 'extra.txt'), 'utf8')).toBe('untracked\n')
    run2.kill('SIGTERM')
    expect(await exited(run2)).toBe(0)
  }, 120_000)

  it('keeps checkpointing, compacting and stopping after the agent rewrites and prunes a commit a pass saw', async () => {
    const ws = await workspace('pruned')
    const one = await life(ws, 'L1')
    const run = start(one)
    await waitFor(() => probe(one))
    const app = path.join(one.tree, 'app')
    await put(app, 'secret.txt', 'oops\n')
    await inCheckout(ws, one, ['add', 'secret.txt'])
    await inCheckout(ws, one, ['commit', '-qm', 'c1'])
    await passNow(ws, one)
    await fs.rm(path.join(app, 'secret.txt'))
    await put(app, 'fine.txt', 'fine\n')
    await inCheckout(ws, one, ['add', '-A'])
    await inCheckout(ws, one, ['commit', '-q', '--amend', '-m', 'c1 without the secret'])
    await execFileAsync('git', ['--git-dir', ws.gitDir, 'reflog', 'expire', '--expire=now', '--all'])
    await execFileAsync('git', ['--git-dir', ws.gitDir, 'gc', '-q', '--prune=now'])
    // Past the chain bound, so a pass compacts.
    for (let i = 0; i < 21; i++) {
      await put(app, 'counter.txt', `${String(i)}\n`)
      await passNow(ws, one)
    }
    expect((await manifest(ws, 'L1'))!.bundles.length).toBeLessThan(5)
    run.kill('SIGTERM')
    expect(await exited(run)).toBe(0)
    expect((await manifest(ws, 'L1'))?.final).toBe(true)
    expect(await fs.readdir(one.tree)).toEqual([])

    const two = await life(ws, 'L2', 'lives/L1/manifest.json')
    const run2 = start(two)
    await waitFor(() => probe(two))
    expect(await fs.readFile(path.join(two.tree, 'app', 'counter.txt'), 'utf8')).toBe('20\n')
    expect(await fs.stat(path.join(two.tree, 'app', 'secret.txt')).catch(() => null)).toBeNull()
    run2.kill('SIGTERM')
    expect(await exited(run2)).toBe(0)
  }, 180_000)

  it('salvages a killed life\'s tree, and leaves one that never started', async () => {
    const ws = await workspace('salvage')
    const one = await life(ws, 'L1')
    const run = start(one)
    await waitFor(() => probe(one))
    await put(one.tree, 'app/late.txt', 'after the last pass\n')
    run.kill('SIGKILL')
    await exited(run)
    expect(await manifest(ws, 'L1')).toBeNull()

    await execFileAsync(script, ['salvage', ...one.args])
    const m = await manifest(ws, 'L1')
    expect(m?.final).toBe(true)
    expect(await fs.readdir(one.tree)).toEqual([])
    const show = (await execFileAsync('git', ['--git-dir', path.join(tmp, 'peek.git'), 'init', '-q', '--bare'])
      .then(() => execFileAsync('git', ['--git-dir', path.join(tmp, 'peek.git'), 'bundle', 'list-heads', path.join(ws.ckpt, m!.bundles[0])])))
      .stdout
    expect(show).toContain('refs/yaac/pass')

    // A life killed before its tree was there saves nothing over the
    // checkpoint before it.
    const two = await life(ws, 'L2', 'lives/L1/manifest.json')
    await put(two.tree, 'app/README.md', 'half restored\n')
    await execFileAsync(script, ['salvage', ...two.args])
    expect(await manifest(ws, 'L2')).toBeNull()
    expect(await fs.readdir(two.tree)).toEqual([])
    expect(await manifest(ws, 'L1')).toEqual(m)
  }, 120_000)

  it('never reports ready on a chain that does not verify, naming the bundle, unless asked for the newest state that does', async () => {
    const ws = await workspace('broken')
    const one = await life(ws, 'L1')
    const run = start(one)
    await waitFor(() => probe(one))
    await put(one.tree, 'app/x.txt', 'x\n')
    run.kill('SIGTERM')
    await exited(run)
    const two = await life(ws, 'L2', 'lives/L1/manifest.json')
    const run2 = start(two)
    await waitFor(() => probe(two))
    await put(two.tree, 'app/y.txt', 'y\n')
    run2.kill('SIGTERM')
    await exited(run2)
    const m = await manifest(ws, 'L2')
    expect(m!.bundles).toHaveLength(2)
    const last = path.join(ws.ckpt, m!.bundles[1])
    await fs.truncate(last, (await fs.stat(last)).size - 10)

    const three = await life(ws, 'L3', 'lives/L2/manifest.json')
    const run3 = start(three)
    const failed = await waitFor(() => fs.readFile(path.join(ws.ckpt, 'lives', 'L3', 'restore-failed.json'), 'utf8').catch(() => null))
    expect(JSON.parse(failed)).toMatchObject({ bundle: m!.bundles[1] })
    expect(await probe(three)).toBe(false)
    run3.kill('SIGTERM')
    expect(await exited(run3)).toBe(0)

    // Asked for the newest state that verifies: the chain before the
    // unreadable bundle, which is moved aside, not deleted.
    const four = await life(ws, 'L4', 'lives/L2/manifest.json', true)
    const run4 = start(four)
    await waitFor(() => probe(four))
    expect(await fs.readFile(path.join(four.tree, 'app', 'x.txt'), 'utf8')).toBe('x\n')
    await expect(fs.stat(path.join(four.tree, 'app', 'y.txt'))).rejects.toThrow()
    await expect(fs.stat(`${last}.unreadable`)).resolves.toBeDefined()
    expect((await manifest(ws, 'L4'))?.bundles).toEqual([m!.bundles[0]])
    run4.kill('SIGTERM')
    expect(await exited(run4)).toBe(0)

    // With its first bundle unreadable too, each checkout's HEAD.
    const first = path.join(ws.ckpt, m!.bundles[0])
    await fs.truncate(first, (await fs.stat(first)).size - 10)
    const five = await life(ws, 'L5', 'lives/L2/manifest.json', true)
    const run5 = start(five)
    await waitFor(() => probe(five))
    expect(await fs.readFile(path.join(five.tree, 'app', 'README.md'), 'utf8')).toBe('line one\nline two\n')
    await expect(fs.stat(path.join(five.tree, 'app', 'x.txt'))).rejects.toThrow()
    run5.kill('SIGTERM')
    expect(await exited(run5)).toBe(0)
  }, 180_000)
})
