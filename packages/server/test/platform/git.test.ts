import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import simpleGit from 'simple-git'
import { cloneRepo, getDefaultBranch, addWorktree, fetchOrigin, injectTokenIntoUrl, torEnv, buildHostSideGitSshCommand, writeKnownHostsFile, isGitAuthError, remoteBranchExists, listRemoteBranches, worktreeUpstreamBranch } from '#platform/git'
import { formatSshCommand, getGitUserConfig, torSshOpts } from '@yaac/shared/git'

describe('git helpers', () => {
  let tmpDir: string
  let sourceRepo: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-git-test-'))
    sourceRepo = path.join(tmpDir, 'source')

    // Create a source repo with a commit
    await fs.mkdir(sourceRepo, { recursive: true })
    const git = simpleGit(sourceRepo)
    await git.init()
    await git.addConfig('user.email', 'test@test.com')
    await git.addConfig('user.name', 'Test')
    await fs.writeFile(path.join(sourceRepo, 'hello.txt'), 'hello world\n')
    await git.add('.')
    await git.commit('initial')
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('clones a repo into a destination', async () => {
    const dest = path.join(tmpDir, 'clone')
    await cloneRepo(sourceRepo, dest, null)

    const cloned = await fs.readFile(path.join(dest, 'hello.txt'), 'utf8')
    expect(cloned).toBe('hello world\n')
  })

  it('gets the default branch name', async () => {
    const branch = await getDefaultBranch(sourceRepo)
    expect(['main', 'master']).toContain(branch)
  })

  it('gets default branch from origin/HEAD when available', async () => {
    // Clone the source so we have an "origin" remote
    const cloneDir = path.join(tmpDir, 'clone-default')
    await cloneRepo(sourceRepo, cloneDir, null)

    // Checkout a different branch so HEAD != default
    const cloneGit = simpleGit(cloneDir)
    await cloneGit.checkoutLocalBranch('feature-branch')

    // getDefaultBranch should still return the remote default, not 'feature-branch'
    const branch = await getDefaultBranch(cloneDir)
    expect(['main', 'master']).toContain(branch)
  })

  it('creates a worktree with a new branch', async () => {
    const wtPath = path.join(tmpDir, 'worktree')
    await addWorktree(sourceRepo, wtPath, 'agent/test-session')

    // Verify worktree exists and has files
    const content = await fs.readFile(path.join(wtPath, 'hello.txt'), 'utf8')
    expect(content).toBe('hello world\n')

    // Verify branch was created
    const git = simpleGit(wtPath)
    const branch = await git.revparse(['--abbrev-ref', 'HEAD'])
    expect(branch.trim()).toBe('agent/test-session')
  })

  it('checks out into a destination that already holds the pod mount points', async () => {
    // /workspace is a bind of the worktree dir, so an ephemeral-module
    // mount at /workspace/frontends/node_modules is a directory ON the host
    // worktree before the checkout runs — and `git worktree add` refuses any
    // destination that is not an empty dir, `--force` included. This is the
    // case the staged checkout exists for.
    const git = simpleGit(sourceRepo)
    await fs.mkdir(path.join(sourceRepo, 'frontends'), { recursive: true })
    await fs.writeFile(path.join(sourceRepo, 'frontends', 'app.txt'), 'app\n')
    await git.add('.')
    await git.commit('frontends')

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
    const wtGit = simpleGit(wtPath)
    expect((await wtGit.revparse(['--abbrev-ref', 'HEAD'])).trim()).toBe('agent/mounted')
    expect((await wtGit.raw(['status', '--porcelain'])).trim()).toBe('')

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
    // A `.git` that is a non-empty DIRECTORY fails the rename after the
    // add has already made both.
    const wtPath = path.join(tmpDir, 'worktree')
    await fs.mkdir(path.join(wtPath, '.git'), { recursive: true })
    await fs.writeFile(path.join(wtPath, '.git', 'blocker'), 'x')

    await expect(addWorktree(sourceRepo, wtPath, 'agent/retried')).rejects.toThrow()

    const worktreesDir = path.join(sourceRepo, '.git', 'worktrees')
    expect(await fs.readdir(worktreesDir).catch(() => [])).toEqual([])
    expect((await simpleGit(sourceRepo).branchLocal()).all).not.toContain('agent/retried')
    // The blocker is not ours to remove — only a `.git` this call staged is.
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
    expect((await simpleGit(wtPath).raw(['status', '--porcelain'])).trim()).toBe('')
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
    const git = simpleGit(wtPath)
    const head = await git.revparse(['HEAD'])
    const remoteHead = await git.revparse([`origin/${defaultBranch}`])
    expect(head.trim()).toBe(remoteHead.trim())

    // ...but no tracking entry may be written: host-side rewrites of the
    // shared .git/config go stale under the virtiofs cache session pods
    // read through (transient "unknown error occurred while reading the
    // configuration files" in-pod). The upstream is set from inside the
    // pod at session setup instead.
    const configAfter = await fs.readFile(configPath, 'utf8')
    expect(configAfter).toBe(configBefore)
    await expect(
      git.raw(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']),
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
      const branch = await simpleGit(path.join(tmpDir, `wt-${i}`))
        .revparse(['--abbrev-ref', 'HEAD'])
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

  it('fetchOrigin updates remote refs', async () => {
    // Clone the source repo
    const cloneDir = path.join(tmpDir, 'clone')
    await cloneRepo(sourceRepo, cloneDir, null)

    // Add a new commit to the source
    const srcGit = simpleGit(sourceRepo)
    await fs.writeFile(path.join(sourceRepo, 'new-file.txt'), 'new content\n')
    await srcGit.add('.')
    await srcGit.commit('second commit')

    // fetchOrigin should update remote refs
    await fetchOrigin(cloneDir, null)

    // Verify origin/main has the new commit (even though local branch hasn't moved)
    const defaultBranch = await getDefaultBranch(cloneDir)
    const cloneGit = simpleGit(cloneDir)
    const log = await cloneGit.log([`origin/${defaultBranch}`])
    expect(log.latest?.message).toBe('second commit')
  })

  it('concurrent fetches on one repo all succeed', async () => {
    // Fetches are serialized per repo: unserialized, two fetches moving the
    // same remote-tracking ref race git's per-ref locks and one dies with
    // "cannot lock ref 'refs/remotes/origin/<branch>'".
    const cloneDir = path.join(tmpDir, 'clone')
    await cloneRepo(sourceRepo, cloneDir, null)

    // Move the remote so every fetch has the same ref update to apply.
    const srcGit = simpleGit(sourceRepo)
    await fs.writeFile(path.join(sourceRepo, 'new-file.txt'), 'new content\n')
    await srcGit.add('.')
    await srcGit.commit('second commit')

    const fetches = Array.from({ length: 5 }, () => fetchOrigin(cloneDir, null))
    await expect(Promise.all(fetches)).resolves.toBeDefined()

    const defaultBranch = await getDefaultBranch(cloneDir)
    const log = await simpleGit(cloneDir).log([`origin/${defaultBranch}`])
    expect(log.latest?.message).toBe('second commit')
  })

  it('creates worktree from startPoint with latest remote content', async () => {
    // Clone the source repo
    const cloneDir = path.join(tmpDir, 'clone')
    await cloneRepo(sourceRepo, cloneDir, null)

    // Add a new commit to the source
    const srcGit = simpleGit(sourceRepo)
    await fs.writeFile(path.join(sourceRepo, 'new-file.txt'), 'new content\n')
    await srcGit.add('.')
    await srcGit.commit('second commit')

    // Fetch so remote refs are updated
    await fetchOrigin(cloneDir, null)

    // Create worktree from origin/<default> — should include the new commit
    const defaultBranch = await getDefaultBranch(cloneDir)
    const wtPath = path.join(tmpDir, 'wt-startpoint')
    await addWorktree(cloneDir, wtPath, 'agent/from-origin', `origin/${defaultBranch}`)

    const content = await fs.readFile(path.join(wtPath, 'new-file.txt'), 'utf8')
    expect(content).toBe('new content\n')
  })

  it('getGitUserConfig returns name and email or null', async () => {
    const result = await getGitUserConfig()
    if (result) {
      expect(result).toHaveProperty('name')
      expect(result).toHaveProperty('email')
      expect(typeof result.name).toBe('string')
      expect(typeof result.email).toBe('string')
    } else {
      expect(result).toBeNull()
    }
  })

  it('fetchOrigin with token uses authenticated URL', async () => {
    // Clone the source repo so we have an origin remote with an https-like URL
    const cloneDir = path.join(tmpDir, 'clone-token')
    await cloneRepo(sourceRepo, cloneDir, null)

    // Add a new commit to the source
    const srcGit = simpleGit(sourceRepo)
    await fs.writeFile(path.join(sourceRepo, 'token-file.txt'), 'token content\n')
    await srcGit.add('.')
    await srcGit.commit('token commit')

    // Set the origin to an https URL so injectTokenIntoUrl can parse it
    const cloneGit = simpleGit(cloneDir)
    await cloneGit.remote(['set-url', 'origin', 'https://localhost/test/repo'])

    // fetchOrigin with a token should fail to connect (no server) but should
    // NOT fail with "does not appear to be a git repository" — that would mean
    // the refspec was passed as the remote instead of the URL.
    try {
      await fetchOrigin(cloneDir, { kind: 'https', token: 'fake-token' })
    } catch (err) {
      const msg = (err as Error).message
      expect(msg).not.toContain('does not appear to be a git repository')
    }
  })

  it('injectTokenIntoUrl embeds credentials in HTTPS URL', () => {
    const result = injectTokenIntoUrl('https://github.com/org/repo.git', 'ghp_abc123')
    const parsed = new URL(result)
    expect(parsed.username).toBe('x-access-token')
    expect(parsed.password).toBe('ghp_abc123')
    expect(parsed.hostname).toBe('github.com')
    expect(parsed.pathname).toBe('/org/repo.git')
    expect(parsed.protocol).toBe('https:')
  })

  it('injectTokenIntoUrl handles URL without path', () => {
    const result = injectTokenIntoUrl('https://github.com', 'tok')
    expect(result).toContain('x-access-token')
    expect(result).toContain('tok')
  })

  it('remoteBranchExists distinguishes present and missing remote branches', async () => {
    const srcGit = simpleGit(sourceRepo)
    await srcGit.checkoutLocalBranch('develop')
    const defaultBranch = await getDefaultBranch(sourceRepo)
    await srcGit.checkout(defaultBranch)

    const cloneDir = path.join(tmpDir, 'clone-branches')
    await cloneRepo(sourceRepo, cloneDir, null)

    expect(await remoteBranchExists(cloneDir, defaultBranch)).toBe(true)
    expect(await remoteBranchExists(cloneDir, 'develop')).toBe(true)
    expect(await remoteBranchExists(cloneDir, 'no-such-branch')).toBe(false)
  })

  it('listRemoteBranches returns names newest-committed first, without HEAD', async () => {
    const srcGit = simpleGit(sourceRepo)
    const defaultBranch = await getDefaultBranch(sourceRepo)
    await srcGit.checkoutLocalBranch('develop')
    // A later commit so develop sorts ahead of the default branch. The
    // committer date needs to actually differ — git timestamps are
    // second-granular, so pin them explicitly instead of sleeping.
    await fs.writeFile(path.join(sourceRepo, 'dev.txt'), 'dev\n')
    await srcGit.add('.')
    await srcGit.env({
      ...process.env,
      GIT_AUTHOR_DATE: '2030-01-01T00:00:00Z',
      GIT_COMMITTER_DATE: '2030-01-01T00:00:00Z',
    }).commit('develop commit')
    await srcGit.checkout(defaultBranch)

    const cloneDir = path.join(tmpDir, 'clone-list')
    await cloneRepo(sourceRepo, cloneDir, null)

    const branches = await listRemoteBranches(cloneDir)
    expect(branches[0]).toBe('develop')
    expect(branches).toContain(defaultBranch)
    expect(branches).not.toContain('HEAD')
  })

  it('worktreeUpstreamBranch reads the tracked branch, null when unset', async () => {
    const cloneDir = path.join(tmpDir, 'clone-upstream')
    await cloneRepo(sourceRepo, cloneDir, null)
    const defaultBranch = await getDefaultBranch(cloneDir)

    const wtPath = path.join(tmpDir, 'wt-upstream')
    await addWorktree(cloneDir, wtPath, 'agent/up-test', `origin/${defaultBranch}`)
    // addWorktree deliberately writes no tracking config
    expect(await worktreeUpstreamBranch(cloneDir, 'agent/up-test')).toBeNull()

    await simpleGit(wtPath).raw(['branch', '--set-upstream-to', `origin/${defaultBranch}`])
    expect(await worktreeUpstreamBranch(cloneDir, 'agent/up-test')).toBe(defaultBranch)
  })

})

describe('torEnv', () => {
  const originalUseTor = process.env.YAAC_USE_TOR
  const originalUrl = process.env.YAAC_HOST_TOR_SOCKS_URL

  afterEach(() => {
    if (originalUseTor === undefined) delete process.env.YAAC_USE_TOR
    else process.env.YAAC_USE_TOR = originalUseTor
    if (originalUrl === undefined) delete process.env.YAAC_HOST_TOR_SOCKS_URL
    else process.env.YAAC_HOST_TOR_SOCKS_URL = originalUrl
  })

  it('returns undefined when YAAC_USE_TOR is unset', () => {
    delete process.env.YAAC_USE_TOR
    expect(torEnv()).toBeUndefined()
  })

  it('returns undefined when YAAC_USE_TOR=false', () => {
    process.env.YAAC_USE_TOR = 'false'
    expect(torEnv()).toBeUndefined()
  })

  it('returns env with default ALL_PROXY when YAAC_USE_TOR=1', () => {
    process.env.YAAC_USE_TOR = '1'
    delete process.env.YAAC_HOST_TOR_SOCKS_URL
    const env = torEnv()
    expect(env).toBeDefined()
    expect(env!.ALL_PROXY).toBe('socks5h://127.0.0.1:9050')
    expect(env!.NO_PROXY).toBe('localhost,127.0.0.1')
  })

  it('returns env when YAAC_USE_TOR=true', () => {
    process.env.YAAC_USE_TOR = 'true'
    delete process.env.YAAC_HOST_TOR_SOCKS_URL
    const env = torEnv()
    expect(env).toBeDefined()
    expect(env!.ALL_PROXY).toBe('socks5h://127.0.0.1:9050')
  })

  it('honors YAAC_HOST_TOR_SOCKS_URL override', () => {
    process.env.YAAC_USE_TOR = '1'
    process.env.YAAC_HOST_TOR_SOCKS_URL = 'socks5h://127.0.0.1:9150'
    const env = torEnv()
    expect(env!.ALL_PROXY).toBe('socks5h://127.0.0.1:9150')
  })

  it('preserves other process.env vars', () => {
    process.env.YAAC_USE_TOR = '1'
    process.env.YAAC_TORENV_TEST_MARKER = 'present'
    const env = torEnv()
    expect(env!.YAAC_TORENV_TEST_MARKER).toBe('present')
    delete process.env.YAAC_TORENV_TEST_MARKER
  })
})

describe('torSshOpts', () => {
  const originalUseTor = process.env.YAAC_USE_TOR
  const originalUrl = process.env.YAAC_HOST_TOR_SOCKS_URL

  afterEach(() => {
    if (originalUseTor === undefined) delete process.env.YAAC_USE_TOR
    else process.env.YAAC_USE_TOR = originalUseTor
    if (originalUrl === undefined) delete process.env.YAAC_HOST_TOR_SOCKS_URL
    else process.env.YAAC_HOST_TOR_SOCKS_URL = originalUrl
  })

  it('returns [] when YAAC_USE_TOR is unset', () => {
    delete process.env.YAAC_USE_TOR
    expect(torSshOpts()).toEqual([])
  })

  it('emits -o ProxyCommand with the default SOCKS host:port', () => {
    process.env.YAAC_USE_TOR = '1'
    delete process.env.YAAC_HOST_TOR_SOCKS_URL
    const opts = torSshOpts()
    expect(opts).toEqual(['-o', 'ProxyCommand=nc -X 5 -x 127.0.0.1:9050 %h %p'])
  })

  it('honors YAAC_HOST_TOR_SOCKS_URL', () => {
    process.env.YAAC_USE_TOR = '1'
    process.env.YAAC_HOST_TOR_SOCKS_URL = 'socks5h://10.0.0.1:9150'
    const opts = torSshOpts()
    expect(opts).toEqual(['-o', 'ProxyCommand=nc -X 5 -x 10.0.0.1:9150 %h %p'])
  })
})

describe('buildHostSideGitSshCommand', () => {
  const originalUseTor = process.env.YAAC_USE_TOR
  afterEach(() => {
    if (originalUseTor === undefined) delete process.env.YAAC_USE_TOR
    else process.env.YAAC_USE_TOR = originalUseTor
  })

  it('produces a non-Tor ssh command with the given key path', () => {
    delete process.env.YAAC_USE_TOR
    const cmd = buildHostSideGitSshCommand('/home/u/.ssh/id_ed25519', '/tmp/known_hosts-abc')
    expect(cmd).toContain('-i /home/u/.ssh/id_ed25519')
    expect(cmd).toContain('UserKnownHostsFile=/tmp/known_hosts-abc')
    expect(cmd).toContain('StrictHostKeyChecking=yes')
    expect(cmd).toContain('IdentitiesOnly=yes')
    expect(cmd).not.toContain('ProxyCommand')
  })

  it('adds ProxyCommand when YAAC_USE_TOR=1, single-quoted so git tokenization keeps it intact', () => {
    process.env.YAAC_USE_TOR = '1'
    const cmd = buildHostSideGitSshCommand('/k', '/kh')
    expect(cmd).toContain("'ProxyCommand=nc -X 5 -x 127.0.0.1:9050 %h %p'")
  })
})

describe('formatSshCommand', () => {
  it('leaves plain args unquoted', () => {
    expect(formatSshCommand(['ssh', '-F', '/dev/null', '-i', '/k'])).toBe(
      'ssh -F /dev/null -i /k',
    )
  })

  it('single-quotes args containing whitespace', () => {
    const cmd = formatSshCommand(['-o', 'ProxyCommand=nc -X 5 %h %p'])
    expect(cmd).toBe("-o 'ProxyCommand=nc -X 5 %h %p'")
  })

  it('escapes embedded single quotes', () => {
    const cmd = formatSshCommand(['-o', "Foo=bar's baz"])
    expect(cmd).toBe(`-o 'Foo=bar'\\''s baz'`)
  })

  it('quotes the empty string', () => {
    expect(formatSshCommand([''])).toBe("''")
  })

  it('quotes shell metacharacters even without whitespace', () => {
    expect(formatSshCommand(['a;b', 'c$d'])).toBe("'a;b' 'c$d'")
  })
})

describe('writeKnownHostsFile', () => {
  it('writes mode 0600 and is idempotent', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-kh-test-'))
    try {
      const dest = path.join(tmpDir, 'known_hosts')
      await writeKnownHostsFile(['example.com ssh-ed25519 AAAA'], dest)
      const stat = await fs.stat(dest)
      expect((stat.mode & 0o777)).toBe(0o600)
      const first = await fs.readFile(dest, 'utf8')

      await writeKnownHostsFile(['example.com ssh-ed25519 AAAA'], dest)
      const second = await fs.readFile(dest, 'utf8')
      expect(second).toBe(first)
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true })
    }
  })
})

describe('isGitAuthError', () => {
  it('matches the messages git emits for rejected credentials', () => {
    const authErrors = [
      "fatal: Authentication failed for 'https://github.com/acme/repo.git/'",
      'remote: Invalid username or password.',
      "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
      "fatal: unable to access 'https://github.com/acme/repo.git/': The requested URL returned error: 403",
      "fatal: unable to access 'https://github.com/acme/repo.git/': The requested URL returned error: 401",
      'git@github.com: Permission denied (publickey).',
      'remote: Permission to acme/repo.git denied to somebody.',
    ]
    for (const msg of authErrors) expect(isGitAuthError(msg), msg).toBe(true)
  })

  it('does not match network, ref, or server errors', () => {
    const otherErrors = [
      "fatal: unable to access 'https://github.com/acme/repo.git/': Could not resolve host: github.com",
      "fatal: couldn't find remote ref refs/heads/missing",
      "fatal: unable to access 'https://github.com/acme/repo.git/': The requested URL returned error: 500",
      'fatal: early EOF',
      'fatal: not a git repository',
    ]
    for (const msg of otherErrors) expect(isGitAuthError(msg), msg).toBe(false)
  })
})
