import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { closeDb } from '#db/client'
import { BUILT_IN_USER_ID, deleteGitCredential, insertGitCredential } from '#db'
import { startGitSshAgent, stopGitSshAgent } from '#domain/git'
import { gitSshAgentSock } from '#domain/git/agent'
import { generateSshKey } from '#lib/ssh-key'

const execFileAsync = promisify(execFile)

/**
 * The server's ssh-agent, driven by real OpenSSH clients: `ssh-add -L` lists
 * the stored keys, and `ssh-keygen -Y sign`, given only the public key, signs
 * through the socket. Listing and signing are all git-over-ssh needs.
 */

let tmpDir: string
let workDir: string

function agentEnv(): NodeJS.ProcessEnv {
  return { ...process.env, SSH_AUTH_SOCK: gitSshAgentSock() }
}

beforeAll(async () => {
  tmpDir = await createTempDataDir()
  workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-agent-test-'))
})

afterAll(async () => {
  await stopGitSshAgent()
  await closeDb()
  await cleanupTempDir(tmpDir)
  await fs.rm(workDir, { recursive: true, force: true })
})

describe('startGitSshAgent', () => {
  it('lists the stored keys, signs with them, and forgets a deleted one live', async () => {
    const a = generateSshKey('yaac a')
    const b = generateSshKey('yaac b')
    const aRow = await insertGitCredential({ owner: BUILT_IN_USER_ID, name: 'a', kind: 'ssh', secret: a.seed.toString('base64'), publicKey: a.publicKey })
    await insertGitCredential({ owner: BUILT_IN_USER_ID, name: 'b', kind: 'ssh', secret: b.seed.toString('base64'), publicKey: b.publicKey })
    // An https token is not listed as an identity.
    await insertGitCredential({ owner: BUILT_IN_USER_ID, name: 'gh', kind: 'https', secret: 'ghp_x' })

    await startGitSshAgent()
    await startGitSshAgent() // idempotent
    expect((await fs.stat(gitSshAgentSock())).mode & 0o777).toBe(0o600)

    const { stdout } = await execFileAsync('ssh-add', ['-L'], { env: agentEnv() })
    // Each key's comment is its credential's name.
    expect(stdout.trim().split('\n')).toEqual([
      a.publicKey.replace(/ yaac a$/, ' a'),
      b.publicKey.replace(/ yaac b$/, ' b'),
    ])

    // Sign with only the public key on disk, as the server's git calls do.
    const pub = path.join(workDir, 'a.pub')
    const msg = path.join(workDir, 'msg')
    await fs.writeFile(pub, `${a.publicKey}\n`)
    await fs.writeFile(msg, 'sign me\n')
    await execFileAsync('ssh-keygen', ['-Y', 'sign', '-f', pub, '-n', 'test', msg], { env: agentEnv() })
    // check-novalidate reads the signed message from stdin.
    const verified = await new Promise<number | null>((resolve) => {
      const child = spawn('ssh-keygen', ['-Y', 'check-novalidate', '-n', 'test', '-s', `${msg}.sig`], {
        stdio: ['pipe', 'ignore', 'inherit'],
      })
      child.on('close', resolve)
      child.stdin.end('sign me\n')
    })
    expect(verified).toBe(0)

    await deleteGitCredential(aRow.id)
    const { stdout: after } = await execFileAsync('ssh-add', ['-L'], { env: agentEnv() })
    expect(after).not.toContain(a.publicKey.split(' ')[1])
    expect(after).toContain(b.publicKey.split(' ')[1])
  })

  it('refuses everything but list and sign', async () => {
    await startGitSshAgent()
    // An empty SSH_AGENTC_ADD_IDENTITY (17). Accepting it would let any
    // process of this uid load keys into the server.
    const reply = await new Promise<Buffer>((resolve, reject) => {
      const sock = net.connect(gitSshAgentSock())
      sock.once('data', (d: Buffer) => { sock.destroy(); resolve(d) })
      sock.once('error', reject)
      sock.write(Buffer.from([0, 0, 0, 1, 17]))
    })
    expect([...reply]).toEqual([0, 0, 0, 1, 5]) // SSH_AGENT_FAILURE
  })
})

describe('stopGitSshAgent', () => {
  it('closes the listener and removes the socket', async () => {
    await startGitSshAgent()
    await stopGitSshAgent()
    await expect(fs.access(gitSshAgentSock())).rejects.toThrow()
    await stopGitSshAgent() // idempotent
  })
})
