import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

// hasSshKeys reads from os.homedir(), so we mock it to use a temp dir
let tmpHome: string

describe('hasSshKeys', () => {
  let originalHome: string

  beforeEach(async () => {
    tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-ssh-test-'))
    originalHome = os.homedir()
    // Override HOME so os.homedir() returns our temp dir
    process.env.HOME = tmpHome
  })

  afterEach(async () => {
    process.env.HOME = originalHome
    await fs.rm(tmpHome, { recursive: true, force: true })
  })

  async function loadHasSshKeys(): Promise<boolean> {
    // Re-import to pick up the changed HOME
    const mod = await import('@/lib/ssh-agent')
    return mod.hasSshKeys()
  }

  it('returns false when ~/.ssh does not exist', async () => {
    const result = await loadHasSshKeys()
    expect(result).toBe(false)
  })

  it('returns false when ~/.ssh is empty', async () => {
    await fs.mkdir(path.join(tmpHome, '.ssh'))
    const result = await loadHasSshKeys()
    expect(result).toBe(false)
  })

  it('returns false when ~/.ssh has only .pub files', async () => {
    const sshDir = path.join(tmpHome, '.ssh')
    await fs.mkdir(sshDir)
    await fs.writeFile(path.join(sshDir, 'id_ed25519.pub'), 'ssh-ed25519 AAAA...')
    const result = await loadHasSshKeys()
    expect(result).toBe(false)
  })

  it('returns true when ~/.ssh has a private key', async () => {
    const sshDir = path.join(tmpHome, '.ssh')
    await fs.mkdir(sshDir)
    await fs.writeFile(path.join(sshDir, 'id_ed25519'), '-----BEGIN OPENSSH PRIVATE KEY-----')
    const result = await loadHasSshKeys()
    expect(result).toBe(true)
  })

  it('returns true with id_rsa key', async () => {
    const sshDir = path.join(tmpHome, '.ssh')
    await fs.mkdir(sshDir)
    await fs.writeFile(path.join(sshDir, 'id_rsa'), '-----BEGIN RSA PRIVATE KEY-----')
    const result = await loadHasSshKeys()
    expect(result).toBe(true)
  })

  it('ignores non-id_ files', async () => {
    const sshDir = path.join(tmpHome, '.ssh')
    await fs.mkdir(sshDir)
    await fs.writeFile(path.join(sshDir, 'known_hosts'), 'github.com ...')
    await fs.writeFile(path.join(sshDir, 'config'), 'Host *')
    const result = await loadHasSshKeys()
    expect(result).toBe(false)
  })
})
