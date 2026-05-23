import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import simpleGit from 'simple-git'
import { cloneRepo, getDefaultBranch, addWorktree, removeWorktree, fetchOrigin, getGitUserConfig, injectTokenIntoUrl, getRemoteHeadCommit, torEnv, isTorEnabled, torSshOpts, buildHostSideGitSshCommand, formatSshCommand, writeKnownHostsFile, expandTilde } from '@/lib/git'

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
    await addWorktree(sourceRepo, wtPath, 'yaac/test-session')

    // Verify worktree exists and has files
    const content = await fs.readFile(path.join(wtPath, 'hello.txt'), 'utf8')
    expect(content).toBe('hello world\n')

    // Verify branch was created
    const git = simpleGit(wtPath)
    const branch = await git.revparse(['--abbrev-ref', 'HEAD'])
    expect(branch.trim()).toBe('yaac/test-session')
  })

  it('creates a worktree with upstream tracking', async () => {
    // Clone so we have a remote called "origin"
    const cloneDir = path.join(tmpDir, 'clone')
    await cloneRepo(sourceRepo, cloneDir, null)

    const defaultBranch = await getDefaultBranch(cloneDir)
    const wtPath = path.join(tmpDir, 'worktree')
    await addWorktree(cloneDir, wtPath, 'yaac/test-tracked', `origin/${defaultBranch}`)

    // Verify the branch tracks origin/<default>
    const git = simpleGit(wtPath)
    const tracking = await git.raw(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])
    expect(tracking.trim()).toBe(`origin/${defaultBranch}`)
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
    await addWorktree(cloneDir, wtPath, 'yaac/from-origin', `origin/${defaultBranch}`)

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

  it('getRemoteHeadCommit returns the commit sha of origin/default', async () => {
    const cloneDir = path.join(tmpDir, 'clone-head')
    await cloneRepo(sourceRepo, cloneDir, null)

    const commit = await getRemoteHeadCommit(cloneDir)
    expect(commit).toMatch(/^[0-9a-f]{40}$/)

    // Should match the latest commit on origin/default branch
    const defaultBranch = await getDefaultBranch(cloneDir)
    const git = simpleGit(cloneDir)
    const expected = (await git.revparse([`origin/${defaultBranch}`])).trim()
    expect(commit).toBe(expected)
  })

  it('getRemoteHeadCommit reflects new commits after fetch', async () => {
    const cloneDir = path.join(tmpDir, 'clone-head-fetch')
    await cloneRepo(sourceRepo, cloneDir, null)

    const before = await getRemoteHeadCommit(cloneDir)

    // Add a commit to source
    const srcGit = simpleGit(sourceRepo)
    await fs.writeFile(path.join(sourceRepo, 'new.txt'), 'new\n')
    await srcGit.add('.')
    await srcGit.commit('new commit')

    await fetchOrigin(cloneDir, null)
    const after = await getRemoteHeadCommit(cloneDir)

    expect(after).not.toBe(before)
    expect(after).toMatch(/^[0-9a-f]{40}$/)
  })

  it('removes a worktree', async () => {
    const wtPath = path.join(tmpDir, 'worktree')
    await addWorktree(sourceRepo, wtPath, 'yaac/to-remove')
    await removeWorktree(sourceRepo, wtPath)

    // Verify directory is gone
    await expect(fs.access(wtPath)).rejects.toThrow()
  })
})

describe('isTorEnabled', () => {
  const originalUseTor = process.env.YAAC_USE_TOR

  afterEach(() => {
    if (originalUseTor === undefined) delete process.env.YAAC_USE_TOR
    else process.env.YAAC_USE_TOR = originalUseTor
  })

  it('returns false when YAAC_USE_TOR is unset', () => {
    delete process.env.YAAC_USE_TOR
    expect(isTorEnabled()).toBe(false)
  })

  it.each(['', '0', 'false', 'FALSE', 'False', '  false  '])(
    'returns false when YAAC_USE_TOR=%j',
    (value) => {
      process.env.YAAC_USE_TOR = value
      expect(isTorEnabled()).toBe(false)
    },
  )

  it.each(['1', 'true', 'TRUE', 'yes', 'on', 'anything'])(
    'returns true when YAAC_USE_TOR=%j',
    (value) => {
      process.env.YAAC_USE_TOR = value
      expect(isTorEnabled()).toBe(true)
    },
  )
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

describe('expandTilde', () => {
  it('expands a leading ~', () => {
    const expanded = expandTilde('~/foo')
    expect(expanded.startsWith('/')).toBe(true)
    expect(expanded.endsWith('/foo')).toBe(true)
  })

  it('leaves non-tilde paths alone', () => {
    expect(expandTilde('/abs/path')).toBe('/abs/path')
  })
})
