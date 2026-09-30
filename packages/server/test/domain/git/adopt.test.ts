import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { adoptLinkedCheckout, cloneRepo, getDefaultBranch, sanitizeMainClone } from '#domain/git'
import { git } from '@yaac/test-utils/git'

/**
 * One project as an older install left it: a main clone with two stopped
 * linked checkouts made by plain `git worktree add`. Shared by the file: the
 * conversions run in order, and the sanitize, which needs both converted,
 * runs last.
 */

let tmp: string
let source: string
let main: string
let base: string
const ID = 'w1'
const CRASHED = 'w2'
const GONE = 'w4'
/** The project's workspace rows. */
const ROWS = new Set([ID, CRASHED, 'w3', GONE])
const wt = (id: string): string => path.join(tmp, 'workspaces', id)
const identity = ['-c', 'user.email=t@t', '-c', 'user.name=T']
const subject = async (repo: string, ref: string): Promise<string> =>
  (await git(repo, ['log', '-1', '--format=%s', ref])).trim()

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-adopt-'))
  source = path.join(tmp, 'source')
  await fs.mkdir(source)
  await git(source, ['init', '-q'])
  await fs.writeFile(path.join(source, 'a.txt'), 'a\n')
  await git(source, ['add', '.'])
  await git(source, [...identity, 'commit', '-q', '-m', 'initial'])
  main = path.join(tmp, 'repo')
  await cloneRepo(source, main, null)
  base = await getDefaultBranch(main)
  await fs.mkdir(path.join(tmp, 'workspaces'))
  for (const id of [ID, CRASHED]) {
    await git(main, ['worktree', 'add', '-q', '-b', `agent/${id}`, wt(id), `origin/${base}`])
    await git(main, ['config', `branch.agent/${id}.merge`, `refs/heads/${base}`])
  }
  await git(main, ['branch', 'user-feature'])
  // A branch no row names, e.g. from a workspace deleted before the upgrade.
  await git(main, ['-c', 'user.email=t@t', '-c', 'user.name=T', 'commit-tree', '-m', 'orphaned work', `origin/${base}^{tree}`])
    .then((sha) => git(main, ['branch', 'agent/someone-else', sha.trim()]))
})

afterAll(async () => {
  await fs.rm(tmp, { recursive: true, force: true })
})

describe('adoptLinkedCheckout', () => {
  it('converts a linked checkout in place, keeping its index, commits and stash', async () => {
    const dir = wt(ID)
    await git(dir, [...identity, 'commit', '-q', '--allow-empty', '-m', 'only on the agent branch'])
    await fs.writeFile(path.join(dir, 'a.txt'), 'stashed\n')
    await git(dir, [...identity, 'stash', '-q'])
    await fs.writeFile(path.join(dir, 'a.txt'), 'staged\n')
    await git(dir, ['add', 'a.txt'])
    await fs.writeFile(path.join(dir, 'b.txt'), 'untracked\n')
    const status = await git(dir, ['status', '--porcelain'])
    const head = await git(dir, ['rev-parse', 'HEAD'])
    // A k8s pod leaves a gitdir path that only resolves inside the pod.
    await fs.writeFile(path.join(dir, '.git'), `gitdir: /repo/.git/worktrees/${ID}\n`)

    await adoptLinkedCheckout(main, dir, ID, source, ROWS)

    expect((await fs.stat(path.join(dir, '.git'))).isDirectory()).toBe(true)
    expect(await git(dir, ['status', '--porcelain'])).toBe(status)
    expect(await git(dir, ['rev-parse', 'HEAD'])).toBe(head)
    expect((await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()).toBe(`agent/${ID}`)
    expect((await git(dir, ['rev-parse', '--abbrev-ref', '@{u}'])).trim()).toBe(`origin/${base}`)
    expect(await git(dir, ['stash', 'list'])).toMatch(/stash@\{0\}/)
    expect(await git(dir, ['branch', '--list', 'user-feature'])).not.toBe('')
    // Unowned agent/* branches come along; another row's branch does not.
    expect(await git(dir, ['branch', '--list', 'agent/someone-else'])).not.toBe('')
    expect(await git(dir, ['branch', '--list', `agent/${CRASHED}`])).toBe('')
    await git(dir, ['fsck', '--connectivity-only'])
    await expect(fs.access(path.join(main, '.git', 'worktrees', ID))).rejects.toThrow()
    expect(await git(main, ['branch', '--list', `agent/${ID}`])).toBe('')
    // Keeps a legacy pod's gc of the main clone from pruning objects.
    expect((await git(main, ['config', 'gc.pruneExpire'])).trim()).toBe('never')

    // A second run is a no-op.
    await adoptLinkedCheckout(main, dir, ID, source, ROWS)
    expect(await git(dir, ['status', '--porcelain'])).toBe(status)
  })

  it('finishes a conversion that crashed between its renames', async () => {
    const dir = wt(CRASHED)
    await fs.writeFile(path.join(dir, 'a.txt'), 'dirty\n')
    await fs.rename(path.join(dir, '.git'), path.join(dir, '.git.linked'))

    await adoptLinkedCheckout(main, dir, CRASHED, source, ROWS)

    expect((await fs.stat(path.join(dir, '.git'))).isDirectory()).toBe(true)
    await expect(fs.access(path.join(dir, '.git.linked'))).rejects.toThrow()
    expect((await git(dir, ['status', '--porcelain'])).trim()).toBe('M a.txt')
  })

  it('keeps the branch of a checkout whose .git is gone, dropping only its admin dir', async () => {
    await git(main, ['worktree', 'add', '-q', '-b', `agent/${GONE}`, wt(GONE), `origin/${base}`])
    await git(wt(GONE), ['-c', 'user.email=t@t', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', 'unpushed'])
    await fs.rm(path.join(wt(GONE), '.git'))

    await adoptLinkedCheckout(main, wt(GONE), GONE, source, ROWS)

    await expect(fs.access(path.join(main, '.git', 'worktrees', GONE))).rejects.toThrow()
    expect(await subject(main, `agent/${GONE}`)).toBe('unpushed')
  })

  it('reads the index from HEAD when the admin dir is gone', async () => {
    await git(main, ['worktree', 'add', '-q', '-b', 'agent/w5', wt('w5'), `origin/${base}`])
    await fs.rm(path.join(main, '.git', 'worktrees', 'w5'), { recursive: true })

    await adoptLinkedCheckout(main, wt('w5'), 'w5', source, ROWS)

    expect((await git(wt('w5'), ['status', '--porcelain'])).trim()).toBe('')
  })
})

describe('sanitizeMainClone', () => {
  it('takes the main clone back once no row owns a linked checkout in it', async () => {
    const gitDir = path.join(main, '.git')
    await git(main, ['worktree', 'add', '-q', '-b', 'agent/w3', wt('w3'), `origin/${base}`])
    await git(main, ['config', 'filter.evil.clean', 'false'])
    expect(await sanitizeMainClone(main, source, ROWS)).toBe(false)

    await adoptLinkedCheckout(main, wt('w3'), 'w3', source, ROWS)
    await fs.symlink('/etc', path.join(gitDir, 'info', 'planted'))
    await expect(sanitizeMainClone(main, source, ROWS)).rejects.toThrow(/symlink/)
    await fs.rm(path.join(gitDir, 'info', 'planted'))

    expect(await sanitizeMainClone(main, source, ROWS)).toBe(true)

    await expect(fs.access(path.join(gitDir, 'worktrees'))).rejects.toThrow()
    await expect(fs.access(path.join(gitDir, 'hooks'))).rejects.toThrow()
    // Branches no clone holds stay in the main clone: the missing
    // checkout's, and the one no row owns.
    expect(await subject(main, `agent/${GONE}`)).toBe('unpushed')
    expect(await git(main, ['branch', '--list', 'agent/someone-else'])).not.toBe('')
    expect(await git(main, ['branch', '--list', `agent/${ID}`])).toBe('')
    const keys = (await git(main, ['config', '--list', '--local'])).split('\n').filter(Boolean).map((l) => l.split('=')[0])
    expect(keys).not.toContain('filter.evil.clean')
    expect(keys).toEqual(expect.arrayContaining(['remote.origin.url', 'gc.pruneexpire']))
    for (const id of [ID, CRASHED, 'w3']) await git(wt(id), ['fsck', '--connectivity-only'])
    expect(await sanitizeMainClone(main, source, new Set())).toBe(true)
  })
})
