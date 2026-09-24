import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { execFile } from 'node:child_process'
import type * as childProcess from 'node:child_process'
import { promisify } from 'node:util'
import { createTempDataDir, cleanupTempDir, getDataDir } from '@yaac/test-utils/setup'
import {
  addHttpsCredential,
  assignProjectCredential,
  generateSshCredential,
  listCredentialSummaries,
  missingCredentialError,
  parseGitRemote,
  removeCredential,
  renameCredential,
  replaceCredential,
  resolveProjectCredential,
  runtimeGitCredentials,
  sshKeyMaterial,
} from '#domain/projects'
import { closeDb, recordProject } from '#db'
import { forgetSecretConfig } from '#db/secret-key'
import { secretKeyPath } from '@yaac/shared/project-paths'

// The process boundary a host-key fetch crosses: `ssh` is driven against the
// host and writes the key it negotiated into the known_hosts file it was
// named. Stood in for here by writing HOST_KEY there, so no network is used.
const HOST_KEY = 'git.example.com ssh-ed25519 AAAAHOST'
const sshRuns: string[][] = []
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof childProcess>()
  return {
    ...actual,
    spawn: vi.fn((cmd: string, args: string[], opts: unknown) => {
      if (cmd !== 'ssh') return actual.spawn(cmd, args, opts as never)
      sshRuns.push(args)
      const file = args.find((a) => a.startsWith('UserKnownHostsFile='))!.split('=')[1]
      const child = Object.assign(new EventEmitter(), { stderr: new EventEmitter() })
      void fs.writeFile(file, `${HOST_KEY}\n`).then(() => child.emit('close', 255))
      return child
    }),
  }
})

const execFileAsync = promisify(execFile)
const PUBLIC_KEY_RE = /^ssh-ed25519 AAAAC3NzaC1lZDI1NTE5\S+ /

let tmpDir: string

beforeEach(async () => {
  tmpDir = await createTempDataDir()
  sshRuns.length = 0
})

afterEach(async () => {
  await closeDb()
  await cleanupTempDir(tmpDir)
})

function project(slug: string, remoteUrl: string): Promise<void> {
  return recordProject({ slug, remoteUrl, addedAt: '2026-01-01' })
}

describe('addHttpsCredential', () => {
  it('stores a token under a trimmed name, and refuses a blank name or token', async () => {
    const { id } = await addHttpsCredential({ name: '  gh  ', token: 'ghp_abcd1234' })
    expect(await listCredentialSummaries()).toEqual([
      { id, name: 'gh', kind: 'https', preview: '***1234', projects: [] },
    ])
    await expect(addHttpsCredential({ name: ' ', token: 'x' })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(addHttpsCredential({ name: 'x', token: '  ' })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(addHttpsCredential({ name: 'a\nb', token: 'x' })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(addHttpsCredential({ name: 'gh', token: 'x' })).rejects.toMatchObject({ code: 'CONFLICT' })
  })
})

describe('generateSshCredential', () => {
  it('answers the public key at once, commented with the name, touching no host', async () => {
    const { id, publicKey } = await generateSshCredential({ name: 'deploy' })
    expect(publicKey).toMatch(PUBLIC_KEY_RE)
    expect(publicKey.endsWith(' deploy')).toBe(true)
    expect(sshRuns).toEqual([])
    expect(await listCredentialSummaries()).toEqual([
      { id, name: 'deploy', kind: 'ssh', preview: publicKey, publicKey, projects: [] },
    ])
  })
})

describe('renameCredential', () => {
  it('renames, re-commenting a key without changing it', async () => {
    const { id, publicKey } = await generateSshCredential({ name: 'old' })
    await renameCredential(id, 'new')
    const [summary] = await listCredentialSummaries()
    expect(summary.name).toBe('new')
    expect(summary.publicKey?.split(' ').slice(0, 2)).toEqual(publicKey.split(' ').slice(0, 2))
    expect(summary.publicKey?.endsWith(' new')).toBe(true)
    // The private half carries the new comment too, and is the same key.
    const keyPath = path.join(getDataDir(), 'probe')
    await fs.writeFile(keyPath, await sshKeyMaterial(id), { mode: 0o600 })
    const { stdout } = await execFileAsync('ssh-keygen', ['-y', '-f', keyPath])
    expect(stdout.trim().split(' ').slice(0, 2)).toEqual(publicKey.split(' ').slice(0, 2))

    await expect(renameCredential('00000000-0000-4000-8000-000000000000', 'x'))
      .rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('assignProjectCredential', () => {
  it('assigns a matching credential — fetching an ssh remote\'s host key — and refuses a mismatched kind', async () => {
    await project('web', 'https://github.com/acme/web.git')
    await project('svc', 'git@git.example.com:acme/svc.git')
    const token = await addHttpsCredential({ name: 'gh', token: 'ghp_abcd1234' })
    const key = await generateSshCredential({ name: 'deploy' })

    expect(await assignProjectCredential('web', token.id)).toEqual({ knownHostsEntry: null })
    expect(sshRuns).toEqual([])
    expect(await assignProjectCredential('svc', key.id)).toEqual({ knownHostsEntry: HOST_KEY })
    expect(sshRuns.at(-1)).toContain('nobody@git.example.com')

    await expect(assignProjectCredential('web', key.id)).rejects.toThrow(/needs a token, not an SSH key/)
    await expect(assignProjectCredential('svc', token.id)).rejects.toThrow(/needs an SSH key, not a token/)
    await expect(assignProjectCredential('nope', token.id)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect((await listCredentialSummaries()).map((c) => [c.name, c.projects]))
      .toEqual([['gh', ['web']], ['deploy', ['svc']]])
  })
})

describe('resolveProjectCredential', () => {
  it('resolves the assigned credential for git, and nothing for a project without a usable one', async () => {
    await project('web', 'https://github.com/acme/web.git')
    await project('svc', 'git@git.example.com:acme/svc.git')
    await project('bare', 'https://github.com/acme/bare.git')
    const token = await addHttpsCredential({ name: 'gh', token: 'ghp_abcd1234' })
    const key = await generateSshCredential({ name: 'deploy' })
    await assignProjectCredential('web', token.id)
    await assignProjectCredential('svc', key.id)

    expect(await resolveProjectCredential('web')).toEqual({ kind: 'https', token: 'ghp_abcd1234' })
    expect(await resolveProjectCredential('svc')).toEqual({
      kind: 'ssh', id: key.id, publicKey: key.publicKey, knownHostsEntry: HOST_KEY,
    })
    expect(await resolveProjectCredential('bare')).toBeNull()
    expect(await resolveProjectCredential('nope')).toBeNull()

    // A remote that changes under a key loses the host key it was assigned
    // with, and with it the credential, until the key is assigned again.
    await project('svc', 'git@other.example.com:acme/svc.git')
    expect(await resolveProjectCredential('svc')).toBeNull()

    // A secret that no longer opens resolves to nothing rather than to
    // something the remote would refuse.
    await fs.writeFile(secretKeyPath(), 'a-completely-different-key\n', { mode: 0o600 })
    forgetSecretConfig()
    expect(await resolveProjectCredential('web')).toBeNull()
    expect((await listCredentialSummaries())[0].preview).toMatch(/unreadable/)
  })
})

describe('missingCredentialError', () => {
  it('names the project and where to fix it', () => {
    expect(missingCredentialError('web')).toMatchObject({
      code: 'VALIDATION',
      message: expect.stringMatching(/"web" has no git credential.*Settings/) as string,
    })
  })
})

describe('removeCredential', () => {
  it('deletes a credential in use, stranding its projects with none', async () => {
    // A leaked credential has to be removable at once.
    await project('web', 'https://github.com/acme/web.git')
    const a = await addHttpsCredential({ name: 'a', token: 'ghp_aaaa' })
    await assignProjectCredential('web', a.id)

    await removeCredential(a.id)
    expect(await listCredentialSummaries()).toEqual([])
    expect(await resolveProjectCredential('web')).toBeNull()
    expect((await runtimeGitCredentials()).git).toEqual([])
    await expect(removeCredential(a.id)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('replaceCredential', () => {
  it('replaces a token or a key in place for every project that used it', async () => {
    await project('web', 'https://github.com/acme/web.git')
    await project('svc', 'git@git.example.com:acme/svc.git')
    const token = await addHttpsCredential({ name: 'gh', token: 'ghp_leaked' })
    const key = await generateSshCredential({ name: 'deploy' })
    await assignProjectCredential('web', token.id)
    await assignProjectCredential('svc', key.id)
    sshRuns.length = 0

    await expect(replaceCredential(token.id, {})).rejects.toMatchObject({ code: 'VALIDATION' })
    await replaceCredential(token.id, { token: 'ghp_fresh' })
    expect(await resolveProjectCredential('web')).toEqual({ kind: 'https', token: 'ghp_fresh' })

    const replaced = await replaceCredential(key.id, {})
    expect(replaced.publicKey).toMatch(PUBLIC_KEY_RE)
    expect(replaced.publicKey).not.toBe(key.publicKey)
    // Same host, so the host key it trusted carries over with no fetch.
    expect(await resolveProjectCredential('svc')).toEqual({
      kind: 'ssh', id: replaced.id, publicKey: replaced.publicKey, knownHostsEntry: HOST_KEY,
    })
    expect(sshRuns).toEqual([])
    expect((await listCredentialSummaries()).map((c) => [c.name, c.projects])).toEqual([['gh', ['web']], ['deploy', ['svc']]])
    await expect(replaceCredential(key.id, {})).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('runtimeGitCredentials', () => {
  it('hands the runtime each used credential with the projects entitled to it', async () => {
    await project('web', 'https://github.com/acme/web.git')
    await project('api', 'https://github.com/acme/api.git')
    await project('svc', 'git@git.example.com:acme/svc.git')
    const token = await addHttpsCredential({ name: 'gh', token: 'ghp_abcd1234' })
    await addHttpsCredential({ name: 'unused', token: 'ghp_zzzz' })
    const key = await generateSshCredential({ name: 'deploy' })
    await assignProjectCredential('web', token.id)
    await assignProjectCredential('api', token.id)
    await assignProjectCredential('svc', key.id)

    const { git, ssh } = await runtimeGitCredentials()
    expect(git).toEqual([{ token: 'ghp_abcd1234', projects: ['web', 'api'] }])
    expect(ssh).toEqual([{
      privateKey: expect.stringContaining('BEGIN OPENSSH PRIVATE KEY') as string,
      publicKey: key.publicKey,
      projects: [{ slug: 'svc', host: 'git.example.com', knownHostsEntry: HOST_KEY }],
    }])
  })
})

describe('sshKeyMaterial', () => {
  it('opens a key in the form ssh-add reads, and refuses anything else', async () => {
    const { id, publicKey } = await generateSshCredential({ name: 'deploy' })
    const keyPath = path.join(getDataDir(), 'probe')
    await fs.writeFile(keyPath, await sshKeyMaterial(id), { mode: 0o600 })
    const { stdout } = await execFileAsync('ssh-keygen', ['-y', '-f', keyPath])
    expect(stdout.trim()).toBe(publicKey)

    await expect(sshKeyMaterial('00000000-0000-4000-8000-000000000000')).rejects.toMatchObject({ code: 'VALIDATION' })
  })
})

describe('listCredentialSummaries', () => {
  it('never carries a secret, and lists each credential with its projects', async () => {
    await project('web', 'https://github.com/acme/web.git')
    const token = await addHttpsCredential({ name: 'gh', token: 'ghp_secret_abcd' })
    await assignProjectCredential('web', token.id)
    const listing = await listCredentialSummaries()
    expect(JSON.stringify(listing)).not.toContain('ghp_secret')
    expect(listing).toEqual([{ id: token.id, name: 'gh', kind: 'https', preview: '***abcd', projects: ['web'] }])
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
