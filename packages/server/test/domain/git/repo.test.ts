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
import { serverLocalPath } from '@yaac/shared/paths'
import { git } from '@yaac/test-utils/git'

let tmpDir: string
let sourceRepo: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-git-test-'))
  sourceRepo = path.join(tmpDir, 'source')

  // Create a source repo with a commit
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

/**
 * A clone whose `.git` holds what a workspace pod can write there, each piece
 * naming a command that leaves a file in `markers` when it runs: a filter
 * driver every path selects, hooks in both the default dir and a
 * `core.hooksPath`, and an fsmonitor; plus an `origin` and a URL rewrite
 * that both lead to a decoy repository holding a `decoy-only` branch.
 *
 * Last, the config includes a file git cannot parse, so ANY git process
 * that opens the real config dies — the direct probe of the runner's
 * invariant, including for git's own child processes. It also means plain
 * git cannot read the clone afterwards; assertions go through the verbs.
 */
interface Hostile {
  clone: string
  markers: string
  configPath: string
  configBefore: string
  configInode: number
}

async function hostileClone(): Promise<Hostile> {
  const clone = path.join(tmpDir, 'hostile')
  await cloneRepo(sourceRepo, clone, null)
  const markers = path.join(tmpDir, 'markers')
  await fs.mkdir(markers)
  const evil = path.join(tmpDir, 'evil.sh')
  // Touches a marker; as a filter, it also passes stdin through so the
  // content still "works".
  await fs.writeFile(evil, `#!/bin/sh\ntouch "${markers}/$1"\ncase "$1" in filter-*) cat ;; esac\n`)
  await fs.chmod(evil, 0o755)

  const decoy = path.join(tmpDir, 'decoy.git')
  await git(tmpDir, ['clone', '-q', '--bare', sourceRepo, decoy])
  await git(decoy, ['branch', 'decoy-only'])

  const gitDir = path.join(clone, '.git')
  const hooksPath = path.join(tmpDir, 'hooks')
  for (const dir of [path.join(gitDir, 'hooks'), hooksPath]) {
    await fs.mkdir(dir, { recursive: true })
    for (const hook of ['post-checkout', 'reference-transaction', 'pre-auto-gc', 'post-index-change']) {
      await fs.writeFile(path.join(dir, hook), `#!/bin/sh\n"${evil}" hook-${hook} </dev/null\n`)
      await fs.chmod(path.join(dir, hook), 0o755)
    }
  }
  const unparseable = path.join(tmpDir, 'unparseable.gitconfig')
  await fs.writeFile(unparseable, '[broken\n')
  for (const [key, value] of [
    ['filter.evil.clean', `"${evil}" filter-clean`],
    ['filter.evil.smudge', `"${evil}" filter-smudge`],
    ['core.hooksPath', hooksPath],
    ['core.fsmonitor', `"${evil}" fsmonitor`],
    [`url.${decoy}.insteadOf`, sourceRepo],
    ['remote.origin.url', decoy],
    ['include.path', unparseable],
  ]) {
    await git(clone, ['config', key, value])
  }
  await fs.mkdir(path.join(gitDir, 'info'), { recursive: true })
  await fs.writeFile(path.join(gitDir, 'info', 'attributes'), '* filter=evil\n')

  const configPath = path.join(gitDir, 'config')
  return {
    clone,
    markers,
    configPath,
    configBefore: await fs.readFile(configPath, 'utf8'),
    configInode: (await fs.stat(configPath)).ino,
  }
}

/** Nothing the hostile clone planted ran, its config is the file it was,
 *  and no throwaway git dir outlived its call. */
async function expectUntouched(h: Hostile): Promise<void> {
  expect(await fs.readdir(h.markers)).toEqual([])
  expect(await fs.readFile(h.configPath, 'utf8')).toBe(h.configBefore)
  expect((await fs.stat(h.configPath)).ino).toBe(h.configInode)
  expect(await fs.readdir(serverLocalPath('run', 'git-shadow'))).toEqual([])
}

describe('cloneRepo', () => {
  it('clones a repo into a destination, pinned against pruning', async () => {
    const dest = path.join(tmpDir, 'clone')
    await cloneRepo(sourceRepo, dest, null)

    const cloned = await fs.readFile(path.join(dest, 'hello.txt'), 'utf8')
    expect(cloned).toBe('hello world\n')
    // Git run in the main clone without the server's pins must not prune
    // what the checkouts borrow either.
    expect((await git(dest, ['config', 'gc.pruneExpire'])).trim()).toBe('never')
  })
})

describe('getDefaultBranch', () => {
  it('gets the default branch name', async () => {
    const branch = await getDefaultBranch(sourceRepo)
    expect(['main', 'master']).toContain(branch)
  })

  it('gets default branch from origin/HEAD when available', async () => {
    // Clone the source so we have an "origin" remote
    const cloneDir = path.join(tmpDir, 'clone-default')
    await cloneRepo(sourceRepo, cloneDir, null)

    // Checkout a different branch so HEAD != default
    await git(cloneDir, ['checkout', '-q', '-b', 'feature-branch'])

    // getDefaultBranch should still return the remote default, not 'feature-branch'
    const branch = await getDefaultBranch(cloneDir)
    expect(['main', 'master']).toContain(branch)
  })

  it('answers from a hostile clone without running anything it planted', async () => {
    const h = await hostileClone()
    expect(['main', 'master']).toContain(await getDefaultBranch(h.clone))
    await expectUntouched(h)
  })

  it('refuses a clone whose config or HEAD it cannot read safely', async () => {
    // Every verb reads the repository the same way; this one stands in.
    const cloneDir = path.join(tmpDir, 'clone-refused')
    await cloneRepo(sourceRepo, cloneDir, null)
    const gitDir = path.join(cloneDir, '.git')
    const config = await fs.readFile(path.join(gitDir, 'config'), 'utf8')

    // A symlinked config is refused, not followed to what it names.
    const elsewhere = path.join(tmpDir, 'elsewhere.gitconfig')
    await fs.writeFile(elsewhere, config)
    await fs.rm(path.join(gitDir, 'config'))
    await fs.symlink(elsewhere, path.join(gitDir, 'config'))
    await expect(getDefaultBranch(cloneDir)).rejects.toThrow()
    await fs.rm(path.join(gitDir, 'config'))

    // A format, or a ref storage, the throwaway git dir cannot stand in for.
    for (const extra of ['[core]\n\trepositoryformatversion = 2\n', '[extensions]\n\trefstorage = reftable\n']) {
      await fs.writeFile(path.join(gitDir, 'config'), config + extra)
      await expect(getDefaultBranch(cloneDir)).rejects.toThrow(/unsupported/)
    }
    await fs.writeFile(path.join(gitDir, 'config'), config)

    const head = await fs.readFile(path.join(gitDir, 'HEAD'), 'utf8')
    await fs.writeFile(path.join(gitDir, 'HEAD'), 'not a ref\n')
    await expect(getDefaultBranch(cloneDir)).rejects.toThrow(/HEAD/)
    await fs.writeFile(path.join(gitDir, 'HEAD'), head)
    expect(['main', 'master']).toContain(await getDefaultBranch(cloneDir))
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

    // /workspace is a bind of the workspace dir, so the pod's module mount
    // points are directories ON it before the checkout runs, and the pod may
    // already hold the dir itself.
    const wtPath = path.join(tmpDir, 'workspace')
    await fs.mkdir(path.join(wtPath, 'frontends', 'node_modules'), { recursive: true })
    const inode = (await fs.stat(wtPath)).ino

    await createCheckout(main, wtPath, { branch: 'agent/wt', baseBranch: base, remoteUrl: sourceRepo })

    expect((await fs.stat(wtPath)).ino).toBe(inode)
    expect((await fs.stat(path.join(wtPath, '.git'))).isDirectory()).toBe(true)
    expect(await fs.readFile(path.join(wtPath, 'frontends', 'app.txt'), 'utf8')).toBe('app\n')
    expect(await fs.readdir(path.join(wtPath, 'frontends', 'node_modules'))).toEqual([])
    expect((await git(wtPath, ['status', '--porcelain'])).trim()).toBe('')
    // Borrowed, not copied: one alternates line, the main clone's objects.
    expect(await fs.readFile(path.join(wtPath, '.git', 'objects', 'info', 'alternates'), 'utf8'))
      .toBe(`${path.join(main, '.git', 'objects')}\n`)
    expect(await git(wtPath, ['count-objects', '-v'])).toMatch(/^count: 0$[\s\S]*^in-pack: 0$/m)
    // Its own refs: main's origin/* and tags, and its branch with an upstream.
    const refs = (repo: string): Promise<string> =>
      git(repo, ['for-each-ref', '--format=%(objectname) %(refname)', 'refs/remotes/origin', 'refs/tags'])
    expect(await refs(wtPath)).toBe(await refs(main))
    expect((await git(wtPath, ['symbolic-ref', 'refs/remotes/origin/HEAD'])).trim()).toBe(`refs/remotes/origin/${base}`)
    expect((await git(wtPath, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()).toBe('agent/wt')
    expect((await git(wtPath, ['rev-parse', '--abbrev-ref', '@{u}'])).trim()).toBe(`origin/${base}`)
    expect((await git(wtPath, ['config', 'remote.origin.url'])).trim()).toBe(sourceRepo)
    // Nothing of it is in the main clone.
    expect(await git(main, ['branch', '--list', 'agent/*'])).toBe('')
    await expect(fs.access(path.join(main, '.git', 'worktrees'))).rejects.toThrow()
    expect(await fs.readdir(tmpDir)).not.toContain('.staging-workspace')

    // A commit in the clone lands in the clone, and a sibling sees none of
    // its git state.
    await git(wtPath, ['-c', 'user.email=t@t', '-c', 'user.name=T', 'commit', '--allow-empty', '-m', 'mine'])
    await git(wtPath, ['config', 'core.hooksPath', '/nowhere'])
    const sibling = path.join(tmpDir, 'sibling')
    await createCheckout(main, sibling, { branch: 'agent/sib', baseBranch: base, remoteUrl: sourceRepo })
    expect(await git(sibling, ['branch', '--list', 'agent/wt'])).toBe('')
    await expect(git(sibling, ['config', 'core.hooksPath'])).rejects.toThrow()
  })

  it('checks out from a hostile main clone without running anything it planted', async () => {
    const h = await hostileClone()
    const wtPath = path.join(tmpDir, 'wt-hostile')
    await createCheckout(h.clone, wtPath, {
      branch: 'agent/hostile', baseBranch: await getDefaultBranch(h.clone), remoteUrl: sourceRepo,
    })
    expect(await fs.readFile(path.join(wtPath, 'hello.txt'), 'utf8')).toBe('hello world\n')
    // The clone's config is the server's: plain git reads it, and none of
    // the main clone's hooks, filters or rewrites came along.
    expect((await git(wtPath, ['config', '--list', '--local'])).split('\n').filter(Boolean).map((l) => l.split('=')[0]).sort())
      .toEqual([
        'branch.agent/hostile.merge', 'branch.agent/hostile.remote', 'core.bare', 'core.filemode', 'core.logallrefupdates',
        'core.repositoryformatversion', 'remote.origin.fetch', 'remote.origin.url',
      ])
    await expectUntouched(h)
  })

  it('leaves nothing behind when it fails, and a retry checks out over a half-written tree', async () => {
    const main = path.join(tmpDir, 'main')
    await cloneRepo(sourceRepo, main, null)
    const wtPath = path.join(tmpDir, 'workspace')
    await expect(createCheckout(main, wtPath, { branch: 'agent/r', baseBranch: 'no-such-branch', remoteUrl: sourceRepo }))
      .rejects.toThrow()
    await expect(fs.access(path.join(wtPath, '.git'))).rejects.toThrow()
    expect(await fs.readdir(tmpDir)).not.toContain('.staging-workspace')

    // An earlier attempt got tracked files down but no `.git`: every one is
    // untracked to a new index, which an unforced checkout would refuse.
    await fs.mkdir(wtPath, { recursive: true })
    await fs.writeFile(path.join(wtPath, 'hello.txt'), 'half-written\n')
    await createCheckout(main, wtPath, { branch: 'agent/r', baseBranch: await getDefaultBranch(main), remoteUrl: sourceRepo })
    expect(await fs.readFile(path.join(wtPath, 'hello.txt'), 'utf8')).toBe('hello world\n')
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

    // origin/<default> has the new commit even though the local branch hasn't moved
    const defaultBranch = await getDefaultBranch(cloneDir)
    expect(await subjectAt(cloneDir, `origin/${defaultBranch}`)).toBe('second commit')
    // The deleted branch is gone, while the symbolic origin/HEAD that
    // getDefaultBranch reads survives the prune.
    expect(await remoteBranchExists(cloneDir, 'merged-and-gone')).toBe(false)
    expect((await git(cloneDir, ['symbolic-ref', 'refs/remotes/origin/HEAD'])).trim())
      .toBe(`refs/remotes/origin/${defaultBranch}`)
  })

  it('fetches from the URL it is given, whatever the clone says its origin is', async () => {
    // The clone's origin and a URL rewrite both lead to the decoy; the
    // fetch still lands the source's new commit and none of the decoy's
    // branches, and the reference-transaction hook the ref update would
    // fire never runs.
    const h = await hostileClone()
    await commitToSource('new-file.txt', 'second commit')

    await fetchOrigin(h.clone, sourceRepo, null)

    const defaultBranch = await getDefaultBranch(h.clone)
    expect(await resolveRemoteRef(h.clone, defaultBranch))
      .toBe((await git(sourceRepo, ['rev-parse', 'HEAD'])).trim())
    expect(await remoteBranchExists(h.clone, 'decoy-only')).toBe(false)
    await expectUntouched(h)
  })

  it('concurrent fetches on one repo all succeed', async () => {
    // Fetches are serialized per repo: unserialized, two fetches moving the
    // same remote-tracking ref race git's per-ref locks and one dies with
    // "cannot lock ref 'refs/remotes/origin/<branch>'".
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
    // Once it has started, a caller needs a fetch of its own — one queued
    // behind it, joined by everyone else who asks before it starts.
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

    // No server answers here, so the fetch fails to connect — but not with
    // "does not appear to be a git repository", which would mean the
    // refspec was passed as the remote instead of the URL.
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
    // A later commit so develop sorts ahead of the default branch. The
    // committer date needs to actually differ — git timestamps are
    // second-granular, so pin them explicitly instead of sleeping.
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
    // A clone of `feature`, which is then force-pushed upstream and fetched
    // into the main clone, whose reflogs are expired: the clone's commit is
    // now unreachable from anything the main clone can see.
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
    // Aged past git's default two-week prune expiry, so only the pins keep
    // the clone's commit: a seconds-old unreachable object survives any gc.
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
  it('is the newest of the server fetch record and the checkout\'s own fetches', async () => {
    const main = path.join(tmpDir, 'main')
    await cloneRepo(sourceRepo, main, null)
    const base = await getDefaultBranch(main)
    const wtPath = path.join(tmpDir, 'wt')
    await createCheckout(main, wtPath, { branch: 'agent/f', baseBranch: base, remoteUrl: sourceRepo })
    const gitDir = path.join(wtPath, '.git')

    const before = Date.now()
    await fetchOrigin(main, sourceRepo, null)
    expect(await lastFetchedAtMs(main, base, gitDir)).toBeGreaterThanOrEqual(before)
    // A fetch the agent ran itself leaves the checkout's FETCH_HEAD. Whole
    // seconds, so the filesystem stores it exactly.
    const agentFetch = new Date(Math.ceil(Date.now() / 1000) * 1000 + 60_000)
    await fs.writeFile(path.join(gitDir, 'FETCH_HEAD'), '')
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
    // The hostile clone's filter would rewrite what a converting read
    // returned; `readBlobAt` hands back exactly what was committed.
    const h = await hostileClone()
    expect(await readBlobAt(h.clone, 'HEAD', 'hello.txt')).toBe('hello world\n')
    expect(await readBlobAt(h.clone, 'HEAD', 'missing.txt')).toBeNull()
    await expectUntouched(h)
  })
})
