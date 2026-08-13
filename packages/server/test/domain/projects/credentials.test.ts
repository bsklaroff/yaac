import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createTempDataDir, cleanupTempDir, getDataDir } from '@yaac/test-utils/setup'
import { addEntry, listEntries, listSshEntries, loadKnownHostsEntryForHost, parseGitRemote, removeEntryChecked, replaceEntries, resolveCredentialForUrl, saveCredentials } from '#domain/projects'
import { githubCredentialsPath } from '@yaac/shared/project-paths'
import { ServerError } from '@yaac/shared/errors'
import { serverLog } from '#log'

// Asserted on: a dropped credential entry is announced, and the announcement
// never carries the token.
vi.mock('#log', () => ({ serverLog: vi.fn() }))

const execFileAsync = promisify(execFile)
const mockServerLog = vi.mocked(serverLog)

const KNOWN_HOSTS = 'git.example.com ssh-ed25519 AAAA'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await createTempDataDir()
  mockServerLog.mockClear()
})

afterEach(async () => {
  await cleanupTempDir(tmpDir)
})

/** Write github.json by hand, bypassing the writers — the shape an older
 *  yaac, or a hand edit, can leave behind. */
async function storeRaw(raw: string): Promise<void> {
  await fs.mkdir(path.dirname(githubCredentialsPath()), { recursive: true })
  await fs.writeFile(githubCredentialsPath(), raw)
}

/** A real ed25519 key pair on disk. `passphrase` produces the encrypted key
 *  the ssh-keygen probe is there to reject. */
async function makeKey(name: string, passphrase = ''): Promise<string> {
  const keyPath = path.join(getDataDir(), name)
  await execFileAsync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', passphrase, '-C', '', '-f', keyPath])
  return keyPath
}

describe('saveCredentials', () => {
  it('writes the file 0600 inside the data dir, and round-trips both kinds', async () => {
    await saveCredentials({ tokens: [
      { kind: 'https', pattern: 'github.com/*', token: 'ghp_test' },
      { kind: 'ssh', pattern: 'git.example.com/*', privateKeyPath: '/k', knownHostsEntry: KNOWN_HOSTS },
    ] })

    expect(githubCredentialsPath()).toBe(path.join(getDataDir(), '.credentials', 'github.json'))
    expect((await fs.stat(githubCredentialsPath())).mode & 0o777).toBe(0o600)
    expect(await listEntries()).toEqual([
      { kind: 'https', pattern: 'github.com/*', preview: '***test' },
      { kind: 'ssh', pattern: 'git.example.com/*', preview: '/k' },
    ])
  })

  it('replaces the stored list wholesale', async () => {
    await saveCredentials({ tokens: [{ kind: 'https', pattern: 'github.com/*', token: 'ghp_a' }] })
    await saveCredentials({ tokens: [] })
    expect(await listEntries()).toEqual([])
  })
})

describe('listEntries', () => {
  it('masks https tokens, shows the key path for ssh, and is [] when unset', async () => {
    expect(await listEntries()).toEqual([])
    await saveCredentials({ tokens: [
      { kind: 'https', pattern: 'github.com/acme/*', token: 'ghp_abcdef1234' },
      { kind: 'https', pattern: 'github.com/tiny/*', token: 'abc' },
      { kind: 'ssh', pattern: 'git.example.com/*', privateKeyPath: '~/.ssh/id_ed25519', knownHostsEntry: KNOWN_HOSTS },
    ] })

    expect(await listEntries()).toEqual([
      { kind: 'https', pattern: 'github.com/acme/*', preview: '***1234' },
      // A token too short to mask meaningfully is hidden outright.
      { kind: 'https', pattern: 'github.com/tiny/*', preview: '****' },
      { kind: 'ssh', pattern: 'git.example.com/*', preview: '~/.ssh/id_ed25519' },
    ])
  })

  it('drops entries a reader could not act on', async () => {
    await storeRaw(JSON.stringify({ tokens: [
      { pattern: 'github.com/*', token: '' }, // no token
      { pattern: '*', token: 'ghp_x' }, // no host axis
      { pattern: 'acme/*', token: 'ghp_x' }, // owner with no host
      { pattern: 'a/b/c', token: 'ghp_x' }, // no host segment
      { pattern: 'bad host/*', token: 'ghp_x' }, // not a host
      { kind: 'ssh', pattern: 'git.example.com/*', privateKeyPath: '/k' }, // no knownHostsEntry
      { kind: 'ssh', pattern: 'nohost', privateKeyPath: '/k', knownHostsEntry: KNOWN_HOSTS },
      { kind: 'gpg', pattern: 'github.com/*' }, // unknown kind
      'not-an-object',
      null,
      { kind: 'https', pattern: 'github.com/org/*', token: 'ghp_valid' },
    ] }))

    expect(await listEntries()).toEqual([
      { kind: 'https', pattern: 'github.com/org/*', preview: '***alid' },
    ])
  })

  // A dropped entry is otherwise invisible: git auth for that repo just stops,
  // with nothing said at the point of use. Every rejected pattern is named,
  // and one that only lacks a host is named with the rewrite that fixes it.
  it('names every dropped pattern, and never a token, on the way past', async () => {
    await storeRaw(JSON.stringify({ tokens: [
      { pattern: '*', token: 'ghp_secret1' },
      { pattern: 'acme/*', token: 'ghp_secret2' },
      { pattern: 'bad host/*', token: 'ghp_secret3' },
      { kind: 'ssh', pattern: 'nohost', privateKeyPath: '/k', knownHostsEntry: KNOWN_HOSTS },
      { kind: 'https', pattern: 'github.com/org/*', token: 'ghp_kept' },
    ] }))

    await listEntries()
    const logged = mockServerLog.mock.calls.map(([line]) => line).join('\n')

    expect(logged).toContain('"*" names no host — use "github.com/*"')
    expect(logged).toContain('"acme/*" names no host — use "github.com/acme/*"')
    // No github.com/ rewrite can rescue a pattern whose host has a space.
    expect(logged).toContain('"bad host/*" is not a valid <host>/<path> pattern')
    expect(logged).toContain('ssh credential: pattern "nohost"')
    // The entry that survived has nothing to announce.
    expect(logged).not.toContain('github.com/org/*')
    for (const secret of ['ghp_secret1', 'ghp_secret2', 'ghp_secret3', 'ghp_kept']) {
      expect(logged).not.toContain(secret)
    }
  })

  it('is [] for a file that is missing, unparseable, or the wrong shape', async () => {
    expect(await listEntries()).toEqual([])
    await storeRaw('not json')
    expect(await listEntries()).toEqual([])
    await storeRaw(JSON.stringify({ tokens: 'not-an-array' }))
    expect(await listEntries()).toEqual([])
    await storeRaw(JSON.stringify([{ pattern: 'github.com/*', token: 'x' }]))
    expect(await listEntries()).toEqual([])
  })
})

describe('parseGitRemote', () => {
  it('parses https URLs at any path depth, dropping .git and a trailing slash', () => {
    expect(parseGitRemote('https://github.com/acme/repo.git'))
      .toEqual({ scheme: 'https', host: 'github.com', path: 'acme/repo' })
    expect(parseGitRemote('https://git.example.com/acme/repo'))
      .toEqual({ scheme: 'https', host: 'git.example.com', path: 'acme/repo' })
    expect(parseGitRemote('https://gitlab.com/group/sub/repo.git'))
      .toEqual({ scheme: 'https', host: 'gitlab.com', path: 'group/sub/repo' })
    expect(parseGitRemote('https://gerrit.example.com/myrepo'))
      .toEqual({ scheme: 'https', host: 'gerrit.example.com', path: 'myrepo' })
    expect(parseGitRemote('https://github.com/acme/repo/'))
      .toEqual({ scheme: 'https', host: 'github.com', path: 'acme/repo' })
  })

  it('parses SCP-style remotes with or without a user', () => {
    expect(parseGitRemote('git@github.com:acme/repo.git'))
      .toEqual({ scheme: 'ssh', host: 'github.com', path: 'acme/repo' })
    expect(parseGitRemote('git.example.com:acme/repo'))
      .toEqual({ scheme: 'ssh', host: 'git.example.com', path: 'acme/repo' })
    expect(parseGitRemote('git@gitlab.com:group/sub/repo.git'))
      .toEqual({ scheme: 'ssh', host: 'gitlab.com', path: 'group/sub/repo' })
    expect(parseGitRemote('git@gerrit.example.com:myrepo.git'))
      .toEqual({ scheme: 'ssh', host: 'gerrit.example.com', path: 'myrepo' })
    expect(parseGitRemote('git@github.com:acme/repo/'))
      .toEqual({ scheme: 'ssh', host: 'github.com', path: 'acme/repo' })
  })

  it('rejects unsupported schemes, ports, and empty paths', () => {
    expect(() => parseGitRemote('ssh://git@github.com/acme/repo')).toThrow(/SCP-style/)
    expect(() => parseGitRemote('http://github.com/acme/repo')).toThrow(/Only HTTPS/)
    expect(() => parseGitRemote('https://github.com:8443/acme/repo')).toThrow(/Custom HTTPS ports/)
    expect(() => parseGitRemote('https://github.com/')).toThrow(/Cannot parse repo path/)
    expect(() => parseGitRemote('git@github.com:.git')).toThrow(/Cannot parse repo path/)
    expect(() => parseGitRemote('not-a-url')).toThrow(/Unrecognized git remote URL/)
  })
})

describe('resolveCredentialForUrl', () => {
  it('takes the first pattern that covers the remote, most specific first', async () => {
    await saveCredentials({ tokens: [
      { kind: 'https', pattern: 'github.com/acme/*', token: 'ghp_acme' },
      { kind: 'https', pattern: 'github.com/*', token: 'ghp_fallback' },
    ] })
    expect(await resolveCredentialForUrl('https://github.com/acme/repo.git'))
      .toEqual({ kind: 'https', token: 'ghp_acme' })
    expect(await resolveCredentialForUrl('https://github.com/other/repo.git'))
      .toEqual({ kind: 'https', token: 'ghp_fallback' })
  })

  it('returns an ssh credential with the key path ~-expanded', async () => {
    await saveCredentials({ tokens: [{
      kind: 'ssh',
      pattern: 'git.example.com/*',
      privateKeyPath: '~/.ssh/id_ed25519',
      knownHostsEntry: KNOWN_HOSTS,
    }] })
    expect(await resolveCredentialForUrl('git@git.example.com:acme/repo.git')).toEqual({
      kind: 'ssh',
      privateKeyPath: path.join(os.homedir(), '.ssh/id_ed25519'),
      knownHostsEntry: KNOWN_HOSTS,
    })
  })

  it('returns null with no match, and never crosses https <-> ssh', async () => {
    await saveCredentials({ tokens: [
      { kind: 'https', pattern: 'github.com/*', token: 'ghp_x' },
    ] })
    expect(await resolveCredentialForUrl('https://git.example.com/a/b')).toBeNull()
    expect(await resolveCredentialForUrl('git@github.com:acme/repo.git')).toBeNull()
  })

  it('rejects a remote URL it cannot parse', async () => {
    await expect(resolveCredentialForUrl('not-a-url')).rejects.toThrow(/Unrecognized/)
  })
})

describe('loadKnownHostsEntryForHost', () => {
  it('returns the first ssh entry whose pattern host matches', async () => {
    await saveCredentials({ tokens: [
      { kind: 'https', pattern: 'git.example.com/*', token: 'ghp_x' },
      { kind: 'ssh', pattern: 'other.example.com/*', privateKeyPath: '/k', knownHostsEntry: 'other ssh-rsa BBB' },
      { kind: 'ssh', pattern: 'git.example.com/acme/*', privateKeyPath: '/k', knownHostsEntry: KNOWN_HOSTS },
    ] })
    expect(await loadKnownHostsEntryForHost('git.example.com')).toBe(KNOWN_HOSTS)
  })

  it('returns null when no ssh entry matches', async () => {
    await saveCredentials({ tokens: [
      { kind: 'https', pattern: 'github.com/*', token: 'ghp_x' },
    ] })
    expect(await loadKnownHostsEntryForHost('github.com')).toBeNull()
  })
})

describe('listSshEntries', () => {
  it('returns every ssh entry with its host and ~-expanded key path', async () => {
    await saveCredentials({ tokens: [
      { kind: 'https', pattern: 'github.com/*', token: 'ghp_x' },
      { kind: 'ssh', pattern: 'git.example.com/acme/*', privateKeyPath: '~/keys/a', knownHostsEntry: KNOWN_HOSTS },
      { kind: 'ssh', pattern: 'other.example.com/*', privateKeyPath: '/abs/b', knownHostsEntry: 'other ssh-rsa BBB' },
    ] })

    expect(await listSshEntries()).toEqual([
      {
        pattern: 'git.example.com/acme/*',
        host: 'git.example.com',
        privateKeyPath: path.join(os.homedir(), 'keys/a'),
        knownHostsEntry: KNOWN_HOSTS,
      },
      {
        pattern: 'other.example.com/*',
        host: 'other.example.com',
        privateKeyPath: '/abs/b',
        knownHostsEntry: 'other ssh-rsa BBB',
      },
    ])
  })

  it('is [] when only https credentials are stored', async () => {
    await addEntry({ kind: 'https', pattern: 'github.com/*', token: 'ghp_x' })
    expect(await listSshEntries()).toEqual([])
  })
})

describe('addEntry', () => {
  it('adds, replaces by exact pattern, and preserves the case as typed', async () => {
    await addEntry({ kind: 'https', pattern: 'github.com/acme/*', token: 'ghp_old' })
    await addEntry({ kind: 'https', pattern: 'github.com/acme/*', token: 'ghp_new' })
    await addEntry({ kind: 'https', pattern: 'github.com/Acme/Repo', token: 'ghp_cased' })

    expect(await listEntries()).toEqual([
      { kind: 'https', pattern: 'github.com/acme/*', preview: '***_new' },
      { kind: 'https', pattern: 'github.com/Acme/Repo', preview: '***ased' },
    ])
  })

  it('accepts an ssh entry whose key is readable and unencrypted', async () => {
    const keyPath = await makeKey('id_ok')
    await addEntry({
      kind: 'ssh',
      pattern: 'git.example.com/*',
      privateKeyPath: keyPath,
      knownHostsEntry: KNOWN_HOSTS,
    })
    expect((await listSshEntries())[0]?.privateKeyPath).toBe(keyPath)
  })

  it('rejects an invalid pattern or an empty token', async () => {
    await expect(addEntry({ kind: 'https', pattern: '*', token: 'ghp_x' }))
      .rejects.toBeInstanceOf(ServerError)
    await expect(addEntry({ kind: 'https', pattern: 'github.com/*', token: '' }))
      .rejects.toBeInstanceOf(ServerError)
  })

  it('rejects an ssh entry missing either of its two required fields', async () => {
    await expect(addEntry({
      kind: 'ssh', pattern: 'git.example.com/*', privateKeyPath: '', knownHostsEntry: KNOWN_HOSTS,
    })).rejects.toThrow(/privateKeyPath cannot be empty/)
    await expect(addEntry({
      kind: 'ssh', pattern: 'git.example.com/*', privateKeyPath: '/k', knownHostsEntry: '',
    })).rejects.toThrow(/knownHostsEntry cannot be empty/)
  })

  it('rejects an unreadable key, and one that needs a passphrase', async () => {
    await expect(addEntry({
      kind: 'ssh',
      pattern: 'git.example.com/*',
      privateKeyPath: path.join(getDataDir(), 'absent'),
      knownHostsEntry: KNOWN_HOSTS,
    })).rejects.toThrow(/SSH private key not readable/)

    const locked = await makeKey('id_locked', 'hunter2')
    await expect(addEntry({
      kind: 'ssh',
      pattern: 'git.example.com/*',
      privateKeyPath: locked,
      knownHostsEntry: KNOWN_HOSTS,
    })).rejects.toThrow(/could not be loaded without a passphrase/)

    expect(await listEntries()).toEqual([])
  })
})

describe('removeEntryChecked', () => {
  it('removes the exactly-matching pattern, leaving the others', async () => {
    await addEntry({ kind: 'https', pattern: 'github.com/acme/*', token: 'ghp_acme' })
    await addEntry({ kind: 'https', pattern: 'github.com/*', token: 'ghp_fallback' })
    await removeEntryChecked('github.com/acme/*')
    expect((await listEntries()).map((e) => e.pattern)).toEqual(['github.com/*'])
  })

  it('throws NOT_FOUND for a pattern that is not stored', async () => {
    await addEntry({ kind: 'https', pattern: 'github.com/*', token: 'ghp_x' })
    await expect(removeEntryChecked('missing/*')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect((await listEntries()).map((e) => e.pattern)).toEqual(['github.com/*'])
  })
})

describe('replaceEntries', () => {
  it('writes the provided list verbatim, case and all, and accepts []', async () => {
    await addEntry({ kind: 'https', pattern: 'github.com/old/*', token: 'ghp_old' })
    await replaceEntries([
      { kind: 'https', pattern: 'github.com/Acme/Repo', token: 'ghp_a' },
      { kind: 'ssh', pattern: 'gitlab.com/*', privateKeyPath: '/k', knownHostsEntry: KNOWN_HOSTS },
    ])
    expect((await listEntries()).map((e) => e.pattern))
      .toEqual(['github.com/Acme/Repo', 'gitlab.com/*'])

    await replaceEntries([])
    expect(await listEntries()).toEqual([])
  })

  it('validates every entry before writing any of them', async () => {
    await addEntry({ kind: 'https', pattern: 'github.com/keep/*', token: 'ghp_keep' })

    await expect(replaceEntries([
      // @ts-expect-error — a kind neither writer nor proxy understands
      { kind: 'gpg', pattern: 'github.com/*' },
    ])).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(replaceEntries([{ kind: 'https', pattern: '*', token: 'ghp_x' }]))
      .rejects.toThrow(/Invalid pattern/)
    await expect(replaceEntries([{ kind: 'https', pattern: 'github.com/*', token: '' }]))
      .rejects.toThrow(/Empty token/)
    await expect(replaceEntries([
      // @ts-expect-error — intentionally missing knownHostsEntry
      { kind: 'ssh', pattern: 'github.com/*', privateKeyPath: '/k' },
    ])).rejects.toThrow(/needs privateKeyPath and knownHostsEntry/)

    expect((await listEntries()).map((e) => e.pattern)).toEqual(['github.com/keep/*'])
  })
})
