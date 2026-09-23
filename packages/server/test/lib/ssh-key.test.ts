import { describe, it, expect } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createPublicKey, verify } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import {
  encodeOpenSshPrivateKey,
  generateSshKey,
  publicKeyLine,
  sshKeyFromSeed,
  sshPublicKeyBlob,
  sshSign,
} from '#lib/ssh-key'

const execFileAsync = promisify(execFile)

/**
 * The compatibility proof, against real OpenSSH: the key yaac encodes is one
 * `ssh-keygen` reads, and `ssh-add -` loads into a real agent — the two
 * programs the containerless driver and the proxy pod feed it to.
 */

async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-ssh-key-'))
  try {
    return await fn(dir)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}

describe('generateSshKey', () => {
  it('yields a 32-byte seed and the matching one-line public key', () => {
    const key = generateSshKey('yaac git.example.com/*')
    expect(key.seed).toHaveLength(32)
    expect(key.publicKey).toMatch(/^ssh-ed25519 AAAAC3NzaC1lZDI1NTE5[A-Za-z0-9+/=]+ yaac git\.example\.com\/\*$/)
    expect(publicKeyLine(key.seed, 'yaac git.example.com/*')).toBe(key.publicKey)
    // Fresh entropy every time.
    expect(generateSshKey('x').publicKey).not.toBe(generateSshKey('x').publicKey)
  })
})

describe('encodeOpenSshPrivateKey', () => {
  it('is a key ssh-keygen reads and ssh-add loads, with the same public half', async () => {
    await withTmp(async (dir) => {
      const key = generateSshKey('yaac test')
      const keyPath = path.join(dir, 'id')
      await fs.writeFile(keyPath, encodeOpenSshPrivateKey(key.seed, 'yaac test'), { mode: 0o600 })

      const { stdout } = await execFileAsync('ssh-keygen', ['-y', '-f', keyPath])
      expect(stdout.trim()).toBe(key.publicKey)

      // An explicit socket: OpenSSH 10 defaults it under $HOME/.ssh/agent,
      // which a deep $HOME pushes past the Unix-socket path limit.
      const { stdout: agentOut } = await execFileAsync('ssh-agent', ['-c', '-a', path.join(dir, 'agent.sock')])
      const sock = /setenv SSH_AUTH_SOCK (\S+);/.exec(agentOut)![1]
      const pid = /setenv SSH_AGENT_PID (\d+);/.exec(agentOut)![1]
      try {
        // From stdin, the way both drivers feed it: never a path.
        await new Promise<void>((resolve, reject) => {
          const child = spawn('ssh-add', ['-'], { env: { ...process.env, SSH_AUTH_SOCK: sock } })
          child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ssh-add exited ${code}`))))
          child.stdin.end(encodeOpenSshPrivateKey(key.seed, 'yaac test'))
        })
        const { stdout: listed } = await execFileAsync('ssh-add', ['-L'], {
          env: { ...process.env, SSH_AUTH_SOCK: sock },
        })
        expect(listed.trim()).toBe(key.publicKey)
      } finally {
        process.kill(Number(pid))
      }
    })
  })
})

describe('sshSign', () => {
  it('answers in agent wire form, with a signature the public key verifies', () => {
    const key = generateSshKey('yaac test')
    const data = Buffer.from('the bytes an ssh client asks to have signed')
    const sig = sshSign(key.seed, data)

    // string "ssh-ed25519", string <64 bytes>
    expect(sig.readUInt32BE(0)).toBe('ssh-ed25519'.length)
    expect(sig.subarray(4, 15).toString()).toBe('ssh-ed25519')
    expect(sig.readUInt32BE(15)).toBe(64)
    const raw = sig.subarray(19)
    expect(verify(null, data, createPublicKey(sshKeyFromSeed(key.seed)), raw)).toBe(true)
  })
})

describe('sshPublicKeyBlob', () => {
  it('is the base64 field of the public line', () => {
    const key = generateSshKey('c')
    expect(sshPublicKeyBlob(key.seed).toString('base64')).toBe(key.publicKey.split(' ')[1])
  })
})
