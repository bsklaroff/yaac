import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createTempDataDir, cleanupTempDir, getDataDir } from '@yaac/test-utils/setup'
import {
  addEntry,
  generateSshCredential,
  listEntries,
  listSshEntries,
  loadKnownHostsEntryForHost,
  parseGitRemote,
  removeEntryChecked,
  resolveCredentialForUrl,
  saveCredentials,
  sshKeyMaterial,
} from '#domain/projects'
import { githubCredentialsPath, secretKeyPath } from '@yaac/shared/project-paths'
import { forgetSecretConfig } from '#db/secret-key'
import { ServerError } from '@yaac/shared/errors'
import { serverLog } from '#log'

// Asserted on: a dropped credential entry is announced, and the announcement
// never carries the token.
vi.mock('#log', () => ({ serverLog: vi.fn() }))

const execFileAsync = promisify(execFile)
const mockServerLog = vi.mocked(serverLog)

const KNOWN_HOSTS = 'git.example.com ssh-ed25519 AAAA'
const PUBLIC_KEY_RE = /^ssh-ed25519 AAAAC3NzaC1lZDI1NTE5\S+ yaac \S+$/

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

/** Generate a key for a pattern with the host key pasted, so no network
 *  is touched. */
function generate(pattern: string, knownHostsEntry = KNOWN_HOSTS): ReturnType<typeof generateSshCredential> {
  return generateSshCredential({ pattern, knownHostsEntry })
}

describe('saveCredentials', () => {
  it('writes the https tokens 0600 inside the data dir', async () => {
    // The file is the https half only: an ssh key is a sealed row, and this
    // directory is bind-mounted into the proxy pod.
    await saveCredentials({ tokens: [
      { kind: 'https', pattern: 'github.com/*', token: 'ghp_test' },
    ] })

    expect(githubCredentialsPath()).toBe(path.join(getDataDir(), 'server-local', '.credentials', 'github.json'))
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
  it('masks https tokens, shows an ssh key as its public half, and is [] when unset', async () => {
    expect(await listEntries()).toEqual([])
    await saveCredentials({ tokens: [
      { kind: 'https', pattern: 'github.com/acme/*', token: 'ghp_abcdef1234' },
      { kind: 'https', pattern: 'github.com/tiny/*', token: 'abc' },
    ] })
    const { publicKey } = await generate('git.example.com/*')

    expect(await listEntries()).toEqual([
      { kind: 'https', pattern: 'github.com/acme/*', preview: '***1234' },
      // A token too short to mask meaningfully is hidden outright.
      { kind: 'https', pattern: 'github.com/tiny/*', preview: '****' },
      // The public key IS the preview: it is the half the user needs, and
      // the only half there is to show.
      { kind: 'ssh', pattern: 'git.example.com/*', preview: publicKey, publicKey },
    ])
    expect(publicKey).toMatch(PUBLIC_KEY_RE)
  })

  it('drops entries a reader could not act on', async () => {
    await storeRaw(JSON.stringify({ tokens: [
      { pattern: 'github.com/*', token: '' }, // no token
      { pattern: '*', token: 'ghp_x' }, // no host axis
      { pattern: 'acme/*', token: 'ghp_x' }, // owner with no host
      { pattern: 'a/b/c', token: 'ghp_x' }, // no host segment
      { pattern: 'bad host/*', token: 'ghp_x' }, // not a host
      { kind: 'ssh', pattern: 'git.example.com/*', privateKeyPath: '/k' }, // ssh lives in the db
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

  it('marks a key the secret key no longer opens, and resolve skips it', async () => {
    const { publicKey } = await generate('git.example.com/*')
    await fs.writeFile(secretKeyPath(), 'a-completely-different-key\n', { mode: 0o600 })
    forgetSecretConfig()

    expect(await listEntries()).toEqual([{
      kind: 'ssh',
      pattern: 'git.example.com/*',
      preview: `${publicKey} (unreadable — generate a new key)`,
      publicKey,
    }])
    // Handing the match out would fail at the remote, where the cause is
    // invisible; the listing above is where it is visible.
    expect(await resolveCredentialForUrl('git@git.example.com:acme/repo.git')).toBeNull()
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

  it('returns an ssh credential carrying only public halves', async () => {
    // The server's own git signs through its agent; what the invocation
    // needs is the identity to pin and the host key to check.
    const { publicKey } = await generate('git.example.com/*')
    expect(await resolveCredentialForUrl('git@git.example.com:acme/repo.git')).toEqual({
      kind: 'ssh',
      pattern: 'git.example.com/*',
      publicKey,
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
    await generate('other.example.com/*', 'other ssh-rsa BBB')
    await generate('git.example.com/acme/*')
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
  it('returns every ssh entry with its host and a key ssh-keygen reads', async () => {
    await saveCredentials({ tokens: [
      { kind: 'https', pattern: 'github.com/*', token: 'ghp_x' },
    ] })
    const a = await generate('git.example.com/acme/*')
    const b = await generate('other.example.com/*', 'other ssh-rsa BBB')

    const entries = await listSshEntries()
    expect(entries).toEqual([
      {
        pattern: 'git.example.com/acme/*',
        host: 'git.example.com',
        privateKey: expect.stringMatching(/^-----BEGIN OPENSSH PRIVATE KEY-----\n/) as string,
        knownHostsEntry: KNOWN_HOSTS,
      },
      {
        pattern: 'other.example.com/*',
        host: 'other.example.com',
        privateKey: expect.stringMatching(/^-----BEGIN OPENSSH PRIVATE KEY-----\n/) as string,
        knownHostsEntry: 'other ssh-rsa BBB',
      },
    ])
    // The material is the key the public half was generated with — proven
    // by the parser the proxy and the containerless driver feed it to.
    for (const [entry, generated] of [[entries[0], a], [entries[1], b]] as const) {
      const keyPath = path.join(getDataDir(), 'probe')
      await fs.writeFile(keyPath, entry.privateKey, { mode: 0o600 })
      const { stdout } = await execFileAsync('ssh-keygen', ['-y', '-f', keyPath])
      expect(stdout.trim()).toBe(generated.publicKey)
      await fs.rm(keyPath)
    }
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

  it('rejects an invalid pattern or an empty token', async () => {
    await expect(addEntry({ kind: 'https', pattern: '*', token: 'ghp_x' }))
      .rejects.toBeInstanceOf(ServerError)
    await expect(addEntry({ kind: 'https', pattern: 'github.com/*', token: '' }))
      .rejects.toBeInstanceOf(ServerError)
  })
})

describe('generateSshCredential', () => {
  it('seals a fresh key, answers its public half, and leaves nothing on disk', async () => {
    const generated = await generate('git.example.com/*')
    expect(generated).toEqual({
      pattern: 'git.example.com/*',
      publicKey: expect.stringMatching(PUBLIC_KEY_RE) as string,
      knownHostsEntry: KNOWN_HOSTS,
    })
    expect(generated.publicKey).toMatch(/ yaac git\.example\.com\/\*$/)

    // Nothing under the data dir holds the private half — not the
    // credentials dir the proxy pod mounts, nor anywhere else.
    const { stdout } = await execFileAsync('grep', ['-rl', 'PRIVATE KEY', getDataDir()])
      .catch(() => ({ stdout: '' }))
    expect(stdout).toBe('')
  })

  it('replaces the key for a pattern, so the previous public half stops working', async () => {
    const first = await generate('git.example.com/*')
    const second = await generate('git.example.com/*', 'git.example.com ssh-ed25519 BBBB')
    expect(second.publicKey).not.toBe(first.publicKey)
    expect(await listEntries()).toEqual([
      { kind: 'ssh', pattern: 'git.example.com/*', preview: second.publicKey, publicKey: second.publicKey },
    ])
    expect(await loadKnownHostsEntryForHost('git.example.com')).toBe('git.example.com ssh-ed25519 BBBB')
  })

  it('rejects an invalid pattern before generating anything', async () => {
    await expect(generate('acme/*')).rejects.toMatchObject({ code: 'VALIDATION' })
    expect(await listEntries()).toEqual([])
  })

  it('fetches the host key when none is pasted, and says so when it cannot', async () => {
    // `.invalid` never resolves, so the fetch fails at DNS; the complaint
    // names the way out, and nothing is stored for a host that could not
    // be verified.
    await expect(generateSshCredential({ pattern: 'nonexistent.invalid/*' }))
      .rejects.toThrow(/Could not fetch the host key for nonexistent\.invalid .*paste a known_hosts line/)
    expect(await listEntries()).toEqual([])
  })
})

describe('sshKeyMaterial', () => {
  it('opens the key for a pattern in the form ssh-add reads', async () => {
    const { publicKey } = await generate('git.example.com/*')
    const material = await sshKeyMaterial('git.example.com/*')
    const keyPath = path.join(getDataDir(), 'probe')
    await fs.writeFile(keyPath, material, { mode: 0o600 })
    const { stdout } = await execFileAsync('ssh-keygen', ['-y', '-f', keyPath])
    expect(stdout.trim()).toBe(publicKey)
  })

  it('refuses a pattern with no key', async () => {
    await expect(sshKeyMaterial('missing.example.com/*')).rejects.toMatchObject({ code: 'VALIDATION' })
  })
})

describe('removeEntryChecked', () => {
  it('removes the exactly-matching pattern, https or ssh, leaving the others', async () => {
    await addEntry({ kind: 'https', pattern: 'github.com/acme/*', token: 'ghp_acme' })
    await addEntry({ kind: 'https', pattern: 'github.com/*', token: 'ghp_fallback' })
    await generate('git.example.com/*')
    await removeEntryChecked('github.com/acme/*')
    expect((await listEntries()).map((e) => e.pattern)).toEqual(['github.com/*', 'git.example.com/*'])
    await removeEntryChecked('git.example.com/*')
    expect((await listEntries()).map((e) => e.pattern)).toEqual(['github.com/*'])
  })

  it('throws NOT_FOUND for a pattern that is not stored', async () => {
    await addEntry({ kind: 'https', pattern: 'github.com/*', token: 'ghp_x' })
    await expect(removeEntryChecked('missing/*')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect((await listEntries()).map((e) => e.pattern)).toEqual(['github.com/*'])
  })
})
