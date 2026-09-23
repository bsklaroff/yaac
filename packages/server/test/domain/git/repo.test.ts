import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  addWorktree,
  cloneRepo,
  fetchOrigin,
  getDefaultBranch,
  listCheckoutFiles,
  listRemoteBranches,
  listTreeSubdirs,
  readBlobAt,
  remoteBranchExists,
  resolveRemoteRef,
  worktreeUpstreamBranch,
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
 * A clone whose `.git` holds what a worktree pod can write there, each piece
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
  it('clones a repo into a destination', async () => {
    const dest = path.join(tmpDir, 'clone')
    await cloneRepo(sourceRepo, dest, null)

    const cloned = await fs.readFile(path.join(dest, 'hello.txt'), 'utf8')
    expect(cloned).toBe('hello world\n')
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

describe('addWorktree', () => {
  it('creates a worktree with a new branch', async () => {
    const wtPath = path.join(tmpDir, 'worktree')
    await addWorktree(sourceRepo, wtPath, 'agent/test-session')

    // Verify worktree exists and has files
    const content = await fs.readFile(path.join(wtPath, 'hello.txt'), 'utf8')
    expect(content).toBe('hello world\n')

    // Verify branch was created
    const branch = await git(wtPath, ['rev-parse', '--abbrev-ref', 'HEAD'])
    expect(branch.trim()).toBe('agent/test-session')
  })

  it('checks out a hostile clone without running anything it planted', async () => {
    // What the server's own checkout of a pod-written repository must not
    // do: run its filter driver, its hooks or its fsmonitor. The tree is
    // the committed bytes — no smudge touched them.
    const h = await hostileClone()
    const defaultBranch = await getDefaultBranch(h.clone)
    const wtPath = path.join(tmpDir, 'wt-hostile')
    await addWorktree(h.clone, wtPath, 'agent/hostile', `origin/${defaultBranch}`)

    expect(await fs.readFile(path.join(wtPath, 'hello.txt'), 'utf8')).toBe('hello world\n')
    // The checkout names the REAL admin dir — git itself reached it through
    // a throwaway git dir whose path it would otherwise have written here.
    expect(await fs.readFile(path.join(wtPath, '.git'), 'utf8'))
      .toBe(`gitdir: ${path.join(h.clone, '.git', 'worktrees', 'wt-hostile')}\n`)
    await expectUntouched(h)

    // The rollback runs git against the same repository: fail AFTER the add
    // has made the branch and the admin dir, with a `.git` directory in the
    // way of the checkout's `.git` file.
    const blocked = path.join(tmpDir, 'wt-bad')
    await fs.mkdir(path.join(blocked, '.git'), { recursive: true })
    await fs.writeFile(path.join(blocked, '.git', 'blocker'), 'x')
    await expect(addWorktree(h.clone, blocked, 'agent/bad', `origin/${defaultBranch}`)).rejects.toThrow()
    const gitDir = path.join(h.clone, '.git')
    await expect(fs.access(path.join(gitDir, 'worktrees', 'wt-bad'))).rejects.toThrow()
    await expect(fs.access(path.join(gitDir, 'refs', 'heads', 'agent', 'bad'))).rejects.toThrow()
    await expectUntouched(h)
  })

  it('leaves a sibling worktree alone when its admin gitdir names a pod path', async () => {
    // Every worktree yaac has started has an admin `gitdir` rewritten to the
    // CONTAINER's view of itself (`/workspace/.git`, see
    // buildWorktreeLinkExec) — a path that means something quite different in
    // whatever namespace the server happens to be running in.
    //
    // `git worktree repair` is not scoped to the path it is handed: it walks
    // every worktree in the repo and, wherever a `gitdir` no longer resolves,
    // writes a fresh `.git` file at the path that file names. Using it here
    // would follow those pod paths out of the repo and overwrite whatever
    // real directory sits at the far end — inside a nested yaac or an e2e run
    // in a session, that is a live worktree someone is working in.
    const first = path.join(tmpDir, 'first')
    await addWorktree(sourceRepo, first, 'agent/first')
    const adminDir = (await fs.readFile(path.join(first, '.git'), 'utf8'))
      .replace(/^gitdir:/, '').trim()

    // Stand in for /workspace: a directory that is not this repo's business.
    const bystander = path.join(tmpDir, 'bystander')
    await fs.mkdir(bystander, { recursive: true })
    await fs.writeFile(path.join(adminDir, 'gitdir'), `${bystander}/.git\n`)

    await addWorktree(sourceRepo, path.join(tmpDir, 'second'), 'agent/second')

    expect(await fs.readdir(bystander)).toEqual([])
    // The second worktree is still fully wired: its own admin entry points
    // at it, which is the whole of the repair it needs.
    const second = path.join(tmpDir, 'second')
    expect((await git(second, ['status', '--porcelain'])).trim()).toBe('')
    expect((await git(second, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()).toBe('agent/second')
  })

  it('checks out into a destination that already holds the pod mount points', async () => {
    // /workspace is a bind of the worktree dir, so an ephemeral-module
    // mount at /workspace/frontends/node_modules is a directory ON the host
    // worktree before the checkout runs — and `git worktree add` refuses any
    // destination that is not an empty dir, `--force` included. This is the
    // case the staged checkout exists for.
    await fs.mkdir(path.join(sourceRepo, 'frontends'), { recursive: true })
    await fs.writeFile(path.join(sourceRepo, 'frontends', 'app.txt'), 'app\n')
    await git(sourceRepo, ['add', '.'])
    await git(sourceRepo, ['commit', '-m', 'frontends'])

    const wtPath = path.join(tmpDir, 'worktree')
    await fs.mkdir(path.join(wtPath, 'node_modules'), { recursive: true })
    await fs.mkdir(path.join(wtPath, 'frontends', 'node_modules'), { recursive: true })

    await addWorktree(sourceRepo, wtPath, 'agent/mounted')

    expect(await fs.readFile(path.join(wtPath, 'hello.txt'), 'utf8')).toBe('hello world\n')
    expect(await fs.readFile(path.join(wtPath, 'frontends', 'app.txt'), 'utf8')).toBe('app\n')
    // The mount points survive — the pod may already be bound to them — and
    // the checked-out tree is clean.
    expect(await fs.readdir(path.join(wtPath, 'node_modules'))).toEqual([])
    expect(await fs.readdir(path.join(wtPath, 'frontends', 'node_modules'))).toEqual([])
    expect((await git(wtPath, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()).toBe('agent/mounted')
    expect((await git(wtPath, ['status', '--porcelain'])).trim()).toBe('')

    // The admin dir keeps the destination's basename — the in-pod relink
    // addresses it as /repo/.git/worktrees/<session id> — and points back at
    // the real worktree, not at the staging dir the checkout was born in.
    expect(await fs.readdir(path.join(sourceRepo, '.git', 'worktrees'))).toEqual(['worktree'])
    const gitdir = await fs.readFile(
      path.join(sourceRepo, '.git', 'worktrees', 'worktree', 'gitdir'), 'utf8')
    expect(gitdir.trim()).toBe(path.join(await fs.realpath(wtPath), '.git'))
    expect(await fs.readdir(tmpDir)).not.toContain('.staging-worktree')
  })

  it('rolls a failed add back so the same id can be retried', async () => {
    // A create that dies here is a never-started session, and restarting
    // one resumes the SAME id — so the branch and the registration the
    // staged add creates before the fallible steps must not survive it.
    // A `.git` that is a non-empty DIRECTORY fails writing the checkout's
    // `.git` file after the add has already made both.
    const wtPath = path.join(tmpDir, 'worktree')
    await fs.mkdir(path.join(wtPath, '.git'), { recursive: true })
    await fs.writeFile(path.join(wtPath, '.git', 'blocker'), 'x')

    await expect(addWorktree(sourceRepo, wtPath, 'agent/retried')).rejects.toThrow()

    const worktreesDir = path.join(sourceRepo, '.git', 'worktrees')
    expect(await fs.readdir(worktreesDir).catch(() => [])).toEqual([])
    expect(await git(sourceRepo, ['branch', '--list', 'agent/retried'])).toBe('')
    // The blocker is not ours to remove — only a `.git` this call wrote is.
    expect(await fs.readdir(path.join(wtPath, '.git'))).toEqual(['blocker'])
    expect(await fs.readdir(tmpDir)).not.toContain('.staging-worktree')

    await fs.rm(path.join(wtPath, '.git'), { recursive: true, force: true })
    await addWorktree(sourceRepo, wtPath, 'agent/retried')
    expect(await fs.readFile(path.join(wtPath, 'hello.txt'), 'utf8')).toBe('hello world\n')
    expect(await fs.readdir(worktreesDir)).toEqual(['worktree'])
  })

  it('checks out over a crashed attempt half-written tree', async () => {
    // Same never-started restart path, one step further along: the earlier
    // attempt got tracked files down but no `.git`. An empty index makes
    // every one of them untracked, and an unforced checkout refuses to
    // overwrite an untracked file even byte-for-byte.
    const wtPath = path.join(tmpDir, 'worktree')
    await fs.mkdir(path.join(wtPath, 'node_modules'), { recursive: true })
    await fs.writeFile(path.join(wtPath, 'hello.txt'), 'half-written\n')

    await addWorktree(sourceRepo, wtPath, 'agent/crashed')

    expect(await fs.readFile(path.join(wtPath, 'hello.txt'), 'utf8')).toBe('hello world\n')
    expect(await fs.readdir(path.join(wtPath, 'node_modules'))).toEqual([])
    expect((await git(wtPath, ['status', '--porcelain'])).trim()).toBe('')
  })

  it('creates a worktree from a start point without writing tracking config', async () => {
    // Clone so we have a remote called "origin"
    const cloneDir = path.join(tmpDir, 'clone')
    await cloneRepo(sourceRepo, cloneDir, null)

    const defaultBranch = await getDefaultBranch(cloneDir)
    const configPath = path.join(cloneDir, '.git', 'config')
    const configBefore = await fs.readFile(configPath, 'utf8')
    const wtPath = path.join(tmpDir, 'worktree')
    await addWorktree(cloneDir, wtPath, 'agent/test-untracked', `origin/${defaultBranch}`)

    // The branch starts at the remote head...
    const head = await git(wtPath, ['rev-parse', 'HEAD'])
    const remoteHead = await git(wtPath, ['rev-parse', `origin/${defaultBranch}`])
    expect(head.trim()).toBe(remoteHead.trim())

    // ...but no tracking entry may be written: host-side rewrites of the
    // shared .git/config go stale under the virtiofs cache session pods
    // read through (transient "unknown error occurred while reading the
    // configuration files" in-pod). The upstream is set from inside the
    // pod at session setup instead.
    const configAfter = await fs.readFile(configPath, 'utf8')
    expect(configAfter).toBe(configBefore)
    await expect(
      git(wtPath, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']),
    ).rejects.toThrow()
  })

  it('concurrent worktree adds on one repo all succeed', async () => {
    // With --no-track nothing writes .git/config, so concurrent adds have
    // no lock to race and need no serialization — they must all land.
    const cloneDir = path.join(tmpDir, 'clone')
    await cloneRepo(sourceRepo, cloneDir, null)
    const defaultBranch = await getDefaultBranch(cloneDir)

    const adds = Array.from({ length: 5 }, (_, i) =>
      addWorktree(
        cloneDir,
        path.join(tmpDir, `wt-${i}`),
        `agent/concurrent-${i}`,
        `origin/${defaultBranch}`,
      ))
    await expect(Promise.all(adds)).resolves.toBeDefined()

    for (let i = 0; i < 5; i++) {
      const branch = await git(path.join(tmpDir, `wt-${i}`), ['rev-parse', '--abbrev-ref', 'HEAD'])
      expect(branch.trim()).toBe(`agent/concurrent-${i}`)
    }
  })

  it('a failed worktree add does not affect a concurrent add on the same repo', async () => {
    const cloneDir = path.join(tmpDir, 'clone')
    await cloneRepo(sourceRepo, cloneDir, null)
    const defaultBranch = await getDefaultBranch(cloneDir)

    const bad = addWorktree(cloneDir, path.join(tmpDir, 'wt-bad'), 'agent/dup', 'origin/does-not-exist')
    const good = addWorktree(cloneDir, path.join(tmpDir, 'wt-good'), 'agent/ok', `origin/${defaultBranch}`)

    await expect(bad).rejects.toThrow()
    await expect(good).resolves.toBeUndefined()
  })

  it('creates worktree from startPoint with latest remote content', async () => {
    const cloneDir = path.join(tmpDir, 'clone')
    await cloneRepo(sourceRepo, cloneDir, null)
    await commitToSource('new-file.txt', 'new content')
    await fetchOrigin(cloneDir, sourceRepo, null)

    // Create worktree from origin/<default> — should include the new commit
    const defaultBranch = await getDefaultBranch(cloneDir)
    const wtPath = path.join(tmpDir, 'wt-startpoint')
    await addWorktree(cloneDir, wtPath, 'agent/from-origin', `origin/${defaultBranch}`)

    const content = await fs.readFile(path.join(wtPath, 'new-file.txt'), 'utf8')
    expect(content).toBe('new content\n')
  })
})

describe('fetchOrigin', () => {
  it('updates remote refs', async () => {
    const cloneDir = path.join(tmpDir, 'clone')
    await cloneRepo(sourceRepo, cloneDir, null)
    await commitToSource('new-file.txt', 'second commit')

    await fetchOrigin(cloneDir, sourceRepo, null)

    // origin/<default> has the new commit even though the local branch hasn't moved
    const defaultBranch = await getDefaultBranch(cloneDir)
    expect(await subjectAt(cloneDir, `origin/${defaultBranch}`)).toBe('second commit')
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

describe('listCheckoutFiles', () => {
  it('reads a checkout whose .git names a path that does not exist here', async () => {
    const wtPath = path.join(tmpDir, 'wt-list')
    await addWorktree(sourceRepo, wtPath, 'agent/wt-list')
    // What the in-pod setup leaves behind: the container's own view.
    await fs.writeFile(path.join(wtPath, '.git'), 'gitdir: /repo/.git/worktrees/wt-list\n')
    await fs.writeFile(path.join(wtPath, '.gitignore'), '*.log\n')
    await fs.writeFile(path.join(wtPath, 'hello.txt'), 'changed\n')
    await fs.writeFile(path.join(wtPath, 'debug.log'), 'ignored\n')
    await fs.mkdir(path.join(wtPath, 'fresh/empty'), { recursive: true })

    const listing = await listCheckoutFiles(sourceRepo, 'wt-list', wtPath)
    expect(listing.paths.sort()).toEqual(['.gitignore', 'hello.txt'])
    expect(listing.ignored).toEqual(['debug.log'])
    expect(listing.untrackedDirs).toEqual(['fresh'])
    expect(listing.status).toEqual({ '.gitignore': 'untracked', 'hello.txt': 'modified' })
  })

  it('lists a hostile clone\'s checkout without running anything it planted', async () => {
    // A same-size edit with a newer mtime is one `status` has to re-hash,
    // which is where a clean filter runs; the listing's index reads are
    // where fsmonitor and `post-index-change` would.
    const h = await hostileClone()
    const wtPath = path.join(tmpDir, 'wt-hostile-list')
    await addWorktree(h.clone, wtPath, 'agent/hostile-list', 'origin/HEAD')
    const file = path.join(wtPath, 'hello.txt')
    await fs.writeFile(file, 'HELLO WORLD\n')
    const later = new Date(Date.now() + 5_000)
    await fs.utimes(file, later, later)

    const listing = await listCheckoutFiles(h.clone, 'wt-hostile-list', wtPath)
    expect(listing.status).toEqual({ 'hello.txt': 'modified' })
    await expectUntouched(h)
  })
})

describe('worktreeUpstreamBranch', () => {
  it('reads the tracked branch, null when unset or not a plain branch', async () => {
    const cloneDir = path.join(tmpDir, 'clone-upstream')
    await cloneRepo(sourceRepo, cloneDir, null)
    const defaultBranch = await getDefaultBranch(cloneDir)

    const wtPath = path.join(tmpDir, 'wt-upstream')
    await addWorktree(cloneDir, wtPath, 'agent/up-test', `origin/${defaultBranch}`)
    // addWorktree deliberately writes no tracking config
    expect(await worktreeUpstreamBranch(cloneDir, 'agent/up-test')).toBeNull()

    await git(wtPath, ['branch', '--set-upstream-to', `origin/${defaultBranch}`])
    expect(await worktreeUpstreamBranch(cloneDir, 'agent/up-test')).toBe(defaultBranch)

    // A pod writes this value, so anything but `refs/heads/<name>` is refused.
    await git(cloneDir, ['config', 'branch.agent/up-test.merge', 'refs/tags/x y'])
    expect(await worktreeUpstreamBranch(cloneDir, 'agent/up-test')).toBeNull()
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
