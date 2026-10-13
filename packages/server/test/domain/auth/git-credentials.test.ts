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
  generateSshCredential,
  listAuth,
  removeCredential,
  renameCredential,
  replaceCredential,
} from '#domain/auth'
import { assignProjectCredential, resolveProjectCredential, sshKeyMaterial } from '#domain/projects'
import { BUILT_IN_USER_ID, closeDb, recordProject, seeTailnetUser } from '#db'

/** The caller of every user-caused write here. */
const local = { kind: 'local', userId: BUILT_IN_USER_ID } as const

const WEB = '2567a5ec-9705-4b7a-82c9-84033e06189d'
const SVC = '961e38b5-146c-4b07-8078-f53dec9b699a'

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

const summaries = async (owner: string) => (await listAuth(owner)).gitCredentials

function project(id: string, remoteUrl: string): Promise<void> {
  return recordProject({ id, name: 'demo', remoteUrl, addedAt: '2026-01-01' }, BUILT_IN_USER_ID)
}

describe('addHttpsCredential', () => {
  it('stores a token under a trimmed name, and refuses a blank name or token', async () => {
    const { id } = await addHttpsCredential(BUILT_IN_USER_ID, { name: '  gh  ', token: 'ghp_abcd1234' })
    expect(await summaries(BUILT_IN_USER_ID)).toEqual([
      { id, name: 'gh', kind: 'https', preview: '***1234', projects: [] },
    ])
    await expect(addHttpsCredential(BUILT_IN_USER_ID, { name: ' ', token: 'x' })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(addHttpsCredential(BUILT_IN_USER_ID, { name: 'x', token: '  ' })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(addHttpsCredential(BUILT_IN_USER_ID, { name: 'a\nb', token: 'x' })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(addHttpsCredential(BUILT_IN_USER_ID, { name: 'gh', token: 'x' })).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('is listed with the projects using it, and never with its token', async () => {
    await project(WEB, 'https://github.com/acme/web.git')
    const token = await addHttpsCredential(BUILT_IN_USER_ID, { name: 'gh', token: 'ghp_secret_abcd' })
    await assignProjectCredential(local, WEB, token.id)
    const listing = await summaries(BUILT_IN_USER_ID)
    expect(JSON.stringify(listing)).not.toContain('ghp_secret')
    expect(listing).toEqual([{ id: token.id, name: 'gh', kind: 'https', preview: '***abcd', projects: [WEB] }])
  })
})

describe('generateSshCredential', () => {
  it('answers the public key at once, commented with the name, touching no host', async () => {
    const { id, publicKey } = await generateSshCredential(BUILT_IN_USER_ID, { name: 'deploy' })
    expect(publicKey).toMatch(PUBLIC_KEY_RE)
    expect(publicKey.endsWith(' deploy')).toBe(true)
    expect(sshRuns).toEqual([])
    expect(await summaries(BUILT_IN_USER_ID)).toEqual([
      { id, name: 'deploy', kind: 'ssh', preview: publicKey, publicKey, projects: [] },
    ])
  })
})

describe('renameCredential', () => {
  it('renames, re-commenting a key without changing it', async () => {
    const { id, publicKey } = await generateSshCredential(BUILT_IN_USER_ID, { name: 'old' })
    await renameCredential(BUILT_IN_USER_ID, id, 'new')
    const [summary] = await summaries(BUILT_IN_USER_ID)
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
    expect((await summaries(BUILT_IN_USER_ID)).map((c) => c.name)).toEqual(['new'])
  })
})

describe('removeCredential', () => {
  it('deletes a credential in use, stranding its projects with none', async () => {
    // A leaked credential has to be removable at once.
    await project(WEB, 'https://github.com/acme/web.git')
    const a = await addHttpsCredential(BUILT_IN_USER_ID, { name: 'a', token: 'ghp_aaaa' })
    await assignProjectCredential(local, WEB, a.id)

    await removeCredential(BUILT_IN_USER_ID, a.id)
    expect(await summaries(BUILT_IN_USER_ID)).toEqual([])
    expect(await resolveProjectCredential(WEB)).toBeNull()
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
    expect((await summaries(BUILT_IN_USER_ID)).map((c) => [c.name, c.projects])).toEqual([['gh', [WEB]], ['deploy', [SVC]]])
    await expect(replaceCredential(BUILT_IN_USER_ID, key.id, {})).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})
