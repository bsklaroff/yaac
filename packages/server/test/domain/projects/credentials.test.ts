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
import { BUILT_IN_USER_ID, closeDb, recordProject, seeTailnetUser } from '#db'
import { forgetSecretConfig } from '#db/secret-key'
import { secretKeyPath } from '@yaac/shared/project-paths'

/** The caller of every user-caused write here. */
const local = { kind: 'local', userId: BUILT_IN_USER_ID } as const

const NOPE = '4101bef8-794f-4d98-8e95-dfb54850c68b'

const WEB = '2567a5ec-9705-4b7a-82c9-84033e06189d'
const SVC = '961e38b5-146c-4b07-8078-f53dec9b699a'
const BARE = '8604aeca-e9ee-44a7-8c52-d4c1965bb0ef'
const API = '8a5da52e-d126-447d-859e-70c05721a8aa'

// A host-key fetch runs `ssh`, which writes the negotiated key into the
// known_hosts file it is given. The mock writes HOST_KEY there instead, so no
// network is used.
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

function project(id: string, remoteUrl: string): Promise<void> {
  return recordProject({ id, name: 'demo', remoteUrl, addedAt: '2026-01-01' }, BUILT_IN_USER_ID)
}

describe('addHttpsCredential', () => {
  it('stores a token under a trimmed name, and refuses a blank name or token', async () => {
    const { id } = await addHttpsCredential(BUILT_IN_USER_ID, { name: '  gh  ', token: 'ghp_abcd1234' })
    expect(await listCredentialSummaries(BUILT_IN_USER_ID)).toEqual([
      { id, name: 'gh', kind: 'https', preview: '***1234', projects: [] },
    ])
    await expect(addHttpsCredential(BUILT_IN_USER_ID, { name: ' ', token: 'x' })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(addHttpsCredential(BUILT_IN_USER_ID, { name: 'x', token: '  ' })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(addHttpsCredential(BUILT_IN_USER_ID, { name: 'a\nb', token: 'x' })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(addHttpsCredential(BUILT_IN_USER_ID, { name: 'gh', token: 'x' })).rejects.toMatchObject({ code: 'CONFLICT' })
  })
})

describe('generateSshCredential', () => {
  it('answers the public key at once, commented with the name, touching no host', async () => {
    const { id, publicKey } = await generateSshCredential(BUILT_IN_USER_ID, { name: 'deploy' })
    expect(publicKey).toMatch(PUBLIC_KEY_RE)
    expect(publicKey.endsWith(' deploy')).toBe(true)
    expect(sshRuns).toEqual([])
    expect(await listCredentialSummaries(BUILT_IN_USER_ID)).toEqual([
      { id, name: 'deploy', kind: 'ssh', preview: publicKey, publicKey, projects: [] },
    ])
  })
})

describe('renameCredential', () => {
  it('renames, re-commenting a key without changing it', async () => {
    const { id, publicKey } = await generateSshCredential(BUILT_IN_USER_ID, { name: 'old' })
    await renameCredential(BUILT_IN_USER_ID, id, 'new')
    const [summary] = await listCredentialSummaries(BUILT_IN_USER_ID)
    expect(summary.name).toBe('new')
    expect(summary.publicKey?.split(' ').slice(0, 2)).toEqual(publicKey.split(' ').slice(0, 2))
    expect(summary.publicKey?.endsWith(' new')).toBe(true)
    // The private half carries the new comment too, and is the same key.
    const keyPath = path.join(getDataDir(), 'probe')
    await fs.writeFile(keyPath, await sshKeyMaterial(id), { mode: 0o600 })
    const { stdout } = await execFileAsync('ssh-keygen', ['-y', '-f', keyPath])
    expect(stdout.trim().split(' ').slice(0, 2)).toEqual(publicKey.split(' ').slice(0, 2))

    await expect(renameCredential(BUILT_IN_USER_ID, '00000000-0000-4000-8000-000000000000', 'x'))
      .rejects.toMatchObject({ code: 'NOT_FOUND' })
    // Another user's credential reads as missing to every write.
    const bob = await seeTailnetUser('bob@example.com', 'Bob')
    await expect(renameCredential(bob, id, 'x')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(replaceCredential(bob, id, {})).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(removeCredential(bob, id)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect((await listCredentialSummaries(BUILT_IN_USER_ID)).map((c) => c.name)).toEqual(['new'])
  })
})

describe('assignProjectCredential', () => {
  it('assigns a matching credential — fetching an ssh remote\'s host key — and refuses a mismatched kind', async () => {
    await project(WEB, 'https://github.com/acme/web.git')
    await project(SVC, 'git@git.example.com:acme/svc.git')
    const token = await addHttpsCredential(BUILT_IN_USER_ID, { name: 'gh', token: 'ghp_abcd1234' })
    const key = await generateSshCredential(BUILT_IN_USER_ID, { name: 'deploy' })

    expect(await assignProjectCredential(local, WEB, token.id)).toEqual({ knownHostsEntry: null })
    expect(sshRuns).toEqual([])
    expect(await assignProjectCredential(local, SVC, key.id)).toEqual({ knownHostsEntry: HOST_KEY })
    expect(sshRuns.at(-1)).toContain('nobody@git.example.com')

    await expect(assignProjectCredential(local, WEB, key.id)).rejects.toThrow(/needs a token, not an SSH key/)
    await expect(assignProjectCredential(local, SVC, token.id)).rejects.toThrow(/needs an SSH key, not a token/)
    await expect(assignProjectCredential(local, NOPE, token.id)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    // Another user's credential is never theirs to assign, so a project
    // cannot spend it.
    const bobs = await addHttpsCredential(await seeTailnetUser('bob@example.com', 'Bob'), { name: 'b', token: 'ghp_b' })
    await expect(assignProjectCredential(local, WEB, bobs.id)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect((await listCredentialSummaries(BUILT_IN_USER_ID)).map((c) => [c.name, c.projects]))
      .toEqual([['gh', [WEB]], ['deploy', [SVC]]])
  })
})

describe('resolveProjectCredential', () => {
  it('resolves the assigned credential for git, and nothing for a project without a usable one', async () => {
    await project(WEB, 'https://github.com/acme/web.git')
    await project(SVC, 'git@git.example.com:acme/svc.git')
    await project(BARE, 'https://github.com/acme/bare.git')
    const token = await addHttpsCredential(BUILT_IN_USER_ID, { name: 'gh', token: 'ghp_abcd1234' })
    const key = await generateSshCredential(BUILT_IN_USER_ID, { name: 'deploy' })
    await assignProjectCredential(local, WEB, token.id)
    await assignProjectCredential(local, SVC, key.id)

    expect(await resolveProjectCredential(WEB)).toEqual({ kind: 'https', token: 'ghp_abcd1234' })
    expect(await resolveProjectCredential(SVC)).toEqual({
      kind: 'ssh', id: key.id, publicKey: key.publicKey, knownHostsEntry: HOST_KEY,
    })
    expect(await resolveProjectCredential(BARE)).toBeNull()
    expect(await resolveProjectCredential(NOPE)).toBeNull()

    // Changing the remote drops the host key, and so the credential, until
    // the key is assigned again.
    await project(SVC, 'git@other.example.com:acme/svc.git')
    expect(await resolveProjectCredential(SVC)).toBeNull()

    // A secret that no longer decrypts resolves to null.
    await fs.writeFile(secretKeyPath(), 'a-completely-different-key\n', { mode: 0o600 })
    forgetSecretConfig()
    expect(await resolveProjectCredential(WEB)).toBeNull()
    expect((await listCredentialSummaries(BUILT_IN_USER_ID))[0].preview).toMatch(/unreadable/)
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
    await project(WEB, 'https://github.com/acme/web.git')
    const a = await addHttpsCredential(BUILT_IN_USER_ID, { name: 'a', token: 'ghp_aaaa' })
    await assignProjectCredential(local, WEB, a.id)

    await removeCredential(BUILT_IN_USER_ID, a.id)
    expect(await listCredentialSummaries(BUILT_IN_USER_ID)).toEqual([])
    expect(await resolveProjectCredential(WEB)).toBeNull()
    expect(await runtimeGitCredentials()).toEqual({})
    await expect(removeCredential(BUILT_IN_USER_ID, a.id)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('replaceCredential', () => {
  it('replaces a token or a key in place for every project that used it', async () => {
    await project(WEB, 'https://github.com/acme/web.git')
    await project(SVC, 'git@git.example.com:acme/svc.git')
    const token = await addHttpsCredential(BUILT_IN_USER_ID, { name: 'gh', token: 'ghp_leaked' })
    const key = await generateSshCredential(BUILT_IN_USER_ID, { name: 'deploy' })
    await assignProjectCredential(local, WEB, token.id)
    await assignProjectCredential(local, SVC, key.id)
    sshRuns.length = 0

    await expect(replaceCredential(BUILT_IN_USER_ID, token.id, {})).rejects.toMatchObject({ code: 'VALIDATION' })
    await replaceCredential(BUILT_IN_USER_ID, token.id, { token: 'ghp_fresh' })
    expect(await resolveProjectCredential(WEB)).toEqual({ kind: 'https', token: 'ghp_fresh' })

    const replaced = await replaceCredential(BUILT_IN_USER_ID, key.id, {})
    expect(replaced.publicKey).toMatch(PUBLIC_KEY_RE)
    expect(replaced.publicKey).not.toBe(key.publicKey)
    // Same host, so the trusted host key carries over without a fetch.
    expect(await resolveProjectCredential(SVC)).toEqual({
      kind: 'ssh', id: replaced.id, publicKey: replaced.publicKey, knownHostsEntry: HOST_KEY,
    })
    expect(sshRuns).toEqual([])
    expect((await listCredentialSummaries(BUILT_IN_USER_ID)).map((c) => [c.name, c.projects])).toEqual([['gh', [WEB]], ['deploy', [SVC]]])
    await expect(replaceCredential(BUILT_IN_USER_ID, key.id, {})).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('runtimeGitCredentials', () => {
  it('hands the runtime each used credential with the projects entitled to it', async () => {
    await project(WEB, 'https://github.com/acme/web.git')
    await project(API, 'https://github.com/acme/api.git')
    await project(SVC, 'git@git.example.com:acme/svc.git')
    const token = await addHttpsCredential(BUILT_IN_USER_ID, { name: 'gh', token: 'ghp_abcd1234' })
    await addHttpsCredential(BUILT_IN_USER_ID, { name: 'unused', token: 'ghp_zzzz' })
    const key = await generateSshCredential(BUILT_IN_USER_ID, { name: 'deploy' })
    await assignProjectCredential(local, WEB, token.id)
    await assignProjectCredential(local, API, token.id)
    await assignProjectCredential(local, SVC, key.id)

    const { git, ssh } = (await runtimeGitCredentials())[BUILT_IN_USER_ID]
    expect(git).toEqual([{ token: 'ghp_abcd1234', projects: [WEB, API] }])
    expect(ssh).toEqual([{
      privateKey: expect.stringContaining('BEGIN OPENSSH PRIVATE KEY') as string,
      publicKey: key.publicKey,
      projects: [{ projectId: SVC, host: 'git.example.com', knownHostsEntry: HOST_KEY }],
    }])
  })
})

describe('sshKeyMaterial', () => {
  it('opens a key in the form ssh-add reads, and refuses anything else', async () => {
    const { id, publicKey } = await generateSshCredential(BUILT_IN_USER_ID, { name: 'deploy' })
    const keyPath = path.join(getDataDir(), 'probe')
    await fs.writeFile(keyPath, await sshKeyMaterial(id), { mode: 0o600 })
    const { stdout } = await execFileAsync('ssh-keygen', ['-y', '-f', keyPath])
    expect(stdout.trim()).toBe(publicKey)

    await expect(sshKeyMaterial('00000000-0000-4000-8000-000000000000')).rejects.toMatchObject({ code: 'VALIDATION' })
  })
})

describe('listCredentialSummaries', () => {
  it('never carries a secret, and lists each credential with its projects', async () => {
    await project(WEB, 'https://github.com/acme/web.git')
    const token = await addHttpsCredential(BUILT_IN_USER_ID, { name: 'gh', token: 'ghp_secret_abcd' })
    await assignProjectCredential(local, WEB, token.id)
    const listing = await listCredentialSummaries(BUILT_IN_USER_ID)
    expect(JSON.stringify(listing)).not.toContain('ghp_secret')
    expect(listing).toEqual([{ id: token.id, name: 'gh', kind: 'https', preview: '***abcd', projects: [WEB] }])
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

  it('rejects a remote-helper URL, which git would run rather than dial', () => {
    // `ext::<cmd>` is shaped like `host:path` with a path of `:<cmd>`; git
    // reads it as the ext helper and runs the command.
    for (const url of ['ext::sh -c touch% /tmp/x', 'fd::17', 'git@ext::sh']) {
      expect(() => parseGitRemote(url)).toThrow(/Unrecognized git remote URL/)
    }
  })
})
