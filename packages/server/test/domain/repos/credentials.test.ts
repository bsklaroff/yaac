import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { execFile } from 'node:child_process'
import type * as childProcess from 'node:child_process'
import { promisify } from 'node:util'
import { createTempDataDir, cleanupTempDir, getDataDir } from '@yaac/test-utils/setup'
import {
  assignRepoCredential,
  missingCredentialError,
  repoCredentialNames,
  resolveCredentialForRemote,
  resolveRepoCredential,
  sshKeyMaterial,
  validateGitRemoteUrl,
} from '#domain/repos'
import { addHttpsCredential, generateSshCredential, listAuth } from '#domain/auth'
import { BUILT_IN_USER_ID, closeDb, getRepo, insertRepo, listRepos, seeTailnetUser, type RepoRow } from '#db'
import { forgetSecretConfig } from '#db/secret-key'
import { secretKeyPath } from '@yaac/shared/project-paths'
import { hostedRemoteUrl } from '@yaac/shared/hosted-git'

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

let tmpDir: string

beforeEach(async () => {
  tmpDir = await createTempDataDir()
  sshRuns.length = 0
})

afterEach(async () => {
  await closeDb()
  await cleanupTempDir(tmpDir)
})

const summaries = async (owner: string) => (await listAuth(owner)).gitCredentials

function repo(id: string, remoteUrl: string, owner = BUILT_IN_USER_ID): Promise<RepoRow> {
  return insertRepo({ id, owner, remoteUrl })
}

/** A repo's row as it stands now. */
async function row(id: string): Promise<RepoRow> {
  return (await getRepo(id)) as RepoRow
}

describe('assignRepoCredential', () => {
  it('assigns a matching credential — fetching an ssh remote\'s host key — and refuses a mismatched kind', async () => {
    await repo(WEB, 'https://github.com/acme/web.git')
    await repo(SVC, 'git@git.example.com:acme/svc.git')
    const token = await addHttpsCredential(BUILT_IN_USER_ID, { name: 'gh', token: 'ghp_abcd1234' })
    const key = await generateSshCredential(BUILT_IN_USER_ID, { name: 'deploy' })

    expect(await assignRepoCredential(local, WEB, token.id)).toEqual({ knownHostsEntry: null })
    expect(sshRuns).toEqual([])
    expect(await assignRepoCredential(local, SVC, key.id)).toEqual({ knownHostsEntry: HOST_KEY })
    expect(sshRuns.at(-1)).toContain('nobody@git.example.com')
    expect(await row(SVC)).toMatchObject({ gitCredentialId: key.id, knownHostsEntry: HOST_KEY })

    await expect(assignRepoCredential(local, WEB, key.id)).rejects.toThrow(/needs a token, not an SSH key/)
    await expect(assignRepoCredential(local, SVC, token.id)).rejects.toThrow(/needs an SSH key, not a token/)
    await expect(assignRepoCredential(local, NOPE, token.id)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    // Another user's credential is never theirs to assign, so a repo cannot
    // spend it; nor is another user's repo theirs to change.
    const bob = await seeTailnetUser('bob@example.com', 'Bob')
    const bobs = await addHttpsCredential(bob, { name: 'b', token: 'ghp_b' })
    await expect(assignRepoCredential(local, WEB, bobs.id)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await repo(BARE, 'https://github.com/bob/own.git', bob)
    await expect(assignRepoCredential(local, BARE, token.id)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect((await summaries(BUILT_IN_USER_ID)).map((c) => [c.name, c.repos]))
      .toEqual([['gh', ['https://github.com/acme/web.git']], ['deploy', ['git@git.example.com:acme/svc.git']]])

    // A remote yaac hosts takes no credential.
    await insertRepo({ id: API, owner: BUILT_IN_USER_ID, remoteUrl: hostedRemoteUrl(API), hosted: true })
    await expect(assignRepoCredential(local, API, token.id)).rejects.toThrow(/needs no git credential/)
  })
})

describe('repoCredentialNames', () => {
  it('names the credential each repo can use, and none for a repo without a usable one', async () => {
    await repo(WEB, 'https://github.com/acme/web.git')
    await repo(SVC, 'git@git.example.com:acme/svc.git')
    await repo(BARE, 'https://github.com/acme/bare.git')
    const token = await addHttpsCredential(BUILT_IN_USER_ID, { name: 'gh', token: 'ghp_abcd1234' })
    const key = await generateSshCredential(BUILT_IN_USER_ID, { name: 'deploy' })
    await assignRepoCredential(local, WEB, token.id)
    await assignRepoCredential(local, SVC, key.id)

    expect(await repoCredentialNames(await listRepos())).toEqual(new Map([
      [WEB, { id: token.id, name: 'gh' }],
      [SVC, { id: key.id, name: 'deploy' }],
    ]))
    // An ssh key whose host key is gone no longer counts.
    expect(await repoCredentialNames([{ ...await row(SVC), knownHostsEntry: null }])).toEqual(new Map())
  })
})

describe('validateGitRemoteUrl', () => {
  it('parses the three remote forms and refuses the rest, a token in the URL included', () => {
    expect(validateGitRemoteUrl('https://github.com/acme/web.git')).toEqual({ scheme: 'https', host: 'github.com', path: 'acme/web' })
    expect(validateGitRemoteUrl('git@git.example.com:acme/svc.git')).toMatchObject({ scheme: 'ssh', host: 'git.example.com', path: 'acme/svc' })
    expect(validateGitRemoteUrl('ssh://git@git.example.com/acme/svc')).toMatchObject({ scheme: 'ssh', path: 'acme/svc' })
    for (const bad of ['http://github.com/acme/web', '/some/local/path', 'ext::sh -c evil', 'https://tok@github.com/acme/web.git']) {
      expect(() => validateGitRemoteUrl(bad)).toThrow(expect.objectContaining({ code: 'VALIDATION' }) as Error)
    }
  })
})

describe('resolveCredentialForRemote', () => {
  it("resolves one of the owner's credentials that fits a remote, and refuses a remote or credential that does not", async () => {
    const token = await addHttpsCredential(BUILT_IN_USER_ID, { name: 'gh', token: 'ghp_abcd1234' })
    const key = await generateSshCredential(BUILT_IN_USER_ID, { name: 'deploy' })

    expect(await resolveCredentialForRemote(BUILT_IN_USER_ID, token.id, 'https://github.com/acme/web.git'))
      .toEqual({ credential: { kind: 'https', token: 'ghp_abcd1234' }, knownHostsEntry: null })
    for (const url of ['git@git.example.com:acme/svc.git', 'ssh://git@git.example.com/acme/svc.git']) {
      expect(await resolveCredentialForRemote(BUILT_IN_USER_ID, key.id, url)).toEqual({
        credential: { kind: 'ssh', id: key.id, publicKey: key.publicKey, knownHostsEntry: HOST_KEY },
        knownHostsEntry: HOST_KEY,
      })
    }

    await expect(resolveCredentialForRemote(BUILT_IN_USER_ID, token.id, 'http://github.com/acme/web.git'))
      .rejects.toMatchObject({ code: 'VALIDATION', message: expect.stringMatching(/Only https:\/\/ and ssh:\/\//) as string })
    // A token in the URL would be stored, listed to every user and written
    // into checkouts.
    for (const url of ['https://x-access-token:ghp_secret@github.com/acme/web.git', 'https://ghp_secret@github.com/acme/web.git']) {
      await expect(resolveCredentialForRemote(BUILT_IN_USER_ID, token.id, url))
        .rejects.toMatchObject({ code: 'VALIDATION', message: expect.stringMatching(/must not carry a user or token/) as string })
    }
    await expect(resolveCredentialForRemote(BUILT_IN_USER_ID, token.id, 'git@git.example.com:acme/svc.git'))
      .rejects.toThrow(/needs an SSH key, not a token/)
    const bob = await seeTailnetUser('bob@example.com', 'Bob')
    await expect(resolveCredentialForRemote(bob, token.id, 'https://github.com/acme/web.git'))
      .rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('resolveRepoCredential', () => {
  it('resolves the assigned credential for git, and nothing for a repo without a usable one', async () => {
    await repo(WEB, 'https://github.com/acme/web.git')
    await repo(SVC, 'git@git.example.com:acme/svc.git')
    const bare = await repo(BARE, 'https://github.com/acme/bare.git')
    const token = await addHttpsCredential(BUILT_IN_USER_ID, { name: 'gh', token: 'ghp_abcd1234' })
    const key = await generateSshCredential(BUILT_IN_USER_ID, { name: 'deploy' })
    await assignRepoCredential(local, WEB, token.id)
    await assignRepoCredential(local, SVC, key.id)

    expect(await resolveRepoCredential(await row(WEB))).toEqual({ kind: 'https', token: 'ghp_abcd1234' })
    expect(await resolveRepoCredential(await row(SVC))).toEqual({
      kind: 'ssh', id: key.id, publicKey: key.publicKey, knownHostsEntry: HOST_KEY,
    })
    expect(await resolveRepoCredential(bare)).toBeNull()
    // A remote yaac hosts is always usable, with no credential row.
    const hosted = await insertRepo({ id: API, owner: BUILT_IN_USER_ID, remoteUrl: hostedRemoteUrl(API), hosted: true })
    expect(await resolveRepoCredential(hosted)).toEqual({ kind: 'hosted' })

    // A credential of the wrong kind for the remote, or an ssh key with no
    // trusted host key, is no credential.
    expect(await resolveRepoCredential({ ...await row(SVC), knownHostsEntry: null })).toBeNull()
    expect(await resolveRepoCredential({ ...await row(WEB), gitCredentialId: key.id })).toBeNull()

    // A secret that no longer decrypts resolves to null.
    await fs.writeFile(secretKeyPath(), 'a-completely-different-key\n', { mode: 0o600 })
    forgetSecretConfig()
    expect(await resolveRepoCredential(await row(WEB))).toBeNull()
    expect((await summaries(BUILT_IN_USER_ID))[0].preview).toMatch(/unreadable/)
  })
})

describe('missingCredentialError', () => {
  it('names the repo and where to fix it', async () => {
    expect(missingCredentialError(await repo(WEB, 'https://github.com/acme/web.git'))).toMatchObject({
      code: 'VALIDATION',
      message: expect.stringMatching(/github\.com\/acme\/web\.git has no git credential.*Settings/) as string,
    })
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
