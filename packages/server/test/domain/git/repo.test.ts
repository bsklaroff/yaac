import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  cloneRepo,
  createCheckout,
  fetchOrigin,
  getDefaultBranch,
  lastFetchedAtMs,
  listRemoteBranches,
  listTreeSubdirs,
  maintainRepo,
  readBlobAt,
  remoteBranchExists,
  resolveRemoteRef,
} from '#domain/git'
import { git } from '@yaac/test-utils/git'

let tmpDir: string
let sourceRepo: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-git-test-'))
  sourceRepo = path.join(tmpDir, 'source')

  await fs.mkdir(sourceRepo, { recursive: true })
  await git(sourceRepo, ['init'])
  await git(sourceRepo, ['config', 'user.email', 'test@test.com'])
  await git(sourceRepo, ['config', 'user.name', 'Test'])
  await fs.writeFile(path.join(sourceRepo, 'hello.txt'), 'hello world\n')
  await git(sourceRepo, ['add', '.'])
  await git(sourceRepo, ['commit', '-m', 'initial'])
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

async function commitToSource(file: string, message: string): Promise<void> {
  await fs.writeFile(path.join(sourceRepo, file), `${message}\n`)
  await git(sourceRepo, ['add', '.'])
  await git(sourceRepo, ['commit', '-m', message])
}

/** A branch's current commit subject, read with plain git. */
async function subjectAt(repo: string, ref: string): Promise<string> {
  return (await git(repo, ['log', '-1', '--format=%s', ref])).trim()
}

describe('cloneRepo', () => {
  it('clones a repo into a destination, pinned against pruning', async () => {
    const dest = path.join(tmpDir, 'clone')
    await cloneRepo(sourceRepo, dest, null)

    const cloned = await fs.readFile(path.join(dest, 'hello.txt'), 'utf8')
    expect(cloned).toBe('hello world\n')
    // Even git run without the server's pins must not prune objects the
    // checkouts borrow.
    expect((await git(dest, ['config', 'gc.pruneExpire'])).trim()).toBe('never')
  })
})

describe('getDefaultBranch', () => {
  it('gets the default branch name', async () => {
    const branch = await getDefaultBranch(sourceRepo)
    expect(['main', 'master']).toContain(branch)
  })

  it('gets default branch from origin/HEAD when available', async () => {
    const cloneDir = path.join(tmpDir, 'clone-default')
    await cloneRepo(sourceRepo, cloneDir, null)

    await git(cloneDir, ['checkout', '-q', '-b', 'feature-branch'])

    const branch = await getDefaultBranch(cloneDir)
    expect(['main', 'master']).toContain(branch)
  })

  it('names an empty clone\'s branch, which has no commit yet', async () => {
    const remote = path.join(tmpDir, 'empty.git')
    await git(tmpDir, ['init', '-q', '--bare', '-b', 'trunk', remote])
    const main = path.join(tmpDir, 'main')
    await cloneRepo(remote, main, null)
    expect(await getDefaultBranch(main)).toBe('trunk')
  })
})

describe('createCheckout', () => {
  it('makes a clone of its own that borrows every object from the main clone', async () => {
    await git(sourceRepo, ['branch', 'feature'])
    await git(sourceRepo, ['tag', 'v1'])
    await fs.mkdir(path.join(sourceRepo, 'frontends'), { recursive: true })
    await fs.writeFile(path.join(sourceRepo, 'frontends', 'app.txt'), 'app\n')
    await git(sourceRepo, ['add', '.'])
    await git(sourceRepo, ['commit', '-m', 'frontends'])
    const main = path.join(tmpDir, 'main')
    await cloneRepo(sourceRepo, main, null)
    const base = await getDefaultBranch(main)

    // /workspace is a bind of the workspace dir, so mount points may already
    // exist in it, and the pod may hold the dir, before the checkout runs.
    const wtPath = path.join(tmpDir, 'workspace')
    await fs.mkdir(path.join(wtPath, 'frontends', 'node_modules'), { recursive: true })
    const inode = (await fs.stat(wtPath)).ino

    await createCheckout(main, wtPath, { branch: 'agent/wt', baseBranch: base, remoteUrl: sourceRepo })

    expect((await fs.stat(wtPath)).ino).toBe(inode)
    expect((await fs.stat(path.join(wtPath, '.git'))).isDirectory()).toBe(true)
    expect(await fs.readFile(path.join(wtPath, 'frontends', 'app.txt'), 'utf8')).toBe('app\n')
    expect(await fs.readdir(path.join(wtPath, 'frontends', 'node_modules'))).toEqual([])
    expect((await git(wtPath, ['status', '--porcelain'])).trim()).toBe('')
    // Objects are borrowed through one alternates line, not copied.
    expect(await fs.readFile(path.join(wtPath, '.git', 'objects', 'info', 'alternates'), 'utf8'))
      .toBe(`${path.join(main, '.git', 'objects')}\n`)
    expect(await git(wtPath, ['count-objects', '-v'])).toMatch(/^count: 0$[\s\S]*^in-pack: 0$/m)
    // Its own refs: main's origin/* and tags, and its branch with upstream.
    const refs = (repo: string): Promise<string> =>
      git(repo, ['for-each-ref', '--format=%(objectname) %(refname)', 'refs/remotes/origin', 'refs/tags'])
    expect(await refs(wtPath)).toBe(await refs(main))
    expect((await git(wtPath, ['symbolic-ref', 'refs/remotes/origin/HEAD'])).trim()).toBe(`refs/remotes/origin/${base}`)
    expect((await git(wtPath, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()).toBe('agent/wt')
    expect((await git(wtPath, ['rev-parse', '--abbrev-ref', '@{u}'])).trim()).toBe(`origin/${base}`)
    expect((await git(wtPath, ['config', 'remote.origin.url'])).trim()).toBe(sourceRepo)
    // None of it is in the main clone.
    expect(await git(main, ['branch', '--list', 'agent/*'])).toBe('')
    await expect(fs.access(path.join(main, '.git', 'worktrees'))).rejects.toThrow()
    expect(await fs.readdir(tmpDir)).not.toContain('.staging-workspace')

    // A sibling checkout sees none of this clone's git state.
    await git(wtPath, ['-c', 'user.email=t@t', '-c', 'user.name=T', 'commit', '--allow-empty', '-m', 'mine'])
    await git(wtPath, ['config', 'core.hooksPath', '/nowhere'])
    const sibling = path.join(tmpDir, 'sibling')
    await createCheckout(main, sibling, { branch: 'agent/sib', baseBranch: base, remoteUrl: sourceRepo })
    expect(await git(sibling, ['branch', '--list', 'agent/wt'])).toBe('')
    await expect(git(sibling, ['config', 'core.hooksPath'])).rejects.toThrow()
  })

  it('leaves nothing behind when it fails, and a retry checks out over a half-written tree', async () => {
    const main = path.join(tmpDir, 'main')
    await cloneRepo(sourceRepo, main, null)
    const wtPath = path.join(tmpDir, 'workspace')
    await expect(createCheckout(main, wtPath, { branch: 'agent/r', baseBranch: 'no-such-branch', remoteUrl: sourceRepo }))
      .rejects.toThrow()
    await expect(fs.access(path.join(wtPath, '.git'))).rejects.toThrow()
    expect(await fs.readdir(tmpDir)).not.toContain('.staging-workspace')

    // A failed attempt left tracked files but no `.git`. They are untracked
    // to a new index, which an unforced checkout would refuse.
    await fs.mkdir(wtPath, { recursive: true })
    await fs.writeFile(path.join(wtPath, 'hello.txt'), 'half-written\n')
    await createCheckout(main, wtPath, { branch: 'agent/r', baseBranch: await getDefaultBranch(main), remoteUrl: sourceRepo })
    expect(await fs.readFile(path.join(wtPath, 'hello.txt'), 'utf8')).toBe('hello world\n')
  })

  it('starts an empty remote\'s checkout on an unborn branch', async () => {
    const remote = path.join(tmpDir, 'empty.git')
    await git(tmpDir, ['init', '-q', '--bare', '-b', 'trunk', remote])
    const main = path.join(tmpDir, 'main')
    await cloneRepo(remote, main, null)
    const wtPath = path.join(tmpDir, 'workspace')
    await createCheckout(main, wtPath, { branch: 'agent/e', baseBranch: 'trunk', remoteUrl: remote })
    expect((await git(wtPath, ['symbolic-ref', 'HEAD'])).trim()).toBe('refs/heads/agent/e')
    await expect(git(wtPath, ['rev-parse', '--verify', 'HEAD'])).rejects.toThrow()

    // The agent's first commit starts the history, and pushes to the base.
    await fs.writeFile(path.join(wtPath, 'a.txt'), 'a\n')
    await git(wtPath, ['add', '.'])
    await git(wtPath, ['-c', 'user.email=t@t', '-c', 'user.name=T', 'commit', '-q', '-m', 'first'])
    await git(wtPath, ['push', '-q', 'origin', 'HEAD:trunk'])
    expect(await subjectAt(remote, 'trunk')).toBe('first')
  })

  it('refuses a shallow main clone', async () => {
    const main = path.join(tmpDir, 'shallow')
    await commitToSource('second.txt', 'second')
    await git(tmpDir, ['clone', '-q', '--depth', '1', `file://${sourceRepo}`, main])
    await expect(createCheckout(main, path.join(tmpDir, 'wt'), {
      branch: 'agent/s', baseBranch: await getDefaultBranch(main), remoteUrl: sourceRepo,
    })).rejects.toThrow(/shallow/)
  })
})

describe('fetchOrigin', () => {
  it('updates remote refs, and prunes the ones origin deleted', async () => {
    await git(sourceRepo, ['branch', 'merged-and-gone'])
    const cloneDir = path.join(tmpDir, 'clone')
    await cloneRepo(sourceRepo, cloneDir, null)
    expect(await remoteBranchExists(cloneDir, 'merged-and-gone')).toBe(true)
    await commitToSource('new-file.txt', 'second commit')
    await git(sourceRepo, ['branch', '-D', 'merged-and-gone'])

    await fetchOrigin(cloneDir, sourceRepo, null)

    const defaultBranch = await getDefaultBranch(cloneDir)
    expect(await subjectAt(cloneDir, `origin/${defaultBranch}`)).toBe('second commit')
    // The symbolic origin/HEAD that getDefaultBranch reads survives the prune.
    expect(await remoteBranchExists(cloneDir, 'merged-and-gone')).toBe(false)
    expect((await git(cloneDir, ['symbolic-ref', 'refs/remotes/origin/HEAD'])).trim())
      .toBe(`refs/remotes/origin/${defaultBranch}`)
  })

  it('runs no hook configured in the main clone', async () => {
    // The runner pins hooks off on every call. Filters, URL rewrites and
    // credential helpers are not neutralised, since no pod can write here.
    const main = path.join(tmpDir, 'main-hooked')
    await cloneRepo(sourceRepo, main, null)
    const markers = path.join(tmpDir, 'markers')
    await fs.mkdir(markers)
    const hooksPath = path.join(tmpDir, 'hooks')
    for (const dir of [path.join(main, '.git', 'hooks'), hooksPath]) {
      await fs.mkdir(dir, { recursive: true })
      for (const hook of ['post-checkout', 'reference-transaction', 'post-index-change']) {
        await fs.writeFile(path.join(dir, hook), `#!/bin/sh\ntouch "${markers}/${hook}"\n`, { mode: 0o755 })
      }
    }
    await git(main, ['config', 'core.hooksPath', hooksPath])

    // The fetch updates refs, which fires `reference-transaction`.
    await commitToSource('new-file.txt', 'second commit')
    await fetchOrigin(main, sourceRepo, null)
    expect(await fs.readdir(markers)).toEqual([])
  })

  it('fetches from the URL it is given, whatever the clone says its origin is', async () => {
    // The clone's origin points at a decoy, yet the fetch lands only the
    // source's commit.
    const clone = path.join(tmpDir, 'clone-decoy')
    await cloneRepo(sourceRepo, clone, null)
    const decoy = path.join(tmpDir, 'decoy.git')
    await git(tmpDir, ['clone', '-q', '--bare', sourceRepo, decoy])
    await git(decoy, ['branch', 'decoy-only'])
    await git(clone, ['config', 'remote.origin.url', decoy])
    await commitToSource('new-file.txt', 'second commit')

    await fetchOrigin(clone, sourceRepo, null)

    const defaultBranch = await getDefaultBranch(clone)
    expect(await resolveRemoteRef(clone, defaultBranch))
      .toBe((await git(sourceRepo, ['rev-parse', 'HEAD'])).trim())
    expect(await remoteBranchExists(clone, 'decoy-only')).toBe(false)
  })

  it('concurrent fetches on one repo all succeed', async () => {
    // Fetches are serialized per repo; otherwise two fetches race on git's
    // ref locks and one fails with "cannot lock ref".
    const cloneDir = path.join(tmpDir, 'clone')
    await cloneRepo(sourceRepo, cloneDir, null)
    await commitToSource('new-file.txt', 'second commit')

    const fetches = Array.from({ length: 5 }, () => fetchOrigin(cloneDir, sourceRepo, null))
    await expect(Promise.all(fetches)).resolves.toBeDefined()

    const defaultBranch = await getDefaultBranch(cloneDir)
    expect(await subjectAt(cloneDir, `origin/${defaultBranch}`)).toBe('second commit')
  })

  it('joins callers onto a fetch not yet started, which still sees what each asked for', async () => {
    const cloneDir = path.join(tmpDir, 'clone')
    await cloneRepo(sourceRepo, cloneDir, null)

    const first = fetchOrigin(cloneDir, sourceRepo, null)
    expect(fetchOrigin(cloneDir, sourceRepo, null)).toBe(first)
    // Once the first has started, a new caller gets a queued fetch, which
    // later callers join until it starts.
    await new Promise((r) => setTimeout(r, 0))
    await commitToSource('late.txt', 'late commit')
    const second = fetchOrigin(cloneDir, sourceRepo, null)
    expect(second).not.toBe(first)
    expect(fetchOrigin(cloneDir, sourceRepo, null)).toBe(second)
    await Promise.all([first, second])

    const defaultBranch = await getDefaultBranch(cloneDir)
    expect(await subjectAt(cloneDir, `origin/${defaultBranch}`)).toBe('late commit')
  })

  it('with a token, fetches the authenticated URL rather than a remote name', async () => {
    const cloneDir = path.join(tmpDir, 'clone-token')
    await cloneRepo(sourceRepo, cloneDir, null)

    // The fetch fails to connect, but not with "does not appear to be a git
    // repository", which would mean the refspec was passed as the remote.
    try {
      await fetchOrigin(cloneDir, 'https://localhost/test/repo', { kind: 'https', token: 'fake-token' })
    } catch (err) {
      const msg = (err as Error).message
      expect(msg).not.toContain('does not appear to be a git repository')
    }
  })
})

describe('remoteBranchExists', () => {
  it('distinguishes present and missing remote branches', async () => {
    const defaultBranch = await getDefaultBranch(sourceRepo)
    await git(sourceRepo, ['branch', 'develop'])

    const cloneDir = path.join(tmpDir, 'clone-branches')
    await cloneRepo(sourceRepo, cloneDir, null)

    expect(await remoteBranchExists(cloneDir, defaultBranch)).toBe(true)
    expect(await remoteBranchExists(cloneDir, 'develop')).toBe(true)
    expect(await remoteBranchExists(cloneDir, 'no-such-branch')).toBe(false)
  })
})

describe('resolveRemoteRef', () => {
  it('names the commit a remote branch points at, and rejects a missing one', async () => {
    const cloneDir = path.join(tmpDir, 'clone-ref')
    await cloneRepo(sourceRepo, cloneDir, null)
    const defaultBranch = await getDefaultBranch(cloneDir)

    const head = (await git(sourceRepo, ['rev-parse', 'HEAD'])).trim()
    expect(await resolveRemoteRef(cloneDir, defaultBranch)).toBe(head)
    await expect(resolveRemoteRef(cloneDir, 'no-such-branch')).rejects.toThrow()
  })
})

describe('listRemoteBranches', () => {
  it('returns names newest-committed first, without HEAD', async () => {
    const defaultBranch = await getDefaultBranch(sourceRepo)
    await git(sourceRepo, ['checkout', '-q', '-b', 'develop'])
    // A later commit so develop sorts first. Git timestamps are whole
    // seconds, so the dates are pinned rather than slept for.
    await fs.writeFile(path.join(sourceRepo, 'dev.txt'), 'dev\n')
    await git(sourceRepo, ['add', '.'])
    await git(sourceRepo, ['commit', '-m', 'develop commit'], {
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: '2030-01-01T00:00:00Z',
        GIT_COMMITTER_DATE: '2030-01-01T00:00:00Z',
      },
    })
    await git(sourceRepo, ['checkout', '-q', defaultBranch])

    const cloneDir = path.join(tmpDir, 'clone-list')
    await cloneRepo(sourceRepo, cloneDir, null)

    const branches = await listRemoteBranches(cloneDir)
    expect(branches[0]).toBe('develop')
    expect(branches).toContain(defaultBranch)
    expect(branches).not.toContain('HEAD')
  })
})

describe('maintainRepo', () => {
  it('packs the main clone and never deletes an object a clone borrows', async () => {
    // Check out `feature`, then force-push it upstream, fetch into the main
    // clone and expire its reflogs, so the checkout's commit is unreachable
    // from the main clone.
    const base = await getDefaultBranch(sourceRepo)
    await git(sourceRepo, ['checkout', '-q', '-b', 'feature'])
    await commitToSource('feat.txt', 'feature one')
    await git(sourceRepo, ['checkout', '-q', base])
    const main = path.join(tmpDir, 'main')
    await cloneRepo(sourceRepo, main, null)
    const wtPath = path.join(tmpDir, 'wt')
    await createCheckout(main, wtPath, { branch: 'agent/m', baseBranch: 'feature', remoteUrl: sourceRepo })
    await git(sourceRepo, ['branch', '-f', 'feature', base])

    // Enough fetched packs that `gc --auto` has work to do.
    const packs = async (): Promise<number> =>
      (await fs.readdir(path.join(main, '.git', 'objects', 'pack'))).filter((f) => f.endsWith('.pack')).length
    const unpackLimit = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'transfer.unpackLimit', GIT_CONFIG_VALUE_0: '1' }
    Object.assign(process.env, unpackLimit)
    try {
      for (let i = 0; i < 52; i++) {
        await commitToSource(`n${i}.txt`, `n${i}`)
        await fetchOrigin(main, sourceRepo, null)
      }
    } finally {
      for (const k of Object.keys(unpackLimit)) delete process.env[k]
    }
    await git(main, ['reflog', 'expire', '--expire=now', '--expire-unreachable=now', '--all'])
    // Age objects past git's two-week prune expiry, so only the pins keep
    // the commit (a fresh unreachable object survives any gc).
    const aged = new Date('2025-01-01T00:00:00Z')
    const age = async (dir: string): Promise<void> => {
      for (const e of await fs.readdir(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name)
        if (e.isDirectory()) await age(p)
        await fs.utimes(p, aged, aged)
      }
    }
    await age(path.join(main, '.git', 'objects'))
    const before = await packs()

    for (let i = 0; i < 3; i++) await maintainRepo(main)

    expect(await packs()).toBeLessThan(before)
    await git(wtPath, ['fsck', '--connectivity-only'])
    expect(await subjectAt(wtPath, 'agent/m')).toBe('feature one')
  })
})

describe('lastFetchedAtMs', () => {
  it('is the newest of the server\'s fetch and the checkout\'s own fetches, ignoring failed ones', async () => {
    const main = path.join(tmpDir, 'main')
    await cloneRepo(sourceRepo, main, null)
    const base = await getDefaultBranch(main)
    const wtPath = path.join(tmpDir, 'wt')
    await createCheckout(main, wtPath, { branch: 'agent/f', baseBranch: base, remoteUrl: sourceRepo })
    const gitDir = path.join(wtPath, '.git')

    const before = Date.now()
    await fetchOrigin(main, sourceRepo, null)
    const fetched = await lastFetchedAtMs(main, base, gitDir)
    expect(fetched).toBeGreaterThanOrEqual(before)
    // A failed fetch empties FETCH_HEAD, which must not read as fresh.
    await new Promise((r) => setTimeout(r, 20))
    await expect(fetchOrigin(main, path.join(tmpDir, 'no-such-repo'), null)).rejects.toThrow()
    expect(await lastFetchedAtMs(main, base, gitDir)).toBe(fetched)
    // A fetch the agent ran leaves FETCH_HEAD in the checkout. Whole
    // seconds, so the filesystem stores the time exactly.
    const agentFetch = new Date(Math.ceil(Date.now() / 1000) * 1000 + 60_000)
    await fs.writeFile(path.join(gitDir, 'FETCH_HEAD'), 'abc\t\tbranch \'main\'\n')
    await fs.utimes(path.join(gitDir, 'FETCH_HEAD'), agentFetch, agentFetch)
    expect(await lastFetchedAtMs(main, base, gitDir)).toBe(agentFetch.getTime())
  })
})

describe('listTreeSubdirs', () => {
  it('lists the subtrees under a path at a ref, [] when the path is absent', async () => {
    await fs.mkdir(path.join(sourceRepo, 'skills', 'alpha'), { recursive: true })
    await fs.writeFile(path.join(sourceRepo, 'skills', 'alpha', 'SKILL.md'), 'a\n')
    await fs.writeFile(path.join(sourceRepo, 'skills', 'loose.md'), 'blob, not a tree\n')
    await fs.symlink('alpha', path.join(sourceRepo, 'skills', 'linked'))
    await commitToSource('skills/.keep', 'skills')

    expect(await listTreeSubdirs(sourceRepo, 'HEAD', 'skills')).toEqual(['alpha'])
    expect(await listTreeSubdirs(sourceRepo, 'HEAD', 'no-such-dir')).toEqual([])
  })
})

describe('readBlobAt', () => {
  it('reads the committed bytes, null when there is no such blob', async () => {
    expect(await readBlobAt(sourceRepo, 'HEAD', 'hello.txt')).toBe('hello world\n')
    expect(await readBlobAt(sourceRepo, 'HEAD', 'missing.txt')).toBeNull()
  })
})
