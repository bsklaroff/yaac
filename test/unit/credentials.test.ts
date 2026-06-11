import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createTempDataDir, cleanupTempDir, getDataDir } from '@test/helpers/setup'
import {
  credentialsPath,
  loadCredentials,
  resolveCredentialForUrl,
  loadKnownHostsEntryForHost,
  addEntry,
  removeEntry,
  removeEntryChecked,
  replaceEntries,
  listEntries,
  validatePattern,
  parsePattern,
  parseGitRemote,
  matchPattern,
  saveCredentials,
  writeProxySecrets,
} from '@/lib/project/credentials'
import { proxySecretsCredentialsPath } from '@/lib/project/paths'
import { DaemonError } from '@/daemon/errors'

describe('credentials', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
  })

  afterEach(async () => {
    await cleanupTempDir(tmpDir)
  })

  it('credentialsPath returns path inside data dir credentials subdirectory', () => {
    expect(credentialsPath()).toBe(path.join(getDataDir(), '.credentials', 'github.json'))
  })

  describe('loadCredentials', () => {
    it('returns empty tokens when file is missing', async () => {
      const result = await loadCredentials()
      expect(result).toEqual({ tokens: [] })
    })

    it('returns tokens from valid file', async () => {
      await saveCredentials({ tokens: [{ kind: 'https', pattern: 'github.com/*', token: 'ghp_test' }] })
      const result = await loadCredentials()
      expect(result.tokens).toEqual([{ kind: 'https', pattern: 'github.com/*', token: 'ghp_test' }])
    })

    it('normalizes legacy bare * to github.com/*', async () => {
      await fs.mkdir(path.dirname(credentialsPath()), { recursive: true })
      await fs.writeFile(
        credentialsPath(),
        JSON.stringify({ tokens: [{ pattern: '*', token: 'ghp_legacy' }] }),
      )
      const result = await loadCredentials()
      expect(result.tokens).toEqual([{ kind: 'https', pattern: 'github.com/*', token: 'ghp_legacy' }])
    })

    it('normalizes legacy owner/* to github.com/owner/*', async () => {
      await fs.mkdir(path.dirname(credentialsPath()), { recursive: true })
      await fs.writeFile(
        credentialsPath(),
        JSON.stringify({ tokens: [{ pattern: 'acme/*', token: 'ghp_acme' }] }),
      )
      const result = await loadCredentials()
      expect(result.tokens).toEqual([{ kind: 'https', pattern: 'github.com/acme/*', token: 'ghp_acme' }])
    })

    it('normalizes legacy owner/repo to github.com/owner/repo', async () => {
      await fs.mkdir(path.dirname(credentialsPath()), { recursive: true })
      await fs.writeFile(
        credentialsPath(),
        JSON.stringify({ tokens: [{ pattern: 'acme/repo', token: 'ghp_acme' }] }),
      )
      const result = await loadCredentials()
      expect(result.tokens).toEqual([{ kind: 'https', pattern: 'github.com/acme/repo', token: 'ghp_acme' }])
    })

    it('filters out https entries with empty tokens', async () => {
      await fs.mkdir(path.dirname(credentialsPath()), { recursive: true })
      await fs.writeFile(
        credentialsPath(),
        JSON.stringify({ tokens: [
          { pattern: 'github.com/*', token: '' },
          { pattern: 'github.com/org/*', token: 'ghp_valid' },
        ] }),
      )
      const result = await loadCredentials()
      expect(result.tokens).toEqual([
        { kind: 'https', pattern: 'github.com/org/*', token: 'ghp_valid' },
      ])
    })

    it('filters out ssh entries missing fields', async () => {
      await fs.mkdir(path.dirname(credentialsPath()), { recursive: true })
      await fs.writeFile(
        credentialsPath(),
        JSON.stringify({ tokens: [
          { kind: 'ssh', pattern: 'git.example.com/*', privateKeyPath: '/k' }, // missing knownHostsEntry
          { kind: 'ssh', pattern: 'git.example.com/*', privateKeyPath: '/k', knownHostsEntry: 'kh' },
        ] }),
      )
      const result = await loadCredentials()
      expect(result.tokens).toEqual([
        { kind: 'ssh', pattern: 'git.example.com/*', privateKeyPath: '/k', knownHostsEntry: 'kh' },
      ])
    })

    it('returns empty tokens for invalid JSON', async () => {
      await fs.mkdir(path.dirname(credentialsPath()), { recursive: true })
      await fs.writeFile(credentialsPath(), 'not json')
      const result = await loadCredentials()
      expect(result).toEqual({ tokens: [] })
    })
  })

  describe('validatePattern', () => {
    it('accepts <host>/*', () => {
      expect(validatePattern('github.com/*')).toBe(true)
      expect(validatePattern('git.example.com/*')).toBe(true)
    })

    it('accepts <host>/<owner>/*', () => {
      expect(validatePattern('github.com/acme/*')).toBe(true)
    })

    it('accepts <host>/<owner>/<repo>', () => {
      expect(validatePattern('github.com/acme/my-repo')).toBe(true)
    })

    it('accepts deep prefix patterns', () => {
      expect(validatePattern('gitlab.com/group/sub/*')).toBe(true)
    })

    it('accepts deep exact patterns', () => {
      expect(validatePattern('gitlab.com/group/sub/repo')).toBe(true)
    })

    it('accepts single-segment exact path (Gerrit-style)', () => {
      expect(validatePattern('gerrit.example.com/myrepo')).toBe(true)
    })

    it('rejects bare *', () => {
      expect(validatePattern('*')).toBe(false)
    })

    it('rejects bare <owner>/*', () => {
      expect(validatePattern('acme/*')).toBe(false)  // 'acme' is not a host (no dot)
    })

    it('rejects bare <owner>/<repo>', () => {
      // 'acme/repo' is rejected — first segment has no dot, treated as owner
      expect(validatePattern('acme/repo')).toBe(false)
    })

    it('rejects empty string', () => {
      expect(validatePattern('')).toBe(false)
    })

    it('rejects wildcard in host', () => {
      expect(validatePattern('*.example.com/*')).toBe(false)
    })

    it('rejects wildcard in middle path segment', () => {
      expect(validatePattern('github.com/*/repo')).toBe(false)
      expect(validatePattern('gitlab.com/group/*/repo')).toBe(false)
    })

    it('rejects partial wildcards in path', () => {
      expect(validatePattern('github.com/owner/repo-*')).toBe(false)
    })

    it('rejects bare host with no path', () => {
      expect(validatePattern('github.com')).toBe(false)
    })

    it('rejects empty path segments', () => {
      expect(validatePattern('github.com//repo')).toBe(false)
    })
  })

  describe('parsePattern', () => {
    it('canonicalizes <host>/*', () => {
      expect(parsePattern('git.example.com/*'))
        .toEqual({ host: 'git.example.com', kind: 'any', path: '' })
    })

    it('canonicalizes <host>/<owner>/*', () => {
      expect(parsePattern('github.com/acme/*'))
        .toEqual({ host: 'github.com', kind: 'prefix', path: 'acme' })
    })

    it('canonicalizes <host>/<owner>/<repo>', () => {
      expect(parsePattern('github.com/acme/repo'))
        .toEqual({ host: 'github.com', kind: 'exact', path: 'acme/repo' })
    })

    it('canonicalizes deep prefix patterns', () => {
      expect(parsePattern('gitlab.com/group/sub/*'))
        .toEqual({ host: 'gitlab.com', kind: 'prefix', path: 'group/sub' })
    })

    it('canonicalizes deep exact patterns', () => {
      expect(parsePattern('gitlab.com/group/sub/repo'))
        .toEqual({ host: 'gitlab.com', kind: 'exact', path: 'group/sub/repo' })
    })

    it('canonicalizes single-segment exact patterns', () => {
      expect(parsePattern('gerrit.example.com/myrepo'))
        .toEqual({ host: 'gerrit.example.com', kind: 'exact', path: 'myrepo' })
    })

    it('throws on bare patterns', () => {
      expect(() => parsePattern('*')).toThrow()
      expect(() => parsePattern('acme/*')).toThrow()
    })
  })

  describe('parseGitRemote', () => {
    it('parses https URL with .git', () => {
      expect(parseGitRemote('https://github.com/acme/repo.git'))
        .toEqual({ scheme: 'https', host: 'github.com', path: 'acme/repo' })
    })

    it('parses https URL without .git', () => {
      expect(parseGitRemote('https://git.example.com/acme/repo'))
        .toEqual({ scheme: 'https', host: 'git.example.com', path: 'acme/repo' })
    })

    it('parses https URL with deep path (gitlab subgroups)', () => {
      expect(parseGitRemote('https://gitlab.com/group/sub/repo.git'))
        .toEqual({ scheme: 'https', host: 'gitlab.com', path: 'group/sub/repo' })
    })

    it('parses https URL with single-segment path', () => {
      expect(parseGitRemote('https://gerrit.example.com/myrepo'))
        .toEqual({ scheme: 'https', host: 'gerrit.example.com', path: 'myrepo' })
    })

    it('parses SCP-style with user', () => {
      expect(parseGitRemote('git@github.com:acme/repo.git'))
        .toEqual({ scheme: 'ssh', host: 'github.com', path: 'acme/repo' })
    })

    it('parses SCP-style without user', () => {
      expect(parseGitRemote('git.example.com:acme/repo'))
        .toEqual({ scheme: 'ssh', host: 'git.example.com', path: 'acme/repo' })
    })

    it('parses SCP-style with deep path', () => {
      expect(parseGitRemote('git@gitlab.com:group/sub/repo.git'))
        .toEqual({ scheme: 'ssh', host: 'gitlab.com', path: 'group/sub/repo' })
    })

    it('parses SCP-style with single-segment path', () => {
      expect(parseGitRemote('git@gerrit.example.com:myrepo.git'))
        .toEqual({ scheme: 'ssh', host: 'gerrit.example.com', path: 'myrepo' })
    })

    it('rejects ssh:// URLs', () => {
      expect(() => parseGitRemote('ssh://git@github.com/acme/repo')).toThrow(/SCP-style/)
    })

    it('rejects http:// URLs', () => {
      expect(() => parseGitRemote('http://github.com/acme/repo')).toThrow()
    })

    it('rejects custom HTTPS ports', () => {
      expect(() => parseGitRemote('https://github.com:8443/acme/repo')).toThrow(/Custom HTTPS ports/)
    })

    it('rejects URLs with no path', () => {
      expect(() => parseGitRemote('https://github.com/')).toThrow()
    })

    it('rejects garbage', () => {
      expect(() => parseGitRemote('not-a-url')).toThrow()
    })
  })

  describe('matchPattern', () => {
    it('<host>/* matches everything on host', () => {
      expect(matchPattern('github.com/*', 'github.com', 'any/repo')).toBe(true)
      expect(matchPattern('github.com/*', 'github.com', 'single')).toBe(true)
    })

    it('<host>/* does not match other host', () => {
      expect(matchPattern('github.com/*', 'git.example.com', 'any/repo')).toBe(false)
    })

    it('<host>/<owner>/* matches owner', () => {
      expect(matchPattern('github.com/acme/*', 'github.com', 'acme/r1')).toBe(true)
      expect(matchPattern('github.com/acme/*', 'github.com', 'other/r1')).toBe(false)
    })

    it('<host>/<owner>/* matches the bare owner path too', () => {
      // The prefix matches the path equal to the prefix as well as anything
      // beneath it. Mostly relevant for deep prefixes; bare owners rarely
      // occur as a full repo path.
      expect(matchPattern('github.com/acme/*', 'github.com', 'acme')).toBe(true)
    })

    it('<host>/<owner>/<repo> exact', () => {
      expect(matchPattern('github.com/acme/repo', 'github.com', 'acme/repo')).toBe(true)
      expect(matchPattern('github.com/acme/repo', 'github.com', 'acme/other')).toBe(false)
    })

    it('deep prefix matches nested paths', () => {
      expect(matchPattern('gitlab.com/group/sub/*', 'gitlab.com', 'group/sub/repo')).toBe(true)
      expect(matchPattern('gitlab.com/group/sub/*', 'gitlab.com', 'group/sub/deep/repo')).toBe(true)
      expect(matchPattern('gitlab.com/group/sub/*', 'gitlab.com', 'group/other/repo')).toBe(false)
    })

    it('deep prefix does not match sibling prefix', () => {
      // path "groupextra" should not match prefix "group"
      expect(matchPattern('gitlab.com/group/*', 'gitlab.com', 'groupextra')).toBe(false)
    })

    it('single-segment exact path', () => {
      expect(matchPattern('gerrit.example.com/myrepo', 'gerrit.example.com', 'myrepo')).toBe(true)
      expect(matchPattern('gerrit.example.com/myrepo', 'gerrit.example.com', 'other')).toBe(false)
    })
  })

  describe('resolveCredentialForUrl', () => {
    it('returns first matching https token', async () => {
      await saveCredentials({ tokens: [
        { kind: 'https', pattern: 'github.com/acme/*', token: 'ghp_acme' },
        { kind: 'https', pattern: 'github.com/*', token: 'ghp_fallback' },
      ] })
      const cred = await resolveCredentialForUrl('https://github.com/acme/repo.git')
      expect(cred).toEqual({ kind: 'https', token: 'ghp_acme' })
    })

    it('falls through to host-wildcard', async () => {
      await saveCredentials({ tokens: [
        { kind: 'https', pattern: 'github.com/acme/*', token: 'ghp_acme' },
        { kind: 'https', pattern: 'github.com/*', token: 'ghp_fallback' },
      ] })
      const cred = await resolveCredentialForUrl('https://github.com/other/repo.git')
      expect(cred).toEqual({ kind: 'https', token: 'ghp_fallback' })
    })

    it('returns null when no match', async () => {
      await saveCredentials({ tokens: [
        { kind: 'https', pattern: 'github.com/*', token: 'ghp_x' },
      ] })
      const cred = await resolveCredentialForUrl('https://git.example.com/a/b')
      expect(cred).toBeNull()
    })

    it('does not cross-match https <-> ssh', async () => {
      await saveCredentials({ tokens: [
        { kind: 'https', pattern: 'github.com/*', token: 'ghp_x' },
      ] })
      const cred = await resolveCredentialForUrl('git@github.com:acme/repo.git')
      expect(cred).toBeNull()
    })

    it('returns ssh credential for ssh URL', async () => {
      await saveCredentials({ tokens: [
        {
          kind: 'ssh',
          pattern: 'git.example.com/*',
          privateKeyPath: '/home/u/k',
          knownHostsEntry: 'git.example.com ssh-ed25519 AAAA',
        },
      ] })
      const cred = await resolveCredentialForUrl('git@git.example.com:acme/repo.git')
      expect(cred).toEqual({
        kind: 'ssh',
        privateKeyPath: '/home/u/k',
        knownHostsEntry: 'git.example.com ssh-ed25519 AAAA',
      })
    })
  })

  describe('loadKnownHostsEntryForHost', () => {
    it('returns the entry for a matching ssh credential', async () => {
      await saveCredentials({ tokens: [
        {
          kind: 'ssh',
          pattern: 'git.example.com/*',
          privateKeyPath: '/k',
          knownHostsEntry: 'git.example.com ssh-ed25519 AAAA',
        },
      ] })
      expect(await loadKnownHostsEntryForHost('git.example.com'))
        .toBe('git.example.com ssh-ed25519 AAAA')
    })

    it('returns null when no ssh entry matches', async () => {
      await saveCredentials({ tokens: [
        { kind: 'https', pattern: 'github.com/*', token: 'ghp_x' },
      ] })
      expect(await loadKnownHostsEntryForHost('github.com')).toBeNull()
    })
  })

  describe('addEntry', () => {
    it('adds a new https entry', async () => {
      await addEntry({ kind: 'https', pattern: 'github.com/acme/*', token: 'ghp_acme' })
      const creds = await loadCredentials()
      expect(creds.tokens).toEqual([{ kind: 'https', pattern: 'github.com/acme/*', token: 'ghp_acme' }])
    })

    it('replaces an existing entry with same pattern', async () => {
      await addEntry({ kind: 'https', pattern: 'github.com/acme/*', token: 'ghp_old' })
      await addEntry({ kind: 'https', pattern: 'github.com/acme/*', token: 'ghp_new' })
      const creds = await loadCredentials()
      expect(creds.tokens).toEqual([{ kind: 'https', pattern: 'github.com/acme/*', token: 'ghp_new' }])
    })

    it('preserves the case of the pattern as typed', async () => {
      await addEntry({ kind: 'https', pattern: 'github.com/Acme/Repo', token: 'ghp_a' })
      await addEntry({ kind: 'https', pattern: 'github.com/acme/repo', token: 'ghp_b' })
      const creds = await loadCredentials()
      expect(creds.tokens).toEqual([
        { kind: 'https', pattern: 'github.com/Acme/Repo', token: 'ghp_a' },
        { kind: 'https', pattern: 'github.com/acme/repo', token: 'ghp_b' },
      ])
    })

    it('rejects invalid pattern', async () => {
      await expect(addEntry({ kind: 'https', pattern: '*', token: 'ghp_x' }))
        .rejects.toBeInstanceOf(DaemonError)
    })

    it('rejects empty token', async () => {
      await expect(addEntry({ kind: 'https', pattern: 'github.com/*', token: '' }))
        .rejects.toBeInstanceOf(DaemonError)
    })
  })

  describe('removeEntry / removeEntryChecked', () => {
    it('removes an existing entry', async () => {
      await addEntry({ kind: 'https', pattern: 'github.com/acme/*', token: 'ghp_acme' })
      await addEntry({ kind: 'https', pattern: 'github.com/*', token: 'ghp_fallback' })
      const removed = await removeEntry('github.com/acme/*')
      expect(removed).toBe(true)
      const creds = await loadCredentials()
      expect(creds.tokens).toEqual([
        { kind: 'https', pattern: 'github.com/*', token: 'ghp_fallback' },
      ])
    })

    it('returns false when pattern not found', async () => {
      await addEntry({ kind: 'https', pattern: 'github.com/*', token: 'ghp_x' })
      const removed = await removeEntry('nonexistent/*')
      expect(removed).toBe(false)
    })

    it('removeEntryChecked throws NOT_FOUND for unknown patterns', async () => {
      await expect(removeEntryChecked('missing/*')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    })
  })

  describe('replaceEntries', () => {
    it('writes the provided list verbatim', async () => {
      await addEntry({ kind: 'https', pattern: 'github.com/old/*', token: 'ghp_old' })
      await replaceEntries([{ kind: 'https', pattern: 'github.com/new/*', token: 'ghp_new' }])
      expect((await loadCredentials()).tokens).toEqual([
        { kind: 'https', pattern: 'github.com/new/*', token: 'ghp_new' },
      ])
    })

    it('preserves the case of each entry as provided', async () => {
      await replaceEntries([
        { kind: 'https', pattern: 'github.com/Acme/Repo', token: 'ghp_a' },
        { kind: 'https', pattern: 'gitlab.com/Acme/Repo', token: 'glp_b' },
      ])
      expect((await loadCredentials()).tokens).toEqual([
        { kind: 'https', pattern: 'github.com/Acme/Repo', token: 'ghp_a' },
        { kind: 'https', pattern: 'gitlab.com/Acme/Repo', token: 'glp_b' },
      ])
    })

    it('accepts an empty list to clear everything', async () => {
      await addEntry({ kind: 'https', pattern: 'github.com/*', token: 'ghp_x' })
      await replaceEntries([])
      expect((await loadCredentials()).tokens).toEqual([])
    })

    it('rejects entries with invalid pattern', async () => {
      await expect(replaceEntries([{ kind: 'https', pattern: '*', token: 'ghp_x' }]))
        .rejects.toBeInstanceOf(DaemonError)
    })

    it('rejects ssh entries missing fields', async () => {
      await expect(replaceEntries([
        // @ts-expect-error — intentionally missing knownHostsEntry
        { kind: 'ssh', pattern: 'github.com/*', privateKeyPath: '/k' },
      ])).rejects.toMatchObject({ code: 'VALIDATION' })
    })
  })

  it('saveCredentials writes the file with 0o600 permissions', async () => {
    await addEntry({ kind: 'https', pattern: 'github.com/*', token: 'ghp_x' })
    const stats = await fs.stat(credentialsPath())
    expect(stats.mode & 0o777).toBe(0o600)
  })

  describe('listEntries', () => {
    it('returns kind-aware summaries with masked tokens', async () => {
      await addEntry({ kind: 'https', pattern: 'github.com/acme/*', token: 'ghp_abcdef1234' })
      const list = await listEntries()
      expect(list).toEqual([
        { kind: 'https', pattern: 'github.com/acme/*', preview: '***1234' },
      ])
    })

    it('shows key path for ssh entries', async () => {
      await saveCredentials({ tokens: [
        {
          kind: 'ssh',
          pattern: 'git.example.com/*',
          privateKeyPath: '~/.ssh/id_ed25519',
          knownHostsEntry: 'git.example.com ssh-ed25519 AAAA',
        },
      ] })
      const list = await listEntries()
      expect(list).toEqual([
        { kind: 'ssh', pattern: 'git.example.com/*', preview: '~/.ssh/id_ed25519' },
      ])
    })

    it('returns empty list when no entries', async () => {
      expect(await listEntries()).toEqual([])
    })
  })

  describe('writeProxySecrets', () => {
    async function readSecretsFile(): Promise<Record<string, string>> {
      const raw = JSON.parse(await fs.readFile(proxySecretsCredentialsPath(), 'utf8')) as {
        secrets: Record<string, string>
      }
      return raw.secrets
    }

    it('writes secrets keyed by env var name with 0600 mode', async () => {
      await writeProxySecrets({ MY_KEY: 'sekrit' })
      expect(await readSecretsFile()).toEqual({ MY_KEY: 'sekrit' })
      const stat = await fs.stat(proxySecretsCredentialsPath())
      expect(stat.mode & 0o777).toBe(0o600)
    })

    it('merges into existing entries instead of replacing them', async () => {
      await writeProxySecrets({ A: '1', B: '2' })
      await writeProxySecrets({ B: 'updated', C: '3' })
      expect(await readSecretsFile()).toEqual({ A: '1', B: 'updated', C: '3' })
    })

    it('no-ops on an empty secrets map', async () => {
      await writeProxySecrets({})
      await expect(fs.access(proxySecretsCredentialsPath())).rejects.toThrow()
    })

    it('recovers from a corrupt existing file', async () => {
      await fs.mkdir(path.dirname(proxySecretsCredentialsPath()), { recursive: true })
      await fs.writeFile(proxySecretsCredentialsPath(), '{not json')
      await writeProxySecrets({ A: '1' })
      expect(await readSecretsFile()).toEqual({ A: '1' })
    })
  })
})
