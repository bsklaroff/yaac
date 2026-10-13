import { describe, it, expect } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createPublicKey, verify } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { encodeOpenSshPrivateKey, generateSshKey, sshSign } from '#lib/ssh-key'

const execFileAsync = promisify(execFile)

/**
 * Checks against real OpenSSH that `ssh-keygen` reads the encoded key and
 * `ssh-add -` loads it into an agent, as both drivers use it.
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

      // OpenSSH 10's default socket under $HOME can exceed the path limit.
      const { stdout: agentOut } = await execFileAsync('ssh-agent', ['-c', '-a', path.join(dir, 'agent.sock')])
      const sock = /setenv SSH_AUTH_SOCK (\S+);/.exec(agentOut)![1]
      const pid = /setenv SSH_AGENT_PID (\d+);/.exec(agentOut)![1]
      try {
        // Via stdin, as both drivers do.
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
    // The public line's blob ends with the raw 32-byte point.
    const point = Buffer.from(key.publicKey.split(' ')[1], 'base64').subarray(-32)
    const pub = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: point.toString('base64url') }, format: 'jwk' })
    expect(verify(null, data, pub, raw)).toBe(true)
  })
})
