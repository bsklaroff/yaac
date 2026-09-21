import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  fetchKnownHostsEntry,
  gitEnvForCredential,
  injectTokenIntoUrl,
  isGitAuthError,
  torEnv,
  writeKnownHostsFile,
} from '#domain/git'
import { formatSshCommand, torSshOpts } from '@yaac/shared/git'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'

const PUBLIC_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIF/MVah8bw8Kp+X9jKkU6CqcHq+8itZO9NwG6kOC+rTD yaac git.example.com/*'
const SSH_CREDENTIAL = {
  kind: 'ssh' as const,
  pattern: 'git.example.com/*',
  publicKey: PUBLIC_KEY,
  knownHostsEntry: 'git.example.com ssh-ed25519 AAAA',
}

describe('injectTokenIntoUrl', () => {
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

describe('gitEnvForCredential', () => {
  const originalUseTor = process.env.YAAC_USE_TOR
  let dataDir: string
  beforeAll(async () => { dataDir = await createTempDataDir() })
  afterAll(async () => { await cleanupTempDir(dataDir) })
  afterEach(() => {
    if (originalUseTor === undefined) delete process.env.YAAC_USE_TOR
    else process.env.YAAC_USE_TOR = originalUseTor
  })

  it('names the agent, the public key and the host key — nothing private', async () => {
    delete process.env.YAAC_USE_TOR
    const env = await gitEnvForCredential(SSH_CREDENTIAL)
    const cmd = env!.GIT_SSH_COMMAND!
    expect(cmd).toMatch(/^ssh -F \/dev\/null /)
    expect(cmd).toContain(`-o IdentityAgent=${path.join(os.tmpdir(), 'yaac-')}`)
    expect(cmd).toContain('StrictHostKeyChecking=yes')
    expect(cmd).toContain('IdentitiesOnly=yes')
    expect(cmd).not.toContain('ProxyCommand')

    // The two files it names hold the two PUBLIC halves, verbatim.
    const pub = /-i (\S+\.pub)/.exec(cmd)![1]
    expect(pub.startsWith(dataDir)).toBe(true)
    expect(await fs.readFile(pub, 'utf8')).toBe(`${PUBLIC_KEY}\n`)
    const kh = /UserKnownHostsFile=(\S+)/.exec(cmd)![1]
    expect(await fs.readFile(kh, 'utf8')).toBe('git.example.com ssh-ed25519 AAAA\n')
    // And the rest of the host env still reaches git.
    expect(env!.PATH).toBe(process.env.PATH)
  })

  it('adds ProxyCommand when YAAC_USE_TOR=1, single-quoted so git tokenization keeps it intact', async () => {
    process.env.YAAC_USE_TOR = '1'
    const env = await gitEnvForCredential(SSH_CREDENTIAL)
    expect(env!.GIT_SSH_COMMAND).toContain("'ProxyCommand=nc -X 5 -x 127.0.0.1:9050 %h %p'")
    expect(env!.ALL_PROXY).toBe('socks5h://127.0.0.1:9050')
  })

  it('is the Tor env, or nothing, for https and for no credential', async () => {
    delete process.env.YAAC_USE_TOR
    expect(await gitEnvForCredential({ kind: 'https', token: 't' })).toBeUndefined()
    expect(await gitEnvForCredential(null)).toBeUndefined()
    process.env.YAAC_USE_TOR = '1'
    expect((await gitEnvForCredential(null))!.ALL_PROXY).toBe('socks5h://127.0.0.1:9050')
  })
})

describe('fetchKnownHostsEntry', () => {
  it('reports a host it could get no key from, naming the host', async () => {
    // `.invalid` never resolves, so this fails at DNS rather than waiting
    // out a connect timeout. The success path needs an sshd to talk to.
    await expect(fetchKnownHostsEntry('nonexistent.invalid'))
      .rejects.toThrow(/no host key recovered for nonexistent\.invalid/)
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
