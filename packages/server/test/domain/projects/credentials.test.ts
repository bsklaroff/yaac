import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createTempDataDir, cleanupTempDir, getDataDir } from '@yaac/test-utils/setup'
import { addEntry, importLegacySshKeys, listEntries, listSshEntries, loadKnownHostsEntryForHost, parseGitRemote, removeEntryChecked, replaceEntries, resolveCredentialForUrl, saveCredentials } from '#domain/projects'
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

/** A real ed25519 private key, as its PEM. `passphrase` produces the
 *  encrypted key the ssh-keygen probe is there to reject. */
async function makeKey(name: string, passphrase = ''): Promise<string> {
  const keyPath = path.join(getDataDir(), name)
  await execFileAsync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', passphrase, '-C', '', '-f', keyPath])
  return await fs.readFile(keyPath, 'utf8')
}

/** A stand-in for the two fields the sealed store needs, where the test is
 *  about something other than the key material. */
async function sshEntry(pattern: string, keyName = pattern.replace(/\W/g, '_')): Promise<{
  kind: 'ssh'
  pattern: string
  privateKey: string
  knownHostsEntry: string
}> {
  return {
    kind: 'ssh',
    pattern,
    privateKey: await makeKey(keyName),
    knownHostsEntry: KNOWN_HOSTS,
  }
}

describe('saveCredentials', () => {
  it('writes the https tokens 0600 inside the data dir', async () => {
    // The file is the https half only: an ssh entry carries key material,
    // and this directory is bind-mounted into the proxy pod.
    await saveCredentials({ tokens: [
      { kind: 'https', pattern: 'github.com/*', token: 'ghp_test' },
    ] })

    expect(githubCredentialsPath()).toBe(path.join(getDataDir(), '.credentials', 'github.json'))
    expect((await fs.stat(githubCredentialsPath())).mode & 0o777).toBe(0o600)
    expect(await listEntries()).toEqual([
      { kind: 'https', pattern: 'github.com/*', preview: '***test' },
    ])
  })

  it('replaces the stored list wholesale', async () => {
    await saveCredentials({ tokens: [{ kind: 'https', pattern: 'github.com/*', token: 'ghp_a' }] })
    await saveCredentials({ tokens: [] })
    expect(await listEntries()).toEqual([])
  })
})

describe('listEntries', () => {
  it('masks https tokens, says where an ssh key is, and is [] when unset', async () => {
    expect(await listEntries()).toEqual([])
    await saveCredentials({ tokens: [
      { kind: 'https', pattern: 'github.com/acme/*', token: 'ghp_abcdef1234' },
      { kind: 'https', pattern: 'github.com/tiny/*', token: 'abc' },
    ] })
    await addEntry(await sshEntry('git.example.com/*'))

    expect(await listEntries()).toEqual([
      { kind: 'https', pattern: 'github.com/acme/*', preview: '***1234' },
      // A token too short to mask meaningfully is hidden outright.
      { kind: 'https', pattern: 'github.com/tiny/*', preview: '****' },
      // Nothing about the key itself, and nothing locating it either: the
      // key is content the server holds, not a path anyone could open.
      { kind: 'ssh', pattern: 'git.example.com/*', preview: 'key stored on server (encrypted)' },
    ])
  })

  it('drops entries a reader could not act on', async () => {
    await storeRaw(JSON.stringify({ tokens: [
      { pattern: 'github.com/*', token: '' }, // no token
      { pattern: '*', token: 'ghp_x' }, // no host axis
      { pattern: 'acme/*', token: 'ghp_x' }, // owner with no host
      { pattern: 'a/b/c', token: 'ghp_x' }, // no host segment
      { pattern: 'bad host/*', token: 'ghp_x' }, // not a host
      { kind: 'ssh', pattern: 'git.example.com/*', privateKeyPath: '/k' }, // ssh lives in the db now
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
      { kind: 'https', pattern: 'github.com/org/*', token: 'ghp_kept' },
    ] }))

    await listEntries()
    const logged = mockServerLog.mock.calls.map(([line]) => line).join('\n')

    expect(logged).toContain('"*" names no host — use "github.com/*"')
    expect(logged).toContain('"acme/*" names no host — use "github.com/acme/*"')
    // No github.com/ rewrite can rescue a pattern whose host has a space.
    expect(logged).toContain('"bad host/*" is not a valid <host>/<path> pattern')
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

  it('returns an ssh credential carrying the key itself', async () => {
    const entry = await sshEntry('git.example.com/*')
    await addEntry(entry)
    expect(await resolveCredentialForUrl('git@git.example.com:acme/repo.git')).toEqual({
      kind: 'ssh',
      privateKey: entry.privateKey,
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
    ] })
    await addEntry({
      ...await sshEntry('other.example.com/*'),
      knownHostsEntry: 'other ssh-rsa BBB',
    })
    await addEntry(await sshEntry('git.example.com/acme/*'))
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
  it('returns every ssh entry with its host and the key the agent loads', async () => {
    await saveCredentials({ tokens: [
      { kind: 'https', pattern: 'github.com/*', token: 'ghp_x' },
    ] })
    const a = await sshEntry('git.example.com/acme/*', 'key_a')
    const b = {
      ...await sshEntry('other.example.com/*', 'key_b'),
      knownHostsEntry: 'other ssh-rsa BBB',
    }
    await addEntry(a)
    await addEntry(b)

    expect(await listSshEntries()).toEqual([
      {
        pattern: 'git.example.com/acme/*',
        host: 'git.example.com',
        privateKey: a.privateKey,
        knownHostsEntry: KNOWN_HOSTS,
      },
      {
        pattern: 'other.example.com/*',
        host: 'other.example.com',
        privateKey: b.privateKey,
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

  it('seals an unencrypted ssh key into a row, leaving no plaintext behind', async () => {
    const entry = await sshEntry('git.example.com/*', 'id_ok')
    await addEntry(entry)
    expect((await listSshEntries())[0]?.privateKey).toBe(entry.privateKey)

    // Nothing under the credentials dir holds the key — the row does, sealed
    // — and this is the directory the proxy pod mounts. Adding an ssh key
    // does not even create it, so an absent dir passes for the right reason.
    const dir = path.dirname(githubCredentialsPath())
    const names = await fs.readdir(dir).catch(() => [] as string[])
    for (const name of names) {
      const body = await fs.readFile(path.join(dir, name), 'utf8')
      expect(body).not.toContain('PRIVATE KEY')
    }
  })

  it('rejects an invalid pattern or an empty token', async () => {
    await expect(addEntry({ kind: 'https', pattern: '*', token: 'ghp_x' }))
      .rejects.toBeInstanceOf(ServerError)
    await expect(addEntry({ kind: 'https', pattern: 'github.com/*', token: '' }))
      .rejects.toBeInstanceOf(ServerError)
  })

  it('rejects an ssh entry missing either of its two required fields', async () => {
    await expect(addEntry({
      kind: 'ssh', pattern: 'git.example.com/*', privateKey: '', knownHostsEntry: KNOWN_HOSTS,
    })).rejects.toThrow(/private key cannot be empty/)
    await expect(addEntry({
      ...await sshEntry('git.example.com/*'), knownHostsEntry: '',
    })).rejects.toThrow(/knownHostsEntry cannot be empty/)
  })

  it('rejects something that is not a private key, and one with a passphrase', async () => {
    // The commonest mistakes: pasting a path, and pasting the .pub half.
    await expect(addEntry({
      kind: 'ssh',
      pattern: 'git.example.com/*',
      privateKey: '~/.ssh/id_ed25519',
      knownHostsEntry: KNOWN_HOSTS,
    })).rejects.toThrow(/does not look like an SSH private key/)

    await expect(addEntry({
      kind: 'ssh',
      pattern: 'git.example.com/*',
      privateKey: await makeKey('id_locked', 'hunter2'),
      knownHostsEntry: KNOWN_HOSTS,
    })).rejects.toThrow(/without a passphrase/)

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
      await sshEntry('gitlab.com/*', 'replace_key'),
    ])
    expect((await listEntries()).map((e) => e.pattern))
      .toEqual(['github.com/Acme/Repo', 'gitlab.com/*'])

    await replaceEntries([])
    expect(await listEntries()).toEqual([])
  })

  it('validates every KEY before deleting any, so one bad entry costs nothing', async () => {
    // The passphrase probe is the only check that can reject a well-shaped
    // entry, and it runs per key. Doing it after the delete would mean one
    // pasted `.pub` in a list costs every previously-working key — a 400 the
    // caller sees, and an agent nobody re-synced.
    const good = await sshEntry('git.example.com/*', 'replace_good')
    await addEntry(good)

    await expect(replaceEntries([
      good,
      {
        kind: 'ssh',
        pattern: 'other.example.com/*',
        privateKey: await makeKey('replace_locked', 'hunter2'),
        knownHostsEntry: KNOWN_HOSTS,
      },
    ])).rejects.toThrow(/without a passphrase/)

    expect((await listSshEntries()).map((e) => e.pattern)).toEqual(['git.example.com/*'])
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
      { kind: 'ssh', pattern: 'github.com/*', privateKey: 'x' },
    ])).rejects.toThrow(/needs privateKey and knownHostsEntry/)

    expect((await listEntries()).map((e) => e.pattern)).toEqual(['github.com/keep/*'])
  })
})

describe('importLegacySshKeys', () => {
  /** The file shape an older install left behind: an ssh entry naming a PATH
   *  the server was expected to open. */
  async function storeLegacySsh(entries: Array<Record<string, unknown>>): Promise<void> {
    await storeRaw(JSON.stringify({
      tokens: [{ kind: 'https', pattern: 'github.com/*', token: 'ghp_keep' }, ...entries],
    }) + '\n')
  }

  it('seals a readable key into a row and strips the entry', async () => {
    const keyPath = path.join(getDataDir(), 'legacy-key')
    await execFileAsync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', '', '-f', keyPath])
    await storeLegacySsh([{
      kind: 'ssh',
      pattern: 'git.example.com/*',
      privateKeyPath: keyPath,
      knownHostsEntry: KNOWN_HOSTS,
    }])

    await importLegacySshKeys()

    expect((await listSshEntries())[0]).toMatchObject({
      pattern: 'git.example.com/*',
      privateKey: await fs.readFile(keyPath, 'utf8'),
      knownHostsEntry: KNOWN_HOSTS,
    })
    // Stripped from the file, which keeps whatever else it held.
    const raw = JSON.parse(await fs.readFile(githubCredentialsPath(), 'utf8')) as {
      tokens: Array<Record<string, unknown>>
    }
    expect(raw.tokens).toEqual([
      { kind: 'https', pattern: 'github.com/*', token: 'ghp_keep' },
    ])
  })

  it('keeps an entry whose key it could not read, so the next start retries', async () => {
    // A read fails for reasons that pass — a home not mounted yet at boot, a
    // containerless worktree's private $HOME sending `~` elsewhere — and
    // stripping on one of those loses the pattern and its known_hosts line
    // for good, with nothing left to retry from.
    await storeLegacySsh([{
      kind: 'ssh',
      pattern: 'git.example.com/*',
      privateKeyPath: path.join(getDataDir(), 'not-there'),
      knownHostsEntry: KNOWN_HOSTS,
    }])

    await importLegacySshKeys()

    expect(await listSshEntries()).toEqual([])
    const raw = JSON.parse(await fs.readFile(githubCredentialsPath(), 'utf8')) as {
      tokens: Array<Record<string, unknown>>
    }
    expect(raw.tokens).toHaveLength(2)
    expect(mockServerLog.mock.calls.map(([l]) => l).join('\n')).toContain('cannot read')
  })

  it('refuses to import a pattern with no host axis', async () => {
    // `parsePattern` would then throw on every SSH create and every key sync
    // — an older file's shape becoming a permanent crash.
    await storeLegacySsh([{
      kind: 'ssh',
      pattern: 'acme/repo',
      privateKeyPath: path.join(getDataDir(), 'whatever'),
      knownHostsEntry: KNOWN_HOSTS,
    }])

    await importLegacySshKeys()

    expect(await listSshEntries()).toEqual([])
    expect(mockServerLog.mock.calls.map(([l]) => l).join('\n')).toContain('names no host')
  })

  it('is a no-op on a file with no ssh entries, and idempotent on a second run', async () => {
    await storeRaw(JSON.stringify({
      tokens: [{ kind: 'https', pattern: 'github.com/*', token: 'ghp_keep' }],
    }) + '\n')
    const before = await fs.readFile(githubCredentialsPath(), 'utf8')

    await importLegacySshKeys()
    expect(await fs.readFile(githubCredentialsPath(), 'utf8')).toBe(before)

    const keyPath = path.join(getDataDir(), 'twice-key')
    await execFileAsync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', '', '-f', keyPath])
    await storeLegacySsh([{
      kind: 'ssh', pattern: 'git.example.com/*', privateKeyPath: keyPath, knownHostsEntry: KNOWN_HOSTS,
    }])
    await importLegacySshKeys()
    await importLegacySshKeys()
    expect(await listSshEntries()).toHaveLength(1)
  })
})
