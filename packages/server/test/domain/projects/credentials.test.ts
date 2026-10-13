import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { execFile } from 'node:child_process'
import type * as childProcess from 'node:child_process'
import { promisify } from 'node:util'
import { createTempDataDir, cleanupTempDir, getDataDir } from '@yaac/test-utils/setup'
import {
  assignProjectCredential,
  missingCredentialError,
  resolveProjectCredential,
  sshKeyMaterial,
} from '#domain/projects'
import { addHttpsCredential, generateSshCredential, listAuth } from '#domain/auth'
import { BUILT_IN_USER_ID, closeDb, recordProject, seeTailnetUser } from '#db'
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

function project(id: string, remoteUrl: string): Promise<void> {
  return recordProject({ id, name: 'demo', remoteUrl, addedAt: '2026-01-01' }, BUILT_IN_USER_ID)
}

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
    expect((await summaries(BUILT_IN_USER_ID)).map((c) => [c.name, c.projects]))
      .toEqual([['gh', [WEB]], ['deploy', [SVC]]])

    // A remote yaac hosts takes no credential.
    await recordProject({ id: API, name: 'api', remoteUrl: hostedRemoteUrl(API), addedAt: '2026-01-01', hosted: true }, BUILT_IN_USER_ID)
    await expect(assignProjectCredential(local, API, token.id)).rejects.toThrow(/needs no git credential/)
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
    // A remote yaac hosts is always usable, with no credential row.
    await recordProject({ id: API, name: 'api', remoteUrl: hostedRemoteUrl(API), addedAt: '2026-01-01', hosted: true }, BUILT_IN_USER_ID)
    expect(await resolveProjectCredential(API)).toEqual({ kind: 'hosted' })

    // Changing the remote drops the host key, and so the credential, until
    // the key is assigned again.
    await project(SVC, 'git@other.example.com:acme/svc.git')
    expect(await resolveProjectCredential(SVC)).toBeNull()

    // A secret that no longer decrypts resolves to null.
    await fs.writeFile(secretKeyPath(), 'a-completely-different-key\n', { mode: 0o600 })
    forgetSecretConfig()
    expect(await resolveProjectCredential(WEB)).toBeNull()
    expect((await summaries(BUILT_IN_USER_ID))[0].preview).toMatch(/unreadable/)
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
